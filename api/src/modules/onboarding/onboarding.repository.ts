import { OnboardingStatus, Prisma, type PrismaClient } from '@prisma/client';
import type { CreateAuditEventInput } from '../audit/audit.types.js';
import type { OnboardingApplicationRecord } from './onboarding.types.js';

export interface UpdateOnboardingData {
  status?: OnboardingStatus;
  contactReference?: string | null;
  city?: string | null;
  country?: string | null;
  accountPurpose?: string | null;
  acceptedSyntheticTerms?: boolean;
  submittedAt?: Date | null;
  reviewedAt?: Date | null;
  reviewedByUserId?: string | null;
  reviewReason?: string | null;
}

export interface OnboardingConcurrencyFilter {
  requireSubmitted?: boolean;
  requireUnsubmittedWhenPending?: boolean;
}

export interface OnboardingTxContext {
  findByUserId(userId: string): Promise<OnboardingApplicationRecord | null>;
  findById(id: string): Promise<OnboardingApplicationRecord | null>;
  updateByIdIfStatus(
    id: string,
    expectedStatuses: OnboardingStatus[],
    data: UpdateOnboardingData,
    filter?: OnboardingConcurrencyFilter,
  ): Promise<OnboardingApplicationRecord | null>;
  createAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }>;
}

export interface OnboardingRepository {
  runInTransaction<T>(fn: (tx: OnboardingTxContext) => Promise<T>): Promise<T>;
  findByUserId(userId: string): Promise<OnboardingApplicationRecord | null>;
  findById(id: string): Promise<OnboardingApplicationRecord | null>;
  listApplications(params: {
    status?: OnboardingStatus;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: OnboardingApplicationRecord[]; total: number }>;
}

const applicationSelect = {
  id: true,
  userId: true,
  status: true,
  contactReference: true,
  city: true,
  country: true,
  accountPurpose: true,
  acceptedSyntheticTerms: true,
  submittedAt: true,
  reviewedAt: true,
  reviewedByUserId: true,
  reviewReason: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      status: true,
    },
  },
} satisfies Prisma.OnboardingApplicationSelect;

type SelectedOnboarding = Prisma.OnboardingApplicationGetPayload<{
  select: typeof applicationSelect;
}>;

function mapApplication(row: SelectedOnboarding): OnboardingApplicationRecord {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    contactReference: row.contactReference,
    city: row.city,
    country: row.country,
    accountPurpose: row.accountPurpose,
    acceptedSyntheticTerms: row.acceptedSyntheticTerms,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedByUserId: row.reviewedByUserId,
    reviewReason: row.reviewReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    applicant: row.user,
  };
}

class PrismaOnboardingTxContext implements OnboardingTxContext {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async findByUserId(userId: string): Promise<OnboardingApplicationRecord | null> {
    const row = await this.tx.onboardingApplication.findUnique({
      where: { userId },
      select: applicationSelect,
    });
    return row ? mapApplication(row) : null;
  }

  async findById(id: string): Promise<OnboardingApplicationRecord | null> {
    const row = await this.tx.onboardingApplication.findUnique({
      where: { id },
      select: applicationSelect,
    });
    return row ? mapApplication(row) : null;
  }

  async updateByIdIfStatus(
    id: string,
    expectedStatuses: OnboardingStatus[],
    data: UpdateOnboardingData,
    filter?: OnboardingConcurrencyFilter,
  ): Promise<OnboardingApplicationRecord | null> {
    const includesPending = expectedStatuses.includes(OnboardingStatus.PENDING);
    const nonPendingStatuses = expectedStatuses.filter(
      (s) => s !== OnboardingStatus.PENDING,
    );

    const statusCondition: Prisma.OnboardingApplicationWhereInput =
      filter?.requireUnsubmittedWhenPending && includesPending
        ? {
            OR: [
              ...(nonPendingStatuses.length > 0
                ? [{ status: { in: nonPendingStatuses } }]
                : []),
              { status: OnboardingStatus.PENDING, submittedAt: null },
            ],
          }
        : {
            status: { in: expectedStatuses },
          };

    const updatedCount = await this.tx.onboardingApplication.updateMany({
      where: {
        id,
        ...statusCondition,
        ...(filter?.requireSubmitted
          ? {
              submittedAt: { not: null },
              acceptedSyntheticTerms: true,
            }
          : {}),
      },
      data,
    });

    if (updatedCount.count === 0) {
      return null;
    }

    const row = await this.tx.onboardingApplication.findUnique({
      where: { id },
      select: applicationSelect,
    });
    return row ? mapApplication(row) : null;
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

export class PrismaOnboardingRepository implements OnboardingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  runInTransaction<T>(fn: (tx: OnboardingTxContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaOnboardingTxContext(tx)), {
      maxWait: 10_000,
      timeout: 20_000,
    });
  }

  async findByUserId(userId: string): Promise<OnboardingApplicationRecord | null> {
    const row = await this.prisma.onboardingApplication.findUnique({
      where: { userId },
      select: applicationSelect,
    });
    return row ? mapApplication(row) : null;
  }

  async findById(id: string): Promise<OnboardingApplicationRecord | null> {
    const row = await this.prisma.onboardingApplication.findUnique({
      where: { id },
      select: applicationSelect,
    });
    return row ? mapApplication(row) : null;
  }

  async listApplications(params: {
    status?: OnboardingStatus;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: OnboardingApplicationRecord[]; total: number }> {
    const where: Prisma.OnboardingApplicationWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.search
        ? {
            user: {
              OR: [
                { fullName: { contains: params.search, mode: 'insensitive' } },
                { email: { contains: params.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.onboardingApplication.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: applicationSelect,
      }),
      this.prisma.onboardingApplication.count({ where }),
    ]);

    return {
      items: rows.map(mapApplication),
      total,
    };
  }
}
