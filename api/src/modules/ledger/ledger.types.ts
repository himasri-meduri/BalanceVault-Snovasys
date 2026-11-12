import type {
  AccountKind,
  AccountStatus,
  EntryDirection,
  JournalTransactionStatus,
  JournalTransactionType,
  OnboardingStatus,
  UserStatus,
} from '@prisma/client';

export interface AccountOwnerSummary {
  id: string;
  fullName: string;
  email: string;
  status: UserStatus;
  onboardingStatus: OnboardingStatus | null;
}

export interface AccountRecord {
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
  owner?: AccountOwnerSummary;
}

export interface AccountDto {
  id: string;
  publicReference: string;
  kind: AccountKind;
  ownerUserId: string | null;
  owner?: AccountOwnerSummary;
  accountName: string;
  currency: string;
  status: AccountStatus;
  balanceMinor: string;
  version: number;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntryWithAccountRecord {
  id: string;
  transactionId: string;
  accountId: string;
  accountPublicReference: string;
  accountKind: AccountKind;
  accountName: string;
  accountOwnerUserId: string | null;
  direction: EntryDirection;
  amountMinor: bigint;
  currency: string;
  createdAt: Date;
}

export interface JournalTransactionRecord {
  id: string;
  publicReference: string;
  type: JournalTransactionType;
  recordedStatus: JournalTransactionStatus;
  effectiveStatus: JournalTransactionStatus;
  currency: string;
  description: string;
  idempotencyKey: string | null;
  initiatedByUserId: string | null;
  reversalOfTransactionId: string | null;
  reversalOfPublicReference: string | null;
  reversedByTransactionId: string | null;
  reversedByPublicReference: string | null;
  metadata: unknown;
  createdAt: Date;
  entries: JournalEntryWithAccountRecord[];
}

export interface AccountLedgerItemRecord {
  id: string;
  transactionId: string;
  transactionPublicReference: string;
  transactionType: JournalTransactionType;
  transactionStatus: JournalTransactionStatus;
  direction: EntryDirection;
  amountMinor: bigint;
  currency: string;
  description: string;
  counterpartyReference: string | null;
  reversalOfTransactionId: string | null;
  reversedByTransactionId: string | null;
  createdAt: Date;
}

export interface AccountLedgerItemDto {
  id: string;
  transactionId: string;
  transactionPublicReference: string;
  transactionType: JournalTransactionType;
  transactionStatus: JournalTransactionStatus;
  direction: EntryDirection;
  amountMinor: string;
  currency: string;
  description: string;
  counterpartyReference: string | null;
  reversalOfTransactionId: string | null;
  reversedByTransactionId: string | null;
  createdAt: string;
}

export interface TransactionEntryDto {
  id: string;
  accountId: string | null;
  accountPublicReference: string;
  accountKind: AccountKind;
  accountName: string | null;
  direction: EntryDirection;
  amountMinor: string;
  currency: string;
}

export interface TransactionDetailDto {
  id: string;
  publicReference: string;
  type: JournalTransactionType;
  status: JournalTransactionStatus;
  currency: string;
  description: string;
  initiatedByUserId: string | null;
  reversalOfTransactionId: string | null;
  reversalOfPublicReference: string | null;
  reversedByTransactionId: string | null;
  reversedByPublicReference: string | null;
  createdAt: string;
  entries: TransactionEntryDto[];
}

export interface IdempotencyRecordData {
  id: string;
  actorUserId: string;
  scope: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
  transactionId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface AdminSummaryCounts {
  customersTotal: number;
  pendingOnboarding: number;
  approvedOnboarding: number;
  rejectedOnboarding: number;
  activeAccounts: number;
  frozenAccounts: number;
  pendingAccounts: number;
  closedAccounts: number;
  demoTransactionsTotal: number;
  auditEventsTotal: number;
}

export interface AccountReconciliationRow {
  accountId: string;
  publicReference: string;
  kind: AccountKind;
  projectedBalanceMinor: bigint;
  journalDerivedBalanceMinor: bigint;
}
