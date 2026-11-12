import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { PrismaAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { PrismaBootstrapRepository } from '../../src/modules/bootstrap/bootstrap.repository.js';
import {
  resolveOperatorDatabaseUrl,
  resolveRuntimeDatabaseUrl,
  verifyBootstrapDbPermissions,
  verifyRuntimeDbHardening,
} from '../../src/modules/bootstrap/bootstrap.service.js';
import { HealthService } from '../../src/modules/health/health.service.js';
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

describe('PostgreSQL + Redis Live Integration Tests', () => {
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

  it('verifies separate app_runtime connection hardening, append-only enforcement, check constraints, and deferred journal balance', async () => {
    // Dedicated app_runtime login connection (never relies on SET LOCAL ROLE)
    const bootstrapRepo = new PrismaBootstrapRepository(prisma);
    const runtimeInspection = await bootstrapRepo.inspectDbPrivileges();
    expect(runtimeInspection.currentUser).toBe('app_runtime');
    expect(runtimeInspection.sessionUser).toBe('app_runtime');

    const hardeningSummary = verifyRuntimeDbHardening(runtimeInspection);
    expect(hardeningSummary.currentUser).toBe('app_runtime');
    expect(hardeningSummary.roleVerified).toBe(true);
    expect(hardeningSummary.triggersVerified).toBe(true);

    // Runtime role must fail strictly with `permission denied` on prohibited DML, role assumption, or migration reads
    const targetPrivilegedRoles = [
      'anon',
      'authenticated',
      'service_role',
      'authenticator',
      'postgres',
      'dashboard_user',
      'supabase_admin',
      'pg_read_all_data',
      'pg_write_all_data',
      'pg_database_owner',
    ];
    const existingPrivilegedRoles = await prisma.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname FROM pg_roles WHERE rolname = ANY(${targetPrivilegedRoles}::text[])
    `;
    for (const { rolname: privRole } of existingPrivilegedRoles) {
      await expect(
        prisma.$executeRawUnsafe(`SET LOCAL ROLE "${privRole}"`),
      ).rejects.toThrow(/permission denied/i);
    }

    await expect(
      prisma.$executeRaw`DELETE FROM "User" WHERE false`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`DELETE FROM "OnboardingApplication" WHERE false`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`DELETE FROM "Account" WHERE false`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`UPDATE "AuditEvent" SET "reason" = 'tamper'`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`DELETE FROM "AuditEvent"`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`UPDATE "JournalTransaction" SET "description" = 'tamper'`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`DELETE FROM "JournalTransaction"`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`UPDATE "JournalEntry" SET "amountMinor" = 1`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`DELETE FROM "JournalEntry"`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`
        INSERT INTO "SystemBootstrapState" ("id", "adminUserId", "note")
        VALUES ('RUNTIME_TEST', ${crypto.randomUUID()}::uuid, 'blocked')
      `,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`UPDATE "SystemBootstrapState" SET "note" = 'tamper'`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$executeRaw`DELETE FROM "SystemBootstrapState"`,
    ).rejects.toThrow(/permission denied/i);

    await expect(
      prisma.$queryRaw`SELECT COUNT(*)::int FROM "_prisma_migrations"`,
    ).rejects.toThrow(/permission denied/i);

    // Non-normalized email check constraint on User
    await expect(
      prisma.$executeRaw`
        INSERT INTO "User" ("id", "email", "passwordHash", "fullName", "updatedAt")
        VALUES (${crypto.randomUUID()}::uuid, 'UnNormalized@BalanceVault.TEST', 'hash', 'Bad Email', NOW())
      `,
    ).rejects.toThrow();

    // Deferred journal balance constraint trigger runs as app_runtime WITHOUT direct EXECUTE:
    // balanced succeeds (rolled back cleanly), single-entry and unbalanced reject cleanly.
    const BALANCED_ROLLBACK_SENTINEL = 'BALANCED_CHECK_PASSED_ROLLBACK';
    const txOptions = { maxWait: 10_000, timeout: 20_000 };
    await expect(
      prisma.$transaction(async (tx) => {
        const acctA = crypto.randomUUID();
        const acctB = crypto.randomUUID();
        const txnId = crypto.randomUUID();

        await tx.$executeRaw`
          INSERT INTO "Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
          VALUES
            (${acctA}::uuid, ${`BV-INT-A-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Issuance A', 'INR', 'ACTIVE', 0, NOW()),
            (${acctB}::uuid, ${`BV-INT-B-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Issuance B', 'INR', 'ACTIVE', 0, NOW())
        `;
        await tx.$executeRaw`
          INSERT INTO "JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
          VALUES (${txnId}::uuid, ${`TXN-INT-BAL-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Balanced integration check')
        `;
        await tx.$executeRaw`
          INSERT INTO "JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
          VALUES
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctA}::uuid, 'DEBIT', 2500, 'INR'),
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctB}::uuid, 'CREDIT', 2500, 'INR')
        `;
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        throw new Error(BALANCED_ROLLBACK_SENTINEL);
      }, txOptions),
    ).rejects.toThrow(BALANCED_ROLLBACK_SENTINEL);

    await expect(
      prisma.$transaction(async (tx) => {
        const acctA = crypto.randomUUID();
        const txnId = crypto.randomUUID();

        await tx.$executeRaw`
          INSERT INTO "Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
          VALUES (${acctA}::uuid, ${`BV-INT-1E-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int One Entry', 'INR', 'ACTIVE', 0, NOW())
        `;
        await tx.$executeRaw`
          INSERT INTO "JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
          VALUES (${txnId}::uuid, ${`TXN-INT-1E-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Single entry integration check')
        `;
        await tx.$executeRaw`
          INSERT INTO "JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
          VALUES (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctA}::uuid, 'DEBIT', 2500, 'INR')
        `;
      }, txOptions),
    ).rejects.toThrow(/at least 2 entries/i);

    await expect(
      prisma.$transaction(async (tx) => {
        const acctA = crypto.randomUUID();
        const acctB = crypto.randomUUID();
        const txnId = crypto.randomUUID();

        await tx.$executeRaw`
          INSERT INTO "Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
          VALUES
            (${acctA}::uuid, ${`BV-INT-UA-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Unbal A', 'INR', 'ACTIVE', 0, NOW()),
            (${acctB}::uuid, ${`BV-INT-UB-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Unbal B', 'INR', 'ACTIVE', 0, NOW())
        `;
        await tx.$executeRaw`
          INSERT INTO "JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
          VALUES (${txnId}::uuid, ${`TXN-INT-UNBAL-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Unbalanced integration check')
        `;
        await tx.$executeRaw`
          INSERT INTO "JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
          VALUES
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctA}::uuid, 'DEBIT', 2500, 'INR'),
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctB}::uuid, 'CREDIT', 2000, 'INR')
        `;
      }, txOptions),
    ).rejects.toThrow(/unbalanced|total_credit/i);

    // Regression: CREATE TEMP TABLE "JournalEntry" cannot shadow public."JournalEntry"
    await expect(
      prisma.$transaction(async (tx) => {
        const acctA = crypto.randomUUID();
        const acctB = crypto.randomUUID();
        const txnId = crypto.randomUUID();

        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE "JournalEntry" (
            "transactionId" uuid,
            "direction" text,
            "amountMinor" bigint
          ) ON COMMIT DROP
        `);
        await tx.$executeRaw`
          INSERT INTO pg_temp."JournalEntry" ("transactionId", "direction", "amountMinor")
          VALUES (${txnId}::uuid, 'DEBIT', 5000), (${txnId}::uuid, 'CREDIT', 5000)
        `;
        await tx.$executeRaw`
          INSERT INTO public."Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
          VALUES
            (${acctA}::uuid, ${`BV-INT-SHAD-A-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Shadow A', 'INR', 'ACTIVE', 0, NOW()),
            (${acctB}::uuid, ${`BV-INT-SHAD-B-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Shadow B', 'INR', 'ACTIVE', 0, NOW())
        `;
        await tx.$executeRaw`
          INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
          VALUES (${txnId}::uuid, ${`TXN-INT-SHAD-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Shadow bypass regression check')
        `;
        await tx.$executeRaw`
          INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
          VALUES
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctA}::uuid, 'DEBIT', 5000, 'INR'),
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctB}::uuid, 'CREDIT', 4000, 'INR')
        `;
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      }, txOptions),
    ).rejects.toThrow(/unbalanced|total_credit/i);

    await expect(
      prisma.$transaction(async (tx) => {
        const acctA = crypto.randomUUID();
        const acctB = crypto.randomUUID();
        const txnId = crypto.randomUUID();

        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE "JournalEntry" (
            "transactionId" uuid,
            "direction" text,
            "amountMinor" bigint
          ) ON COMMIT DROP
        `);
        await tx.$executeRaw`
          INSERT INTO pg_temp."JournalEntry" ("transactionId", "direction", "amountMinor")
          VALUES (${txnId}::uuid, 'DEBIT', 9999)
        `;
        await tx.$executeRaw`
          INSERT INTO public."Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
          VALUES
            (${acctA}::uuid, ${`BV-INT-SHOK-A-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Shadow OK A', 'INR', 'ACTIVE', 0, NOW()),
            (${acctB}::uuid, ${`BV-INT-SHOK-B-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Shadow OK B', 'INR', 'ACTIVE', 0, NOW())
        `;
        await tx.$executeRaw`
          INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
          VALUES (${txnId}::uuid, ${`TXN-INT-SHOK-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Shadow non-interference check')
        `;
        await tx.$executeRaw`
          INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
          VALUES
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctA}::uuid, 'DEBIT', 2500, 'INR'),
            (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctB}::uuid, 'CREDIT', 2500, 'INR')
        `;
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        throw new Error(BALANCED_ROLLBACK_SENTINEL);
      }, txOptions),
    ).rejects.toThrow(BALANCED_ROLLBACK_SENTINEL);

    // Verify operator connection independently when DIRECT_URL is configured (always rolled back)
    if (process.env.DIRECT_URL) {
      const directConn = resolveOperatorDatabaseUrl({
        DIRECT_URL: process.env.DIRECT_URL,
      });
      const directPrisma = createPrismaClient(
        buildIntegrationDatabaseUrl(directConn.url),
      );
      try {
        const directRepo = new PrismaBootstrapRepository(directPrisma);
        const directInspection = await directRepo.inspectDbPrivileges();
        const directSummary = verifyBootstrapDbPermissions(directInspection);
        expect(directSummary.appendOnlyTriggersActive).toBe(true);

        // Prove all 4 BEFORE UPDATE/DELETE append-only triggers reject mutations cleanly & roll back
        await expect(
          directPrisma.$transaction(async (tx) => {
            const id = crypto.randomUUID();
            await tx.$executeRaw`
              INSERT INTO "AuditEvent" ("id", "actorType", "action", "entityType", "entityId", "requestId")
              VALUES (${id}::uuid, 'SYSTEM', 'INT_AUDIT_TRIGGER_CHECK', 'Verification', ${id}, 'int-trig-1')
            `;
            await tx.$executeRaw`
              UPDATE "AuditEvent" SET "reason" = 'tamper' WHERE "id" = ${id}::uuid
            `;
          }, txOptions),
        ).rejects.toThrow(/Table AuditEvent is append-only/i);

        await expect(
          directPrisma.$transaction(async (tx) => {
            const userId = crypto.randomUUID();
            const bootId = `INT_BOOT_${userId}`;
            await tx.$executeRaw`
              INSERT INTO "User" ("id", "email", "passwordHash", "fullName", "updatedAt")
              VALUES (${userId}::uuid, ${`int-boot-${userId}@balancevault.test`}, '$argon2id$tmp', 'Int Boot Admin', NOW())
            `;
            await tx.$executeRaw`
              INSERT INTO "SystemBootstrapState" ("id", "adminUserId", "note")
              VALUES (${bootId}, ${userId}::uuid, 'Temp trigger check')
            `;
            await tx.$executeRaw`
              DELETE FROM "SystemBootstrapState" WHERE "id" = ${bootId}
            `;
          }, txOptions),
        ).rejects.toThrow(/Table SystemBootstrapState is append-only/i);

        await expect(
          directPrisma.$transaction(async (tx) => {
            const txnId = crypto.randomUUID();
            await tx.$executeRaw`
              INSERT INTO "JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
              VALUES (${txnId}::uuid, ${`TXN-INT-TRIG-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Temp txn trigger check')
            `;
            await tx.$executeRaw`
              DELETE FROM "JournalTransaction" WHERE "id" = ${txnId}::uuid
            `;
          }, txOptions),
        ).rejects.toThrow(/Table JournalTransaction is append-only/i);

        await expect(
          directPrisma.$transaction(async (tx) => {
            const acctA = crypto.randomUUID();
            const acctB = crypto.randomUUID();
            const txnId = crypto.randomUUID();
            const entryId = crypto.randomUUID();
            await tx.$executeRaw`
              INSERT INTO "Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
              VALUES
                (${acctA}::uuid, ${`BV-TRG-A-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Trig A', 'INR', 'ACTIVE', 0, NOW()),
                (${acctB}::uuid, ${`BV-TRG-B-${Date.now()}`}, 'SYSTEM_ISSUANCE', NULL, 'Int Trig B', 'INR', 'ACTIVE', 0, NOW())
            `;
            await tx.$executeRaw`
              INSERT INTO "JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
              VALUES (${txnId}::uuid, ${`TXN-ENT-TRIG-${Date.now()}`}, 'ADJUSTMENT', 'POSTED', 'INR', 'Temp entry trigger check')
            `;
            await tx.$executeRaw`
              INSERT INTO "JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
              VALUES
                (${entryId}::uuid, ${txnId}::uuid, ${acctA}::uuid, 'DEBIT', 1000, 'INR'),
                (${crypto.randomUUID()}::uuid, ${txnId}::uuid, ${acctB}::uuid, 'CREDIT', 1000, 'INR')
            `;
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.$executeRaw`
              UPDATE "JournalEntry" SET "amountMinor" = 500 WHERE "id" = ${entryId}::uuid
            `;
          }, txOptions),
        ).rejects.toThrow(/Table JournalEntry is append-only/i);
      } finally {
        await directPrisma.$disconnect();
      }
    }
  });

  it('verifies PostgreSQL-backed registration, login session rotation, logout revocation, and Redis rate limiting over HTTP', async () => {
    const authService = new AuthService(new PrismaAuthRepository(prisma), env);
    const auditService = new AuditService(new PrismaAuditRepository(prisma));
    const rateLimitStore = new IsolatedIntegrationRateLimitStore(redis, 'auth');

    const app = createApp({
      env,
      logger,
      healthService: new HealthService({
        checkDatabase: () => checkDatabaseHealth(prisma),
        checkRedis: () => checkRedisHealth(redis),
      }),
      authService,
      auditService,
      rateLimitStore,
      rateLimitConfig: {
        registerMax: 20,
        loginMax: 3,
        windowMs: 60_000,
      },
    });

    try {
      const readyRes = await request(app).get('/api/ready');
      expect(readyRes.status).toBe(200);
      expect(readyRes.body.checks.database).toBe('ok');
      expect(readyRes.body.checks.redis).toBe('ok');

      const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const email = `int-auth-${suffix}@balancevault.test`;
      const password = 'IntegrationUser#2026';

      const regRes = await request(app).post('/api/auth/register').send({
        fullName: 'Integration Customer',
        email,
        password,
      });
      expect(regRes.status).toBe(201);
      expect(regRes.body.user.role).toBe('CUSTOMER');
      const regCookies = extractCookies(regRes);

      // Login rotates session and revokes prior session in PostgreSQL
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('Cookie', regCookies)
        .send({ email, password });
      expect(loginRes.status).toBe(200);
      expect(loginRes.headers['x-ratelimit-limit']).toBe('3');
      expect(loginRes.headers['x-ratelimit-remaining']).toBe('2');
      const loginCookies = extractCookies(loginRes);
      const loginCsrf = loginRes.body.csrfToken as string;

      expect((await request(app).get('/api/auth/me').set('Cookie', regCookies)).status).toBe(
        401,
      );
      expect((await request(app).get('/api/auth/me').set('Cookie', loginCookies)).status).toBe(
        200,
      );

      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', loginCookies)
        .set('X-CSRF-Token', loginCsrf);
      expect(logoutRes.status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Cookie', loginCookies)).status).toBe(
        401,
      );

      // Redis rate limit enforcement
      const key = `int:ratelimit:${suffix}`;
      expect((await rateLimitStore.incrementWindow(key, 10_000)).count).toBe(1);
      expect((await rateLimitStore.incrementWindow(key, 10_000)).count).toBe(2);
      expect((await rateLimitStore.incrementWindow(key, 10_000)).count).toBe(3);
    } finally {
      await rateLimitStore.cleanup().catch(() => {});
    }
  });
});
