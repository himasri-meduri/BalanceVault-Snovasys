import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes } from '../src/app/App';
import { AuthProvider } from '../src/auth/AuthProvider';
import type {
  AccountItem,
  AccountLedgerItem,
  AdminOnboardingApplication,
  AdminSummaryCounts,
  AuditEventItem,
  AuthUser,
  CustomerOnboardingApplication,
  TransactionDetailItem,
  UserRole,
} from '../src/lib/types';

export interface CapturedFetchCall {
  path: string;
  method: string;
  credentials: RequestCredentials | undefined;
  headers: Headers;
  body: unknown;
}

export function jsonResponse(status: number, body: unknown): Response {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => payload,
  } as Response;
}

export function apiErrorBody(params: {
  code: string;
  message: string;
  requestId?: string;
  fieldErrors?: Record<string, string[]>;
}) {
  return {
    error: {
      code: params.code,
      message: params.message,
      requestId: params.requestId ?? 'req-test-1',
      ...(params.fieldErrors ? { fieldErrors: params.fieldErrors } : {}),
    },
  };
}

export function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    fullName: 'Asha Rao',
    email: 'asha.rao@example.com',
    role: 'CUSTOMER',
    status: 'ACTIVE',
    onboardingStatus: 'PENDING',
    createdAt: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

export function makeCustomerOnboarding(
  overrides: Partial<CustomerOnboardingApplication> = {},
): CustomerOnboardingApplication {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'PENDING',
    contactReference: null,
    city: null,
    country: null,
    accountPurpose: null,
    acceptedSyntheticTerms: false,
    submittedAt: null,
    reviewedAt: null,
    reviewReason: null,
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
    applicant: {
      id: '11111111-1111-4111-8111-111111111111',
      fullName: 'Asha Rao',
      email: 'asha.rao@example.com',
    },
    ...overrides,
  };
}

export function makeAdminOnboarding(
  overrides: Partial<AdminOnboardingApplication> = {},
): AdminOnboardingApplication {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    userId: '11111111-1111-4111-8111-111111111111',
    status: 'PENDING',
    contactReference: '+91-90000-00001',
    city: 'Bengaluru',
    country: 'India',
    accountPurpose: 'Synthetic double-entry vault demonstration account',
    acceptedSyntheticTerms: true,
    submittedAt: '2026-11-11T10:15:00.000Z',
    reviewedAt: null,
    reviewedByUserId: null,
    reviewReason: null,
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:15:00.000Z',
    applicant: {
      id: '11111111-1111-4111-8111-111111111111',
      fullName: 'Asha Rao',
      email: 'asha.rao@example.com',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
    ...overrides,
  };
}

export function makeAuditEvent(
  overrides: Partial<AuditEventItem> = {},
): AuditEventItem {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    actorUserId: '99999999-9999-4999-8999-999999999999',
    actorType: 'USER',
    action: 'ONBOARDING_APPROVED',
    entityType: 'OnboardingApplication',
    entityId: '33333333-3333-4333-8333-333333333333',
    requestId: 'req-audit-1',
    reason: 'Approved after synthetic onboarding review',
    beforeState: { status: 'PENDING' },
    afterState: { status: 'APPROVED' },
    occurredAt: '2026-11-11T11:00:00.000Z',
    ipHash: null,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publicReference: 'BV-A1B2C3D4E5F6',
    kind: 'CUSTOMER',
    ownerUserId: '11111111-1111-4111-8111-111111111111',
    accountName: 'Primary Synthetic Vault',
    currency: 'INR',
    status: 'ACTIVE',
    balanceMinor: '500000',
    version: 1,
    statusReason: 'Initial allocation approved',
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

export function makeLedgerEntry(
  overrides: Partial<AccountLedgerItem> = {},
): AccountLedgerItem {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    transactionId: '55555555-5555-4555-8555-555555555555',
    transactionPublicReference: 'TXN-20261111-0001',
    transactionType: 'DEMO_TRANSFER',
    transactionStatus: 'POSTED',
    direction: 'DEBIT',
    amountMinor: '150000',
    currency: 'INR',
    description: 'Internal vault allocation',
    counterpartyReference: 'BV-9988776655AA',
    reversalOfTransactionId: null,
    reversedByTransactionId: null,
    createdAt: '2026-11-11T11:15:00.000Z',
    ...overrides,
  };
}

export function makeTransactionDetail(
  overrides: Partial<TransactionDetailItem> = {},
): TransactionDetailItem {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    publicReference: 'TXN-20261111-0001',
    type: 'DEMO_TRANSFER',
    status: 'POSTED',
    currency: 'INR',
    description: 'Internal vault allocation',
    initiatedByUserId: '11111111-1111-4111-8111-111111111111',
    reversalOfTransactionId: null,
    reversalOfPublicReference: null,
    reversedByTransactionId: null,
    reversedByPublicReference: null,
    createdAt: '2026-11-11T11:15:00.000Z',
    entries: [
      {
        id: '66666666-6666-4666-8666-666666666661',
        accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        accountPublicReference: 'BV-A1B2C3D4E5F6',
        accountKind: 'CUSTOMER',
        accountName: 'Primary Synthetic Vault',
        direction: 'DEBIT',
        amountMinor: '150000',
        currency: 'INR',
      },
      {
        id: '66666666-6666-4666-8666-666666666662',
        accountId: null,
        accountPublicReference: 'BV-9988776655AA',
        accountKind: 'CUSTOMER',
        accountName: null,
        direction: 'CREDIT',
        amountMinor: '150000',
        currency: 'INR',
      },
    ],
    ...overrides,
  };
}

export function makeAdminSummary(
  overrides: Partial<AdminSummaryCounts> = {},
): AdminSummaryCounts {
  return {
    customersTotal: 8,
    pendingOnboarding: 3,
    approvedOnboarding: 4,
    rejectedOnboarding: 1,
    activeAccounts: 6,
    frozenAccounts: 1,
    pendingAccounts: 2,
    closedAccounts: 1,
    demoTransactionsTotal: 14,
    auditEventsTotal: 25,
    requestId: 'req-summary-1',
    ...overrides,
  };
}

export function makeSessionResponse(
  role: UserRole,
  csrfToken = 'csrf-token-123',
  userOverrides: Partial<AuthUser> = {},
) {
  return {
    user: makeUser({
      id:
        role === 'CUSTOMER'
          ? '11111111-1111-4111-8111-111111111111'
          : '99999999-9999-4999-8999-999999999999',
      fullName: role === 'CUSTOMER' ? 'Asha Rao' : 'Vikram Admin',
      email:
        role === 'CUSTOMER'
          ? 'asha.rao@example.com'
          : 'admin@balancevault.local',
      role,
      onboardingStatus: role === 'CUSTOMER' ? 'PENDING' : null,
      ...userOverrides,
    }),
    csrfToken,
    requestId: 'req-auth-1',
  };
}

export function installFetchMock(
  handler: (call: CapturedFetchCall) => Response | Promise<Response>,
): CapturedFetchCall[] {
  const calls: CapturedFetchCall[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input.toString();
    const apiMarker = '/api';
    const markerIndex = rawUrl.indexOf(apiMarker);
    const path =
      markerIndex >= 0 ? rawUrl.slice(markerIndex + apiMarker.length) : rawUrl;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);

    let parsedBody: unknown = undefined;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }

    const call: CapturedFetchCall = {
      path,
      method,
      credentials: init?.credentials,
      headers,
      body: parsedBody,
    };
    calls.push(call);
    return handler(call);
  });

  return calls;
}

export function renderAppRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}
