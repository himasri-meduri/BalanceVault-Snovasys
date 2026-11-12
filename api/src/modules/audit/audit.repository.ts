import type { Prisma, PrismaClient } from '@prisma/client';
import {
  sanitizeAuditState,
  type AuditEventRecord,
  type CreateAuditEventInput,
  type ListAuditEventsQuery,
} from './audit.types.js';

export type PrismaDbClient = PrismaClient | Prisma.TransactionClient;

export interface AuditRepository {
  create(input: CreateAuditEventInput, tx?: PrismaDbClient): Promise<AuditEventRecord>;
  list(query: ListAuditEventsQuery): Promise<{ items: AuditEventRecord[]; total: number }>;
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    input: CreateAuditEventInput,
    tx?: PrismaDbClient,
  ): Promise<AuditEventRecord> {
    const db = tx ?? this.prisma;
    return db.auditEvent.create({
      data: {
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        requestId: input.requestId,
        reason: input.reason ?? null,
        beforeState: sanitizeAuditState(input.beforeState),
        afterState: sanitizeAuditState(input.afterState),
        ipHash: input.ipHash ?? null,
      },
    });
  }

  async list(
    query: ListAuditEventsQuery,
  ): Promise<{ items: AuditEventRecord[]; total: number }> {
    const occurredAtFilter =
      query.from || query.to
        ? {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          }
        : undefined;

    const where: Prisma.AuditEventWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(occurredAtFilter ? { occurredAt: occurredAtFilter } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return { items, total };
  }
}
