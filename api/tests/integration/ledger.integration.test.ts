import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AccountStatus,
  JournalTransactionStatus,
  OnboardingStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
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
import { PrismaLedgerRepository } from '../../src/modules/ledger/ledger.repository.js';
import { LedgerService } from '../../src/modules/ledger/ledger.service.js';
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

describe('Ledger, Transfers, Concurrency, Reversals & User Admin PostgreSQL Integration Tests', () => {
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

  it('verifies account eligibility, IDOR isolation, idempotency, concurrent double-spend & identical-key races on PostgreSQL', async () => {
    const authService = new AuthService(new PrismaAuthRepository(prisma), env);
    const auditService = new AuditService(new PrismaAuditRepository(prisma));
    const onboardingService = new OnboardingService(
      new PrismaOnboardingRepository(prisma),
      env,
    );
    const ledgerRepo = new PrismaLedgerRepository(prisma);
    const ledgerService = new LedgerService(ledgerRepo, env);
    const rateLimitStore = new IsolatedIntegrationRateLimitStore(redis, 'ledger-core');

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
      ledgerService,
      rateLimitStore,
      rateLimitConfig: {
        registerMax: 30,
        loginMax: 30,
        onboardingSubmitMax: 30,
        transferMax: 30,
        windowMs: 60_000,
      },
    });

    try {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      // OpenAPI spec check
      const openApiRes = await request(app).get('/api/openapi.json');
      expect(openApiRes.status).toBe(200);
      expect(openApiRes.body.openapi).toBe('3.0.3');
      expect(openApiRes.body.paths['/api/transfers']).toBeDefined();

      // Seed dedicated synthetic test ADMIN (never touch existing SUPER_ADMIN)
      const adminEmail = `int-ledger-admin-${suffix}@balancevault.test`;
      const adminPassword = 'IntegrationAdmin#2026';
      const adminHash = await hashPassword(adminPassword);
      await prisma.user.create({
        data: {
          email: adminEmail,
          fullName: 'Integration Ledger Admin',
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

      // Register synthetic customers A, B, C via HTTP
      const custPass = 'IntegrationCustomer#2026';
      const custAEmail = `int-ledger-a-${suffix}@balancevault.test`;
      const custBEmail = `int-ledger-b-${suffix}@balancevault.test`;
      const custCEmail = `int-ledger-c-${suffix}@balancevault.test`;

      const regA = await request(app).post('/api/auth/register').send({
        fullName: 'Ledger Customer A',
        email: custAEmail,
        password: custPass,
      });
      const regB = await request(app).post('/api/auth/register').send({
        fullName: 'Ledger Customer B',
        email: custBEmail,
        password: custPass,
      });
      const regC = await request(app).post('/api/auth/register').send({
        fullName: 'Ledger Customer C',
        email: custCEmail,
        password: custPass,
      });
      expect(regA.status).toBe(201);
      expect(regB.status).toBe(201);
      expect(regC.status).toBe(201);

      const cookiesA = extractCookies(regA);
      const csrfA = regA.body.csrfToken as string;
      const userAId = regA.body.user.id as string;

      const cookiesB = extractCookies(regB);
      const csrfB = regB.body.csrfToken as string;
      const userBId = regB.body.user.id as string;

      const cookiesC = extractCookies(regC);
      const userCId = regC.body.user.id as string;

      // Submit onboarding for A & B, leave C PENDING
      const subA = await request(app)
        .post('/api/onboarding/me/submit')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .send({
          contactReference: '+91-9876500001',
          city: 'Bengaluru',
          country: 'India',
          accountPurpose: 'Live integration ledger testing A',
          acceptedSyntheticTerms: true,
        });
      const subB = await request(app)
        .post('/api/onboarding/me/submit')
        .set('Cookie', cookiesB)
        .set('X-CSRF-Token', csrfB)
        .send({
          contactReference: '+91-9876500002',
          city: 'Mumbai',
          country: 'India',
          accountPurpose: 'Live integration ledger testing B',
          acceptedSyntheticTerms: true,
        });
      expect(subA.status).toBe(200);
      expect(subB.status).toBe(200);

      // Admin approves A & B
      const approveA = await request(app)
        .post(`/api/admin/onboarding/applications/${subA.body.application.id}/approve`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Approved A for live PostgreSQL ledger testing' });
      const approveB = await request(app)
        .post(`/api/admin/onboarding/applications/${subB.body.application.id}/approve`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Approved B for live PostgreSQL ledger testing' });
      expect(approveA.status).toBe(200);
      expect(approveB.status).toBe(200);

      // Unapproved customer C cannot receive an account
      const unapprovedCreate = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: userCId,
          accountName: 'Should Fail Unapproved',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '10000',
          reason: 'Must fail because onboarding is not APPROVED',
        });
      expect(unapprovedCreate.status).toBe(409);
      expect(unapprovedCreate.body.error.code).toBe('CUSTOMER_NOT_ELIGIBLE');

      // Admin opens ACTIVE funded account for A (Rs 5,000 = 500000 paise), B (Rs 1,000 = 100000 paise),
      // and a PENDING vault for A then activates it.
      const createAccA = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: userAId,
          accountName: 'Customer A Primary Reserve',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '500000',
          reason: 'Opening allocation for live PostgreSQL integration suite',
        });
      const createAccB = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: userBId,
          accountName: 'Customer B Settlement Vault',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '100000',
          reason: 'Opening allocation for Customer B live integration suite',
        });
      const createAccAPending = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: userAId,
          accountName: 'Customer A Secondary Vault',
          initialStatus: AccountStatus.PENDING,
          initialCreditMinor: '0',
          reason: 'Verify PENDING -> ACTIVE lifecycle transition on PostgreSQL',
        });

      expect(createAccA.status).toBe(201);
      expect(createAccB.status).toBe(201);
      expect(createAccAPending.status).toBe(201);

      const accA = createAccA.body.account as {
        id: string;
        publicReference: string;
        balanceMinor: string;
      };
      const accB = createAccB.body.account as {
        id: string;
        publicReference: string;
        balanceMinor: string;
      };
      const accAPendingId = createAccAPending.body.account.id as string;

      const activatePending = await request(app)
        .post(`/api/admin/accounts/${accAPendingId}/activate`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Activating PENDING customer vault on live PostgreSQL' });
      expect(activatePending.status).toBe(200);
      expect(activatePending.body.account.status).toBe(AccountStatus.ACTIVE);

      // IDOR concealment checks
      expect(
        (await request(app).get(`/api/accounts/${accB.id}`).set('Cookie', cookiesA)).status,
      ).toBe(404);
      expect(
        (await request(app).get(`/api/accounts/${accB.id}/ledger`).set('Cookie', cookiesA))
          .status,
      ).toBe(404);

      // Single transfer A -> B: 150000 paise (Rs 1,500), A goes 500000 -> 350000, B goes 100000 -> 250000
      const baseKey = `int-base-${suffix}`;
      const baseTransfer = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', baseKey)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '150000',
          description: 'Live DB baseline synthetic transfer',
        });
      expect(baseTransfer.status).toBe(201);
      expect(baseTransfer.body.idempotentReplay).toBe(false);
      expect(baseTransfer.body.sourceAccount.balanceMinor).toBe('350000');

      // Idempotent replay with identical key & payload must not double-debit
      const replayTransfer = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', baseKey)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '150000',
          description: 'Live DB baseline synthetic transfer',
        });
      expect(replayTransfer.status).toBe(201);
      expect(replayTransfer.body.idempotentReplay).toBe(true);
      expect(replayTransfer.headers['x-idempotent-replay']).toBe('true');
      expect(replayTransfer.body.transaction.id).toBe(baseTransfer.body.transaction.id);

      // Payload mismatch with reused key -> 409
      const mismatchTransfer = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', baseKey)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '150001',
          description: 'Live DB baseline synthetic transfer',
        });
      expect(mismatchTransfer.status).toBe(409);
      expect(mismatchTransfer.body.error.code).toBe(
        'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
      );

      // Non-participant C cannot inspect A<->B transaction; participant B can (with A private name redacted)
      const baseTxnId = baseTransfer.body.transaction.id as string;
      expect(
        (await request(app).get(`/api/transactions/${baseTxnId}`).set('Cookie', cookiesC))
          .status,
      ).toBe(404);
      const txnAsB = await request(app)
        .get(`/api/transactions/${baseTxnId}`)
        .set('Cookie', cookiesB);
      expect(txnAsB.status).toBe(200);
      const debitEntryAsB = txnAsB.body.transaction.entries.find(
        (e: { direction: string }) => e.direction === 'DEBIT',
      );
      expect(debitEntryAsB.accountName).toBeNull();
      expect(debitEntryAsB.accountId).toBeNull();
      expect(debitEntryAsB.accountPublicReference).toBe(accA.publicReference);

      // CONCURRENT DOUBLE-SPEND RACE on live PostgreSQL FOR UPDATE row locks:
      // A has 350000. Fire 5 simultaneous 100000 transfers -> strictly 3 succeed (201), 2 fail (422), 0 deadlocks.
      const raceResponses = await Promise.all(
        [1, 2, 3, 4, 5].map((idx) =>
          request(app)
            .post('/api/transfers')
            .set('Cookie', cookiesA)
            .set('X-CSRF-Token', csrfA)
            .set('Idempotency-Key', `int-race-ds-${idx}-${suffix}`)
            .send({
              sourceAccountId: accA.id,
              destinationAccountReference: accB.publicReference,
              amountMinor: '100000',
              description: `Concurrent double-spend race ${idx}`,
            }),
        ),
      );
      const raceStatuses = raceResponses.map((r) => r.status).sort((a, b) => a - b);
      expect(raceStatuses).toEqual([201, 201, 201, 422, 422]);

      // Balance of A = 50000, Balance of B = 550000
      // CONCURRENT IDENTICAL IDEMPOTENCY-KEY RACE for full remaining 50000 balance:
      // All 3 concurrent identical retries must commit/replay 201 with exact same transaction.id, draining A to 0 only once!
      const sharedRaceKey = `int-race-idem-${suffix}`;
      const idemRaceResponses = await Promise.all(
        [1, 2, 3].map(() =>
          request(app)
            .post('/api/transfers')
            .set('Cookie', cookiesA)
            .set('X-CSRF-Token', csrfA)
            .set('Idempotency-Key', sharedRaceKey)
            .send({
              sourceAccountId: accA.id,
              destinationAccountReference: accB.publicReference,
              amountMinor: '50000',
              description: 'Concurrent identical idempotency key zero-drain race',
            }),
        ),
      );
      expect(idemRaceResponses.map((r) => r.status)).toEqual([201, 201, 201]);
      const idemRaceTxnIds = new Set(
        idemRaceResponses.map((r) => r.body.transaction.id as string),
      );
      expect(idemRaceTxnIds.size).toBe(1);

      // Verify post-race balances: A = 0, B = 600000
      const accAAfterRaces = await request(app)
        .get(`/api/accounts/${accA.id}`)
        .set('Cookie', cookiesA);
      const accBAfterRaces = await request(app)
        .get(`/api/accounts/${accB.id}`)
        .set('Cookie', cookiesB);
      expect(accAAfterRaces.body.account.balanceMinor).toBe('0');
      expect(accBAfterRaces.body.account.balanceMinor).toBe('600000');

      // DOUBLE-ENTRY RECONCILIATION PROOF ON LIVE POSTGRESQL
      const treasury = await prisma.account.findUniqueOrThrow({
        where: { publicReference: 'BV-SYS-TREASURY-01' },
        select: { id: true },
      });
      const recRows = await ledgerRepo.reconcileAccounts([
        accA.id,
        accB.id,
        accAPendingId,
        treasury.id,
      ]);
      expect(recRows).toHaveLength(4);
      for (const row of recRows) {
        expect(row.projectedBalanceMinor).toBe(row.journalDerivedBalanceMinor);
      }
    } finally {
      await rateLimitStore.cleanup().catch(() => {});
    }
  });

  it('verifies compensating reversals, append-only ledger, freeze/close lifecycle, admin summary, and user status governance on PostgreSQL', async () => {
    const authService = new AuthService(new PrismaAuthRepository(prisma), env);
    const auditService = new AuditService(new PrismaAuditRepository(prisma));
    const onboardingService = new OnboardingService(
      new PrismaOnboardingRepository(prisma),
      env,
    );
    const ledgerRepo = new PrismaLedgerRepository(prisma);
    const ledgerService = new LedgerService(ledgerRepo, env);
    const rateLimitStore = new IsolatedIntegrationRateLimitStore(redis, 'ledger-gov');

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
      ledgerService,
      rateLimitStore,
      rateLimitConfig: {
        registerMax: 30,
        loginMax: 30,
        onboardingSubmitMax: 30,
        transferMax: 30,
        windowMs: 60_000,
      },
    });

    try {
      const testWindowStart = new Date(Date.now() - 2_000).toISOString();
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const adminPassword = 'GovernanceAdmin#2026';
      const custPassword = 'GovernanceCust#2026';
      const [adminHash, custHash] = await Promise.all([
        hashPassword(adminPassword),
        hashPassword(custPassword),
      ]);

      const adminEmail = `int-gov-admin-${suffix}@balancevault.test`;
      const custAEmail = `int-gov-a-${suffix}@balancevault.test`;
      const custBEmail = `int-gov-b-${suffix}@balancevault.test`;

      const adminUser = await prisma.user.create({
        data: {
          email: adminEmail,
          fullName: 'Governance Admin',
          passwordHash: adminHash,
          role: UserRole.ADMIN,
        },
      });
      const custA = await prisma.user.create({
        data: {
          email: custAEmail,
          fullName: 'Governance Customer A',
          passwordHash: custHash,
          role: UserRole.CUSTOMER,
          onboardingApplication: {
            create: {
              status: OnboardingStatus.APPROVED,
              contactReference: '+91-9876500101',
              city: 'Hyderabad',
              country: 'India',
              accountPurpose: 'Live governance and reversal integration check',
              acceptedSyntheticTerms: true,
              submittedAt: new Date(),
              reviewedAt: new Date(),
              reviewedByUserId: adminUser.id,
            },
          },
        },
      });
      const custB = await prisma.user.create({
        data: {
          email: custBEmail,
          fullName: 'Governance Customer B',
          passwordHash: custHash,
          role: UserRole.CUSTOMER,
          onboardingApplication: {
            create: {
              status: OnboardingStatus.APPROVED,
              contactReference: '+91-9876500102',
              city: 'Pune',
              country: 'India',
              accountPurpose: 'Live governance receiver integration check',
              acceptedSyntheticTerms: true,
              submittedAt: new Date(),
              reviewedAt: new Date(),
              reviewedByUserId: adminUser.id,
            },
          },
        },
      });

      const [adminLogin, loginA, loginB] = await Promise.all([
        request(app).post('/api/auth/login').send({
          email: adminEmail,
          password: adminPassword,
        }),
        request(app).post('/api/auth/login').send({
          email: custAEmail,
          password: custPassword,
        }),
        request(app).post('/api/auth/login').send({
          email: custBEmail,
          password: custPassword,
        }),
      ]);
      expect(adminLogin.status).toBe(200);
      expect(loginA.status).toBe(200);
      expect(loginB.status).toBe(200);

      const adminCookies = extractCookies(adminLogin);
      const adminCsrf = adminLogin.body.csrfToken as string;
      const cookiesA = extractCookies(loginA);
      const csrfA = loginA.body.csrfToken as string;
      const cookiesB = extractCookies(loginB);

      const createAccA = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: custA.id,
          accountName: 'Governance A Vault',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '250000',
          reason: 'Fund governance test account A',
        });
      const createAccB = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: custB.id,
          accountName: 'Governance B Vault',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '0',
          reason: 'Open governance test account B',
        });
      expect(createAccA.status).toBe(201);
      expect(createAccB.status).toBe(201);

      const accA = createAccA.body.account as {
        id: string;
        publicReference: string;
      };
      const accB = createAccB.body.account as {
        id: string;
        publicReference: string;
      };

      // Execute two transfers A -> B: 100000 (will be reversed) and 150000 (leaves A at 0 before reversal, then 100000 after reversal)
      const transferToReverse = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', `gov-rev-${suffix}`)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '100000',
          description: 'Transfer scheduled for compensating reversal test',
        });
      const transferKept = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', `gov-kept-${suffix}`)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '150000',
          description: 'Remaining transfer before closing drained vault',
        });
      expect(transferToReverse.status).toBe(201);
      expect(transferKept.status).toBe(201);
      const revTargetTxnId = transferToReverse.body.transaction.id as string;

      // Compensating Reversal of 100000 transfer -> A goes 0 -> 100000, B goes 250000 -> 150000
      const reversalRes = await request(app)
        .post(`/api/transactions/${revTargetTxnId}/reverse`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Compensating reversal verified in live PostgreSQL test' });
      expect(reversalRes.status).toBe(201);
      expect(reversalRes.body.reversedTransactionStatus).toBe(
        JournalTransactionStatus.REVERSED,
      );
      const reversalTxnId = reversalRes.body.reversalTransaction.id as string;

      // Original JournalTransaction DB row stays POSTED (append-only!) while API projects REVERSED
      const rawOriginalTxn = await prisma.journalTransaction.findUniqueOrThrow({
        where: { id: revTargetTxnId },
        select: { status: true },
      });
      expect(rawOriginalTxn.status).toBe(JournalTransactionStatus.POSTED);

      const apiOriginalTxn = await request(app)
        .get(`/api/transactions/${revTargetTxnId}`)
        .set('Cookie', adminCookies);
      expect(apiOriginalTxn.status).toBe(200);
      expect(apiOriginalTxn.body.transaction.status).toBe(
        JournalTransactionStatus.REVERSED,
      );

      // Append-only enforcement as app_runtime blocks direct SQL mutation
      await expect(
        prisma.$executeRaw`UPDATE "JournalTransaction" SET "description" = 'tampered' WHERE "id" = ${revTargetTxnId}::uuid`,
      ).rejects.toThrow(/permission denied/i);

      // Double reversal and reversing a reversal are blocked
      const doubleReverse = await request(app)
        .post(`/api/transactions/${revTargetTxnId}/reverse`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Double reversal attempt must return conflict 409' });
      expect(doubleReverse.status).toBe(409);
      expect(doubleReverse.body.error.code).toBe('TRANSACTION_ALREADY_REVERSED');

      const reverseReversal = await request(app)
        .post(`/api/transactions/${reversalTxnId}/reverse`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Reversal of reversal attempt must return conflict 409' });
      expect(reverseReversal.status).toBe(409);
      expect(reverseReversal.body.error.code).toBe('CANNOT_REVERSE_REVERSAL');

      // Freeze -> blocked transfer -> Unfreeze -> Close non-zero blocked -> drain -> Close success
      const freezeA = await request(app)
        .post(`/api/admin/accounts/${accA.id}/freeze`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Live DB compliance hold check' });
      expect(freezeA.status).toBe(200);
      expect(freezeA.body.account.status).toBe(AccountStatus.FROZEN);

      const blockedFrozenTransfer = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', `gov-frozen-${suffix}`)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '1000',
          description: 'Must fail while frozen',
        });
      expect(blockedFrozenTransfer.status).toBe(409);
      expect(blockedFrozenTransfer.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');

      const unfreezeA = await request(app)
        .post(`/api/admin/accounts/${accA.id}/unfreeze`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Lift compliance hold on live DB' });
      expect(unfreezeA.status).toBe(200);

      const nonZeroClose = await request(app)
        .post(`/api/admin/accounts/${accA.id}/close`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Cannot close non-zero account' });
      expect(nonZeroClose.status).toBe(409);
      expect(nonZeroClose.body.error.code).toBe('ACCOUNT_BALANCE_NON_ZERO');

      const drainA = await request(app)
        .post('/api/transfers')
        .set('Cookie', cookiesA)
        .set('X-CSRF-Token', csrfA)
        .set('Idempotency-Key', `gov-drain-${suffix}`)
        .send({
          sourceAccountId: accA.id,
          destinationAccountReference: accB.publicReference,
          amountMinor: '100000',
          description: 'Drain remaining balance before closing account A',
        });
      expect(drainA.status).toBe(201);

      const closeA = await request(app)
        .post(`/api/admin/accounts/${accA.id}/close`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({ reason: 'Close drained customer A vault' });
      expect(closeA.status).toBe(200);
      expect(closeA.body.account.status).toBe(AccountStatus.CLOSED);

      // DOUBLE-ENTRY RECONCILIATION PROOF ON LIVE POSTGRESQL
      const treasury = await prisma.account.findUniqueOrThrow({
        where: { publicReference: 'BV-SYS-TREASURY-01' },
        select: { id: true },
      });
      const recRows = await ledgerRepo.reconcileAccounts([accA.id, accB.id, treasury.id]);
      expect(recRows).toHaveLength(3);
      for (const row of recRows) {
        expect(row.projectedBalanceMinor).toBe(row.journalDerivedBalanceMinor);
      }

      // Admin Summary, User Search, User Detail, Status Change + Session Revocation, Audit Date Filter
      const summaryRes = await request(app)
        .get('/api/admin/summary')
        .set('Cookie', adminCookies);
      expect(summaryRes.status).toBe(200);
      expect(summaryRes.body.customersTotal).toBeGreaterThanOrEqual(2);
      expect(summaryRes.body.demoTransactionsTotal).toBeGreaterThanOrEqual(3);
      expect(summaryRes.body.closedAccounts).toBeGreaterThanOrEqual(1);

      const userSearchRes = await request(app)
        .get(`/api/admin/users?search=${encodeURIComponent(custBEmail)}`)
        .set('Cookie', adminCookies);
      expect(userSearchRes.status).toBe(200);
      expect(userSearchRes.body.items).toHaveLength(1);
      expect(userSearchRes.body.items[0].id).toBe(custB.id);

      const userDetailRes = await request(app)
        .get(`/api/admin/users/${custB.id}`)
        .set('Cookie', adminCookies);
      expect(userDetailRes.status).toBe(200);
      expect(userDetailRes.body.user.accountCount).toBe(1);
      expect(userDetailRes.body.user.passwordHash).toBeUndefined();

      const disableB = await request(app)
        .patch(`/api/admin/users/${custB.id}/status`)
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          status: UserStatus.DISABLED,
          reason: 'Disable synthetic customer B and revoke live session',
        });
      expect(disableB.status).toBe(200);
      expect(disableB.body.user.status).toBe(UserStatus.DISABLED);

      // Customer B session is immediately invalidated on PostgreSQL
      const revokedMe = await request(app).get('/api/auth/me').set('Cookie', cookiesB);
      expect(revokedMe.status).toBe(401);

      const testWindowEnd = new Date(Date.now() + 2_000).toISOString();
      const auditFilterRes = await request(app)
        .get(
          `/api/admin/audit-events?action=USER_STATUS_CHANGE&entityId=${custB.id}&from=${encodeURIComponent(testWindowStart)}&to=${encodeURIComponent(testWindowEnd)}`,
        )
        .set('Cookie', adminCookies);
      expect(auditFilterRes.status).toBe(200);
      expect(auditFilterRes.body.items.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rateLimitStore.cleanup().catch(() => {});
    }
  });

  it('enforces Upstash Redis transfer rate limit (429 RATE_LIMITED)', async () => {
    const authService = new AuthService(new PrismaAuthRepository(prisma), env);
    const auditService = new AuditService(new PrismaAuditRepository(prisma));
    const onboardingService = new OnboardingService(
      new PrismaOnboardingRepository(prisma),
      env,
    );
    const ledgerService = new LedgerService(new PrismaLedgerRepository(prisma), env);
    const rateLimitStore = new IsolatedIntegrationRateLimitStore(redis, 'ledger-rl');

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
      ledgerService,
      rateLimitStore,
      rateLimitConfig: {
        registerMax: 20,
        loginMax: 20,
        onboardingSubmitMax: 20,
        transferMax: 2,
        windowMs: 60_000,
      },
    });

    try {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const adminHash = await hashPassword('RateLimitAdmin#2026');
      const custHash = await hashPassword('RateLimitCust#2026');

      const admin = await prisma.user.create({
        data: {
          email: `int-rl-admin-${suffix}@balancevault.test`,
          fullName: 'RL Admin',
          passwordHash: adminHash,
          role: UserRole.ADMIN,
        },
      });
      const custA = await prisma.user.create({
        data: {
          email: `int-rl-a-${suffix}@balancevault.test`,
          fullName: 'RL Sender',
          passwordHash: custHash,
          role: UserRole.CUSTOMER,
          onboardingApplication: {
            create: {
              status: OnboardingStatus.APPROVED,
              contactReference: '+91-9876500099',
              city: 'Delhi',
              country: 'India',
              accountPurpose: 'Rate limit verification',
              acceptedSyntheticTerms: true,
              submittedAt: new Date(),
              reviewedAt: new Date(),
              reviewedByUserId: admin.id,
            },
          },
        },
      });
      const custB = await prisma.user.create({
        data: {
          email: `int-rl-b-${suffix}@balancevault.test`,
          fullName: 'RL Receiver',
          passwordHash: custHash,
          role: UserRole.CUSTOMER,
          onboardingApplication: {
            create: {
              status: OnboardingStatus.APPROVED,
              contactReference: '+91-9876500098',
              city: 'Chennai',
              country: 'India',
              accountPurpose: 'Rate limit receiver verification',
              acceptedSyntheticTerms: true,
              submittedAt: new Date(),
              reviewedAt: new Date(),
              reviewedByUserId: admin.id,
            },
          },
        },
      });

      const adminLogin = await request(app).post('/api/auth/login').send({
        email: admin.email,
        password: 'RateLimitAdmin#2026',
      });
      const adminCookies = extractCookies(adminLogin);
      const adminCsrf = adminLogin.body.csrfToken as string;

      const accARes = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: custA.id,
          accountName: 'RL Source',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '50000',
          reason: 'Setup RL source account',
        });
      const accBRes = await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminCookies)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          ownerUserId: custB.id,
          accountName: 'RL Dest',
          initialStatus: AccountStatus.ACTIVE,
          initialCreditMinor: '0',
          reason: 'Setup RL destination account',
        });
      expect(accARes.status).toBe(201);
      expect(accBRes.status).toBe(201);

      const senderLogin = await request(app).post('/api/auth/login').send({
        email: custA.email,
        password: 'RateLimitCust#2026',
      });
      const senderCookies = extractCookies(senderLogin);
      const senderCsrf = senderLogin.body.csrfToken as string;

      const r1 = await request(app)
        .post('/api/transfers')
        .set('Cookie', senderCookies)
        .set('X-CSRF-Token', senderCsrf)
        .set('Idempotency-Key', `rl-1-${suffix}`)
        .send({
          sourceAccountId: accARes.body.account.id,
          destinationAccountReference: accBRes.body.account.publicReference,
          amountMinor: '1000',
          description: 'RL transfer 1',
        });
      const r2 = await request(app)
        .post('/api/transfers')
        .set('Cookie', senderCookies)
        .set('X-CSRF-Token', senderCsrf)
        .set('Idempotency-Key', `rl-2-${suffix}`)
        .send({
          sourceAccountId: accARes.body.account.id,
          destinationAccountReference: accBRes.body.account.publicReference,
          amountMinor: '1000',
          description: 'RL transfer 2',
        });
      const r3 = await request(app)
        .post('/api/transfers')
        .set('Cookie', senderCookies)
        .set('X-CSRF-Token', senderCsrf)
        .set('Idempotency-Key', `rl-3-${suffix}`)
        .send({
          sourceAccountId: accARes.body.account.id,
          destinationAccountReference: accBRes.body.account.publicReference,
          amountMinor: '1000',
          description: 'RL transfer 3 blocked',
        });

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r3.status).toBe(429);
      expect(r3.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await rateLimitStore.cleanup().catch(() => {});
    }
  });
});
