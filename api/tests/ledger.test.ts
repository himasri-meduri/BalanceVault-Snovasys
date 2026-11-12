import {
  AccountKind,
  AccountStatus,
  JournalTransactionStatus,
  JournalTransactionType,
  OnboardingStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { type RedisRateLimitStore } from '../src/middleware/rateLimit.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { hashPassword } from '../src/modules/auth/auth.crypto.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { HealthService } from '../src/modules/health/health.service.js';
import { LedgerService } from '../src/modules/ledger/ledger.service.js';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service.js';
import {
  InMemoryAuthAuditBootstrapStore,
  InMemoryRateLimitStore,
} from './helpers/inMemoryStore.js';

function makeTestEnv() {
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
  });
}

function buildLedgerHarness(options?: {
  transferMax?: number;
  rateLimitStore?: RedisRateLimitStore;
}) {
  let currentNow = new Date('2026-11-11T12:00:00.000Z');
  const nowProvider = () => {
    currentNow = new Date(currentNow.getTime() + 1000);
    return currentNow;
  };

  const env = makeTestEnv();
  const store = new InMemoryAuthAuditBootstrapStore(nowProvider);
  const rateLimitStore = options?.rateLimitStore ?? new InMemoryRateLimitStore();
  const auditService = new AuditService(store);
  const authService = new AuthService(store, env, nowProvider);
  const onboardingService = new OnboardingService(store, env, nowProvider);
  const ledgerService = new LedgerService(store, env, nowProvider);

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
    ledgerService,
    rateLimitStore,
    rateLimitConfig: {
      registerMax: 50,
      loginMax: 50,
      onboardingSubmitMax: 50,
      transferMax: options?.transferMax ?? 50,
      windowMs: 60_000,
    },
  });

  return { app, store, env };
}

function extractCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

async function loginSeeded(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string,
) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return {
    cookies: extractCookies(res),
    csrfToken: res.body.csrfToken as string,
    user: res.body.user as { id: string; email: string; role: UserRole },
  };
}

describe('Phase 4 Accounts, Double-Entry Ledger, Transfers & Reversals', () => {
  it('enforces eligibility on admin account creation and reconciles initial synthetic allocation via BV-SYS-TREASURY-01', async () => {
    const { app, store } = buildLedgerHarness();
    const passwordHash = await hashPassword('StrongPass#2026');

    const admin = store.seedUser({
      email: 'ops.admin@balancevault.test',
      fullName: 'Ops Admin',
      passwordHash,
      role: UserRole.ADMIN,
    });
    const pendingCustomer = store.seedUser({
      email: 'pending.cust@balancevault.test',
      fullName: 'Pending Customer',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.PENDING,
    });
    const approvedCustomer = store.seedUser({
      email: 'approved.cust@balancevault.test',
      fullName: 'Approved Customer',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });

    const adminSession = await loginSeeded(app, admin.email, 'StrongPass#2026');
    const approvedSession = await loginSeeded(
      app,
      approvedCustomer.email,
      'StrongPass#2026',
    );

    // Customer cannot create account
    const customerAttempt = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', approvedSession.cookies)
      .set('X-CSRF-Token', approvedSession.csrfToken)
      .send({
        ownerUserId: approvedCustomer.id,
        accountName: 'Self Created Vault',
        initialCreditMinor: '50000',
        reason: 'Customer trying to call admin endpoint',
      });
    expect(customerAttempt.status).toBe(403);

    // Cannot create account for non-approved customer
    const unapprovedAttempt = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminSession.cookies)
      .set('X-CSRF-Token', adminSession.csrfToken)
      .send({
        ownerUserId: pendingCustomer.id,
        accountName: 'Unapproved Vault',
        initialCreditMinor: '0',
        reason: 'Trying to provision unapproved customer',
      });
    expect(unapprovedAttempt.status).toBe(409);
    expect(unapprovedAttempt.body.error.code).toBe('CUSTOMER_NOT_ELIGIBLE');

    // Cannot open PENDING account with opening balance > 0
    const pendingWithCredit = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminSession.cookies)
      .set('X-CSRF-Token', adminSession.csrfToken)
      .send({
        ownerUserId: approvedCustomer.id,
        accountName: 'Pending Funded Vault',
        initialStatus: AccountStatus.PENDING,
        initialCreditMinor: '10000',
        reason: 'Invalid initial credit on pending account',
      });
    expect(pendingWithCredit.status).toBe(400);

    // Valid creation with ₹1,500.00 (150000 minor) opening synthetic allocation
    const created = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminSession.cookies)
      .set('X-CSRF-Token', adminSession.csrfToken)
      .send({
        ownerUserId: approvedCustomer.id,
        accountName: 'Primary Synthetic Vault',
        initialCreditMinor: '150000',
        reason: 'Approved hackathon demo allocation',
      });
    expect(created.status).toBe(201);
    expect(created.body.account.balanceMinor).toBe('150000');
    expect(created.body.account.status).toBe(AccountStatus.ACTIVE);
    expect(created.body.openingTransaction.type).toBe(JournalTransactionType.ADJUSTMENT);
    expect(created.body.openingTransaction.entries).toHaveLength(2);

    // Reconcile every account (customer + BV-SYS-TREASURY-01)
    const rows = await store.reconcileAccounts();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.projectedBalanceMinor).toBe(row.journalDerivedBalanceMinor);
    }

    // Also create a PENDING account and activate it
    const pendingCreated = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminSession.cookies)
      .set('X-CSRF-Token', adminSession.csrfToken)
      .send({
        ownerUserId: approvedCustomer.id,
        accountName: 'Secondary Pending Vault',
        initialStatus: AccountStatus.PENDING,
        initialCreditMinor: '0',
        reason: 'Provision pending demo account for activation test',
      });
    expect(pendingCreated.status).toBe(201);
    const secondaryId = pendingCreated.body.account.id as string;

    const activateRes = await request(app)
      .post(`/api/admin/accounts/${secondaryId}/activate`)
      .set('Cookie', adminSession.cookies)
      .set('X-CSRF-Token', adminSession.csrfToken)
      .send({ reason: 'Activating verified secondary vault' });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.account.status).toBe(AccountStatus.ACTIVE);
  });

  it('prevents IDOR across accounts, ledgers, transactions, and transfers while obscuring counterparty private fields', async () => {
    const { app, store } = buildLedgerHarness();
    const passwordHash = await hashPassword('StrongPass#2026');

    const admin = store.seedUser({
      email: 'admin.idor@balancevault.test',
      fullName: 'IDOR Admin',
      passwordHash,
      role: UserRole.ADMIN,
    });
    const custA = store.seedUser({
      email: 'cust.a@balancevault.test',
      fullName: 'Customer A',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });
    const custB = store.seedUser({
      email: 'cust.b@balancevault.test',
      fullName: 'Customer B',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });
    const custC = store.seedUser({
      email: 'cust.c@balancevault.test',
      fullName: 'Customer C',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });

    const adminAuth = await loginSeeded(app, admin.email, 'StrongPass#2026');
    const authA = await loginSeeded(app, custA.email, 'StrongPass#2026');
    const authB = await loginSeeded(app, custB.email, 'StrongPass#2026');
    const authC = await loginSeeded(app, custC.email, 'StrongPass#2026');

    const accARes = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({
        ownerUserId: custA.id,
        accountName: 'Alpha Private Secret Name',
        initialCreditMinor: '500000',
        reason: 'Open Customer A account',
      });
    const accBRes = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({
        ownerUserId: custB.id,
        accountName: 'Beta Private Secret Name',
        initialCreditMinor: '100000',
        reason: 'Open Customer B account',
      });

    const accA = accARes.body.account as { id: string; publicReference: string };
    const accB = accBRes.body.account as { id: string; publicReference: string };

    // Customer A listing only shows Customer A account (ignores SYSTEM_ISSUANCE, rejects ownerUserId probe)
    const listA = await request(app).get('/api/accounts').set('Cookie', authA.cookies);
    expect(listA.status).toBe(200);
    expect(listA.body.total).toBe(1);
    expect(listA.body.items[0].id).toBe(accA.id);

    const probeOtherList = await request(app)
      .get(`/api/accounts?ownerUserId=${custB.id}`)
      .set('Cookie', authA.cookies);
    expect(probeOtherList.status).toBe(403);

    // Customer A cannot read Customer B's account or ledger
    expect(
      (await request(app).get(`/api/accounts/${accB.id}`).set('Cookie', authA.cookies))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/accounts/${accB.id}/ledger`)
          .set('Cookie', authA.cookies)
      ).status,
    ).toBe(404);

    // Customer A cannot transfer OUT OF Customer B's account
    const stolenSourceTransfer = await request(app)
      .post('/api/transfers')
      .set('Cookie', authA.cookies)
      .set('X-CSRF-Token', authA.csrfToken)
      .set('Idempotency-Key', 'stolen-source-attempt-key-12345')
      .send({
        sourceAccountId: accB.id,
        destinationAccountReference: accA.publicReference,
        amountMinor: '10000',
        description: 'Attempted IDOR transfer',
      });
    expect(stolenSourceTransfer.status).toBe(404);

    // Legitimate A -> B transfer succeeds and hides B's private accountName/id in A's txn view
    const validTransfer = await request(app)
      .post('/api/transfers')
      .set('Cookie', authA.cookies)
      .set('X-CSRF-Token', authA.csrfToken)
      .set('Idempotency-Key', 'valid-transfer-key-abcdef123456')
      .send({
        sourceAccountId: accA.id,
        destinationAccountReference: accB.publicReference,
        amountMinor: '125000',
        description: 'Synthetic vendor demo settlement',
      });
    expect(validTransfer.status).toBe(201);
    const txnId = validTransfer.body.transaction.id as string;

    const txnAsA = await request(app)
      .get(`/api/transactions/${txnId}`)
      .set('Cookie', authA.cookies);
    expect(txnAsA.status).toBe(200);
    const debitLeg = txnAsA.body.transaction.entries.find(
      (e: { direction: string }) => e.direction === 'DEBIT',
    );
    const creditLeg = txnAsA.body.transaction.entries.find(
      (e: { direction: string }) => e.direction === 'CREDIT',
    );
    expect(debitLeg.accountName).toBe('Alpha Private Secret Name');
    expect(creditLeg.accountPublicReference).toBe(accB.publicReference);
    expect(creditLeg.accountName).toBeNull();
    expect(creditLeg.accountId).toBeNull();

    // Recipient Customer B can also inspect the transaction with A's private name/id redacted
    const txnAsB = await request(app)
      .get(`/api/transactions/${txnId}`)
      .set('Cookie', authB.cookies);
    expect(txnAsB.status).toBe(200);
    const debitLegAsB = txnAsB.body.transaction.entries.find(
      (e: { direction: string }) => e.direction === 'DEBIT',
    );
    const creditLegAsB = txnAsB.body.transaction.entries.find(
      (e: { direction: string }) => e.direction === 'CREDIT',
    );
    expect(creditLegAsB.accountName).toBe('Beta Private Secret Name');
    expect(debitLegAsB.accountPublicReference).toBe(accA.publicReference);
    expect(debitLegAsB.accountName).toBeNull();
    expect(debitLegAsB.accountId).toBeNull();

    // Non-participant Customer C cannot view A<->B transaction
    const txnAsC = await request(app)
      .get(`/api/transactions/${txnId}`)
      .set('Cookie', authC.cookies);
    expect(txnAsC.status).toBe(404);
  });

  it('enforces idempotency replay, payload mismatch conflict, insufficient funds, concurrency lock, freeze/close, and reversals', async () => {
    const { app, store } = buildLedgerHarness();
    const passwordHash = await hashPassword('StrongPass#2026');

    const admin = store.seedUser({
      email: 'admin.ops@balancevault.test',
      fullName: 'Ledger Admin',
      passwordHash,
      role: UserRole.ADMIN,
    });
    const cust1 = store.seedUser({
      email: 'sender@balancevault.test',
      fullName: 'Sender One',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });
    const cust2 = store.seedUser({
      email: 'receiver@balancevault.test',
      fullName: 'Receiver Two',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });

    const adminAuth = await loginSeeded(app, admin.email, 'StrongPass#2026');
    const senderAuth = await loginSeeded(app, cust1.email, 'StrongPass#2026');
    const receiverAuth = await loginSeeded(app, cust2.email, 'StrongPass#2026');

    const sRes = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({
        ownerUserId: cust1.id,
        accountName: 'Sender Main Vault',
        initialCreditMinor: '100000', // ₹1,000.00
        reason: 'Initial demo balance for sender',
      });
    const rRes = await request(app)
      .post('/api/admin/accounts')
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({
        ownerUserId: cust2.id,
        accountName: 'Receiver Main Vault',
        initialCreditMinor: '20000', // ₹200.00
        reason: 'Initial demo balance for receiver',
      });
    const senderAcc = sRes.body.account as { id: string; publicReference: string };
    const receiverAcc = rRes.body.account as { id: string; publicReference: string };

    // Missing / short Idempotency-Key -> 400 with fieldErrors.idempotencyKey
    const missingKey = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '1000',
        description: 'Missing key test',
      });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.fieldErrors.idempotencyKey).toBeTruthy();

    // Decimal / zero / negative amountMinor rejected
    const decimalRes = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', 'decimal-check-key-123456')
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '10.50',
        description: 'Decimal rejected',
      });
    expect(decimalRes.status).toBe(400);

    // Same-account transfer rejected (422)
    const sameRes = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', 'same-account-key-123456')
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: senderAcc.publicReference,
        amountMinor: '5000',
        description: 'Same account test',
      });
    expect(sameRes.status).toBe(422);
    expect(sameRes.body.error.code).toBe('SAME_ACCOUNT_TRANSFER');

    // Insufficient funds rejected (422) and audited as TRANSFER_REJECTED
    const overdrawRes = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', 'overdraw-check-key-123456')
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '999999',
        description: 'Overdraw attempt',
      });
    expect(overdrawRes.status).toBe(422);
    expect(overdrawRes.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(
      store.auditEvents.some((e) => e.action === 'TRANSFER_REJECTED'),
    ).toBe(true);

    // Post ₹300.00 (30000 minor) transfer + verify idempotent replay + mismatch rejection
    const idemKey = 'idempotent-transfer-key-000001';
    const firstPost = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', idemKey)
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '30000',
        description: 'Initial valid payment',
      });
    expect(firstPost.status).toBe(201);
    expect(firstPost.body.idempotentReplay).toBe(false);
    expect(firstPost.body.sourceAccount.balanceMinor).toBe('70000');
    const postedTxnId = firstPost.body.transaction.id as string;

    const replayPost = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', idemKey)
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '30000',
        description: 'Initial valid payment',
      });
    expect(replayPost.status).toBe(201);
    expect(replayPost.body.idempotentReplay).toBe(true);
    expect(replayPost.headers['x-idempotent-replay']).toBe('true');
    expect(replayPost.body.transaction.id).toBe(postedTxnId);

    const mismatchPost = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', idemKey)
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '40000',
        description: 'Initial valid payment',
      });
    expect(mismatchPost.status).toBe(409);
    expect(mismatchPost.body.error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    );

    // Concurrent race test: sender has ₹700.00 (70000 minor); send 4 parallel ₹300.00 transfers -> max 2 succeed
    const concurrentResponses = await Promise.all(
      [1, 2, 3, 4].map((idx) =>
        request(app)
          .post('/api/transfers')
          .set('Cookie', senderAuth.cookies)
          .set('X-CSRF-Token', senderAuth.csrfToken)
          .set('Idempotency-Key', `concurrent-race-key-${idx}-000000`)
          .send({
            sourceAccountId: senderAcc.id,
            destinationAccountReference: receiverAcc.publicReference,
            amountMinor: '30000',
            description: `Concurrent race #${idx}`,
          }),
      ),
    );
    const successes = concurrentResponses.filter((r) => r.status === 201);
    const insufficient = concurrentResponses.filter(
      (r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_FUNDS',
    );
    expect(successes).toHaveLength(2);
    expect(insufficient).toHaveLength(2);

    // Verify sender balance is ₹100.00 (10000) and receiver has ₹1,100.00 (110000)
    const senderCheck = await request(app)
      .get(`/api/accounts/${senderAcc.id}`)
      .set('Cookie', senderAuth.cookies);
    expect(senderCheck.body.account.balanceMinor).toBe('10000');

    // Customer cannot reverse; Admin reverses the first postedTxnId (₹300.00)
    const custReverse = await request(app)
      .post(`/api/transactions/${postedTxnId}/reverse`)
      .set('Cookie', receiverAuth.cookies)
      .set('X-CSRF-Token', receiverAuth.csrfToken)
      .send({ reason: 'Unauthorized reversal attempt' });
    expect(custReverse.status).toBe(403);

    const adminReverse = await request(app)
      .post(`/api/transactions/${postedTxnId}/reverse`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Duplicate settlement reversal demonstration' });
    expect(adminReverse.status).toBe(201);
    expect(adminReverse.body.reversedTransactionId).toBe(postedTxnId);
    expect(adminReverse.body.reversedTransactionStatus).toBe(
      JournalTransactionStatus.REVERSED,
    );
    const reversalId = adminReverse.body.reversalTransaction.id as string;

    // Double-reversal & reversal-of-reversal blocked cleanly
    const secondReverse = await request(app)
      .post(`/api/transactions/${postedTxnId}/reverse`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Double reversal should return 409 conflict' });
    expect(secondReverse.status).toBe(409);
    expect(secondReverse.body.error.code).toBe('TRANSACTION_ALREADY_REVERSED');

    const reverseOfReversal = await request(app)
      .post(`/api/transactions/${reversalId}/reverse`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Reversal of reversal should return 409 conflict' });
    expect(reverseOfReversal.status).toBe(409);
    expect(reverseOfReversal.body.error.code).toBe('CANNOT_REVERSE_REVERSAL');

    // Freeze blocks transfer, close rejects non-zero balance, unfreeze restores transfer
    const freezeRes = await request(app)
      .post(`/api/admin/accounts/${senderAcc.id}/freeze`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Compliance hold pending verification check' });
    expect(freezeRes.status).toBe(200);
    expect(freezeRes.body.account.status).toBe(AccountStatus.FROZEN);

    const blockedByFreeze = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', 'frozen-blocked-transfer-12345')
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '5000',
        description: 'Transfer while frozen',
      });
    expect(blockedByFreeze.status).toBe(409);
    expect(blockedByFreeze.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');

    const closeNonZero = await request(app)
      .post(`/api/admin/accounts/${senderAcc.id}/close`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Attempt to close account with remaining funds' });
    expect(closeNonZero.status).toBe(409);
    expect(closeNonZero.body.error.code).toBe('ACCOUNT_BALANCE_NON_ZERO');

    const unfreezeRes = await request(app)
      .post(`/api/admin/accounts/${senderAcc.id}/unfreeze`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Hold cleared by compliance team' });
    expect(unfreezeRes.status).toBe(200);
    expect(unfreezeRes.body.account.status).toBe(AccountStatus.ACTIVE);

    // Drain exact ₹400.00 (40000 minor) to 0 so account can close cleanly
    const drainRes = await request(app)
      .post('/api/transfers')
      .set('Cookie', senderAuth.cookies)
      .set('X-CSRF-Token', senderAuth.csrfToken)
      .set('Idempotency-Key', 'drain-sender-account-key-1234')
      .send({
        sourceAccountId: senderAcc.id,
        destinationAccountReference: receiverAcc.publicReference,
        amountMinor: '40000',
        description: 'Drain vault before closing',
      });
    expect(drainRes.status).toBe(201);
    expect(drainRes.body.sourceAccount.balanceMinor).toBe('0');

    const closeZeroRes = await request(app)
      .post(`/api/admin/accounts/${senderAcc.id}/close`)
      .set('Cookie', adminAuth.cookies)
      .set('X-CSRF-Token', adminAuth.csrfToken)
      .send({ reason: 'Customer requested synthetic account closure' });
    expect(closeZeroRes.status).toBe(200);
    expect(closeZeroRes.body.account.status).toBe(AccountStatus.CLOSED);

    // Ledger + Summary + Full Reconciliation check
    const ledgerRes = await request(app)
      .get(`/api/accounts/${senderAcc.id}/ledger`)
      .set('Cookie', senderAuth.cookies);
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body.total).toBe(6);

    const summaryRes = await request(app)
      .get('/api/admin/summary')
      .set('Cookie', adminAuth.cookies);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.activeAccounts).toBe(1);
    expect(summaryRes.body.closedAccounts).toBe(1);
    expect(summaryRes.body.demoTransactionsTotal).toBe(7);

    const reconcile = await store.reconcileAccounts();
    for (const r of reconcile) {
      expect(r.projectedBalanceMinor).toBe(r.journalDerivedBalanceMinor);
    }
    const customerSum = reconcile
      .filter((r) => r.kind === AccountKind.CUSTOMER)
      .reduce((acc, r) => acc + r.projectedBalanceMinor, 0n);
    const treasury = reconcile.find((r) => r.kind === AccountKind.SYSTEM_ISSUANCE)!;
    expect(customerSum + treasury.projectedBalanceMinor).toBe(0n);
  });

  it('enforces transfer rate limiting and fails closed with 503 when Redis is unavailable', async () => {
    const { app, store } = buildLedgerHarness({ transferMax: 2 });
    const passwordHash = await hashPassword('StrongPass#2026');

    const admin = store.seedUser({
      email: 'admin.rl@balancevault.test',
      fullName: 'RL Admin',
      passwordHash,
      role: UserRole.ADMIN,
    });
    const cust = store.seedUser({
      email: 'cust.rl@balancevault.test',
      fullName: 'RL Customer',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });
    const dest = store.seedUser({
      email: 'dest.rl@balancevault.test',
      fullName: 'RL Dest',
      passwordHash,
      role: UserRole.CUSTOMER,
      onboardingStatus: OnboardingStatus.APPROVED,
    });

    const adminAuth = await loginSeeded(app, admin.email, 'StrongPass#2026');
    const custAuth = await loginSeeded(app, cust.email, 'StrongPass#2026');

    const sAcc = (
      await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminAuth.cookies)
        .set('X-CSRF-Token', adminAuth.csrfToken)
        .send({
          ownerUserId: cust.id,
          accountName: 'RL Sender',
          initialCreditMinor: '50000',
          reason: 'Rate limit test',
        })
    ).body.account;

    const dAcc = (
      await request(app)
        .post('/api/admin/accounts')
        .set('Cookie', adminAuth.cookies)
        .set('X-CSRF-Token', adminAuth.csrfToken)
        .send({
          ownerUserId: dest.id,
          accountName: 'RL Receiver',
          initialCreditMinor: '0',
          reason: 'Rate limit dest',
        })
    ).body.account;

    for (const idx of [1, 2]) {
      const ok = await request(app)
        .post('/api/transfers')
        .set('Cookie', custAuth.cookies)
        .set('X-CSRF-Token', custAuth.csrfToken)
        .set('Idempotency-Key', `rl-transfer-key-000000${idx}`)
        .send({
          sourceAccountId: sAcc.id,
          destinationAccountReference: dAcc.publicReference,
          amountMinor: '1000',
          description: `RL transfer ${idx}`,
        });
      expect(ok.status).toBe(201);
    }

    const third = await request(app)
      .post('/api/transfers')
      .set('Cookie', custAuth.cookies)
      .set('X-CSRF-Token', custAuth.csrfToken)
      .set('Idempotency-Key', 'rl-transfer-key-0000003')
      .send({
        sourceAccountId: sAcc.id,
        destinationAccountReference: dAcc.publicReference,
        amountMinor: '1000',
        description: 'RL transfer blocked',
      });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');

    // Outage fail-closed harness
    const outageHarness = buildLedgerHarness({
      rateLimitStore: {
        async incrementWindow() {
          throw new Error('ECONNREFUSED redis down');
        },
      },
    });
    const outAdmin = outageHarness.store.seedUser({
      email: 'out.admin@balancevault.test',
      fullName: 'Out Admin',
      passwordHash,
      role: UserRole.ADMIN,
    });
    const outCust = outageHarness.store.seedUser({
      email: 'out.cust@balancevault.test',
      fullName: 'Out Cust',
      passwordHash,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      onboardingStatus: OnboardingStatus.APPROVED,
    });
    const outCustCookies = extractCookies(
      await request(outageHarness.app)
        .post('/api/auth/login')
        .set('Cookie', [])
        .send({ email: outCust.email, password: 'StrongPass#2026' }),
    );
    // Login above will fail closed with 503 too when Redis is down!
    expect(outCustCookies).toEqual([]);
    const outRes = await request(outageHarness.app).post('/api/auth/login').send({
      email: outAdmin.email,
      password: 'StrongPass#2026',
    });
    expect(outRes.status).toBe(503);
    expect(outRes.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
