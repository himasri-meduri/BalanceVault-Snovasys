import { apiRequest } from './apiClient';
import type {
  AccountItem,
  AccountLedgerItem,
  AccountStatus,
  AdminOnboardingApplication,
  AdminSummaryCounts,
  AdminUserDetail,
  AdminUserItem,
  AuditEventItem,
  AuthSessionResponse,
  CustomerOnboardingApplication,
  EntryDirection,
  HealthPayload,
  JournalTransactionType,
  LogoutResponse,
  OnboardingStatus,
  PaginatedResponse,
  ReadyPayload,
  ReversalResponse,
  TransactionDetailItem,
  TransferResponse,
  UserRole,
  UserStatus,
} from './types';

function buildQuery(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && String(value).trim() !== '') {
      search.set(key, String(value).trim());
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const healthApi = {
  getHealth(): Promise<HealthPayload> {
    return apiRequest<HealthPayload>('/health', { skipUnauthorizedCallback: true });
  },
  getReady(): Promise<ReadyPayload> {
    return apiRequest<ReadyPayload>('/ready', { skipUnauthorizedCallback: true });
  },
};

export const authApi = {
  me(options?: { skipUnauthorizedCallback?: boolean }): Promise<AuthSessionResponse> {
    return apiRequest<AuthSessionResponse>('/auth/me', {
      skipUnauthorizedCallback: options?.skipUnauthorizedCallback ?? false,
    });
  },

  login(payload: { email: string; password: string }): Promise<AuthSessionResponse> {
    return apiRequest<AuthSessionResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipUnauthorizedCallback: true,
    });
  },

  register(payload: {
    fullName: string;
    email: string;
    password: string;
  }): Promise<AuthSessionResponse> {
    return apiRequest<AuthSessionResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipUnauthorizedCallback: true,
    });
  },

  logout(): Promise<LogoutResponse> {
    return apiRequest<LogoutResponse>('/auth/logout', {
      method: 'POST',
      skipUnauthorizedCallback: true,
    });
  },
};

export const onboardingApi = {
  getOwn(): Promise<{ application: CustomerOnboardingApplication; requestId: string }> {
    return apiRequest<{ application: CustomerOnboardingApplication; requestId: string }>(
      '/onboarding/me',
    );
  },

  updateOwn(payload: {
    contactReference?: string;
    city?: string;
    country?: string;
    accountPurpose?: string;
    acceptedSyntheticTerms?: boolean;
    reopenForResubmission?: boolean;
  }): Promise<{ application: CustomerOnboardingApplication; requestId: string }> {
    return apiRequest<{ application: CustomerOnboardingApplication; requestId: string }>(
      '/onboarding/me',
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
    );
  },

  submitOwn(payload: {
    contactReference?: string;
    city?: string;
    country?: string;
    accountPurpose?: string;
    acceptedSyntheticTerms?: boolean;
    resubmit?: boolean;
  }): Promise<{ application: CustomerOnboardingApplication; requestId: string }> {
    return apiRequest<{ application: CustomerOnboardingApplication; requestId: string }>(
      '/onboarding/me/submit',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  },
};

export const accountsApi = {
  list(params?: {
    page?: number;
    pageSize?: number;
    status?: AccountStatus;
    search?: string;
    ownerUserId?: string;
    includeSystem?: boolean;
  }): Promise<PaginatedResponse<AccountItem>> {
    const query = buildQuery({
      page: params?.page ?? 1,
      pageSize: params?.pageSize ?? 20,
      status: params?.status,
      search: params?.search,
      ownerUserId: params?.ownerUserId,
      includeSystem: params?.includeSystem,
    });
    return apiRequest<PaginatedResponse<AccountItem>>(`/accounts${query}`);
  },

  getById(id: string): Promise<{ account: AccountItem; requestId: string }> {
    return apiRequest<{ account: AccountItem; requestId: string }>(
      `/accounts/${encodeURIComponent(id)}`,
    );
  },

  getLedger(
    id: string,
    params?: {
      page?: number;
      pageSize?: number;
      direction?: EntryDirection;
      type?: JournalTransactionType;
    },
  ): Promise<{
    account: AccountItem;
    items: AccountLedgerItem[];
    total: number;
    page: number;
    pageSize: number;
    requestId: string;
  }> {
    const query = buildQuery({
      page: params?.page ?? 1,
      pageSize: params?.pageSize ?? 20,
      direction: params?.direction,
      type: params?.type,
    });
    return apiRequest(`/accounts/${encodeURIComponent(id)}/ledger${query}`);
  },
};

export const transactionsApi = {
  getById(id: string): Promise<{ transaction: TransactionDetailItem; requestId: string }> {
    return apiRequest<{ transaction: TransactionDetailItem; requestId: string }>(
      `/transactions/${encodeURIComponent(id)}`,
    );
  },
};

export const transfersApi = {
  create(
    payload: {
      sourceAccountId: string;
      destinationAccountReference: string;
      amountMinor: string;
      description: string;
    },
    idempotencyKey: string,
  ): Promise<TransferResponse> {
    return apiRequest<TransferResponse>('/transfers', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
  },
};

export const adminApi = {
  getSummary(): Promise<AdminSummaryCounts> {
    return apiRequest<AdminSummaryCounts>('/admin/summary');
  },

  listOnboardingApplications(params: {
    status?: OnboardingStatus;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResponse<AdminOnboardingApplication>> {
    const query = buildQuery({
      status: params.status,
      search: params.search,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
    });
    return apiRequest<PaginatedResponse<AdminOnboardingApplication>>(
      `/admin/onboarding/applications${query}`,
    );
  },

  getOnboardingApplication(
    id: string,
  ): Promise<{ application: AdminOnboardingApplication; requestId: string }> {
    return apiRequest<{ application: AdminOnboardingApplication; requestId: string }>(
      `/admin/onboarding/applications/${encodeURIComponent(id)}`,
    );
  },

  approveOnboardingApplication(
    id: string,
    reason?: string,
  ): Promise<{ application: AdminOnboardingApplication; requestId: string }> {
    const trimmedReason = reason?.trim();
    const body = trimmedReason ? { reason: trimmedReason } : {};
    return apiRequest<{ application: AdminOnboardingApplication; requestId: string }>(
      `/admin/onboarding/applications/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  },

  rejectOnboardingApplication(
    id: string,
    reason: string,
  ): Promise<{ application: AdminOnboardingApplication; requestId: string }> {
    return apiRequest<{ application: AdminOnboardingApplication; requestId: string }>(
      `/admin/onboarding/applications/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      },
    );
  },

  listUsers(params: {
    page?: number;
    pageSize?: number;
    search?: string;
    role?: UserRole;
    status?: UserStatus;
  }): Promise<PaginatedResponse<AdminUserItem>> {
    const query = buildQuery({
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
      search: params.search,
      role: params.role,
      status: params.status,
    });
    return apiRequest<PaginatedResponse<AdminUserItem>>(`/admin/users${query}`);
  },

  getUser(id: string): Promise<{ user: AdminUserDetail; requestId: string }> {
    return apiRequest<{ user: AdminUserDetail; requestId: string }>(
      `/admin/users/${encodeURIComponent(id)}`,
    );
  },

  changeUserStatus(
    id: string,
    payload: { status: UserStatus; reason: string },
  ): Promise<{ user: AdminUserItem; requestId: string }> {
    return apiRequest<{ user: AdminUserItem; requestId: string }>(
      `/admin/users/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: payload.status,
          reason: payload.reason.trim(),
        }),
      },
    );
  },

  changeUserRole(
    id: string,
    payload: { role: UserRole; reason: string },
  ): Promise<{ user: AdminUserItem; requestId: string }> {
    return apiRequest<{ user: AdminUserItem; requestId: string }>(
      `/admin/users/${encodeURIComponent(id)}/role`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          role: payload.role,
          reason: payload.reason.trim(),
        }),
      },
    );
  },

  createAccount(payload: {
    ownerUserId: string;
    accountName: string;
    initialStatus: 'ACTIVE' | 'PENDING';
    initialCreditMinor: string;
    reason: string;
  }): Promise<{
    account: AccountItem;
    openingTransaction: TransactionDetailItem | null;
    requestId: string;
  }> {
    return apiRequest('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        accountName: payload.accountName.trim(),
        reason: payload.reason.trim(),
      }),
    });
  },

  activateAccount(
    id: string,
    reason: string,
  ): Promise<{ account: AccountItem; requestId: string }> {
    return apiRequest(`/admin/accounts/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
  },

  freezeAccount(
    id: string,
    reason: string,
  ): Promise<{ account: AccountItem; requestId: string }> {
    return apiRequest(`/admin/accounts/${encodeURIComponent(id)}/freeze`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
  },

  unfreezeAccount(
    id: string,
    reason: string,
  ): Promise<{ account: AccountItem; requestId: string }> {
    return apiRequest(`/admin/accounts/${encodeURIComponent(id)}/unfreeze`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
  },

  closeAccount(
    id: string,
    reason: string,
  ): Promise<{ account: AccountItem; requestId: string }> {
    return apiRequest(`/admin/accounts/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
  },

  reverseTransaction(transactionId: string, reason: string): Promise<ReversalResponse> {
    return apiRequest<ReversalResponse>(
      `/transactions/${encodeURIComponent(transactionId)}/reverse`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      },
    );
  },

  listAuditEvents(params: {
    page?: number;
    pageSize?: number;
    action?: string;
    entityType?: string;
    actorUserId?: string;
    from?: string;
    to?: string;
  }): Promise<PaginatedResponse<AuditEventItem>> {
    const query = buildQuery({
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
      action: params.action,
      entityType: params.entityType,
      actorUserId: params.actorUserId,
      from: params.from,
      to: params.to,
    });
    return apiRequest<PaginatedResponse<AuditEventItem>>(`/admin/audit-events${query}`);
  },
};
