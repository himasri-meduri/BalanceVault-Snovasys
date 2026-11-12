import crypto from 'node:crypto';
import { OnboardingStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { hashPassword } from '../src/modules/auth/auth.crypto.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { HealthService } from '../src/modules/health/health.service.js';
import type {
  OnboardingRepository,
  OnboardingTxContext,
} from '../src/modules/onboarding/onboarding.repository.js';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service.js';
import type { OnboardingApplicationRecord } from '../src/modules/onboarding/onboarding.types.js';
import {
  InMemoryAuthAuditBootstrapStore,
  InMemoryRateLimitStore,
} from './helpers/inMemoryStore.js';

function makeTestEnv(overrides: Record<string, string> = {}) {
  return parseEnv({
    NODE_ENV: 'test',
    PORT: '4000',
    APP_ORIGIN: 'http://localhost:5173',
    API_PUBLIC_URL: 'http://localhost:4000',
    DATABASE_URL: 'postgresql://app_runtime:secret@localhost:5432/balancevault',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-session-secret-that-is-well-over-32-characters-long',
    SESSION_TTL_HOURS: '12',
    SESSION_IDLE_MINUTES: '30',
    COOKIE_SECURE: 'false',
    COOKIE_SAME_SITE: 'lax',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

function extractCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

function buildOnboardingHarness() {
  let currentNow = new Date('2026-11-11T12:00:00.000Z');
  const nowProvider = () => currentNow;

  const env = makeTestEnv();
  const store = new InMemoryAuthAuditBootstrapStore(nowProvider);
  const rateLimitStore = new InMemoryRateLimitStore();
  const auditService = new AuditService(store);
  const authService = new AuthService(store, env, nowProvider);
  const onboardingService = new OnboardingService(store, env, nowProvider);

  const app = createApp({
    env,
    logger: createLogger('silent'),
    healthService: new HealthService({
      checkDatabase: async () => 'ok',
      checkRedis: async () => 'ok',
    }),
    authService,
    auditService,
    onboardingService,
    rateLimitStore,
    rateLimitConfig: {
      registerMax: 50,
      loginMax: 50,
      onboardingSubmitMax: 25,
      windowMs: 60_000,
    },
  });

  async function registerCustomerSession(name: string, email: string) {
    const res = await request(app).post('/api/auth/register').send({
      fullName: name,
      email,
      password: 'CustomerPass#2026',
    });
    expect(res.status).toBe(201);
    return {
      user: res.body.user as { id: string; email: string; role: UserRole },
      cookies: extractCookies(res),
      csrfToken: res.body.csrfToken as string,
    };
  }

  async function seedAndLoginStaff(role: UserRole, email: string, fullName: string) {
    const passwordHash = await hashPassword('StaffPass#2026');
    const seeded = store.seedUser({
      email,
      fullName,
      passwordHash,
      role,
    });
    const res = await request(app).post('/api/auth/login').send({
      email,
      password: 'StaffPass#2026',
    });
    expect(res.status).toBe(200);
    return {
      user: seeded,
      cookies: extractCookies(res),
      csrfToken: res.body.csrfToken as string,
    };
  }

  return {
    app,
    env,
    store,
    onboardingService,
    auditService,
    registerCustomerSession,
    seedAndLoginStaff,
    advanceMinutes(minutes: number) {
      currentNow = new Date(currentNow.getTime() + minutes * 60_000);
    },
  };
}

const VALID_PROFILE = {
  contactReference: '+91-9876543210',
  city: 'Bengaluru',
  country: 'India',
  accountPurpose: 'Personal INR savings and demo ledger walkthroughs',
  acceptedSyntheticTerms: true,
};

describe('Phase 3 Onboarding & Admin Review Workflow, IDOR & RBAC', () => {
  it('1. Unauthenticated users cannot access any customer or admin onboarding endpoints', async () => {
    const { app } = buildOnboardingHarness();
    const randomId = crypto.randomUUID();

    expect((await request(app).get('/api/onboarding/me')).status).toBe(401);
    expect((await request(app).patch('/api/onboarding/me').send({ city: 'Mumbai' })).status).toBe(
      401,
    );
    expect((await request(app).post('/api/onboarding/me/submit').send(VALID_PROFILE)).status).toBe(
      401,
    );

    expect((await request(app).get('/api/admin/onboarding/applications')).status).toBe(401);
    expect((await request(app).get('/api/admin/onboarding')).status).toBe(401);
    expect((await request(app).get(`/api/admin/onboarding/applications/${randomId}`)).status).toBe(
      401,
    );
    expect(
      (await request(app).post(`/api/admin/onboarding/applications/${randomId}/approve`)).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(`/api/admin/onboarding/applications/${randomId}/reject`)
          .send({ reason: 'Unauthenticated rejection should return 401 first' })
      ).status,
    ).toBe(401);
  });

  it('2. Customer can view, update, and submit only their own onboarding application with strict schema & CSRF checks', async () => {
    const { app, registerCustomerSession } = buildOnboardingHarness();
    const customer = await registerCustomerSession('Ananya Sharma', 'ananya@balancevault.test');

    const initialRes = await request(app)
      .get('/api/onboarding/me')
      .set('Cookie', customer.cookies);
    expect(initialRes.status).toBe(200);
    expect(initialRes.body.application.status).toBe(OnboardingStatus.PENDING);
    expect(initialRes.body.application.submittedAt).toBeNull();
    expect(initialRes.body.application.applicant.email).toBe('ananya@balancevault.test');

    // Missing CSRF header on mutation must fail cleanly
    const missingCsrfPatch = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .send({ city: 'Bengaluru' });
    expect(missingCsrfPatch.status).toBe(403);
    expect(missingCsrfPatch.body.error.code).toBe('CSRF_INVALID');

    // Incomplete submission fails validation before marking submittedAt
    const incompleteSubmit = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ city: 'Bengaluru' });
    expect(incompleteSubmit.status).toBe(400);
    expect(incompleteSubmit.body.error.code).toBe('VALIDATION_ERROR');

    // Partial draft update via PATCH
    const patchRes = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        contactReference: VALID_PROFILE.contactReference,
        city: VALID_PROFILE.city,
        country: VALID_PROFILE.country,
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.application.city).toBe('Bengaluru');
    expect(patchRes.body.application.submittedAt).toBeNull();

    // Missing CSRF on submit must also fail cleanly
    const missingCsrfSubmit = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .send({
        accountPurpose: VALID_PROFILE.accountPurpose,
        acceptedSyntheticTerms: true,
      });
    expect(missingCsrfSubmit.status).toBe(403);
    expect(missingCsrfSubmit.body.error.code).toBe('CSRF_INVALID');

    // Complete submission merges saved PATCH fields + POST fields
    const submitRes = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        accountPurpose: VALID_PROFILE.accountPurpose,
        acceptedSyntheticTerms: true,
      });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.application.status).toBe(OnboardingStatus.PENDING);
    expect(submitRes.body.application.submittedAt).toBeTruthy();
    expect(submitRes.body.application.acceptedSyntheticTerms).toBe(true);

    // Once submitted for review, customer cannot edit or duplicate-submit while PENDING review
    const postSubmitPatch = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ city: 'Chennai' });
    expect(postSubmitPatch.status).toBe(409);
    expect(postSubmitPatch.body.error.code).toBe('ONBOARDING_ALREADY_SUBMITTED');

    const postSubmitResubmit = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({});
    expect(postSubmitResubmit.status).toBe(409);
    expect(postSubmitResubmit.body.error.code).toBe('ONBOARDING_ALREADY_SUBMITTED');
  });

  it('3 & 4. Customer A cannot read, update, or submit Customer B onboarding application (IDOR & mass-assignment defense)', async () => {
    const { app, store, registerCustomerSession } = buildOnboardingHarness();
    const customerA = await registerCustomerSession('Customer A', 'customera@balancevault.test');
    const customerB = await registerCustomerSession('Customer B', 'customerb@balancevault.test');

    const appA = await store.findByUserId(customerA.user.id);
    const appB = await store.findByUserId(customerB.user.id);
    expect(appA).toBeTruthy();
    expect(appB).toBeTruthy();

    // Customer B sets known city
    const patchB = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customerB.cookies)
      .set('X-CSRF-Token', customerB.csrfToken)
      .send({ city: 'Jaipur' });
    expect(patchB.status).toBe(200);

    // Customer A tries reading Customer B via direct ID path or admin endpoint
    const directReadAttempt = await request(app)
      .get(`/api/onboarding/${appB!.id}`)
      .set('Cookie', customerA.cookies);
    expect(directReadAttempt.status).toBe(404);

    const adminReadAttempt = await request(app)
      .get(`/api/admin/onboarding/applications/${appB!.id}`)
      .set('Cookie', customerA.cookies);
    expect(adminReadAttempt.status).toBe(403);

    // Customer A tries forging userId/id/status/role in PATCH & POST body -> strict schema rejects 400
    const forgedPatch = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customerA.cookies)
      .set('X-CSRF-Token', customerA.csrfToken)
      .send({
        userId: customerB.user.id,
        id: appB!.id,
        status: OnboardingStatus.APPROVED,
        city: 'HackedCity',
      });
    expect(forgedPatch.status).toBe(400);
    expect(forgedPatch.body.error.code).toBe('VALIDATION_ERROR');

    const forgedSubmit = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customerA.cookies)
      .set('X-CSRF-Token', customerA.csrfToken)
      .send({
        ...VALID_PROFILE,
        userId: customerB.user.id,
        id: appB!.id,
      });
    expect(forgedSubmit.status).toBe(400);
    expect(forgedSubmit.body.error.code).toBe('VALIDATION_ERROR');

    const directPatchAttempt = await request(app)
      .patch(`/api/onboarding/${appB!.id}`)
      .set('Cookie', customerA.cookies)
      .set('X-CSRF-Token', customerA.csrfToken)
      .send({ city: 'HackedCity' });
    expect(directPatchAttempt.status).toBe(404);

    // Verify Customer B's data remained completely isolated and untouched
    const verifyB = await request(app)
      .get('/api/onboarding/me')
      .set('Cookie', customerB.cookies);
    expect(verifyB.status).toBe(200);
    expect(verifyB.body.application.city).toBe('Jaipur');
    expect(verifyB.body.application.submittedAt).toBeNull();
  });

  it('5. Customers cannot access any administrator onboarding review endpoints', async () => {
    const { app, store, registerCustomerSession } = buildOnboardingHarness();
    const customer = await registerCustomerSession('Customer User', 'cust@balancevault.test');
    const ownApp = await store.findByUserId(customer.user.id);

    expect(
      (
        await request(app)
          .get('/api/admin/onboarding/applications')
          .set('Cookie', customer.cookies)
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .get('/api/admin/onboarding')
          .set('Cookie', customer.cookies)
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .get(`/api/admin/onboarding/applications/${ownApp!.id}`)
          .set('Cookie', customer.cookies)
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .post(`/api/admin/onboarding/applications/${ownApp!.id}/approve`)
          .set('Cookie', customer.cookies)
          .set('X-CSRF-Token', customer.csrfToken)
          .send({})
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .post(`/api/admin/onboarding/applications/${ownApp!.id}/reject`)
          .set('Cookie', customer.cookies)
          .set('X-CSRF-Token', customer.csrfToken)
          .send({ reason: 'Customer self-reject attempt should be 403' })
      ).status,
    ).toBe(403);
  });

  it('6. Only authorized ADMIN and SUPER_ADMIN roles can list, inspect, and approve submitted applications without secret exposure', async () => {
    const { app, store, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();

    const customer = await registerCustomerSession('Priya Nair', 'priya@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'reviewer@balancevault.test',
      'Compliance Admin',
    );
    const superAdmin = await seedAndLoginStaff(
      UserRole.SUPER_ADMIN,
      'super@balancevault.test',
      'Super Admin',
    );
    const custApp = await store.findByUserId(customer.user.id);

    // Admin cannot approve an application before the customer has submitted it
    const approveUnsubmitted = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(approveUnsubmitted.status).toBe(409);
    expect(approveUnsubmitted.body.error.code).toBe('ONBOARDING_NOT_SUBMITTED');

    // Customer submits profile
    const submitRes = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(VALID_PROFILE);
    expect(submitRes.status).toBe(200);

    // Admin lists and retrieves application without exposing secrets or password hashes
    const listRes = await request(app)
      .get('/api/admin/onboarding/applications?status=PENDING&search=priya')
      .set('Cookie', admin.cookies);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].applicant.passwordHash).toBeUndefined();
    expect(JSON.stringify(listRes.body)).not.toContain('$argon2id$');

    const detailRes = await request(app)
      .get(`/api/admin/onboarding/applications/${custApp!.id}`)
      .set('Cookie', superAdmin.cookies);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.application.id).toBe(custApp!.id);
    expect(detailRes.body.application.applicant.passwordHash).toBeUndefined();

    // Admin approves submitted application
    const approveRes = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Synthetic identity checks passed' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.application.status).toBe(OnboardingStatus.APPROVED);
    expect(approveRes.body.application.reviewedByUserId).toBe(admin.user.id);
    expect(approveRes.body.application.reviewReason).toBe('Synthetic identity checks passed');
  });

  it('7. Invalid or missing application IDs return consistent safe errors without exposing other customers data', async () => {
    const { app, registerCustomerSession, seedAndLoginStaff } = buildOnboardingHarness();
    await registerCustomerSession('Victim User', 'victim@balancevault.test');
    const customer2 = await registerCustomerSession('Snooper User', 'snooper@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'admin-check@balancevault.test',
      'Admin Check',
    );

    const malformed = await request(app)
      .get('/api/admin/onboarding/applications/not-a-valid-uuid')
      .set('Cookie', admin.cookies);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(malformed.body)).not.toContain('victim@balancevault.test');

    const missingUuid = crypto.randomUUID();
    const missing = await request(app)
      .get(`/api/admin/onboarding/applications/${missingUuid}`)
      .set('Cookie', admin.cookies);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const approveMissing = await request(app)
      .post(`/api/admin/onboarding/applications/${missingUuid}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(approveMissing.status).toBe(404);
    expect(approveMissing.body.error.code).toBe('NOT_FOUND');

    // Customer probing malformed admin ID still gets 403 (role check before param parsing)
    const customerProbe = await request(app)
      .get('/api/admin/onboarding/applications/not-a-uuid')
      .set('Cookie', customer2.cookies);
    expect(customerProbe.status).toBe(403);
  });

  it('8. Rejected applications require explicit resubmission policy and can then be updated, resubmitted, and approved', async () => {
    const { app, store, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();
    const customer = await registerCustomerSession('Vikram Rao', 'vikram@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'reviewer2@balancevault.test',
      'Compliance Reviewer Two',
    );
    const custApp = await store.findByUserId(customer.user.id);

    // Submit then reject
    await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(VALID_PROFILE);

    const rejectRes = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Account purpose is too generic; please specify demo use case' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.application.status).toBe(OnboardingStatus.REJECTED);

    // Implicit PATCH /me without reopenForResubmission: true must fail with 409
    const implicitPatch = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ accountPurpose: 'Updated without explicit reopen flag' });
    expect(implicitPatch.status).toBe(409);
    expect(implicitPatch.body.error.code).toBe('EXPLICIT_RESUBMISSION_REQUIRED');

    // Implicit POST /me/submit without resubmit: true must fail with 409
    const implicitSubmit = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ accountPurpose: 'Updated without explicit resubmit flag' });
    expect(implicitSubmit.status).toBe(409);
    expect(implicitSubmit.body.error.code).toBe('EXPLICIT_RESUBMISSION_REQUIRED');

    // Path A: Reopen explicitly REJECTED -> DRAFT using reopenForResubmission alone, edit in DRAFT, then submit
    const reopenRes = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        reopenForResubmission: true,
      });
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.body.application.status).toBe(OnboardingStatus.DRAFT);
    expect(reopenRes.body.application.submittedAt).toBeNull();
    expect(reopenRes.body.application.reviewReason).toBe(
      'Account purpose is too generic; please specify demo use case',
    );

    const draftEditRes = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        accountPurpose: 'Household demo budgeting and synthetic salary split',
      });
    expect(draftEditRes.status).toBe(200);
    expect(draftEditRes.body.application.status).toBe(OnboardingStatus.DRAFT);

    const resubmitAfterReopen = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({});
    expect(resubmitAfterReopen.status).toBe(200);
    expect(resubmitAfterReopen.body.application.status).toBe(OnboardingStatus.PENDING);
    expect(resubmitAfterReopen.body.application.reviewReason).toBeNull();

    // Reject a second time, then test Path B: direct REJECTED -> PENDING with resubmit: true
    const rejectAgain = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Please also clarify your demo city before resubmitting' });
    expect(rejectAgain.status).toBe(200);

    const directResubmit = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        resubmit: true,
        city: 'Pune',
        accountPurpose: 'Clarified demo city and household savings simulation',
        acceptedSyntheticTerms: true,
      });
    expect(directResubmit.status).toBe(200);
    expect(directResubmit.body.application.status).toBe(OnboardingStatus.PENDING);
    expect(directResubmit.body.application.city).toBe('Pune');
    expect(directResubmit.body.application.reviewReason).toBeNull();

    const finalApprove = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(finalApprove.status).toBe(200);
    expect(finalApprove.body.application.status).toBe(OnboardingStatus.APPROVED);
  });

  it('9. Approved applications cannot be modified or resubmitted by customer or transitioned by admin', async () => {
    const { app, store, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();
    const customer = await registerCustomerSession('Approved User', 'approved@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'admin-approved@balancevault.test',
      'Admin Approver',
    );
    const custApp = await store.findByUserId(customer.user.id);

    await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(VALID_PROFILE);

    const approvedRes = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(approvedRes.status).toBe(200);

    const patchApproved = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ city: 'Delhi' });
    expect(patchApproved.status).toBe(409);
    expect(patchApproved.body.error.code).toBe('ONBOARDING_ALREADY_APPROVED');

    const reopenApproved = await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ reopenForResubmission: true, city: 'Delhi' });
    expect(reopenApproved.status).toBe(409);
    expect(reopenApproved.body.error.code).toBe('ONBOARDING_ALREADY_APPROVED');

    const submitApproved = await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ resubmit: true, ...VALID_PROFILE });
    expect(submitApproved.status).toBe(409);
    expect(submitApproved.body.error.code).toBe('ONBOARDING_ALREADY_APPROVED');

    const rejectAfterApprove = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Attempting to reject an already approved application' });
    expect(rejectAfterApprove.status).toBe(409);
    expect(rejectAfterApprove.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('10. Admin rejection requires a valid non-trivial reason', async () => {
    const { app, store, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();
    const customer = await registerCustomerSession('Reject Reason User', 'reason@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'admin-reason@balancevault.test',
      'Admin Reason',
    );
    const custApp = await store.findByUserId(customer.user.id);

    await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(VALID_PROFILE);

    const emptyBodyReject = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(emptyBodyReject.status).toBe(400);
    expect(emptyBodyReject.body.error.code).toBe('VALIDATION_ERROR');

    const whitespaceReject = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: '         ' });
    expect(whitespaceReject.status).toBe(400);
    expect(whitespaceReject.body.error.code).toBe('VALIDATION_ERROR');

    const shortReject = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'too short' });
    expect(shortReject.status).toBe(400);
    expect(shortReject.body.error.code).toBe('VALIDATION_ERROR');

    const validReject = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Synthetic city and purpose could not be verified' });
    expect(validReject.status).toBe(200);
    expect(validReject.body.application.status).toBe(OnboardingStatus.REJECTED);
    expect(validReject.body.application.reviewReason).toBe(
      'Synthetic city and purpose could not be verified',
    );
  });

  it('11. Concurrent and repeated reviews cannot create conflicting state changes or duplicate audit events', async () => {
    const { app, store, env, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();
    const customer = await registerCustomerSession('Race User', 'race@balancevault.test');
    const admin1 = await seedAndLoginStaff(
      UserRole.ADMIN,
      'admin1@balancevault.test',
      'Admin One',
    );
    const admin2 = await seedAndLoginStaff(
      UserRole.ADMIN,
      'admin2@balancevault.test',
      'Admin Two',
    );
    const custApp = await store.findByUserId(customer.user.id);

    await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(VALID_PROFILE);

    // Concurrent HTTP approve vs reject
    const [resApprove, resReject] = await Promise.all([
      request(app)
        .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
        .set('Cookie', admin1.cookies)
        .set('X-CSRF-Token', admin1.csrfToken)
        .send({ reason: 'Concurrent approve attempt' }),
      request(app)
        .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
        .set('Cookie', admin2.cookies)
        .set('X-CSRF-Token', admin2.csrfToken)
        .send({ reason: 'Concurrent reject attempt with full reason' }),
    ]);

    const statuses = [resApprove.status, resReject.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const reviewAuditEvents = store.auditEvents.filter(
      (event) =>
        event.entityId === custApp!.id &&
        (event.action === 'ONBOARDING_APPROVED' || event.action === 'ONBOARDING_REJECTED'),
    );
    expect(reviewAuditEvents).toHaveLength(1);

    // Repeated approve after completion must also return 409
    const repeatApprove = await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
      .set('Cookie', admin2.cookies)
      .set('X-CSRF-Token', admin2.csrfToken)
      .send({});
    expect(repeatApprove.status).toBe(409);

    // Simulate PostgreSQL READ COMMITTED stale findById read where conditional UPDATE matches only once
    let currentState: OnboardingApplicationRecord = {
      ...(await store.findById(custApp!.id))!,
      status: OnboardingStatus.PENDING,
      submittedAt: new Date(),
      acceptedSyntheticTerms: true,
    };
    const raceRepo: OnboardingRepository = {
      async runInTransaction<T>(fn: (tx: OnboardingTxContext) => Promise<T>): Promise<T> {
        const snapshot = structuredClone(currentState);
        const tx: OnboardingTxContext = {
          findByUserId: async () => structuredClone(currentState),
          // Intentionally returns stale PENDING before lock acquisition
          findById: async () => snapshot,
          updateByIdIfStatus: async (_id, expectedStatuses, data) => {
            if (!expectedStatuses.includes(currentState.status)) {
              return null;
            }
            currentState = {
              ...currentState,
              status: data.status ?? currentState.status,
              reviewedAt: data.reviewedAt ?? currentState.reviewedAt,
              reviewedByUserId: data.reviewedByUserId ?? currentState.reviewedByUserId,
              reviewReason: data.reviewReason ?? currentState.reviewReason,
            };
            return structuredClone(currentState);
          },
          createAuditEvent: async (input) => store.create(input),
        };
        return fn(tx);
      },
      findByUserId: async () => currentState,
      findById: async () => currentState,
      listApplications: async () => ({ items: [currentState], total: 1 }),
    };

    const raceService = new OnboardingService(raceRepo, env);
    const actor = {
      sessionId: crypto.randomUUID(),
      userId: admin1.user.id,
      email: admin1.user.email,
      fullName: admin1.user.fullName,
      role: UserRole.ADMIN,
      status: admin1.user.status,
      onboardingStatus: null,
    };

    const staleRace = await Promise.allSettled([
      raceService.approveApplication(actor, currentState.id, 'First review', {
        requestId: 'req-1',
      }),
      raceService.rejectApplication(
        actor,
        currentState.id,
        'Second conflicting review attempt',
        { requestId: 'req-2' },
      ),
    ]);

    expect(staleRace.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(staleRace.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('12. Audit events are recorded for onboarding lifecycle transitions and expose no modification or deletion endpoints', async () => {
    const { app, store, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();
    const customer = await registerCustomerSession('Audit User', 'audit-onb@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'audit-admin@balancevault.test',
      'Audit Admin',
    );
    const custApp = await store.findByUserId(customer.user.id);

    await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ city: 'Hyderabad' });

    await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(VALID_PROFILE);

    await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/reject`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Audit trail verification rejection step' });

    await request(app)
      .patch('/api/onboarding/me')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({ reopenForResubmission: true, city: 'Chennai' });

    await request(app)
      .post('/api/onboarding/me/submit')
      .set('Cookie', customer.cookies)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({});

    await request(app)
      .post(`/api/admin/onboarding/applications/${custApp!.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Audit trail verification approval step' });

    const auditListRes = await request(app)
      .get('/api/admin/audit-events?entityType=OnboardingApplication&pageSize=20')
      .set('Cookie', admin.cookies);
    expect(auditListRes.status).toBe(200);

    const actions = (auditListRes.body.items as Array<{ action: string }>).map(
      (item) => item.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'ONBOARDING_PROFILE_UPDATED',
        'ONBOARDING_SUBMITTED',
        'ONBOARDING_REJECTED',
        'ONBOARDING_RESUBMISSION_DRAFTED',
        'ONBOARDING_RESUBMITTED',
        'ONBOARDING_APPROVED',
      ]),
    );

    const sampleAuditId = auditListRes.body.items[0].id as string;

    // No audit event update/delete routes exist
    expect(
      (
        await request(app)
          .patch(`/api/admin/audit-events/${sampleAuditId}`)
          .set('Cookie', admin.cookies)
          .set('X-CSRF-Token', admin.csrfToken)
          .send({ reason: 'Tampered reason' })
      ).status,
    ).toBe(404);

    expect(
      (
        await request(app)
          .delete(`/api/admin/audit-events/${sampleAuditId}`)
          .set('Cookie', admin.cookies)
          .set('X-CSRF-Token', admin.csrfToken)
      ).status,
    ).toBe(404);
  });

  it('13. Onboarding state transitions roll back atomically if AuditEvent creation fails', async () => {
    const { store, env, registerCustomerSession, seedAndLoginStaff } =
      buildOnboardingHarness();

    const failingStore = Object.create(store) as InMemoryAuthAuditBootstrapStore;
    let forceAuditFailure = false;
    failingStore.runInTransaction = async <T>(
      fn: (tx: OnboardingTxContext) => Promise<T>,
    ): Promise<T> => {
      return store.runInTransaction(async (tx: OnboardingTxContext) => {
        return fn({
          ...tx,
          createAuditEvent: async (input) => {
            if (forceAuditFailure) {
              throw new Error('Simulated AuditEvent write failure');
            }
            return tx.createAuditEvent(input);
          },
        });
      });
    };

    const isolatedService = new OnboardingService(failingStore, env);
    const customer = await registerCustomerSession('Rollback User', 'rollback@balancevault.test');
    const admin = await seedAndLoginStaff(
      UserRole.ADMIN,
      'rollback-admin@balancevault.test',
      'Rollback Admin',
    );
    const custApp = await store.findByUserId(customer.user.id);
    expect(custApp).toBeTruthy();

    const customerActor = {
      sessionId: crypto.randomUUID(),
      userId: customer.user.id,
      email: customer.user.email,
      fullName: 'Rollback User',
      role: UserRole.CUSTOMER,
      status: 'ACTIVE' as const,
      onboardingStatus: OnboardingStatus.PENDING,
    };

    // Simulate audit write failure during submit -> application must remain unsubmitted
    forceAuditFailure = true;
    await expect(
      isolatedService.submitOwnApplication(customerActor, VALID_PROFILE, {
        requestId: 'req-rollback-submit',
      }),
    ).rejects.toThrow('Simulated AuditEvent write failure');

    const afterSubmitFailure = await store.findById(custApp!.id);
    expect(afterSubmitFailure?.status).toBe(OnboardingStatus.PENDING);
    expect(afterSubmitFailure?.submittedAt).toBeNull();
    expect(afterSubmitFailure?.city).toBeNull();

    // Succeed submit, then simulate audit failure on admin approve -> stays PENDING
    forceAuditFailure = false;
    await isolatedService.submitOwnApplication(customerActor, VALID_PROFILE, {
      requestId: 'req-valid-submit',
    });

    const adminActor = {
      sessionId: crypto.randomUUID(),
      userId: admin.user.id,
      email: admin.user.email,
      fullName: admin.user.fullName,
      role: UserRole.ADMIN,
      status: admin.user.status,
      onboardingStatus: null,
    };

    forceAuditFailure = true;
    await expect(
      isolatedService.approveApplication(adminActor, custApp!.id, 'Should roll back', {
        requestId: 'req-rollback-approve',
      }),
    ).rejects.toThrow('Simulated AuditEvent write failure');

    const afterApproveFailure = await store.findById(custApp!.id);
    expect(afterApproveFailure?.status).toBe(OnboardingStatus.PENDING);
    expect(afterApproveFailure?.reviewedAt).toBeNull();
    expect(afterApproveFailure?.reviewedByUserId).toBeNull();
  });
});
