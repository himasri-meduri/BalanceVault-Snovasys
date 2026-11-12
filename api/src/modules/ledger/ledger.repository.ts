import {
  AccountKind,
  AccountStatus,
  EntryDirection,
  JournalTransactionStatus,
  JournalTransactionType,
  OnboardingStatus,
  Prisma,
  UserRole,
  type PrismaClient,
} from '@prisma/client';
import type { CreateAuditEventInput } from '../audit/audit.types.js';
import type { UserRecord } from '../auth/auth.types.js';
import type {
  AccountLedgerItemRecord,
  AccountReconciliationRow,
  AccountRecord,
  AdminSummaryCounts,
  IdempotencyRecordData,
  JournalTransactionRecord,
} from './ledger.types.js';

export class IdempotencyKeyRaceError extends Error {
  constructor() {
    super('Concurrent idempotency key insertion conflict');
    this.name = 'IdempotencyKeyRaceError';
  }
}

export class ReversalAlreadyExistsError extends Error {
  constructor() {
    super('Transaction already has a compensating reversal');
    this.name = 'ReversalAlreadyExistsError';
  }
}

export class AccountReferenceCollisionError extends Error {
  constructor() {
    super('Account publicReference collision');
    this.name = 'AccountReferenceCollisionError';
  }
}

export class TransactionReferenceCollisionError extends Error {
  constructor() {
    super('Transaction publicReference collision');
    this.name = 'TransactionReferenceCollisionError';
  }
}

export interface CreatePostedJournalTransactionInput {
  publicReference: string;
  type: JournalTransactionType;
  description: string;
  idempotencyKey?: string | null;
  initiatedByUserId: string | null;
  reversalOfTransactionId?: string | null;
  metadata?: Record<string, unknown> | null;
  entries: Array<{
    accountId: string;
    direction: EntryDirection;
    amountMinor: bigint;
  }>;
}

export interface LedgerTxContext {
  findUserById(userId: string): Promise<UserRecord | null>;
  findAccountById(id: string): Promise<AccountRecord | null>;
  findAccountByPublicReference(publicReference: string): Promise<AccountRecord | null>;
  findOrCreateSystemTreasuryAccount(): Promise<AccountRecord>;
  lockAccountsByIds(accountIds: string[]): Promise<AccountRecord[]>;
  createAccount(params: {
    publicReference: string;
    kind: AccountKind;
    ownerUserId: string | null;
    accountName: string;
    status: AccountStatus;
    balanceMinor: bigint;
    statusReason: string | null;
  }): Promise<AccountRecord>;
  updateAccountBalance(
    accountId: string,
    newBalanceMinor: bigint,
  ): Promise<AccountRecord>;
  updateAccountStatusIfMatches(params: {
    accountId: string;
    expectedStatuses: AccountStatus[];
    newStatus: AccountStatus;
    statusReason: string;
    requireZeroBalance?: boolean;
  }): Promise<AccountRecord | null>;
  findTransactionById(transactionId: string): Promise<JournalTransactionRecord | null>;
  createPostedJournalTransaction(
    input: CreatePostedJournalTransactionInput,
  ): Promise<JournalTransactionRecord>;
  findIdempotencyRecord(
    actorUserId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRecordData | null>;
  deleteIdempotencyRecord(id: string): Promise<void>;
  createIdempotencyRecord(params: {
    actorUserId: string;
    scope: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    transactionId: string | null;
    expiresAt: Date;
  }): Promise<IdempotencyRecordData>;
  createAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }>;
}

export interface ListAccountsParams {
  ownerUserId?: string;
  status?: AccountStatus;
  search?: string;
  includeSystem?: boolean;
  includeOwnerDetails?: boolean;
  page: number;
  pageSize: number;
}

export interface ListLedgerEntriesParams {
  accountId: string;
  direction?: EntryDirection;
  type?: JournalTransactionType;
  page: number;
  pageSize: number;
}

export interface LedgerRepository {
  runInTransaction<T>(fn: (tx: LedgerTxContext) => Promise<T>): Promise<T>;
  listAccounts(
    params: ListAccountsParams,
  ): Promise<{ items: AccountRecord[]; total: number }>;
  findAccountById(
    id: string,
    options?: { includeOwnerDetails?: boolean },
  ): Promise<AccountRecord | null>;
  listAccountLedgerEntries(
    params: ListLedgerEntriesParams,
  ): Promise<{ items: AccountLedgerItemRecord[]; total: number }>;
  findTransactionById(transactionId: string): Promise<JournalTransactionRecord | null>;
  findIdempotencyRecord(
    actorUserId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRecordData | null>;
  createRejectedAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }>;
  getAdminSummaryCounts(): Promise<AdminSummaryCounts>;
  reconcileAccounts(accountIds?: string[]): Promise<AccountReconciliationRow[]>;
}

const accountWithOwnerSelect = {
  id: true,
  publicReference: true,
  kind: true,
  ownerUserId: true,
  accountName: true,
  currency: true,
  status: true,
  balanceMinor: true,
  version: true,
  statusReason: true,
  createdAt: true,
  updatedAt: true,
  owner: {
    select: {
      id: true,
      fullName: true,
      email: true,
      status: true,
      onboardingApplication: { select: { status: true } },
    },
  },
} satisfies Prisma.AccountSelect;

const accountPlainSelect = {
  id: true,
  publicReference: true,
  kind: true,
  ownerUserId: true,
  accountName: true,
  currency: true,
  status: true,
  balanceMinor: true,
  version: true,
  statusReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccountSelect;

const transactionIncludeSelect = {
  id: true,
  publicReference: true,
  type: true,
  status: true,
  currency: true,
  description: true,
  idempotencyKey: true,
  initiatedByUserId: true,
  reversalOfTransactionId: true,
  metadata: true,
  createdAt: true,
  reversalOfTransaction: {
    select: { id: true, publicReference: true },
  },
  reversedByTransaction: {
    select: { id: true, publicReference: true },
  },
  entries: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      transactionId: true,
      accountId: true,
      direction: true,
      amountMinor: true,
      currency: true,
      createdAt: true,
      account: {
        select: {
          publicReference: true,
          kind: true,
          accountName: true,
          ownerUserId: true,
        },
      },
    },
  },
} satisfies Prisma.JournalTransactionSelect;

function mapPlainAccount(
  row: Prisma.AccountGetPayload<{ select: typeof accountPlainSelect }>,
): AccountRecord {
  return {
    id: row.id,
    publicReference: row.publicReference,
    kind: row.kind,
    ownerUserId: row.ownerUserId,
    accountName: row.accountName,
    currency: row.currency,
    status: row.status,
    balanceMinor: BigInt(row.balanceMinor),
    version: row.version,
    statusReason: row.statusReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOwnerAccount(
  row: Prisma.AccountGetPayload<{ select: typeof accountWithOwnerSelect }>,
): AccountRecord {
  return {
    ...mapPlainAccount(row),
    owner: row.owner
      ? {
          id: row.owner.id,
          fullName: row.owner.fullName,
          email: row.owner.email,
          status: row.owner.status,
          onboardingStatus: row.owner.onboardingApplication?.status ?? null,
        }
      : undefined,
  };
}

function mapJournalTransaction(
  row: Prisma.JournalTransactionGetPayload<{
    select: typeof transactionIncludeSelect;
  }>,
): JournalTransactionRecord {
  return {
    id: row.id,
    publicReference: row.publicReference,
    type: row.type,
    recordedStatus: row.status,
    effectiveStatus: row.reversedByTransaction
      ? JournalTransactionStatus.REVERSED
      : row.status,
    currency: row.currency,
    description: row.description,
    idempotencyKey: row.idempotencyKey,
    initiatedByUserId: row.initiatedByUserId,
    reversalOfTransactionId: row.reversalOfTransactionId,
    reversalOfPublicReference: row.reversalOfTransaction?.publicReference ?? null,
    reversedByTransactionId: row.reversedByTransaction?.id ?? null,
    reversedByPublicReference: row.reversedByTransaction?.publicReference ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt,
    entries: row.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      accountId: entry.accountId,
      accountPublicReference: entry.account.publicReference,
      accountKind: entry.account.kind,
      accountName: entry.account.accountName,
      accountOwnerUserId: entry.account.ownerUserId,
      direction: entry.direction,
      amountMinor: BigInt(entry.amountMinor),
      currency: entry.currency,
      createdAt: entry.createdAt,
    })),
  };
}

function getUniqueConstraintTarget(err: Prisma.PrismaClientKnownRequestError): string {
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return target.join(',');
  }
  return typeof target === 'string' ? target : '';
}

class PrismaLedgerTxContext implements LedgerTxContext {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async findUserById(userId: string): Promise<UserRecord | null> {
    const user = await this.tx.user.findUnique({
      where: { id: userId },
      include: { onboardingApplication: { select: { status: true } } },
    });
    if (!user) {
      return null;
    }
    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      onboardingStatus: user.onboardingApplication?.status ?? null,
    };
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    const row = await this.tx.account.findUnique({
      where: { id },
      select: accountWithOwnerSelect,
    });
    return row ? mapOwnerAccount(row) : null;
  }

  async findAccountByPublicReference(
    publicReference: string,
  ): Promise<AccountRecord | null> {
    const row = await this.tx.account.findUnique({
      where: { publicReference },
      select: accountPlainSelect,
    });
    return row ? mapPlainAccount(row) : null;
  }

  async findOrCreateSystemTreasuryAccount(): Promise<AccountRecord> {
    const existing = await this.tx.account.findUnique({
      where: { publicReference: 'BV-SYS-TREASURY-01' },
      select: accountPlainSelect,
    });
    if (existing) {
      return mapPlainAccount(existing);
    }

    try {
      const created = await this.tx.account.create({
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
        select: accountPlainSelect,
      });
      return mapPlainAccount(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const refetched = await this.tx.account.findUniqueOrThrow({
          where: { publicReference: 'BV-SYS-TREASURY-01' },
          select: accountPlainSelect,
        });
        return mapPlainAccount(refetched);
      }
      throw err;
    }
  }

  async lockAccountsByIds(accountIds: string[]): Promise<AccountRecord[]> {
    const sortedIds = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
    if (sortedIds.length === 0) {
      return [];
    }

    const idParams = sortedIds.map((id) => Prisma.sql`${id}::uuid`);
    const rows = await this.tx.$queryRaw<
      Array<{
        id: string;
        publicReference: string;
        kind: AccountKind;
        ownerUserId: string | null;
        accountName: string;
        currency: string;
        status: AccountStatus;
        balanceMinor: bigint;
        version: number;
        statusReason: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(
      Prisma.sql`
        SELECT
          "id",
          "publicReference",
          "kind",
          "ownerUserId",
          "accountName",
          "currency",
          "status",
          "balanceMinor",
          "version",
          "statusReason",
          "createdAt",
          "updatedAt"
        FROM "Account"
        WHERE "id" IN (${Prisma.join(idParams)})
        ORDER BY "id" ASC
        FOR UPDATE
      `,
    );

    return rows.map((row) => ({
      ...row,
      balanceMinor: BigInt(row.balanceMinor),
    }));
  }

  async createAccount(params: {
    publicReference: string;
    kind: AccountKind;
    ownerUserId: string | null;
    accountName: string;
    status: AccountStatus;
    balanceMinor: bigint;
    statusReason: string | null;
  }): Promise<AccountRecord> {
    try {
      const row = await this.tx.account.create({
        data: {
          publicReference: params.publicReference,
          kind: params.kind,
          ownerUserId: params.ownerUserId,
          accountName: params.accountName,
          currency: 'INR',
          status: params.status,
          balanceMinor: params.balanceMinor,
          statusReason: params.statusReason,
        },
        select: accountWithOwnerSelect,
      });
      return mapOwnerAccount(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new AccountReferenceCollisionError();
      }
      throw err;
    }
  }

  async updateAccountBalance(
    accountId: string,
    newBalanceMinor: bigint,
  ): Promise<AccountRecord> {
    const row = await this.tx.account.update({
      where: { id: accountId },
      data: {
        balanceMinor: newBalanceMinor,
        version: { increment: 1 },
      },
      select: accountPlainSelect,
    });
    return mapPlainAccount(row);
  }

  async updateAccountStatusIfMatches(params: {
    accountId: string;
    expectedStatuses: AccountStatus[];
    newStatus: AccountStatus;
    statusReason: string;
    requireZeroBalance?: boolean;
  }): Promise<AccountRecord | null> {
    const result = await this.tx.account.updateMany({
      where: {
        id: params.accountId,
        kind: AccountKind.CUSTOMER,
        status: { in: params.expectedStatuses },
        ...(params.requireZeroBalance ? { balanceMinor: 0n } : {}),
      },
      data: {
        status: params.newStatus,
        statusReason: params.statusReason,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      return null;
    }

    const row = await this.tx.account.findUniqueOrThrow({
      where: { id: params.accountId },
      select: accountWithOwnerSelect,
    });
    return mapOwnerAccount(row);
  }

  async findTransactionById(
    transactionId: string,
  ): Promise<JournalTransactionRecord | null> {
    const row = await this.tx.journalTransaction.findUnique({
      where: { id: transactionId },
      select: transactionIncludeSelect,
    });
    return row ? mapJournalTransaction(row) : null;
  }

  async createPostedJournalTransaction(
    input: CreatePostedJournalTransactionInput,
  ): Promise<JournalTransactionRecord> {
    try {
      const txn = await this.tx.journalTransaction.create({
        data: {
          publicReference: input.publicReference,
          type: input.type,
          status: JournalTransactionStatus.POSTED,
          currency: 'INR',
          description: input.description,
          idempotencyKey: input.idempotencyKey ?? null,
          initiatedByUserId: input.initiatedByUserId,
          reversalOfTransactionId: input.reversalOfTransactionId ?? null,
          metadata: (input.metadata ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
        },
        select: { id: true },
      });

      await this.tx.journalEntry.createMany({
        data: input.entries.map((entry) => ({
          transactionId: txn.id,
          accountId: entry.accountId,
          direction: entry.direction,
          amountMinor: entry.amountMinor,
          currency: 'INR',
        })),
      });

      const created = await this.tx.journalTransaction.findUniqueOrThrow({
        where: { id: txn.id },
        select: transactionIncludeSelect,
      });
      return mapJournalTransaction(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = getUniqueConstraintTarget(err);
        if (target.includes('reversalOfTransactionId')) {
          throw new ReversalAlreadyExistsError();
        }
        throw new TransactionReferenceCollisionError();
      }
      throw err;
    }
  }

  async findIdempotencyRecord(
    actorUserId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRecordData | null> {
    const row = await this.tx.idempotencyRecord.findUnique({
      where: {
        actorUserId_scope_key: {
          actorUserId,
          scope,
          key,
        },
      },
    });
    if (!row) {
      return null;
    }
    return {
      ...row,
      responseBody: row.responseBody as Record<string, unknown>,
    };
  }

  async deleteIdempotencyRecord(id: string): Promise<void> {
    await this.tx.idempotencyRecord.deleteMany({
      where: { id },
    });
  }

  async createIdempotencyRecord(params: {
    actorUserId: string;
    scope: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    transactionId: string | null;
    expiresAt: Date;
  }): Promise<IdempotencyRecordData> {
    try {
      const created = await this.tx.idempotencyRecord.create({
        data: {
          actorUserId: params.actorUserId,
          scope: params.scope,
          key: params.key,
          requestHash: params.requestHash,
          responseStatus: params.responseStatus,
          responseBody: params.responseBody as Prisma.InputJsonValue,
          transactionId: params.transactionId,
          expiresAt: params.expiresAt,
        },
      });

      return {
        ...created,
        responseBody: created.responseBody as Record<string, unknown>,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new IdempotencyKeyRaceError();
      }
      throw err;
    }
  }

  async createAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }> {
    return this.tx.auditEvent.create({
      data: {
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        requestId: input.requestId,
        reason: input.reason ?? null,
        beforeState: (input.beforeState ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        afterState: (input.afterState ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        ipHash: input.ipHash ?? null,
      },
      select: { id: true },
    });
  }
}

export class PrismaLedgerRepository implements LedgerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  runInTransaction<T>(fn: (tx: LedgerTxContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaLedgerTxContext(tx)), {
      maxWait: 10_000,
      timeout: 20_000,
    });
  }

  async listAccounts(
    params: ListAccountsParams,
  ): Promise<{ items: AccountRecord[]; total: number }> {
    const search = params.search?.trim();
    const where: Prisma.AccountWhereInput = {
      ...(params.includeSystem ? {} : { kind: AccountKind.CUSTOMER }),
      ...(params.ownerUserId ? { ownerUserId: params.ownerUserId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(search
        ? {
            OR: [
              { publicReference: { contains: search, mode: 'insensitive' } },
              { accountName: { contains: search, mode: 'insensitive' } },
              {
                owner: {
                  OR: [
                    { fullName: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      params.includeOwnerDetails
        ? this.prisma.account.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
            select: accountWithOwnerSelect,
          })
        : this.prisma.account.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
            select: accountPlainSelect,
          }),
      this.prisma.account.count({ where }),
    ]);

    return {
      items: rows.map((row) =>
        'owner' in row
          ? mapOwnerAccount(
              row as Prisma.AccountGetPayload<{ select: typeof accountWithOwnerSelect }>,
            )
          : mapPlainAccount(row),
      ),
      total,
    };
  }

  async findAccountById(
    id: string,
    options?: { includeOwnerDetails?: boolean },
  ): Promise<AccountRecord | null> {
    if (options?.includeOwnerDetails) {
      const row = await this.prisma.account.findUnique({
        where: { id },
        select: accountWithOwnerSelect,
      });
      return row ? mapOwnerAccount(row) : null;
    }
    const row = await this.prisma.account.findUnique({
      where: { id },
      select: accountPlainSelect,
    });
    return row ? mapPlainAccount(row) : null;
  }

  async listAccountLedgerEntries(
    params: ListLedgerEntriesParams,
  ): Promise<{ items: AccountLedgerItemRecord[]; total: number }> {
    const where: Prisma.JournalEntryWhereInput = {
      accountId: params.accountId,
      ...(params.direction ? { direction: params.direction } : {}),
      ...(params.type ? { transaction: { type: params.type } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          transactionId: true,
          accountId: true,
          direction: true,
          amountMinor: true,
          currency: true,
          createdAt: true,
          transaction: {
            select: {
              id: true,
              publicReference: true,
              type: true,
              status: true,
              description: true,
              reversalOfTransactionId: true,
              reversedByTransaction: { select: { id: true } },
              entries: {
                select: {
                  accountId: true,
                  account: { select: { publicReference: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.journalEntry.count({ where }),
    ]);

    return {
      items: rows.map((row) => {
        const counterpartyEntry = row.transaction.entries.find(
          (e) => e.accountId !== params.accountId,
        );
        return {
          id: row.id,
          transactionId: row.transactionId,
          transactionPublicReference: row.transaction.publicReference,
          transactionType: row.transaction.type,
          transactionStatus: row.transaction.reversedByTransaction
            ? JournalTransactionStatus.REVERSED
            : row.transaction.status,
          direction: row.direction,
          amountMinor: BigInt(row.amountMinor),
          currency: row.currency,
          description: row.transaction.description,
          counterpartyReference: counterpartyEntry?.account.publicReference ?? null,
          reversalOfTransactionId: row.transaction.reversalOfTransactionId,
          reversedByTransactionId: row.transaction.reversedByTransaction?.id ?? null,
          createdAt: row.createdAt,
        };
      }),
      total,
    };
  }

  async findTransactionById(
    transactionId: string,
  ): Promise<JournalTransactionRecord | null> {
    const row = await this.prisma.journalTransaction.findUnique({
      where: { id: transactionId },
      select: transactionIncludeSelect,
    });
    return row ? mapJournalTransaction(row) : null;
  }

  async findIdempotencyRecord(
    actorUserId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRecordData | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({
      where: {
        actorUserId_scope_key: {
          actorUserId,
          scope,
          key,
        },
      },
    });
    if (!row) {
      return null;
    }
    return {
      ...row,
      responseBody: row.responseBody as Record<string, unknown>,
    };
  }

  async createRejectedAuditEvent(
    input: CreateAuditEventInput,
  ): Promise<{ id: string }> {
    return this.prisma.auditEvent.create({
      data: {
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        requestId: input.requestId,
        reason: input.reason ?? null,
        beforeState: (input.beforeState ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        afterState: (input.afterState ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        ipHash: input.ipHash ?? null,
      },
      select: { id: true },
    });
  }

  async getAdminSummaryCounts(): Promise<AdminSummaryCounts> {
    const [
      customersTotal,
      pendingOnboarding,
      approvedOnboarding,
      rejectedOnboarding,
      activeAccounts,
      frozenAccounts,
      pendingAccounts,
      closedAccounts,
      demoTransactionsTotal,
      auditEventsTotal,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: UserRole.CUSTOMER } }),
      this.prisma.onboardingApplication.count({
        where: { status: OnboardingStatus.PENDING },
      }),
      this.prisma.onboardingApplication.count({
        where: { status: OnboardingStatus.APPROVED },
      }),
      this.prisma.onboardingApplication.count({
        where: { status: OnboardingStatus.REJECTED },
      }),
      this.prisma.account.count({
        where: { kind: AccountKind.CUSTOMER, status: AccountStatus.ACTIVE },
      }),
      this.prisma.account.count({
        where: { kind: AccountKind.CUSTOMER, status: AccountStatus.FROZEN },
      }),
      this.prisma.account.count({
        where: { kind: AccountKind.CUSTOMER, status: AccountStatus.PENDING },
      }),
      this.prisma.account.count({
        where: { kind: AccountKind.CUSTOMER, status: AccountStatus.CLOSED },
      }),
      this.prisma.journalTransaction.count(),
      this.prisma.auditEvent.count(),
    ]);

    return {
      customersTotal,
      pendingOnboarding,
      approvedOnboarding,
      rejectedOnboarding,
      activeAccounts,
      frozenAccounts,
      pendingAccounts,
      closedAccounts,
      demoTransactionsTotal,
      auditEventsTotal,
    };
  }

  async reconcileAccounts(
    accountIds?: string[],
  ): Promise<AccountReconciliationRow[]> {
    const accounts = await this.prisma.account.findMany({
      where: accountIds ? { id: { in: accountIds } } : undefined,
      select: {
        id: true,
        publicReference: true,
        kind: true,
        balanceMinor: true,
      },
    });

    if (accounts.length === 0) {
      return [];
    }

    const grouped = await this.prisma.journalEntry.groupBy({
      by: ['accountId', 'direction'],
      where: {
        accountId: { in: accounts.map((a) => a.id) },
      },
      _sum: { amountMinor: true },
    });

    const netByAccount = new Map<string, bigint>();
    for (const g of grouped) {
      const prev = netByAccount.get(g.accountId) ?? 0n;
      const sum = BigInt(g._sum.amountMinor ?? 0n);
      netByAccount.set(
        g.accountId,
        g.direction === EntryDirection.CREDIT ? prev + sum : prev - sum,
      );
    }

    return accounts.map((acc) => ({
      accountId: acc.id,
      publicReference: acc.publicReference,
      kind: acc.kind,
      projectedBalanceMinor: BigInt(acc.balanceMinor),
      journalDerivedBalanceMinor: netByAccount.get(acc.id) ?? 0n,
    }));
  }
}
