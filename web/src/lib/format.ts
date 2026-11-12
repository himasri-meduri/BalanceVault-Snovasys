import type {
  AccountItem,
  AdminOnboardingApplication,
  CustomerOnboardingApplication,
  UserRole,
} from './types';

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

export function getDefaultHomePath(role: UserRole): string {
  return role === 'ADMIN' || role === 'SUPER_ADMIN' ? '/admin' : '/customer';
}

export function isAdminRole(role: UserRole | null | undefined): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export function describeOnboardingStage(
  app: Pick<CustomerOnboardingApplication, 'status' | 'submittedAt'>,
): string {
  if (app.status === 'PENDING' && app.submittedAt === null) {
    return 'Profile setup needed before submission';
  }
  if (app.status === 'PENDING' && app.submittedAt !== null) {
    return 'Submitted — awaiting administrator review';
  }
  if (app.status === 'DRAFT') {
    return 'Draft reopened — complete edits and submit for review';
  }
  if (app.status === 'NEEDS_INFORMATION') {
    return 'Additional information requested — update and submit';
  }
  if (app.status === 'APPROVED') {
    return 'Approved — synthetic onboarding verified';
  }
  if (app.status === 'REJECTED') {
    return 'Rejected — review reason below before reopening or resubmitting';
  }
  return app.status;
}

export function canCustomerEditOnboarding(
  app: Pick<CustomerOnboardingApplication, 'status' | 'submittedAt'>,
): boolean {
  if (app.status === 'DRAFT' || app.status === 'NEEDS_INFORMATION') {
    return true;
  }
  if (app.status === 'PENDING' && app.submittedAt === null) {
    return true;
  }
  return false;
}

export function canCustomerSubmitOnboarding(
  app: Pick<CustomerOnboardingApplication, 'status' | 'submittedAt'>,
): boolean {
  return canCustomerEditOnboarding(app);
}

export function canAdminApproveOnboarding(
  app: Pick<
    AdminOnboardingApplication,
    'status' | 'submittedAt' | 'acceptedSyntheticTerms'
  >,
): boolean {
  return (
    app.status === 'PENDING' &&
    app.submittedAt !== null &&
    app.acceptedSyntheticTerms === true
  );
}

export function canAdminRejectOnboarding(
  app: Pick<AdminOnboardingApplication, 'status'>,
): boolean {
  return app.status === 'PENDING' || app.status === 'NEEDS_INFORMATION';
}

export function sumAccountBalancesMinor(
  accounts: ReadonlyArray<Pick<AccountItem, 'balanceMinor' | 'kind'>>,
): string {
  let total = 0n;
  for (const acc of accounts) {
    if (acc.kind === 'CUSTOMER') {
      total += BigInt(acc.balanceMinor);
    }
  }
  return total.toString(10);
}

export function sanitizeInternalRedirectPath(
  candidate: unknown,
  fallback: string,
): string {
  if (typeof candidate !== 'string') {
    return fallback;
  }
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }
  return trimmed;
}
