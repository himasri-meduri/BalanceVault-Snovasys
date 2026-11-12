import { UserRole } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import {
  BOOTSTRAP_MARKER_ID,
  resolveOperatorDatabaseUrl,
  resolveRuntimeDatabaseUrl,
  runFirstAdminBootstrap,
  verifyBootstrapDbPermissions,
  verifyRuntimeDbHardening,
} from '../src/modules/bootstrap/bootstrap.service.js';
import { HealthService } from '../src/modules/health/health.service.js';
import {
  createHardenedRuntimeInspection,
  InMemoryAuthAuditBootstrapStore,
  InMemoryRateLimitStore,
} from './helpers/inMemoryStore.js';

const testEnv = parseEnv({
  NODE_ENV: 'test',
  PORT: '4000',
  APP_ORIGIN: 'http://localhost:5173',
  API_PUBLIC_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgresql://app_runtime:secret@localhost:5432/balancevault',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'test-session-secret-that-is-well-over-32-characters-long',
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'lax',
  LOG_LEVEL: 'silent',
});

describe('Phase 2 First SUPER_ADMIN Bootstrap (CLI-Only) & DB Hardening', () => {
  it('13. Bootstrap cannot be invoked through HTTP endpoints', async () => {
    const store = new InMemoryAuthAuditBootstrapStore();
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
      authService: new AuthService(store, testEnv),
      auditService: new AuditService(store),
      rateLimitStore: new InMemoryRateLimitStore(),
    });

    for (const path of [
      '/api/bootstrap',
      '/api/admin/bootstrap',
      '/api/auth/bootstrap',
      '/api/auth/register-admin',
    ]) {
      const res = await request(app).post(path).send({
        email: 'admin@balancevault.test',
        password: 'SuperAdminPass#2026',
      });
      expect(res.status).toBe(404);
    }
  });

  it('14 & 15. Bootstrap is idempotent, creates an auditable event without secrets, and allows normal login', async () => {
    const store = new InMemoryAuthAuditBootstrapStore();
    const secret = 'one-time-bootstrap-secret-value-at-least-24-chars';
    const password = 'SuperAdminVault#2026';

    const first = await runFirstAdminBootstrap(store, {
      email: '  Founder.Admin@BalanceVault.TEST ',
      fullName: 'BalanceVault Founder Admin',
      bootstrapSecret: secret,
      expectedBootstrapSecret: secret,
      password,
    });

    expect(first.status).toBe('created');
    expect(first.adminUser.role).toBe(UserRole.SUPER_ADMIN);
    expect(first.adminUser.email).toBe('founder.admin@balancevault.test');
    expect(first.auditEventId).toBeTruthy();
    expect(first.dbRoleSummary.appendOnlyTriggersActive).toBe(true);
    expect(store.bootstrapStates.get(BOOTSTRAP_MARKER_ID)?.adminUserId).toBe(
      first.adminUser.id,
    );

    // 15. Verify audit trail and ensure no secrets leaked
    expect(store.auditEvents).toHaveLength(1);
    const audit = store.auditEvents[0];
    expect(audit?.action).toBe('ADMIN_BOOTSTRAP_COMPLETED');
    expect(audit?.entityType).toBe('User');
    expect(audit?.entityId).toBe(first.adminUser.id);
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(secret);
    expect(serializedAudit).not.toContain(password);
    expect(serializedAudit).not.toContain('$argon2id$');

    // 14. Idempotent second run with same email
    const second = await runFirstAdminBootstrap(store, {
      email: 'founder.admin@balancevault.test',
      bootstrapSecret: secret,
      expectedBootstrapSecret: secret,
      password,
    });
    expect(second.status).toBe('already_bootstrapped');
    expect(second.adminUser.id).toBe(first.adminUser.id);
    expect(store.users.size).toBe(1);

    // Refuses creating a second initial admin with a different email
    await expect(
      runFirstAdminBootstrap(store, {
        email: 'second.admin@balancevault.test',
        bootstrapSecret: secret,
        expectedBootstrapSecret: secret,
        password,
      }),
    ).rejects.toThrow(/already completed/i);

    // Created SUPER_ADMIN can log in through normal HTTP login and view audit events
    const app = createApp({
      env: testEnv,
      logger: createLogger('silent'),
      healthService: new HealthService({
        checkDatabase: async () => 'ok',
        checkRedis: async () => 'ok',
      }),
      authService: new AuthService(store, testEnv),
      auditService: new AuditService(store),
      rateLimitStore: new InMemoryRateLimitStore(),
    });

    const loginRes = await request(app).post('/api/auth/login').send({
      email: 'founder.admin@balancevault.test',
      password,
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe(UserRole.SUPER_ADMIN);

    const rawCookie = loginRes.headers['set-cookie'];
    const cookie = Array.isArray(rawCookie)
      ? rawCookie
      : rawCookie
        ? [rawCookie]
        : [];
    expect(cookie.length).toBeGreaterThan(0);
    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.role).toBe(UserRole.SUPER_ADMIN);

    const auditRes = await request(app)
      .get('/api/admin/audit-events?action=ADMIN_BOOTSTRAP_COMPLETED')
      .set('Cookie', cookie);
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.items).toHaveLength(1);
    expect(auditRes.body.items[0].action).toBe('ADMIN_BOOTSTRAP_COMPLETED');
  });

  it('Verifies bootstrap DB privileges without requiring trigger function EXECUTE grants and fails safely if grants/triggers are missing', async () => {
    const store = new InMemoryAuthAuditBootstrapStore();
    // Direct EXECUTE on prevent_append_only_mutation() is intentionally revoked from non-owner roles
    expect(store.dbPrivilegeInspection.functionPrivileges.preventAppendOnlyExecute).toBe(
      false,
    );
    const validSummary = verifyBootstrapDbPermissions(store.dbPrivilegeInspection);
    expect(validSummary.appendOnlyTriggersActive).toBe(true);
    expect(validSummary.untrustedExposureWarnings).toEqual([]);

    store.dbPrivilegeInspection.tablePrivileges.auditInsert = false;
    expect(() => verifyBootstrapDbPermissions(store.dbPrivilegeInspection)).toThrow(
      /lacks required bootstrap privileges.*INSERT on "AuditEvent"/,
    );

    await expect(
      runFirstAdminBootstrap(store, {
        email: 'admin@balancevault.test',
        bootstrapSecret: 'one-time-bootstrap-secret-value-at-least-24-chars',
        password: 'SuperAdminVault#2026',
      }),
    ).rejects.toThrow(/DB_PRIVILEGE_ERROR|lacks required bootstrap privileges/);

    const missingTriggerStore = new InMemoryAuthAuditBootstrapStore();
    missingTriggerStore.dbPrivilegeInspection.triggerIntegrity.auditEventAppendOnly = false;
    expect(() =>
      verifyBootstrapDbPermissions(missingTriggerStore.dbPrivilegeInspection),
    ).toThrow(/trg_audit_event_append_only/);
  });

  it('Verifies Supabase/PostgreSQL runtime least-privilege hardening against untrusted roles, append-only mutations, and triggers', () => {
    const baseline = createHardenedRuntimeInspection();
    const summary = verifyRuntimeDbHardening(baseline);
    expect(summary.roleVerified).toBe(true);
    expect(summary.triggersVerified).toBe(true);
    expect(summary.sequenceCount).toBe(0);
    expect(summary.checkedUntrustedRoles).toEqual(['PUBLIC', 'anon', 'authenticated']);

    // 1. Fails if Supabase anon or authenticated retains table or function access
    const anonExposed = createHardenedRuntimeInspection();
    anonExposed.untrustedRoleExposures[1]!.tablesWithPrivileges = ['User', 'AuditEvent'];
    expect(() => verifyRuntimeDbHardening(anonExposed)).toThrow(
      /Role "anon" holds table privileges on: User, AuditEvent/,
    );

    const authFnExposed = createHardenedRuntimeInspection();
    authFnExposed.untrustedRoleExposures[2]!.verifyBalancedJournalExecute = true;
    expect(() => verifyRuntimeDbHardening(authFnExposed)).toThrow(
      /Role "authenticated" holds EXECUTE on public\.verify_balanced_journal_transaction\(\)/,
    );

    const publicExposed = createHardenedRuntimeInspection();
    publicExposed.untrustedRoleExposures[0]!.preventAppendOnlyExecute = true;
    expect(() => verifyRuntimeDbHardening(publicExposed)).toThrow(
      /Role "PUBLIC" holds EXECUTE on public\.prevent_append_only_mutation\(\)/,
    );

    // 2. Fails if app_runtime can tamper with append-only, bootstrap, migration, or delete domain tables
    const appendOnlyWritable = createHardenedRuntimeInspection();
    appendOnlyWritable.tablePrivileges.auditUpdate = true;
    appendOnlyWritable.tablePrivileges.journalEntryDelete = true;
    expect(() => verifyRuntimeDbHardening(appendOnlyWritable)).toThrow(
      /UPDATE\/DELETE on append-only "JournalEntry".*UPDATE\/DELETE on append-only "AuditEvent"/,
    );

    const bootstrapWritable = createHardenedRuntimeInspection();
    bootstrapWritable.tablePrivileges.bootstrapInsert = true;
    expect(() => verifyRuntimeDbHardening(bootstrapWritable)).toThrow(
      /must NOT hold INSERT\/UPDATE\/DELETE on "SystemBootstrapState"/,
    );

    const migrationsReadable = createHardenedRuntimeInspection();
    migrationsReadable.tablePrivileges.prismaMigrationsAny = true;
    expect(() => verifyRuntimeDbHardening(migrationsReadable)).toThrow(
      /_prisma_migrations/,
    );

    const runtimeSuper = createHardenedRuntimeInspection();
    runtimeSuper.roleInfo!.rolsuper = true;
    expect(() => verifyRuntimeDbHardening(runtimeSuper)).toThrow(/must NOT have SUPERUSER/);

    const runtimeInherit = createHardenedRuntimeInspection();
    runtimeInherit.roleInfo!.rolinherit = true;
    expect(() => verifyRuntimeDbHardening(runtimeInherit)).toThrow(/NOINHERIT/);

    const runtimePlatformMember = createHardenedRuntimeInspection();
    runtimePlatformMember.memberships = [
      { roleName: 'authenticated', adminOption: false },
    ];
    expect(() => verifyRuntimeDbHardening(runtimePlatformMember)).toThrow(
      /must have zero role memberships.*authenticated/,
    );

    // 3. Fails if balanced journal trigger is missing/disabled
    const missingBalanceTrigger = createHardenedRuntimeInspection();
    missingBalanceTrigger.triggerIntegrity.verifyBalancedJournal = false;
    expect(() => verifyRuntimeDbHardening(missingBalanceTrigger)).toThrow(
      /trg_verify_balanced_journal_transaction/,
    );

    // 4. Rejects SET ROLE spoofing, non-app_runtime active role, and PG 17 excess ACLs (MAINTAIN)
    const spoofedViaSetRole = createHardenedRuntimeInspection();
    spoofedViaSetRole.sessionUser = 'postgres';
    expect(() => verifyRuntimeDbHardening(spoofedViaSetRole)).toThrow(
      /dedicated app_runtime session login, not SET ROLE/,
    );

    const wrongRole = createHardenedRuntimeInspection();
    wrongRole.currentUser = 'postgres';
    wrongRole.sessionUser = 'postgres';
    expect(() => verifyRuntimeDbHardening(wrongRole)).toThrow(
      /must execute as "app_runtime", found active role "postgres"/,
    );

    const unhardenedSearchPath = createHardenedRuntimeInspection();
    unhardenedSearchPath.triggerIntegrity.verifyBalancedJournalSearchPathHardened = false;
    expect(() => verifyRuntimeDbHardening(unhardenedSearchPath)).toThrow(
      /verify_balanced_journal_transaction\(\).*SET search_path = pg_catalog, public/,
    );

    const maintainExcess = createHardenedRuntimeInspection();
    maintainExcess.excessTablePrivileges = [
      { tableName: 'AuditEvent', privilegeType: 'MAINTAIN' },
    ];
    expect(() => verifyRuntimeDbHardening(maintainExcess)).toThrow(
      /disallowed excess ACL privilege\(s\): MAINTAIN on "AuditEvent"/,
    );
  });

  it('Enforces dedicated app_runtime DATABASE_URL separation without leaking credentials', () => {
    const secret = 'RuntimePass!2026';
    const supabasePooler = resolveRuntimeDatabaseUrl({
      DATABASE_URL: `postgresql://app_runtime.projref:${secret}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
      DIRECT_URL: `postgresql://postgres:OperatorPass!@db.example.supabase.co:5432/postgres`,
    });
    expect(supabasePooler.username).toBe('app_runtime.projref');
    expect(supabasePooler.usesPgBouncerPooler).toBe(true);

    expect(() =>
      resolveRuntimeDatabaseUrl({
        DATABASE_URL: `postgresql://postgres:${secret}@db.example.supabase.co:5432/postgres`,
      }),
    ).toThrow(/least-privilege runtime role/);

    expect(() =>
      resolveRuntimeDatabaseUrl({
        DATABASE_URL: `postgresql://app_runtime:${secret}@localhost:5432/balancevault`,
        DIRECT_URL: `postgresql://app_runtime:other@localhost:5432/balancevault`,
      }),
    ).toThrow(/separate database roles/);
  });

  it('Enforces DIRECT_URL migration/operator connection separation without ever leaking credentials', () => {
    const secretPassword = 'SuperSecretPassword!99';
    const preferred = resolveOperatorDatabaseUrl({
      DIRECT_URL: `postgresql://postgres:${secretPassword}@db.example.supabase.co:5432/postgres`,
      DATABASE_URL: `postgresql://app_runtime:runtimepass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    });
    expect(preferred.sourceEnvVar).toBe('DIRECT_URL');
    expect(preferred.username).toBe('postgres');
    expect(preferred.port).toBe('5432');

    // Refuses app_runtime fallback when DIRECT_URL is absent
    expect(() =>
      resolveOperatorDatabaseUrl({
        DATABASE_URL: `postgresql://app_runtime.projref:${secretPassword}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
      }),
    ).toThrow(/Refusing to run CLI bootstrap with least-privilege runtime role/);

    // Refuses PgBouncer / Supabase transaction pooler port 6543 even if named postgres
    let caughtErrorMessage = '';
    try {
      resolveOperatorDatabaseUrl({
        DIRECT_URL: `postgresql://postgres:${secretPassword}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
      });
    } catch (err) {
      caughtErrorMessage = err instanceof Error ? err.message : String(err);
    }
    expect(caughtErrorMessage).toMatch(/transaction pooler/);
    expect(caughtErrorMessage).not.toContain(secretPassword);
  });

  it('Rejects invalid bootstrap secret or weak/placeholder passwords', async () => {
    const store = new InMemoryAuthAuditBootstrapStore();

    await expect(
      runFirstAdminBootstrap(store, {
        email: 'admin@balancevault.test',
        bootstrapSecret: 'REPLACE_WITH_ONE_TIME_SECRET',
        password: 'SuperAdminVault#2026',
      }),
    ).rejects.toThrow(/placeholder|24 characters/);

    await expect(
      runFirstAdminBootstrap(store, {
        email: 'admin@balancevault.test',
        bootstrapSecret: 'valid-secret-that-is-over-24-chars',
        expectedBootstrapSecret: 'different-secret-that-is-over-24-chars',
        password: 'SuperAdminVault#2026',
      }),
    ).rejects.toThrow(/verification failed/);
  });
});
