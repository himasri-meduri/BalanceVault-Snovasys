export type UserRole = 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'DISABLED' | 'LOCKED';
export type OnboardingStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'NEEDS_INFORMATION'
  | 'APPROVED'
  | 'REJECTED';
export type ActorType = 'USER' | 'SYSTEM' | 'ANONYMOUS';

export type AccountKind = 'CUSTOMER' | 'SYSTEM_ISSUANCE';
export type AccountStatus = 'PENDING' | 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type JournalTransactionType = 'DEMO_TRANSFER' | 'REVERSAL' | 'ADJUSTMENT';
export type JournalTransactionStatus = 'POSTED' | 'REVERSED';
export type EntryDirection = 'DEBIT' | 'CREDIT';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  onboardingStatus: OnboardingStatus | null;
  createdAt?: string;
}

export interface AuthSessionResponse {
  user: AuthUser;
  csrfToken: string;
  requestId: string;
}

export interface LogoutResponse {
  loggedOut: boolean;
  requestId: string;
}

export interface CustomerOnboardingApplication {
  id: string;
  status: OnboardingStatus;
  contactReference: string | null;
  city: string | null;
  country: string | null;
  accountPurpose: string | null;
  acceptedSyntheticTerms: boolean;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  applicant: {
    id: string;
    fullName: string;
    email: string;
  };
}

export interface AdminOnboardingApplication {
  id: string;
  userId: string;
  status: OnboardingStatus;
  contactReference: string | null;
  city: string | null;
  country: string | null;
  accountPurpose: string | null;
  acceptedSyntheticTerms: boolean;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
  applicant: {
    id: string;
    fullName: string;
    email: string;
    role: UserRole;
    status: UserStatus;
  };
}

export interface AdminUserItem {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  onboardingStatus: OnboardingStatus | null;
  createdAt: string;
  updatedAt?: string;
}

export interface AdminUserDetail extends AdminUserItem {
  updatedAt: string;
  accountCount: number;
  activeAccountCount: number;
  onboardingSubmittedAt: string | null;
  onboardingReviewedAt: string | null;
  onboardingReviewReason: string | null;
}

export interface AccountOwnerSummary {
  id: string;
  fullName: string;
  email: string;
  status: UserStatus;
  onboardingStatus: OnboardingStatus | null;
}

export interface AccountItem {
  id: string;
  publicReference: string;
  kind: AccountKind;
  ownerUserId: string | null;
  owner?: AccountOwnerSummary;
  accountName: string;
  currency: 'INR' | string;
  status: AccountStatus;
  balanceMinor: string;
  version: number;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountLedgerItem {
  id: string;
  transactionId: string;
  transactionPublicReference: string;
  transactionType: JournalTransactionType;
  transactionStatus: JournalTransactionStatus;
  direction: EntryDirection;
  amountMinor: string;
  currency: 'INR' | string;
  description: string;
  counterpartyReference: string | null;
  reversalOfTransactionId: string | null;
  reversedByTransactionId: string | null;
  createdAt: string;
}

export interface TransactionEntryItem {
  id: string;
  accountId: string | null;
  accountPublicReference: string;
  accountKind: AccountKind;
  accountName: string | null;
  direction: EntryDirection;
  amountMinor: string;
  currency: 'INR' | string;
}

export interface TransactionDetailItem {
  id: string;
  publicReference: string;
  type: JournalTransactionType;
  status: JournalTransactionStatus;
  currency: 'INR' | string;
  description: string;
  initiatedByUserId: string | null;
  reversalOfTransactionId: string | null;
  reversalOfPublicReference: string | null;
  reversedByTransactionId: string | null;
  reversedByPublicReference: string | null;
  createdAt: string;
  entries: TransactionEntryItem[];
}

export interface TransferResponse {
  transaction: TransactionDetailItem;
  sourceAccount: AccountItem;
  idempotentReplay: boolean;
  requestId: string;
}

export interface ReversalResponse {
  reversalTransaction: TransactionDetailItem;
  reversedTransactionId: string;
  reversedTransactionStatus: JournalTransactionStatus;
  requestId: string;
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
  requestId: string;
}

export interface AuditEventItem {
  id: string;
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: string;
  requestId: string;
  reason: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipHash: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  requestId: string;
}

export interface HealthPayload {
  status: string;
  service: string;
  timestamp: string;
  requestId: string;
}

export interface ReadyPayload {
  status: 'ready' | 'degraded';
  checks: {
    database: 'ok' | 'unavailable';
    redis: 'ok' | 'unavailable';
  };
  timestamp: string;
  requestId: string;
}
