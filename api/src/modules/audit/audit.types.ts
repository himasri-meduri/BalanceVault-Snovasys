import type { ActorType, Prisma } from '@prisma/client';

const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|hash|cookie|authorization|database_url|direct_url|redis_url)/i;

export function sanitizeAuditState(
  input: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!input) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeAuditState(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized as Prisma.InputJsonValue;
}

export interface CreateAuditEventInput {
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string;
  reason?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  ipHash?: string | null;
}

export interface AuditEventRecord {
  id: string;
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  requestId: string;
  reason: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipHash: string | null;
}

export interface ListAuditEventsQuery {
  page: number;
  pageSize: number;
  action?: string;
  entityType?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
}
