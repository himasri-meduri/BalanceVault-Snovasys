import {
  AccountKind,
  AccountStatus,
  OnboardingStatus,
  Prisma,
  UserRole,
  UserStatus,
  type PrismaClient,
} from '@prisma/client';
import { ConflictError } from '../../shared/errors.js';
import type { CreateAuditEventInput } from '../audit/audit.types.js';
import type {
  AdminUserDetail,
  SessionWithUserRecord,
  UserRecord,
} from './auth.types.js';

export interface ListUsersParams {
  page: number;
  pageSize: number;
  search?: string;
  role?: UserRole;
  status?: UserStatus;
}

export interface AuthTxContext {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(userId: string): Promise<UserRecord | null>;
  createCustomerWithOnboarding(params: {
    email: string;
    fullName: string;
    passwordHash: string;
    onboardingStatus: OnboardingStatus;
  }): Promise<UserRecord>;
  createSession(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    lastSeenAt: Date;
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<{ id: string }>;
  revokeSessionByTokenHash(tokenHash: string, revokedAt: Date): Promise<void>;
  revokeSessionById(sessionId: string, revokedAt: Date): Promise<void>;
  revokeAllUserSessions(userId: string, revokedAt: Date): Promise<void>;
  updateUserRole(userId: string, role: UserRole): Promise<UserRecord>;
  updateUserStatus(userId: string, status: UserStatus): Promise<UserRecord>;
  countActiveSuperAdmins(): Promise<number>;
  createAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }>;
}

export interface AuthRepository {
  runInTransaction<T>(fn: (tx: AuthTxContext) => Promise<T>): Promise<T>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserDetailById(userId: string): Promise<AdminUserDetail | null>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionWithUserRecord | null>;
  revokeSessionById(sessionId: string, revokedAt: Date): Promise<void>;
  touchSessionLastSeen(sessionId: string, lastSeenAt: Date): Promise<void>;
  listUsers(params: ListUsersParams): Promise<{
    items: Array<Omit<UserRecord, 'passwordHash'>>;
    total: number;
  }>;
}

class PrismaAuthTxContext implements AuthTxContext {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = await this.tx.user.findUnique({
      where: { email },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return user ? mapUserRecord(user) : null;
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    const user = await this.tx.user.findUnique({
      where: { id: userId },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return user ? mapUserRecord(user) : null;
  }

  async createCustomerWithOnboarding(params: {
    email: string;
    fullName: string;
    passwordHash: string;
    onboardingStatus: OnboardingStatus;
  }): Promise<UserRecord> {
    try {
      const user = await this.tx.user.create({
        data: {
          email: params.email,
          fullName: params.fullName,
          passwordHash: params.passwordHash,
          role: UserRole.CUSTOMER,
          status: UserStatus.ACTIVE,
          onboardingApplication: {
            create: {
              status: params.onboardingStatus,
            },
          },
        },
        include: { onboardingApplication: { select: { status: true } } },
      });

      return mapUserRecord(user);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictError(
          'An account with this email already exists',
          'EMAIL_ALREADY_EXISTS',
        );
      }
      throw err;
    }
  }

  async createSession(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    lastSeenAt: Date;
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<{ id: string }> {
    return this.tx.session.create({
      data: {
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        lastSeenAt: params.lastSeenAt,
        userAgent: params.userAgent,
        ipHash: params.ipHash,
      },
      select: { id: true },
    });
  }

  async revokeSessionByTokenHash(tokenHash: string, revokedAt: Date): Promise<void> {
    await this.tx.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeSessionById(sessionId: string, revokedAt: Date): Promise<void> {
    await this.tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAllUserSessions(userId: string, revokedAt: Date): Promise<void> {
    await this.tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async updateUserRole(userId: string, role: UserRole): Promise<UserRecord> {
    const user = await this.tx.user.update({
      where: { id: userId },
      data: { role },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return mapUserRecord(user);
  }

  async updateUserStatus(userId: string, status: UserStatus): Promise<UserRecord> {
    const user = await this.tx.user.update({
      where: { id: userId },
      data: { status },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return mapUserRecord(user);
  }

  async countActiveSuperAdmins(): Promise<number> {
    return this.tx.user.count({
      where: {
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
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

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  runInTransaction<T>(fn: (tx: AuthTxContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaAuthTxContext(tx)), {
      maxWait: 10_000,
      timeout: 20_000,
    });
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return user ? mapUserRecord(user) : null;
  }

  async findUserDetailById(userId: string): Promise<AdminUserDetail | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        onboardingApplication: {
          select: {
            status: true,
            submittedAt: true,
            reviewedAt: true,
            reviewReason: true,
          },
        },
        _count: {
          select: {
            accounts: {
              where: { kind: AccountKind.CUSTOMER },
            },
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    const activeAccountCount = await this.prisma.account.count({
      where: {
        ownerUserId: user.id,
        kind: AccountKind.CUSTOMER,
        status: AccountStatus.ACTIVE,
      },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      onboardingStatus: user.onboardingApplication?.status ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accountCount: user._count.accounts,
      activeAccountCount,
      onboardingSubmittedAt: user.onboardingApplication?.submittedAt ?? null,
      onboardingReviewedAt: user.onboardingApplication?.reviewedAt ?? null,
      onboardingReviewReason: user.onboardingApplication?.reviewReason ?? null,
    };
  }

  async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<SessionWithUserRecord | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            status: true,
            onboardingApplication: { select: { status: true } },
          },
        },
      },
    });

    if (!session) {
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
        id: session.user.id,
        email: session.user.email,
        fullName: session.user.fullName,
        role: session.user.role,
        status: session.user.status,
        onboardingStatus: session.user.onboardingApplication?.status ?? null,
      },
    };
  }

  async revokeSessionById(sessionId: string, revokedAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async touchSessionLastSeen(sessionId: string, lastSeenAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt },
    });
  }

  async listUsers(params: ListUsersParams) {
    const search = params.search?.trim();
    const where: Prisma.UserWhereInput = {
      ...(params.role ? { role: params.role } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          onboardingApplication: { select: { status: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        onboardingStatus: u.onboardingApplication?.status ?? null,
      })),
      total,
    };
  }
}

function mapUserRecord(user: {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  onboardingApplication: { status: OnboardingStatus } | null;
}): UserRecord {
  return {
    id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    onboardingStatus: user.onboardingApplication?.status ?? null,
  };
}
