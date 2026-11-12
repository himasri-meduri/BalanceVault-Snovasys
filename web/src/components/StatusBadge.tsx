interface StatusBadgeProps {
  value: string;
}

const TONE_MAP: Record<
  string,
  'success' | 'warning' | 'danger' | 'neutral' | 'info'
> = {
  ACTIVE: 'success',
  APPROVED: 'success',
  POSTED: 'success',
  CREDIT: 'success',
  READY: 'success',
  OK: 'success',
  PENDING: 'warning',
  DRAFT: 'neutral',
  NEEDS_INFORMATION: 'warning',
  REVERSED: 'warning',
  REVERSAL: 'warning',
  FROZEN: 'danger',
  REJECTED: 'danger',
  DISABLED: 'danger',
  LOCKED: 'danger',
  DEBIT: 'danger',
  CLOSED: 'neutral',
  DEGRADED: 'danger',
  UNAVAILABLE: 'danger',
  DEMO_TRANSFER: 'info',
  ADJUSTMENT: 'neutral',
  ADMIN: 'info',
  SUPER_ADMIN: 'info',
  CUSTOMER: 'neutral',
  SYSTEM: 'info',
  SYSTEM_ISSUANCE: 'info',
};

export function StatusBadge({ value }: StatusBadgeProps) {
  const normalized = value.toUpperCase();
  const tone = TONE_MAP[normalized] ?? 'neutral';

  return <span className={`bv-badge bv-badge--${tone}`}>{normalized}</span>;
}
