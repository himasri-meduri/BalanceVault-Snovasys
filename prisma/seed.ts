import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import argon2 from 'argon2';
import {
  AccountKind,
  AccountStatus,
  ActorType,
  EntryDirection,
  JournalTransactionStatus,
  JournalTransactionType,
  OnboardingStatus,
  PrismaClient,
  UserRole,
  UserStatus,
} from '@prisma/client';

const rootDir = resolve(import.meta.dirname, '..');
const envPath = resolve(rootDir, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Refusing to run demo seed in production without ALLOW_DEMO_SEED=true.');
  process.exit(1);
}

const demoPassword =
  process.env.SEED_DEMO_PASSWORD || (isProduction ? '' : 'DemoUser#2026');
if (!demoPassword || demoPassword.length < 10) {
  console.error(
    'SEED_DEMO_PASSWORD must be provided (min 10 chars) when running seed in production.',
  );
  process.exit(1);
}

const prisma = new PrismaClient();

async function ensureTreasuryAccount() {
  const existing = await prisma.account.findUnique({
    where: { publicReference: 'BV-SYS-TREASURY-01' },
  });
  if (existing) {
    return existing;
  }

  return prisma.account.create({
    data: {
      publicReference: 'BV-SYS-TREASURY-01',
      kind: AccountKind.SYSTEM_ISSUANCE,
      ownerUserId: null,
      accountName: 'Synthetic Demo Issuance Reserve',
      currency: 'INR',
      status: AccountStatus.ACTIVE,
      balanceMinor: 0n,
      statusReason: 'System double-entry synthetic issuance source',
    },
  });
}

async function ensureCustomer(params: {
  email: string;
  fullName: string;
  passwordHash: string;
  onboardingStatus: OnboardingStatus;
  city: string;
  accountPurpose: string;
  reviewReason?: string;
}) {
  const normalizedEmail = params.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { onboardingApplication: true },
  });

  if (existing) {
    return existing;
  }

  const now = new Date();
  const isReviewed =
    params.onboardingStatus === OnboardingStatus.APPROVED ||
    params.onboardingStatus === OnboardingStatus.REJECTED;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        fullName: params.fullName,
        passwordHash: params.passwordHash,
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      },
    });

    await tx.onboardingApplication.create({
      data: {
        userId: user.id,
        status: params.onboardingStatus,
        contactReference: '+91-90000-00000',
        city: params.city,
        country: 'IN',
        accountPurpose: params.accountPurpose,
        acceptedSyntheticTerms: true,
        submittedAt:
          params.onboardingStatus === OnboardingStatus.DRAFT ? null : now,
        reviewedAt: isReviewed ? now : null,
        reviewReason: params.reviewReason ?? null,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorUserId: null,
        actorType: ActorType.SYSTEM,
        action: 'SEED_CUSTOMER_CREATED',
        entityType: 'User',
        entityId: user.id,
        requestId: `seed-${crypto.randomUUID()}`,
        reason: 'Synthetic demo seed data initialization',
        afterState: {
          role: UserRole.CUSTOMER,
          onboardingStatus: params.onboardingStatus,
        },
      },
    });

    return tx.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { onboardingApplication: true },
    });
  });
}

async function ensureFundedAccount(params: {
  publicReference: string;
  ownerUserId: string;
  accountName: string;
  targetStatus: AccountStatus;
  statusReason?: string;
  initialCreditMinor: bigint;
  treasuryAccountId: string;
  seedTxnReference: string;
}) {
  const existing = await prisma.account.findUnique({
    where: { publicReference: params.publicReference },
  });
  if (existing) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: {
        publicReference: params.publicReference,
        kind: AccountKind.CUSTOMER,
        ownerUserId: params.ownerUserId,
        accountName: params.accountName,
        currency: 'INR',
        status: params.targetStatus,
        balanceMinor: params.initialCreditMinor,
        statusReason: params.statusReason ?? null,
      },
    });

    if (params.initialCreditMinor > 0n) {
      await tx.account.update({
        where: { id: params.treasuryAccountId },
        data: {
          balanceMinor: { decrement: params.initialCreditMinor },
          version: { increment: 1 },
        },
      });

      const txn = await tx.journalTransaction.create({
        data: {
          publicReference: params.seedTxnReference,
          type: JournalTransactionType.ADJUSTMENT,
          status: JournalTransactionStatus.POSTED,
          currency: 'INR',
          description: `Synthetic demo opening allocation for ${params.publicReference}`,
          initiatedByUserId: null,
          metadata: { syntheticSeed: true },
        },
      });

      await tx.journalEntry.createMany({
        data: [
          {
            transactionId: txn.id,
            accountId: params.treasuryAccountId,
            direction: EntryDirection.DEBIT,
            amountMinor: params.initialCreditMinor,
            currency: 'INR',
          },
          {
            transactionId: txn.id,
            accountId: account.id,
            direction: EntryDirection.CREDIT,
            amountMinor: params.initialCreditMinor,
            currency: 'INR',
          },
        ],
      });

      await tx.auditEvent.create({
        data: {
          actorUserId: null,
          actorType: ActorType.SYSTEM,
          action: 'SEED_ACCOUNT_FUNDED',
          entityType: 'Account',
          entityId: account.id,
          requestId: `seed-${crypto.randomUUID()}`,
          reason: 'Synthetic demo opening balance allocation',
          afterState: {
            publicReference: account.publicReference,
            status: account.status,
            balanceMinor: params.initialCreditMinor.toString(),
          },
        },
      });
    }

    return account;
  });
}

async function ensureSampleTransfer(params: {
  sourceAccountId: string;
  destinationAccountId: string;
  initiatedByUserId: string;
}) {
  const existing = await prisma.journalTransaction.findUnique({
    where: { publicReference: 'TXN-SEED-DEMO-0001' },
  });
  if (existing) {
    return existing;
  }

  const amountMinor = 150000n; // ₹1,500.00

  return prisma.$transaction(async (tx) => {
    await tx.account.update({
      where: { id: params.sourceAccountId },
      data: {
        balanceMinor: { decrement: amountMinor },
        version: { increment: 1 },
      },
    });

    await tx.account.update({
      where: { id: params.destinationAccountId },
      data: {
        balanceMinor: { increment: amountMinor },
        version: { increment: 1 },
      },
    });

    const txn = await tx.journalTransaction.create({
      data: {
        publicReference: 'TXN-SEED-DEMO-0001',
        type: JournalTransactionType.DEMO_TRANSFER,
        status: JournalTransactionStatus.POSTED,
        currency: 'INR',
        description: 'Synthetic demo transfer between approved accounts',
        initiatedByUserId: params.initiatedByUserId,
        idempotencyKey: 'seed-demo-transfer-0001',
        metadata: { syntheticSeed: true },
      },
    });

    await tx.journalEntry.createMany({
      data: [
        {
          transactionId: txn.id,
          accountId: params.sourceAccountId,
          direction: EntryDirection.DEBIT,
          amountMinor,
          currency: 'INR',
        },
        {
          transactionId: txn.id,
          accountId: params.destinationAccountId,
          direction: EntryDirection.CREDIT,
          amountMinor,
          currency: 'INR',
        },
      ],
    });

    await tx.auditEvent.create({
      data: {
        actorUserId: params.initiatedByUserId,
        actorType: ActorType.USER,
        action: 'TRANSFER_POSTED',
        entityType: 'JournalTransaction',
        entityId: txn.id,
        requestId: `seed-${crypto.randomUUID()}`,
        reason: 'Synthetic demo seed transfer',
        afterState: {
          publicReference: txn.publicReference,
          amountMinor: amountMinor.toString(),
        },
      },
    });

    return txn;
  });
}

async function main() {
  const passwordHash = await argon2.hash(demoPassword, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const treasury = await ensureTreasuryAccount();

  const ananya = await ensureCustomer({
    email: 'ananya.sharma@balancevault.test',
    fullName: 'Ananya Sharma',
    passwordHash,
    onboardingStatus: OnboardingStatus.APPROVED,
    city: 'Bengaluru',
    accountPurpose: 'Synthetic personal budgeting ledger demo',
  });

  const rohan = await ensureCustomer({
    email: 'rohan.verma@balancevault.test',
    fullName: 'Rohan Verma',
    passwordHash,
    onboardingStatus: OnboardingStatus.APPROVED,
    city: 'Hyderabad',
    accountPurpose: 'Synthetic internal transfer walkthrough',
  });

  await ensureCustomer({
    email: 'priya.nair@balancevault.test',
    fullName: 'Priya Nair',
    passwordHash,
    onboardingStatus: OnboardingStatus.PENDING,
    city: 'Kochi',
    accountPurpose: 'Pending onboarding review demonstration',
  });

  await ensureCustomer({
    email: 'vikram.rao@balancevault.test',
    fullName: 'Vikram Rao',
    passwordHash,
    onboardingStatus: OnboardingStatus.REJECTED,
    city: 'Pune',
    accountPurpose: 'Testing rejected onboarding resubmission',
    reviewReason: 'Incomplete demo purpose description; please update and resubmit.',
  });

  const ananyaActive = await ensureFundedAccount({
    publicReference: 'BV-IND-1001-8842',
    ownerUserId: ananya.id,
    accountName: 'Primary Demo Vault',
    targetStatus: AccountStatus.ACTIVE,
    initialCreditMinor: 2500000n, // ₹25,000.00
    treasuryAccountId: treasury.id,
    seedTxnReference: 'TXN-SEED-ALLOC-1001',
  });

  await ensureFundedAccount({
    publicReference: 'BV-IND-1002-4419',
    ownerUserId: ananya.id,
    accountName: 'Reserve Demo Vault (Frozen)',
    targetStatus: AccountStatus.FROZEN,
    statusReason: 'Demo compliance hold for testing frozen transfer rejection',
    initialCreditMinor: 500000n, // ₹5,000.00
    treasuryAccountId: treasury.id,
    seedTxnReference: 'TXN-SEED-ALLOC-1002',
  });

  const rohanActive = await ensureFundedAccount({
    publicReference: 'BV-IND-2001-7731',
    ownerUserId: rohan.id,
    accountName: 'Everyday Demo Vault',
    targetStatus: AccountStatus.ACTIVE,
    initialCreditMinor: 1200000n, // ₹12,000.00
    treasuryAccountId: treasury.id,
    seedTxnReference: 'TXN-SEED-ALLOC-2001',
  });

  await ensureSampleTransfer({
    sourceAccountId: ananyaActive.id,
    destinationAccountId: rohanActive.id,
    initiatedByUserId: ananya.id,
  });

  if (process.env.SEED_INCLUDE_DEMO_ADMIN === 'true') {
    const reviewerEmail = 'reviewer.demo@balancevault.test';
    const existingReviewer = await prisma.user.findUnique({
      where: { email: reviewerEmail },
    });
    if (!existingReviewer) {
      await prisma.user.create({
        data: {
          email: reviewerEmail,
          fullName: 'Demo Compliance Reviewer',
          passwordHash,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
    }
  }

  console.log('BalanceVault synthetic demo seed completed successfully.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
