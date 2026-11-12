import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OnboardingStatus, UserRole } from '@prisma/client';
import dotenv from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/config/logger.js';
import { checkDatabaseHealth, createPrismaClient } from '../../src/config/prisma.js';
import { checkRedisHealth, createRedisClient } from '../../src/config/redis.js';
import { PrismaAuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { hashPassword } from '../../src/modules/auth/auth.crypto.js';
import { PrismaAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { resolveRuntimeDatabaseUrl } from '../../src/modules/bootstrap/bootstrap.service.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import { PrismaOnboardingRepository } from '../../src/modules/onboarding/onboarding.repository.js';
import { OnboardingService } from '../../src/modules/onboarding/onboarding.service.js';
import {
  buildIntegrationDatabaseUrl,
  warmupLiveDependencies,
} from '../helpers/integrationDb.js';
import { IsolatedIntegrationRateLimitStore } from '../helpers/isolatedRateLimitStore.js';

const rootEnv = resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}

function extractCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

describe('Phase 3 Onboarding PostgreSQL Integration Tests', () => {
  if (process.env.NODE_ENV === 'production') {
    it('refuses to run destructive integration tests against NODE_ENV=production', () => {
      throw new Error('Integration tests must never run when NODE_ENV=production.');
    });
    return;
  }

  const hasRequiredEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

  if (!hasRequiredEnv) {
    it('requires live DATABASE_URL and REDIS_URL environment variables', () => {
      throw new Error(
        'Integration tests blocked: DATABASE_URL and REDIS_URL must be configured in .env or process environment.',
      );
    });
    return;
  }

  const env = parseEnv(process.env);
  const logger = createLogger('silent');
  const runtimeConn = resolveRuntimeDatabaseUrl({
    DATABASE_URL: env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
  });
  const prisma = createPrismaClient(buildIntegrationDatabaseUrl(runtimeConn.url));
  const redis = createRedisClient(env.REDIS_URL, logger);

  beforeAll(async () => {
    await warmupLiveDependencies(prisma, redis);
  });

  afterAll(async () => {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  });

  it('verifies full customer onboarding, both rejected resubmission paths, concurrent admin reviews, and atomic audit triggers in PostgreSQL', async () => {
    const authService = new AuthService(new PrismaAuthRepository(prisma), env);
    const auditService = new AuditService(new PrismaAuditRepository(prisma));
    const onboardingService = new OnboardingService(
      new PrismaOnboardingRepository(prisma),
      env,
    );

    const rateLimitStore = new IsolatedIntegrationRateLimitStore(redis, 'onboarding');

    const app = createApp({
      env,
      logger,
      healthService: new HealthService({
        checkDatabase: () => checkDatabaseHealth(prisma),
        checkRedis: () => checkRedisHealth(redis),
      }),
      authService,
      auditService,
      onboardingService,
      rateLimitStore,
    });

    try {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const adminEmail = `int-admin-${suffix}@balancevault.test`;
      const adminPassword = 'IntegrationAdmin#2026';
      const adminHash = await hashPassword(adminPassword);
      await prisma.user.create({
        data: {
          email: adminEmail,
          fullName: 'Integration Admin',
          passwordHash: adminHash,
          role: UserRole.ADMIN,
        },
      });

      const adminLogin = await request(app).post('/api/auth/login').send({
        email: adminEmail,
        password: adminPassword,
      });
      expect(adminLogin.status).toBe(200);
      const adminCookies = extractCookies(adminLogin);
      const adminCsrf = adminLogin.body.csrfToken as string;

      // 1. Newly registered customer starts PENDING (submittedAt: null) and can update & submit
      const custEmail = `int-onb-${suffix}@balancevault.test`;
      const custReg = await request(app).post('/api/auth/register').send({
        fullName: 'Integration Onboarding Customer',
        email: custEmail,
        password: 'IntegrationCustomer#2026',
      });
      expect(custReg.status).toBe(201);
      const custCookies = extractCookies(custReg);
      const custCsrf = custReg.body.csrfToken as string;

      const patchRes = await request(app)
        .patch('/api/onboarding/me')
        .set('Cookie', custCookies)
        .set('X-CSRF-Token', custCsrf)
        .send({ city: 'Bengaluru', country: 'India' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.application.submittedAt).toBeNull();
      const appId = patchRes.body.application.id as string;

      const submitRes = await request(app)
        .post('/api/onboarding/me/submit')
        .set('Cookie', custCookies)
        .set('X-CSRF-Token', custCsrf)
        .send({
          contactReference: '+91-9876501234',
          accountPurpose: 'PostgreSQL transactional onboarding verification',
          acceptedSyntheticTerms: true,
        });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.application.status).toBe(OnboardingStatus.PENDING);

      // 2. Reject -> Path A (reopenForResubmission: true -> DRAFT -> PATCH -> submit)
      const reject1 = await request(app)
        .post(`/api/admin/onboarding/applications/${appId}/reject`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'First live DB rejection to test reopen path' });
      expect(reject1.status).toBe(200);

      const reopenRes = await request(app)
        .patch('/api/onboarding/me')
        .set('Cookie', custCookies)
        .set('X-CSRF-Token', custCsrf)
        .send({ reopenForResubmission: true });
      expect(reopenRes.status).toBe(200);
      expect(reopenRes.body.application.status).toBe(OnboardingStatus.DRAFT);

      const resubmitA = await request(app)
        .post('/api/onboarding/me/submit')
        .set('Cookie', custCookies)
        .set('X-CSRF-Token', custCsrf)
        .send({ accountPurpose: 'Updated purpose after reopening to DRAFT' });
      expect(resubmitA.status).toBe(200);
      expect(resubmitA.body.application.status).toBe(OnboardingStatus.PENDING);

      // 3. Reject -> Path B (direct resubmit: true on POST /me/submit)
      const reject2 = await request(app)
        .post(`/api/admin/onboarding/applications/${appId}/reject`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Second live DB rejection to test direct resubmit' });
      expect(reject2.status).toBe(200);

      const resubmitB = await request(app)
        .post('/api/onboarding/me/submit')
        .set('Cookie', custCookies)
        .set('X-CSRF-Token', custCsrf)
        .send({ resubmit: true, city: 'Pune' });
      expect(resubmitB.status).toBe(200);
      expect(resubmitB.body.application.status).toBe(OnboardingStatus.PENDING);

      // 4. Concurrent approve vs reject against PostgreSQL row lock
      const [raceApprove, raceReject] = await Promise.all([
        request(app)
          .post(`/api/admin/onboarding/applications/${appId}/approve`)
          .set('Cookie', adminCookies)
          .set('X-CSRF-Token', adminCsrf)
          .send({ reason: 'Concurrent live DB approve winner' }),
        request(app)
          .post(`/api/admin/onboarding/applications/${appId}/reject`)
          .set('Cookie', adminCookies)
          .set('X-CSRF-Token', adminCsrf)
          .send({ reason: 'Concurrent live DB reject attempt reason' }),
      ]);

      expect([raceApprove.status, raceReject.status].sort((a, b) => a - b)).toEqual([200, 409]);

      const auditRows = await prisma.auditEvent.findMany({
        where: { entityType: 'OnboardingApplication', entityId: appId },
      });
      const actions = auditRows.map((row) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'ONBOARDING_PROFILE_UPDATED',
          'ONBOARDING_SUBMITTED',
          'ONBOARDING_REJECTED',
          'ONBOARDING_RESUBMISSION_DRAFTED',
          'ONBOARDING_RESUBMITTED',
        ]),
      );

      // 5. Append-only DB trigger blocks AuditEvent UPDATE and DELETE
      const sampleAudit = auditRows[0]!;
      await expect(
        prisma.$executeRaw`UPDATE "AuditEvent" SET "reason" = 'tampered' WHERE "id" = ${sampleAudit.id}::uuid`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${sampleAudit.id}::uuid`,
      ).rejects.toThrow();
    } finally {
      await rateLimitStore.cleanup().catch(() => {});
    }
  });
});
