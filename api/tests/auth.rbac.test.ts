import { OnboardingStatus, UserRole, UserStatus } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { hashPassword } from '../src/modules/auth/auth.crypto.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { HealthService } from '../src/modules/health/health.service.js';
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

function buildTestHarness(options?: {
  nowProvider?: () => Date;
  registerMax?: number;
  loginMax?: number;
}) {
  let currentNow = new Date('2026-11-11T10:00:00.000Z');
  const nowProvider = options?.nowProvider ?? (() => currentNow);

  const env = makeTestEnv();
  const store = new InMemoryAuthAuditBootstrapStore(nowProvider);
  const rateLimitStore = new InMemoryRateLimitStore();
  const auditService = new AuditService(store);
  const authService = new AuthService(store, env, nowProvider);

  const app = createApp({
    env,
    logger: createLogger('silent'),
    healthService: new HealthService({
      checkDatabase: async () => 'ok',
      checkRedis: async () => 'ok',
    }),
    authService,
    auditService,
    rateLimitStore,
    rateLimitConfig: {
      registerMax: options?.registerMax ?? 50,
      loginMax: options?.loginMax ?? 50,
      windowMs: 60_000,
    },
  });

  return {
    app,
    env,
    store,
    authService,
    advanceMinutes(minutes: number) {
      currentNow = new Date(currentNow.getTime() + minutes * 60_000);
    },
  };
}

function extractCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

describe('Phase 2 Auth, Sessions, CSRF, and RBAC', () => {
  it('1. Customer registration always assigns CUSTOMER and creates PENDING onboarding', async () => {
    const { app, store } = buildTestHarness();

    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Ananya Sharma',
      email: '  Ananya.Sharma@BalanceVault.TEST ',
      password: 'StrongUser#2026',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe(UserRole.CUSTOMER);
    expect(res.body.user.email).toBe('ananya.sharma@balancevault.test');
    expect(res.body.user.onboardingStatus).toBe(OnboardingStatus.PENDING);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.sessionToken).toBeUndefined();
    expect(typeof res.body.csrfToken).toBe('string');

    const cookies = extractCookies(res);
    expect(cookies.some((c) => c.includes('bv_sid=') && c.includes('HttpOnly'))).toBe(
      true,
    );

    const dbUser = await store.findUserByEmail('ananya.sharma@balancevault.test');
    expect(dbUser?.role).toBe(UserRole.CUSTOMER);
    expect(dbUser?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(dbUser?.passwordHash).not.toBe('StrongUser#2026');
  });

  it('2. Registration cannot create ADMIN', async () => {
    const { app, store } = buildTestHarness();

    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Attacker Admin',
      email: 'attacker-admin@balancevault.test',
      password: 'StrongUser#2026',
      role: 'ADMIN',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await store.findUserByEmail('attacker-admin@balancevault.test')).toBeNull();
  });

  it('3. Registration cannot create SUPER_ADMIN', async () => {
    const { app, store } = buildTestHarness();

    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Attacker SuperAdmin',
      email: 'attacker-super@balancevault.test',
      password: 'StrongUser#2026',
      role: 'SUPER_ADMIN',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await store.findUserByEmail('attacker-super@balancevault.test')).toBeNull();
  });

  it('4. Duplicate normalized email is rejected with 409 Conflict', async () => {
    const { app } = buildTestHarness();

    const first = await request(app).post('/api/auth/register').send({
      fullName: 'Rohan Verma',
      email: 'rohan@balancevault.test',
      password: 'StrongUser#2026',
    });
    expect(first.status).toBe(201);

    const duplicate = await request(app).post('/api/auth/register').send({
      fullName: 'Rohan Duplicate',
      email: '  ROHAN@BalanceVault.Test ',
      password: 'StrongUser#2026',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('5 & 6. Valid login succeeds with rotated opaque cookie; invalid login fails safely with generic error', async () => {
    const { app, store } = buildTestHarness();
    const passwordHash = await hashPassword('ValidPass#2026');
    store.seedUser({
      email: 'alice@balancevault.test',
      fullName: 'Alice',
      passwordHash,
      role: UserRole.CUSTOMER,
    });

    const badPass = await request(app).post('/api/auth/login').send({
      email: 'alice@balancevault.test',
      password: 'WrongPassword#2026',
    });
    expect(badPass.status).toBe(401);
    expect(badPass.body.error.message).toBe('Invalid email or password');

    const badEmail = await request(app).post('/api/auth/login').send({
      email: 'nobody@balancevault.test',
      password: 'WrongPassword#2026',
    });
    expect(badEmail.status).toBe(401);
    expect(badEmail.body.error.message).toBe('Invalid email or password');

    const login1 = await request(app).post('/api/auth/login').send({
      email: '  ALICE@balancevault.test ',
      password: 'ValidPass#2026',
    });
    expect(login1.status).toBe(200);
    expect(login1.body.user.email).toBe('alice@balancevault.test');
    expect(login1.body.user.passwordHash).toBeUndefined();
    expect(login1.body.sessionToken).toBeUndefined();
    expect(typeof login1.body.csrfToken).toBe('string');

    const cookies1 = extractCookies(login1);
    expect(cookies1.some((c) => c.includes('bv_sid=') && c.includes('HttpOnly'))).toBe(
      true,
    );

    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookies1);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe('alice@balancevault.test');

    // Re-login rotates session identifier and revokes prior cookie
    const login2 = await request(app)
      .post('/api/auth/login')
      .set('Cookie', cookies1)
      .send({
        email: 'alice@balancevault.test',
        password: 'ValidPass#2026',
      });
    expect(login2.status).toBe(200);
    const cookies2 = extractCookies(login2);

    const oldCookieCheck = await request(app).get('/api/auth/me').set('Cookie', cookies1);
    expect(oldCookieCheck.status).toBe(401);

    const newCookieCheck = await request(app).get('/api/auth/me').set('Cookie', cookies2);
    expect(newCookieCheck.status).toBe(200);
  });

  it('7 & 8. Logout revokes the session and revoked sessions cannot authenticate', async () => {
    const { app } = buildTestHarness();

    const reg = await request(app).post('/api/auth/register').send({
      fullName: 'Priya Nair',
      email: 'priya@balancevault.test',
      password: 'StrongUser#2026',
    });
    const cookies = extractCookies(reg);
    const csrfToken = reg.body.csrfToken as string;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.loggedOut).toBe(true);

    const meAfterLogout = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meAfterLogout.status).toBe(401);
  });

  it('9. Disabled and locked users cannot log in and existing sessions fail immediately', async () => {
    const { app, store } = buildTestHarness();
    const passwordHash = await hashPassword('StrongUser#2026');

    const disabledUser = store.seedUser({
      email: 'disabled@balancevault.test',
      fullName: 'Disabled User',
      passwordHash,
      role: UserRole.CUSTOMER,
      status: UserStatus.DISABLED,
    });

    const loginDisabled = await request(app).post('/api/auth/login').send({
      email: disabledUser.email,
      password: 'StrongUser#2026',
    });
    expect(loginDisabled.status).toBe(401);
    expect(loginDisabled.body.error.message).toBe('Invalid email or password');

    const activeUser = store.seedUser({
      email: 'later-disabled@balancevault.test',
      fullName: 'Later Disabled',
      passwordHash,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
    });

    const loginActive = await request(app).post('/api/auth/login').send({
      email: activeUser.email,
      password: 'StrongUser#2026',
    });
    expect(loginActive.status).toBe(200);
    const cookies = extractCookies(loginActive);

    // Disable user on server while session cookie still exists
    const storedUser = store.users.get(activeUser.id);
    if (storedUser) storedUser.status = UserStatus.DISABLED;

    const meAfterDisable = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meAfterDisable.status).toBe(401);
  });

  it('10. Idle and absolute expired sessions cannot authenticate', async () => {
    const harness = buildTestHarness();
    const reg = await request(harness.app).post('/api/auth/register').send({
      fullName: 'Idle Tester',
      email: 'idle@balancevault.test',
      password: 'StrongUser#2026',
    });
    const cookies = extractCookies(reg);

    // Advance 31 minutes past SESSION_IDLE_MINUTES (30)
    harness.advanceMinutes(31);
    const afterIdle = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', cookies);
    expect(afterIdle.status).toBe(401);

    // Fresh login then keep refreshing until past absolute SESSION_TTL_HOURS (12h)
    const login2 = await request(harness.app).post('/api/auth/login').send({
      email: 'idle@balancevault.test',
      password: 'StrongUser#2026',
    });
    const cookies2 = extractCookies(login2);

    // Advance in 20m increments for 12.5 hours, touching lastSeenAt until absolute TTL expires
    for (let i = 0; i < 35; i += 1) {
      harness.advanceMinutes(20);
      const ping = await request(harness.app)
        .get('/api/auth/me')
        .set('Cookie', cookies2);
      expect(ping.status).toBe(200);
    }

    harness.advanceMinutes(25); // Total > 12 hours
    const afterAbsolute = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', cookies2);
    expect(afterAbsolute.status).toBe(401);
  });

  it('11 & 12. Customer cannot access admin endpoints or modify their own/others role', async () => {
    const { app, store } = buildTestHarness();
    const customerReg = await request(app).post('/api/auth/register').send({
      fullName: 'Customer One',
      email: 'customer1@balancevault.test',
      password: 'StrongUser#2026',
    });
    const customerCookies = extractCookies(customerReg);
    const customerCsrf = customerReg.body.csrfToken as string;
    const customerId = customerReg.body.user.id as string;

    // Unauthenticated -> 401
    expect((await request(app).get('/api/admin/audit-events')).status).toBe(401);

    // Customer -> 403 Forbidden
    const adminAuditRes = await request(app)
      .get('/api/admin/audit-events')
      .set('Cookie', customerCookies);
    expect(adminAuditRes.status).toBe(403);

    const adminUsersRes = await request(app)
      .get('/api/admin/users')
      .set('Cookie', customerCookies);
    expect(adminUsersRes.status).toBe(403);

    const selfElevateRes = await request(app)
      .patch(`/api/admin/users/${customerId}/role`)
      .set('Cookie', customerCookies)
      .set('X-CSRF-Token', customerCsrf)
      .send({ role: 'SUPER_ADMIN', reason: 'Self promotion attempt' });
    expect(selfElevateRes.status).toBe(403);

    // Regular ADMIN also cannot change roles (SUPER_ADMIN only)
    const adminHash = await hashPassword('AdminPass#2026');
    store.seedUser({
      email: 'admin@balancevault.test',
      fullName: 'Regular Admin',
      passwordHash: adminHash,
      role: UserRole.ADMIN,
    });
    const adminLogin = await request(app).post('/api/auth/login').send({
      email: 'admin@balancevault.test',
      password: 'AdminPass#2026',
    });
    const adminCookies = extractCookies(adminLogin);
    const adminCsrf = adminLogin.body.csrfToken as string;

    const adminAuditOk = await request(app)
      .get('/api/admin/audit-events')
      .set('Cookie', adminCookies);
    expect(adminAuditOk.status).toBe(200);

    const adminChangeRole = await request(app)
      .patch(`/api/admin/users/${customerId}/role`)
      .set('Cookie', adminCookies)
      .set('X-CSRF-Token', adminCsrf)
      .send({ role: 'ADMIN', reason: 'Unauthorized role escalation' });
    expect(adminChangeRole.status).toBe(403);

    // SUPER_ADMIN can change role, which audits and revokes target sessions
    const superHash = await hashPassword('SuperPass#2026');
    store.seedUser({
      email: 'super@balancevault.test',
      fullName: 'Super Admin',
      passwordHash: superHash,
      role: UserRole.SUPER_ADMIN,
    });
    const superLogin = await request(app).post('/api/auth/login').send({
      email: 'super@balancevault.test',
      password: 'SuperPass#2026',
    });
    const superCookies = extractCookies(superLogin);
    const superCsrf = superLogin.body.csrfToken as string;

    const superRoleRes = await request(app)
      .patch(`/api/admin/users/${customerId}/role`)
      .set('Cookie', superCookies)
      .set('X-CSRF-Token', superCsrf)
      .send({ role: 'ADMIN', reason: 'Promoted for hackathon review' });
    expect(superRoleRes.status).toBe(200);
    expect(superRoleRes.body.user.role).toBe(UserRole.ADMIN);

    // Target user's previous session was revoked on role change
    const customerOldSession = await request(app)
      .get('/api/auth/me')
      .set('Cookie', customerCookies);
    expect(customerOldSession.status).toBe(401);
  });

  it('16. CSRF protection rejects missing/invalid/cross-session CSRF tokens and preserves auth->CSRF ordering', async () => {
    const { app } = buildTestHarness();

    // Unauthenticated logout must return 401 (auth runs BEFORE CSRF)
    const unauthLogout = await request(app).post('/api/auth/logout');
    expect(unauthLogout.status).toBe(401);

    const userA = await request(app).post('/api/auth/register').send({
      fullName: 'User A',
      email: 'usera@balancevault.test',
      password: 'StrongUser#2026',
    });
    const cookiesA = extractCookies(userA);
    const csrfA = userA.body.csrfToken as string;

    const userB = await request(app).post('/api/auth/register').send({
      fullName: 'User B',
      email: 'userb@balancevault.test',
      password: 'StrongUser#2026',
    });
    const csrfB = userB.body.csrfToken as string;

    // Missing CSRF header -> 403 CSRF_INVALID
    const missingCsrf = await request(app).post('/api/auth/logout').set('Cookie', cookiesA);
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe('CSRF_INVALID');

    // Invalid CSRF header -> 403 CSRF_INVALID
    const invalidCsrf = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', 'invalid.token');
    expect(invalidCsrf.status).toBe(403);
    expect(invalidCsrf.body.error.code).toBe('CSRF_INVALID');

    // Cross-session CSRF token -> 403 CSRF_INVALID
    const crossSessionCsrf = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', csrfB);
    expect(crossSessionCsrf.status).toBe(403);
    expect(crossSessionCsrf.body.error.code).toBe('CSRF_INVALID');

    // Untrusted Origin -> 403 CSRF_INVALID
    const badOrigin = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', csrfA)
      .set('Origin', 'https://attacker.example.test');
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('CSRF_INVALID');

    // Valid CSRF + matching Origin -> 200
    const validLogout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookiesA)
      .set('X-CSRF-Token', csrfA)
      .set('Origin', 'http://localhost:5173');
    expect(validLogout.status).toBe(200);
  });

  it('Enforces Redis rate limiting on /api/auth/login', async () => {
    const { app } = buildTestHarness({ loginMax: 2 });

    expect(
      (
        await request(app).post('/api/auth/login').send({
          email: 'rate@balancevault.test',
          password: 'Password#2026',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app).post('/api/auth/login').send({
          email: 'rate@balancevault.test',
          password: 'Password#2026',
        })
      ).status,
    ).toBe(401);

    const third = await request(app).post('/api/auth/login').send({
      email: 'rate@balancevault.test',
      password: 'Password#2026',
    });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('supports admin user search, user detail, date-filtered audits, and status governance', async () => {
    const harness = buildTestHarness();
    const { app, store } = harness;
    const passwordHash = await hashPassword('StrongUser#2026');

    const superUser = store.seedUser({
      email: 'root-super@balancevault.test',
      fullName: 'Root Super',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    const adminUser = store.seedUser({
      email: 'ops-admin@balancevault.test',
      fullName: 'Ops Admin',
      passwordHash,
      role: UserRole.ADMIN,
    });
    const alice = store.seedUser({
      email: 'alice.searchable@balancevault.test',
      fullName: 'Alice Searchable',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: alice.email,
      password: 'StrongUser#2026',
    });
    const aliceCookies = extractCookies(aliceLogin);

    const adminLogin = await request(app).post('/api/auth/login').send({
      email: adminUser.email,
      password: 'StrongUser#2026',
    });
    const adminCookies = extractCookies(adminLogin);
    const adminCsrf = adminLogin.body.csrfToken as string;

    const superLogin = await request(app).post('/api/auth/login').send({
      email: superUser.email,
      password: 'StrongUser#2026',
    });
    const superCookies = extractCookies(superLogin);
    const superCsrf = superLogin.body.csrfToken as string;

    // Search + role/status filters on /api/admin/users
    const searchRes = await request(app)
      .get('/api/admin/users?search=Searchable&role=CUSTOMER&status=ACTIVE')
      .set('Cookie', adminCookies);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.total).toBe(1);
    expect(searchRes.body.items[0].email).toBe(alice.email);

    // Detail endpoint excludes passwordHash
    const detailRes = await request(app)
      .get(`/api/admin/users/${alice.id}`)
      .set('Cookie', adminCookies);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.user.email).toBe(alice.email);
    expect(detailRes.body.user.accountCount).toBe(0);
    expect(detailRes.body.user.passwordHash).toBeUndefined();

    // ADMIN cannot disable another ADMIN or SUPER_ADMIN
    const forbiddenStatusRes = await request(app)
      .patch(`/api/admin/users/${superUser.id}/status`)
      .set('Cookie', adminCookies)
      .set('X-CSRF-Token', adminCsrf)
      .send({ status: 'DISABLED', reason: 'Attempt to disable super admin' });
    expect(forbiddenStatusRes.status).toBe(403);

    // ADMIN can disable CUSTOMER, revoking existing session immediately and auditing
    harness.advanceMinutes(10);
    const disableCustomerRes = await request(app)
      .patch(`/api/admin/users/${alice.id}/status`)
      .set('Cookie', adminCookies)
      .set('X-CSRF-Token', adminCsrf)
      .send({ status: 'DISABLED', reason: 'Synthetic compliance suspension test' });
    expect(disableCustomerRes.status).toBe(200);
    expect(disableCustomerRes.body.user.status).toBe('DISABLED');

    const aliceAfterDisable = await request(app)
      .get('/api/auth/me')
      .set('Cookie', aliceCookies);
    expect(aliceAfterDisable.status).toBe(401);

    // Re-enable Alice
    const enableCustomerRes = await request(app)
      .patch(`/api/admin/users/${alice.id}/status`)
      .set('Cookie', adminCookies)
      .set('X-CSRF-Token', adminCsrf)
      .send({ status: 'ACTIVE', reason: 'Reactivated after verification' });
    expect(enableCustomerRes.status).toBe(200);

    // SUPER_ADMIN cannot disable self or last active SUPER_ADMIN
    const selfDisable = await request(app)
      .patch(`/api/admin/users/${superUser.id}/status`)
      .set('Cookie', superCookies)
      .set('X-CSRF-Token', superCsrf)
      .send({ status: 'DISABLED', reason: 'Self disable check' });
    expect(selfDisable.status).toBe(409);
    expect(selfDisable.body.error.code).toBe('SELF_STATUS_CHANGE_FORBIDDEN');

    // SUPER_ADMIN can lock an ADMIN user
    const lockAdmin = await request(app)
      .patch(`/api/admin/users/${adminUser.id}/status`)
      .set('Cookie', superCookies)
      .set('X-CSRF-Token', superCsrf)
      .send({ status: 'LOCKED', reason: 'Temporary admin lockout drill' });
    expect(lockAdmin.status).toBe(200);
    expect(lockAdmin.body.user.status).toBe('LOCKED');

    // Audit date-range filtering
    const invalidDateRange = await request(app)
      .get('/api/admin/audit-events?from=2026-11-12T00:00:00.000Z&to=2026-11-11T00:00:00.000Z')
      .set('Cookie', superCookies);
    expect(invalidDateRange.status).toBe(400);

    const statusAudits = await request(app)
      .get('/api/admin/audit-events?action=USER_STATUS_CHANGE&from=2026-11-11&to=2026-11-11')
      .set('Cookie', superCookies);
    expect(statusAudits.status).toBe(200);
    expect(statusAudits.body.total).toBe(3);
  });
});
