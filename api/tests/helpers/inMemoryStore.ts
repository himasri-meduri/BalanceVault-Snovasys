import crypto from 'node:crypto';
import {
  AccountKind,
  AccountStatus,
  ActorType,
  EntryDirection,
  JournalTransactionStatus,
  JournalTransactionType,
  OnboardingStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { ConflictError } from '../../src/shared/errors.js';
import type { RedisRateLimitStore } from '../../src/middleware/rateLimit.js';
import type { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import {
  sanitizeAuditState,
  type AuditEventRecord,
  type CreateAuditEventInput,
  type ListAuditEventsQuery,
} from '../../src/modules/audit/audit.types.js';
import type {
  AuthRepository,
  AuthTxContext,
  ListUsersParams,
} from '../../src/modules/auth/auth.repository.js';
import type {
  AdminUserDetail,
  SessionWithUserRecord,
  UserRecord,
} from '../../src/modules/auth/auth.types.js';
import type {
  BootstrapMarkerRecord,
  BootstrapRepository,
  BootstrapTxContext,
  DbPrivilegeInspection,
} from '../../src/modules/bootstrap/bootstrap.repository.js';
import {
  AccountReferenceCollisionError,
  IdempotencyKeyRaceError,
  ReversalAlreadyExistsError,
  TransactionReferenceCollisionError,
  type CreatePostedJournalTransactionInput,
  type LedgerRepository,
  type LedgerTxContext,
  type ListAccountsParams,
  type ListLedgerEntriesParams,
} from '../../src/modules/ledger/ledger.repository.js';
import type {
  AccountLedgerItemRecord,
  AccountReconciliationRow,
  AccountRecord,
  AdminSummaryCounts,
  IdempotencyRecordData,
  JournalTransactionRecord,
} from '../../src/modules/ledger/ledger.types.js';
import type {
  OnboardingConcurrencyFilter,
  OnboardingRepository,
  OnboardingTxContext,
  UpdateOnboardingData,
} from '../../src/modules/onboarding/onboarding.repository.js';
import type { OnboardingApplicationRecord } from '../../src/modules/onboarding/onboarding.types.js';

interface StoredSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipHash: string | null;
}

interface StoredOnboardingApplication {
  id: string;
  userId: string;
  status: OnboardingStatus;
  contactReference: string | null;
  city: string | null;
  country: string | null;
  accountPurpose: string | null;
  acceptedSyntheticTerms: boolean;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  reviewReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function createHardenedOperatorInspection(): DbPrivilegeInspection {
  return {
    currentUser: 'app_migrator',
    sessionUser: 'app_migrator',
    roleInfo: {
      rolname: 'app_migrator',
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolinherit: false,
    },
    memberships: [],
    tablePrivileges: {
      userSelect: true,
      userInsert: true,
      userUpdate: true,
      userDelete: true,
      sessionSelect: true,
      sessionInsert: true,
      sessionUpdate: true,
      sessionDelete: true,
      onboardingSelect: true,
      onboardingInsert: true,
      onboardingUpdate: true,
      onboardingDelete: true,
      accountSelect: true,
      accountInsert: true,
      accountUpdate: true,
      accountDelete: true,
      journalTransactionSelect: true,
      journalTransactionInsert: true,
      journalTransactionUpdate: false,
      journalTransactionDelete: false,
      journalEntrySelect: true,
      journalEntryInsert: true,
      journalEntryUpdate: false,
      journalEntryDelete: false,
      idempotencySelect: true,
      idempotencyInsert: true,
      idempotencyUpdate: true,
      idempotencyDelete: true,
      auditSelect: true,
      auditInsert: true,
      auditUpdate: false,
      auditDelete: false,
      bootstrapSelect: true,
      bootstrapInsert: true,
      bootstrapUpdate: false,
      bootstrapDelete: false,
      prismaMigrationsAny: true,
    },
    functionPrivileges: {
      preventAppendOnlyExecute: false,
      verifyBalancedJournalExecute: false,
    },
    triggerIntegrity: {
      journalTransactionAppendOnly: true,
      journalEntryAppendOnly: true,
      auditEventAppendOnly: true,
      bootstrapStateAppendOnly: true,
      verifyBalancedJournal: true,
      verifyBalancedJournalSearchPathHardened: true,
    },
    sequenceCount: 0,
    excessTablePrivileges: [],
    untrustedRoleExposures: [
      {
        role: 'PUBLIC',
        exists: true,
        tablesWithPrivileges: [],
        sequencesWithPrivileges: [],
        preventAppendOnlyExecute: false,
        verifyBalancedJournalExecute: false,
      },
      {
        role: 'anon',
        exists: true,
        tablesWithPrivileges: [],
        sequencesWithPrivileges: [],
        preventAppendOnlyExecute: false,
        verifyBalancedJournalExecute: false,
      },
      {
        role: 'authenticated',
        exists: true,
        tablesWithPrivileges: [],
        sequencesWithPrivileges: [],
        preventAppendOnlyExecute: false,
        verifyBalancedJournalExecute: false,
      },
    ],
  };
}

export function createHardenedRuntimeInspection(): DbPrivilegeInspection {
  return {
    currentUser: 'app_runtime',
    sessionUser: 'app_runtime',
    roleInfo: {
      rolname: 'app_runtime',
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolinherit: false,
    },
    memberships: [],
    tablePrivileges: {
      userSelect: true,
      userInsert: true,
      userUpdate: true,
      userDelete: false,
      sessionSelect: true,
      sessionInsert: true,
      sessionUpdate: true,
      sessionDelete: true,
      onboardingSelect: true,
      onboardingInsert: true,
      onboardingUpdate: true,
      onboardingDelete: false,
      accountSelect: true,
      accountInsert: true,
      accountUpdate: true,
      accountDelete: false,
      journalTransactionSelect: true,
      journalTransactionInsert: true,
      journalTransactionUpdate: false,
      journalTransactionDelete: false,
      journalEntrySelect: true,
      journalEntryInsert: true,
      journalEntryUpdate: false,
      journalEntryDelete: false,
      idempotencySelect: true,
      idempotencyInsert: true,
      idempotencyUpdate: true,
      idempotencyDelete: true,
      auditSelect: true,
      auditInsert: true,
      auditUpdate: false,
      auditDelete: false,
      bootstrapSelect: true,
      bootstrapInsert: false,
      bootstrapUpdate: false,
      bootstrapDelete: false,
      prismaMigrationsAny: false,
    },
    functionPrivileges: {
      preventAppendOnlyExecute: false,
      verifyBalancedJournalExecute: false,
    },
    triggerIntegrity: {
      journalTransactionAppendOnly: true,
      journalEntryAppendOnly: true,
      auditEventAppendOnly: true,
      bootstrapStateAppendOnly: true,
      verifyBalancedJournal: true,
      verifyBalancedJournalSearchPathHardened: true,
    },
    sequenceCount: 0,
    excessTablePrivileges: [],
    untrustedRoleExposures: [
      {
        role: 'PUBLIC',
        exists: true,
        tablesWithPrivileges: [],
        sequencesWithPrivileges: [],
        preventAppendOnlyExecute: false,
        verifyBalancedJournalExecute: false,
      },
      {
        role: 'anon',
        exists: true,
        tablesWithPrivileges: [],
        sequencesWithPrivileges: [],
        preventAppendOnlyExecute: false,
        verifyBalancedJournalExecute: false,
      },
      {
        role: 'authenticated',
        exists: true,
        tablesWithPrivileges: [],
        sequencesWithPrivileges: [],
        preventAppendOnlyExecute: false,
        verifyBalancedJournalExecute: false,
      },
    ],
  };
}

interface StoredAccount {
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
}

interface StoredJournalTransaction {
  id: string;
  publicReference: string;
  type: JournalTransactionType;
  status: JournalTransactionStatus;
  currency: string;
  description: string;
  idempotencyKey: string | null;
  initiatedByUserId: string | null;
  reversalOfTransactionId: string | null;
  metadata: unknown;
  createdAt: Date;
}

interface StoredJournalEntry {
  id: string;
  transactionId: string;
  accountId: string;
  direction: EntryDirection;
  amountMinor: bigint;
  currency: string;
  createdAt: Date;
}

export class InMemoryAuthAuditBootstrapStore
  implements
    AuthRepository,
    AuditRepository,
    BootstrapRepository,
    OnboardingRepository,
    LedgerRepository
{
  public users = new Map<string, UserRecord>();
  public sessions = new Map<string, StoredSession>();
  public onboardingApplications = new Map<string, StoredOnboardingApplication>();
  public accounts = new Map<string, StoredAccount>();
  public journalTransactions = new Map<string, StoredJournalTransaction>();
  public journalEntries: StoredJournalEntry[] = [];
  public idempotencyRecords = new Map<string, IdempotencyRecordData>();
  public auditEvents: AuditEventRecord[] = [];
  public bootstrapStates = new Map<string, BootstrapMarkerRecord>();

  private txQueue: Promise<void> = Promise.resolve();

  public dbPrivilegeInspection: DbPrivilegeInspection = createHardenedOperatorInspection();

  constructor(private readonly nowProvider: () => Date = () => new Date()) {}

  private snapshot() {
    return {
      users: structuredClone(this.users),
      sessions: structuredClone(this.sessions),
      onboardingApplications: structuredClone(this.onboardingApplications),
      accounts: structuredClone(this.accounts),
      journalTransactions: structuredClone(this.journalTransactions),
      journalEntries: structuredClone(this.journalEntries),
      idempotencyRecords: structuredClone(this.idempotencyRecords),
      auditEvents: structuredClone(this.auditEvents),
      bootstrapStates: structuredClone(this.bootstrapStates),
    };
  }

  private restore(snap: ReturnType<InMemoryAuthAuditBootstrapStore['snapshot']>) {
    this.users = snap.users;
    this.sessions = snap.sessions;
    this.onboardingApplications = snap.onboardingApplications;
    this.accounts = snap.accounts;
    this.journalTransactions = snap.journalTransactions;
    this.journalEntries = snap.journalEntries;
    this.idempotencyRecords = snap.idempotencyRecords;
    this.auditEvents = snap.auditEvents;
    this.bootstrapStates = snap.bootstrapStates;
  }

  private assembleAccountRecord(
    account: StoredAccount,
    includeOwnerDetails = true,
  ): AccountRecord {
    const owner = account.ownerUserId ? this.users.get(account.ownerUserId) : undefined;
    return {
      ...structuredClone(account),
      ...(includeOwnerDetails && owner
        ? {
            owner: {
              id: owner.id,
              fullName: owner.fullName,
              email: owner.email,
              status: owner.status,
              onboardingStatus: owner.onboardingStatus,
            },
          }
        : {}),
    };
  }

  private assembleTransactionRecord(
    txn: StoredJournalTransaction,
  ): JournalTransactionRecord {
    const reversalOf = txn.reversalOfTransactionId
      ? this.journalTransactions.get(txn.reversalOfTransactionId) ?? null
      : null;

    let reversedBy: StoredJournalTransaction | null = null;
    for (const candidate of this.journalTransactions.values()) {
      if (candidate.reversalOfTransactionId === txn.id) {
        reversedBy = candidate;
        break;
      }
    }

    const entries = this.journalEntries
      .filter((e) => e.transactionId === txn.id)
      .map((e) => {
        const account = this.accounts.get(e.accountId)!;
        return {
          ...e,
          accountPublicReference: account.publicReference,
          accountKind: account.kind,
          accountName: account.accountName,
          accountOwnerUserId: account.ownerUserId,
        };
      });

    return {
      id: txn.id,
      publicReference: txn.publicReference,
      type: txn.type,
      recordedStatus: txn.status,
      effectiveStatus: reversedBy
        ? JournalTransactionStatus.REVERSED
        : txn.status,
      currency: txn.currency,
      description: txn.description,
      idempotencyKey: txn.idempotencyKey,
      initiatedByUserId: txn.initiatedByUserId,
      reversalOfTransactionId: txn.reversalOfTransactionId,
      reversalOfPublicReference: reversalOf?.publicReference ?? null,
      reversedByTransactionId: reversedBy?.id ?? null,
      reversedByPublicReference: reversedBy?.publicReference ?? null,
      metadata: structuredClone(txn.metadata),
      createdAt: new Date(txn.createdAt),
      entries,
    };
  }

  private assembleOnboardingRecord(
    app: StoredOnboardingApplication,
  ): OnboardingApplicationRecord | null {
    const user = this.users.get(app.userId);
    if (!user) {
      return null;
    }

    return structuredClone({
      ...app,
      applicant: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        status: user.status,
      },
    });
  }

  private withTxLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.txQueue.then(operation, operation);
    this.txQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async runInTransaction<T>(
    fn:
      | ((tx: AuthTxContext) => Promise<T>)
      | ((tx: BootstrapTxContext) => Promise<T>)
      | ((tx: OnboardingTxContext) => Promise<T>)
      | ((tx: LedgerTxContext) => Promise<T>),
  ): Promise<T> {
    return this.withTxLock(async () => {
      const snap = this.snapshot();
      try {
        const txContext: AuthTxContext &
          BootstrapTxContext &
          OnboardingTxContext &
          LedgerTxContext = {
          findUserByEmail: async (email: string) => this.findUserByEmail(email),
          findUserById: async (userId: string) => {
            const user = this.users.get(userId);
            return user ? structuredClone(user) : null;
          },
          createCustomerWithOnboarding: async (params) => {
            for (const existing of this.users.values()) {
              if (existing.email === params.email) {
                throw new ConflictError(
                  'An account with this email already exists',
                  'EMAIL_ALREADY_EXISTS',
                );
              }
            }

            const now = this.nowProvider();
            const userId = crypto.randomUUID();
            const record: UserRecord = {
              id: userId,
              email: params.email,
              fullName: params.fullName,
              passwordHash: params.passwordHash,
              role: UserRole.CUSTOMER,
              status: UserStatus.ACTIVE,
              onboardingStatus: params.onboardingStatus,
              createdAt: now,
              updatedAt: now,
            };
            this.users.set(record.id, record);

            const appRecord: StoredOnboardingApplication = {
              id: crypto.randomUUID(),
              userId,
              status: params.onboardingStatus,
              contactReference: null,
              city: null,
              country: null,
              accountPurpose: null,
              acceptedSyntheticTerms: false,
              submittedAt: null,
              reviewedAt: null,
              reviewedByUserId: null,
              reviewReason: null,
              createdAt: now,
              updatedAt: now,
            };
            this.onboardingApplications.set(appRecord.id, appRecord);

            return structuredClone(record);
          },
          createSession: async (params) => {
            const id = crypto.randomUUID();
            this.sessions.set(id, {
              id,
              userId: params.userId,
              tokenHash: params.tokenHash,
              createdAt: this.nowProvider(),
              expiresAt: params.expiresAt,
              lastSeenAt: params.lastSeenAt,
              revokedAt: null,
              userAgent: params.userAgent,
              ipHash: params.ipHash,
            });
            return { id };
          },
          revokeSessionByTokenHash: async (tokenHash: string, revokedAt: Date) => {
            for (const session of this.sessions.values()) {
              if (session.tokenHash === tokenHash && session.revokedAt === null) {
                session.revokedAt = revokedAt;
              }
            }
          },
          revokeSessionById: async (sessionId: string, revokedAt: Date) => {
            const session = this.sessions.get(sessionId);
            if (session && session.revokedAt === null) {
              session.revokedAt = revokedAt;
            }
          },
          revokeAllUserSessions: async (userId: string, revokedAt: Date) => {
            for (const session of this.sessions.values()) {
              if (session.userId === userId && session.revokedAt === null) {
                session.revokedAt = revokedAt;
              }
            }
          },
          updateUserRole: async (userId: string, role: UserRole) => {
            const user = this.users.get(userId);
            if (!user) {
              throw new Error('User not found');
            }
            user.role = role;
            user.updatedAt = this.nowProvider();
            return structuredClone(user);
          },
          updateUserStatus: async (userId: string, status: UserStatus) => {
            const user = this.users.get(userId);
            if (!user) {
              throw new Error('User not found');
            }
            user.status = status;
            user.updatedAt = this.nowProvider();
            return structuredClone(user);
          },
          countActiveSuperAdmins: async () => {
            let count = 0;
            for (const u of this.users.values()) {
              if (u.role === UserRole.SUPER_ADMIN && u.status === UserStatus.ACTIVE) {
                count += 1;
              }
            }
            return count;
          },
          findBootstrapState: async (id: string) => {
            const marker = this.bootstrapStates.get(id);
            return marker ? structuredClone(marker) : null;
          },
          findSuperAdmins: async () => {
            const list: UserRecord[] = [];
            for (const u of this.users.values()) {
              if (u.role === UserRole.SUPER_ADMIN) {
                list.push(structuredClone(u));
              }
            }
            return list;
          },
          createSuperAdmin: async (params) => {
            const now = this.nowProvider();
            const record: UserRecord = {
              id: crypto.randomUUID(),
              email: params.email,
              fullName: params.fullName,
              passwordHash: params.passwordHash,
              role: UserRole.SUPER_ADMIN,
              status: UserStatus.ACTIVE,
              onboardingStatus: null,
              createdAt: now,
              updatedAt: now,
            };
            this.users.set(record.id, record);
            return structuredClone(record);
          },
          createBootstrapState: async (params) => {
            if (this.bootstrapStates.has(params.id)) {
              throw new ConflictError('Bootstrap state already exists');
            }
            const marker: BootstrapMarkerRecord = {
              id: params.id,
              completedAt: this.nowProvider(),
              adminUserId: params.adminUserId,
              note: params.note,
            };
            this.bootstrapStates.set(marker.id, marker);
            return structuredClone(marker);
          },
          findByUserId: async (userId: string) => this.findByUserId(userId),
          findById: async (id: string) => this.findById(id),
          updateByIdIfStatus: async (
            id: string,
            expectedStatuses: OnboardingStatus[],
            data: UpdateOnboardingData,
            filter?: OnboardingConcurrencyFilter,
          ) => {
            const existing = this.onboardingApplications.get(id);
            if (!existing || !expectedStatuses.includes(existing.status)) {
              return null;
            }
            if (
              filter?.requireUnsubmittedWhenPending &&
              existing.status === OnboardingStatus.PENDING &&
              existing.submittedAt !== null
            ) {
              return null;
            }
            if (
              filter?.requireSubmitted &&
              (existing.submittedAt === null || !existing.acceptedSyntheticTerms)
            ) {
              return null;
            }

            const now = this.nowProvider();
            const updated: StoredOnboardingApplication = {
              ...existing,
              ...data,
              updatedAt: now,
            };
            this.onboardingApplications.set(id, updated);

            const owner = this.users.get(existing.userId);
            if (owner) {
              owner.onboardingStatus = updated.status;
              owner.updatedAt = now;
            }

            return this.assembleOnboardingRecord(updated);
          },
          createAuditEvent: async (input: CreateAuditEventInput) => {
            return this.create(input);
          },
          findAccountById: async (id: string) => {
            const acc = this.accounts.get(id);
            return acc ? this.assembleAccountRecord(acc, true) : null;
          },
          findAccountByPublicReference: async (publicReference: string) => {
            for (const acc of this.accounts.values()) {
              if (acc.publicReference === publicReference) {
                return this.assembleAccountRecord(acc, false);
              }
            }
            return null;
          },
          findOrCreateSystemTreasuryAccount: async () => {
            for (const acc of this.accounts.values()) {
              if (acc.publicReference === 'BV-SYS-TREASURY-01') {
                return this.assembleAccountRecord(acc, false);
              }
            }
            const now = this.nowProvider();
            const treasury: StoredAccount = {
              id: crypto.randomUUID(),
              publicReference: 'BV-SYS-TREASURY-01',
              kind: AccountKind.SYSTEM_ISSUANCE,
              ownerUserId: null,
              accountName: 'Synthetic Demo Issuance Reserve',
              currency: 'INR',
              status: AccountStatus.ACTIVE,
              balanceMinor: 0n,
              version: 0,
              statusReason: 'System double-entry synthetic issuance source',
              createdAt: now,
              updatedAt: now,
            };
            this.accounts.set(treasury.id, treasury);
            return this.assembleAccountRecord(treasury, false);
          },
          lockAccountsByIds: async (accountIds: string[]) => {
            const sorted = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
            return sorted
              .map((id) => {
                for (const acc of this.accounts.values()) {
                  if (acc.id.toLowerCase() === id) {
                    return this.assembleAccountRecord(acc, false);
                  }
                }
                return null;
              })
              .filter((acc): acc is AccountRecord => acc !== null);
          },
          createAccount: async (params) => {
            for (const existing of this.accounts.values()) {
              if (existing.publicReference === params.publicReference) {
                throw new AccountReferenceCollisionError();
              }
            }
            const now = this.nowProvider();
            const account: StoredAccount = {
              id: crypto.randomUUID(),
              publicReference: params.publicReference,
              kind: params.kind,
              ownerUserId: params.ownerUserId,
              accountName: params.accountName,
              currency: 'INR',
              status: params.status,
              balanceMinor: params.balanceMinor,
              version: 0,
              statusReason: params.statusReason,
              createdAt: now,
              updatedAt: now,
            };
            if (account.kind === AccountKind.CUSTOMER && account.balanceMinor < 0n) {
              throw new Error('Account CHECK violation: customer balanceMinor < 0');
            }
            this.accounts.set(account.id, account);
            return this.assembleAccountRecord(account, true);
          },
          updateAccountBalance: async (accountId: string, newBalanceMinor: bigint) => {
            const acc = this.accounts.get(accountId);
            if (!acc) {
              throw new Error('Account not found');
            }
            if (acc.kind === AccountKind.CUSTOMER && newBalanceMinor < 0n) {
              throw new Error('Account CHECK violation: customer balanceMinor < 0');
            }
            acc.balanceMinor = newBalanceMinor;
            acc.version += 1;
            acc.updatedAt = this.nowProvider();
            return this.assembleAccountRecord(acc, false);
          },
          updateAccountStatusIfMatches: async (params) => {
            const acc = this.accounts.get(params.accountId);
            if (
              !acc ||
              acc.kind !== AccountKind.CUSTOMER ||
              !params.expectedStatuses.includes(acc.status) ||
              (params.requireZeroBalance && acc.balanceMinor !== 0n)
            ) {
              return null;
            }
            acc.status = params.newStatus;
            acc.statusReason = params.statusReason;
            acc.version += 1;
            acc.updatedAt = this.nowProvider();
            return this.assembleAccountRecord(acc, true);
          },
          findTransactionById: async (transactionId: string) => {
            const txn = this.journalTransactions.get(transactionId);
            return txn ? this.assembleTransactionRecord(txn) : null;
          },
          createPostedJournalTransaction: async (
            input: CreatePostedJournalTransactionInput,
          ) => {
            for (const existing of this.journalTransactions.values()) {
              if (existing.publicReference === input.publicReference) {
                throw new TransactionReferenceCollisionError();
              }
              if (
                input.reversalOfTransactionId &&
                existing.reversalOfTransactionId === input.reversalOfTransactionId
              ) {
                throw new ReversalAlreadyExistsError();
              }
            }

            let sumCredit = 0n;
            let sumDebit = 0n;
            for (const e of input.entries) {
              if (e.amountMinor <= 0n) {
                throw new Error('JournalEntry CHECK violation: amountMinor <= 0');
              }
              if (e.direction === EntryDirection.CREDIT) {
                sumCredit += e.amountMinor;
              } else {
                sumDebit += e.amountMinor;
              }
            }
            if (input.entries.length < 2 || sumCredit !== sumDebit) {
              throw new Error('JournalTransaction invariant violation: unbalanced entries');
            }

            const now = this.nowProvider();
            const txn: StoredJournalTransaction = {
              id: crypto.randomUUID(),
              publicReference: input.publicReference,
              type: input.type,
              status: JournalTransactionStatus.POSTED,
              currency: 'INR',
              description: input.description,
              idempotencyKey: input.idempotencyKey ?? null,
              initiatedByUserId: input.initiatedByUserId,
              reversalOfTransactionId: input.reversalOfTransactionId ?? null,
              metadata: input.metadata ?? null,
              createdAt: now,
            };
            this.journalTransactions.set(txn.id, txn);

            for (const entry of input.entries) {
              this.journalEntries.push({
                id: crypto.randomUUID(),
                transactionId: txn.id,
                accountId: entry.accountId,
                direction: entry.direction,
                amountMinor: entry.amountMinor,
                currency: 'INR',
                createdAt: now,
              });
            }

            return this.assembleTransactionRecord(txn);
          },
          findIdempotencyRecord: async (
            actorUserId: string,
            scope: string,
            key: string,
          ) => {
            const composite = `${actorUserId}::${scope}::${key}`;
            const rec = this.idempotencyRecords.get(composite);
            return rec ? structuredClone(rec) : null;
          },
          deleteIdempotencyRecord: async (id: string) => {
            for (const [k, rec] of this.idempotencyRecords.entries()) {
              if (rec.id === id) {
                this.idempotencyRecords.delete(k);
              }
            }
          },
          createIdempotencyRecord: async (params) => {
            const composite = `${params.actorUserId}::${params.scope}::${params.key}`;
            if (this.idempotencyRecords.has(composite)) {
              throw new IdempotencyKeyRaceError();
            }
            const record: IdempotencyRecordData = {
              id: crypto.randomUUID(),
              actorUserId: params.actorUserId,
              scope: params.scope,
              key: params.key,
              requestHash: params.requestHash,
              responseStatus: params.responseStatus,
              responseBody: structuredClone(params.responseBody),
              transactionId: params.transactionId,
              createdAt: this.nowProvider(),
              expiresAt: params.expiresAt,
            };
            this.idempotencyRecords.set(composite, record);
            return structuredClone(record);
          },
        };

        return await (
          fn as (
            tx: AuthTxContext &
              BootstrapTxContext &
              OnboardingTxContext &
              LedgerTxContext,
          ) => Promise<T>
        )(txContext);
      } catch (err) {
        this.restore(snap);
        throw err;
      }
    });
  }

  async inspectDbPrivileges(): Promise<DbPrivilegeInspection> {
    return structuredClone(this.dbPrivilegeInspection);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return structuredClone(user);
      }
    }
    return null;
  }

  async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<SessionWithUserRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) {
        const user = this.users.get(session.userId);
        if (!user) {
          return null;
        }
        return {
          id: session.id,
          userId: session.userId,
          tokenHash: session.tokenHash,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          lastSeenAt: session.lastSeenAt,
          revokedAt: session.revokedAt,
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            status: user.status,
            onboardingStatus: user.onboardingStatus,
          },
        };
      }
    }
    return null;
  }

  async revokeSessionById(sessionId: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null) {
      session.revokedAt = revokedAt;
    }
  }

  async touchSessionLastSeen(sessionId: string, lastSeenAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null) {
      session.lastSeenAt = lastSeenAt;
    }
  }

  async findUserDetailById(userId: string): Promise<AdminUserDetail | null> {
    const user = this.users.get(userId);
    if (!user) {
      return null;
    }

    let onboardingSubmittedAt: Date | null = null;
    let onboardingReviewedAt: Date | null = null;
    let onboardingReviewReason: string | null = null;
    for (const app of this.onboardingApplications.values()) {
      if (app.userId === userId) {
        onboardingSubmittedAt = app.submittedAt;
        onboardingReviewedAt = app.reviewedAt;
        onboardingReviewReason = app.reviewReason;
        break;
      }
    }

    let accountCount = 0;
    let activeAccountCount = 0;
    for (const acc of this.accounts.values()) {
      if (acc.kind === AccountKind.CUSTOMER && acc.ownerUserId === userId) {
        accountCount += 1;
        if (acc.status === AccountStatus.ACTIVE) {
          activeAccountCount += 1;
        }
      }
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      onboardingStatus: user.onboardingStatus,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accountCount,
      activeAccountCount,
      onboardingSubmittedAt,
      onboardingReviewedAt,
      onboardingReviewReason,
    };
  }

  async listUsers(params: ListUsersParams) {
    const search = params.search?.trim().toLowerCase();
    const all = Array.from(this.users.values())
      .filter((u) => (!params.role ? true : u.role === params.role))
      .filter((u) => (!params.status ? true : u.status === params.status))
      .filter((u) =>
        !search
          ? true
          : u.fullName.toLowerCase().includes(search) ||
            u.email.toLowerCase().includes(search),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ passwordHash: _passwordHash, ...safe }) => safe);
    const start = (params.page - 1) * params.pageSize;
    return {
      items: all.slice(start, start + params.pageSize),
      total: all.length,
    };
  }

  async listAccounts(
    params: ListAccountsParams,
  ): Promise<{ items: AccountRecord[]; total: number }> {
    const needle = params.search?.trim().toLowerCase();
    const matched = Array.from(this.accounts.values())
      .filter((acc) =>
        params.includeSystem ? true : acc.kind === AccountKind.CUSTOMER,
      )
      .filter((acc) =>
        !params.ownerUserId ? true : acc.ownerUserId === params.ownerUserId,
      )
      .filter((acc) => (!params.status ? true : acc.status === params.status))
      .map((acc) =>
        this.assembleAccountRecord(acc, Boolean(params.includeOwnerDetails)),
      )
      .filter((acc) => {
        if (!needle) return true;
        return (
          acc.publicReference.toLowerCase().includes(needle) ||
          acc.accountName.toLowerCase().includes(needle) ||
          Boolean(acc.owner?.fullName.toLowerCase().includes(needle)) ||
          Boolean(acc.owner?.email.toLowerCase().includes(needle))
        );
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const start = (params.page - 1) * params.pageSize;
    return {
      items: matched.slice(start, start + params.pageSize),
      total: matched.length,
    };
  }

  async findAccountById(
    id: string,
    options?: { includeOwnerDetails?: boolean },
  ): Promise<AccountRecord | null> {
    const acc = this.accounts.get(id);
    return acc
      ? this.assembleAccountRecord(acc, Boolean(options?.includeOwnerDetails))
      : null;
  }

  async listAccountLedgerEntries(
    params: ListLedgerEntriesParams,
  ): Promise<{ items: AccountLedgerItemRecord[]; total: number }> {
    const filtered = this.journalEntries
      .filter((entry) => entry.accountId === params.accountId)
      .filter((entry) => (!params.direction ? true : entry.direction === params.direction))
      .map((entry) => {
        const txn = this.journalTransactions.get(entry.transactionId)!;
        const assembledTxn = this.assembleTransactionRecord(txn);
        return { entry, assembledTxn };
      })
      .filter(({ assembledTxn }) =>
        !params.type ? true : assembledTxn.type === params.type,
      )
      .sort((a, b) => b.entry.createdAt.getTime() - a.entry.createdAt.getTime());

    const mapped: AccountLedgerItemRecord[] = filtered.map(
      ({ entry, assembledTxn }) => {
        const counterparty = assembledTxn.entries.find(
          (e) => e.accountId !== params.accountId,
        );
        return {
          id: entry.id,
          transactionId: assembledTxn.id,
          transactionPublicReference: assembledTxn.publicReference,
          transactionType: assembledTxn.type,
          transactionStatus: assembledTxn.effectiveStatus,
          direction: entry.direction,
          amountMinor: entry.amountMinor,
          currency: entry.currency,
          description: assembledTxn.description,
          counterpartyReference: counterparty?.accountPublicReference ?? null,
          reversalOfTransactionId: assembledTxn.reversalOfTransactionId,
          reversedByTransactionId: assembledTxn.reversedByTransactionId,
          createdAt: entry.createdAt,
        };
      },
    );

    const start = (params.page - 1) * params.pageSize;
    return {
      items: mapped.slice(start, start + params.pageSize),
      total: mapped.length,
    };
  }

  async findTransactionById(
    transactionId: string,
  ): Promise<JournalTransactionRecord | null> {
    const txn = this.journalTransactions.get(transactionId);
    return txn ? this.assembleTransactionRecord(txn) : null;
  }

  async findIdempotencyRecord(
    actorUserId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRecordData | null> {
    const rec = this.idempotencyRecords.get(`${actorUserId}::${scope}::${key}`);
    return rec ? structuredClone(rec) : null;
  }

  async createRejectedAuditEvent(
    input: CreateAuditEventInput,
  ): Promise<{ id: string }> {
    return this.create(input);
  }

  async getAdminSummaryCounts(): Promise<AdminSummaryCounts> {
    let customersTotal = 0;
    for (const u of this.users.values()) {
      if (u.role === UserRole.CUSTOMER) customersTotal += 1;
    }

    let pendingOnboarding = 0;
    let approvedOnboarding = 0;
    let rejectedOnboarding = 0;
    for (const app of this.onboardingApplications.values()) {
      if (app.status === OnboardingStatus.PENDING) pendingOnboarding += 1;
      if (app.status === OnboardingStatus.APPROVED) approvedOnboarding += 1;
      if (app.status === OnboardingStatus.REJECTED) rejectedOnboarding += 1;
    }

    let activeAccounts = 0;
    let frozenAccounts = 0;
    let pendingAccounts = 0;
    let closedAccounts = 0;
    for (const acc of this.accounts.values()) {
      if (acc.kind !== AccountKind.CUSTOMER) continue;
      if (acc.status === AccountStatus.ACTIVE) activeAccounts += 1;
      if (acc.status === AccountStatus.FROZEN) frozenAccounts += 1;
      if (acc.status === AccountStatus.PENDING) pendingAccounts += 1;
      if (acc.status === AccountStatus.CLOSED) closedAccounts += 1;
    }

    return {
      customersTotal,
      pendingOnboarding,
      approvedOnboarding,
      rejectedOnboarding,
      activeAccounts,
      frozenAccounts,
      pendingAccounts,
      closedAccounts,
      demoTransactionsTotal: this.journalTransactions.size,
      auditEventsTotal: this.auditEvents.length,
    };
  }

  async reconcileAccounts(
    accountIds?: string[],
  ): Promise<AccountReconciliationRow[]> {
    const targetAccounts = Array.from(this.accounts.values()).filter((acc) =>
      accountIds ? accountIds.includes(acc.id) : true,
    );

    return targetAccounts.map((acc) => {
      let derived = 0n;
      for (const entry of this.journalEntries) {
        if (entry.accountId === acc.id) {
          derived +=
            entry.direction === EntryDirection.CREDIT
              ? entry.amountMinor
              : -entry.amountMinor;
        }
      }
      return {
        accountId: acc.id,
        publicReference: acc.publicReference,
        kind: acc.kind,
        projectedBalanceMinor: acc.balanceMinor,
        journalDerivedBalanceMinor: derived,
      };
    });
  }

  async findByUserId(userId: string): Promise<OnboardingApplicationRecord | null> {
    for (const app of this.onboardingApplications.values()) {
      if (app.userId === userId) {
        return this.assembleOnboardingRecord(app);
      }
    }
    return null;
  }

  async findById(id: string): Promise<OnboardingApplicationRecord | null> {
    const app = this.onboardingApplications.get(id);
    return app ? this.assembleOnboardingRecord(app) : null;
  }

  async listApplications(params: {
    status?: OnboardingStatus;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: OnboardingApplicationRecord[]; total: number }> {
    const needle = params.search?.trim().toLowerCase();
    const matched = Array.from(this.onboardingApplications.values())
      .map((app) => this.assembleOnboardingRecord(app))
      .filter((record): record is OnboardingApplicationRecord => record !== null)
      .filter((record) => (!params.status ? true : record.status === params.status))
      .filter((record) =>
        !needle
          ? true
          : record.applicant.fullName.toLowerCase().includes(needle) ||
            record.applicant.email.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const start = (params.page - 1) * params.pageSize;
    return {
      items: matched.slice(start, start + params.pageSize),
      total: matched.length,
    };
  }

  async create(input: CreateAuditEventInput): Promise<AuditEventRecord> {
    const record: AuditEventRecord = {
      id: crypto.randomUUID(),
      actorUserId: input.actorUserId,
      actorType: input.actorType ?? ActorType.SYSTEM,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      occurredAt: this.nowProvider(),
      requestId: input.requestId,
      reason: input.reason ?? null,
      beforeState: sanitizeAuditState(input.beforeState) ?? null,
      afterState: sanitizeAuditState(input.afterState) ?? null,
      ipHash: input.ipHash ?? null,
    };
    this.auditEvents.push(record);
    return structuredClone(record);
  }

  async list(
    query: ListAuditEventsQuery,
  ): Promise<{ items: AuditEventRecord[]; total: number }> {
    const filtered = this.auditEvents
      .filter((item) => (!query.action ? true : item.action === query.action))
      .filter((item) => (!query.entityType ? true : item.entityType === query.entityType))
      .filter((item) =>
        !query.actorUserId ? true : item.actorUserId === query.actorUserId,
      )
      .filter((item) =>
        !query.from ? true : item.occurredAt.getTime() >= query.from.getTime(),
      )
      .filter((item) =>
        !query.to ? true : item.occurredAt.getTime() <= query.to.getTime(),
      )
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
    };
  }

  seedUser(params: {
    email: string;
    fullName: string;
    passwordHash: string;
    role: UserRole;
    status?: UserStatus;
    onboardingStatus?: OnboardingStatus | null;
  }): UserRecord {
    const now = this.nowProvider();
    const userId = crypto.randomUUID();
    const effectiveOnboardingStatus =
      params.onboardingStatus === undefined
        ? params.role === UserRole.CUSTOMER
          ? OnboardingStatus.PENDING
          : null
        : params.onboardingStatus;

    const record: UserRecord = {
      id: userId,
      email: params.email.trim().toLowerCase(),
      fullName: params.fullName,
      passwordHash: params.passwordHash,
      role: params.role,
      status: params.status ?? UserStatus.ACTIVE,
      onboardingStatus: effectiveOnboardingStatus,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(record.id, record);

    if (params.role === UserRole.CUSTOMER && effectiveOnboardingStatus !== null) {
      const appId = crypto.randomUUID();
      this.onboardingApplications.set(appId, {
        id: appId,
        userId,
        status: effectiveOnboardingStatus,
        contactReference: null,
        city: null,
        country: null,
        accountPurpose: null,
        acceptedSyntheticTerms: false,
        submittedAt: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    return structuredClone(record);
  }
}

export class InMemoryRateLimitStore implements RedisRateLimitStore {
  private buckets = new Map<string, { count: number; expiresAt: number }>();

  async incrementWindow(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; ttlMs: number }> {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.expiresAt <= now) {
      this.buckets.set(key, { count: 1, expiresAt: now + windowMs });
      return { count: 1, ttlMs: windowMs };
    }

    current.count += 1;
    return { count: current.count, ttlMs: Math.max(current.expiresAt - now, 0) };
  }
}
