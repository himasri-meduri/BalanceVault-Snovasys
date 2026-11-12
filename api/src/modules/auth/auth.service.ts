import { ActorType, OnboardingStatus, UserRole, UserStatus } from '@prisma/client';
import type { AppEnv } from '../../config/env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/errors.js';
import { sanitizeAuditState } from '../audit/audit.types.js';
import {
  createCsrfToken,
  generateOpaqueToken,
  hashIpAddress,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './auth.crypto.js';
import type { AuthRepository, ListUsersParams } from './auth.repository.js';
import type {
  AdminUserDetail,
  AuthenticatedContext,
  PublicUserSummary,
  UserRecord,
} from './auth.types.js';

// Precomputed dummy Argon2id-shaped fallback for timing equalization on missing email
const DUMMY_PASSWORD_HASH_FALLBACK =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface RequestMetadata {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

export interface AuthSessionResult {
  user: PublicUserSummary;
  sessionToken: string;
  csrfToken: string;
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly env: AppEnv,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  async registerCustomer(
    input: { fullName: string; email: string; password: string },
    meta: RequestMetadata,
  ): Promise<AuthSessionResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const now = this.nowProvider();
    const expiresAt = this.computeAbsoluteExpiry(now);
    const rawSessionToken = generateOpaqueToken(32);
    const tokenHash = hashSessionToken(rawSessionToken, this.env.SESSION_SECRET);
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);
    const userAgent = sanitizeUserAgent(meta.userAgent);

    const created = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findUserByEmail(normalizedEmail);
      if (existing) {
        throw new ConflictError(
          'An account with this email already exists',
          'EMAIL_ALREADY_EXISTS',
        );
      }

      const user = await tx.createCustomerWithOnboarding({
        email: normalizedEmail,
        fullName: input.fullName.trim(),
        passwordHash,
        onboardingStatus: OnboardingStatus.PENDING,
      });

      const session = await tx.createSession({
        userId: user.id,
        tokenHash,
        expiresAt,
        lastSeenAt: now,
        userAgent,
        ipHash,
      });

      await tx.createAuditEvent({
        actorUserId: user.id,
        actorType: ActorType.USER,
        action: 'AUTH_REGISTER',
        entityType: 'User',
        entityId: user.id,
        requestId: meta.requestId,
        ipHash,
        afterState: sanitizeAuditState({
          role: user.role,
          status: user.status,
          onboardingStatus: user.onboardingStatus,
        }) as Record<string, unknown>,
      });

      return { user, sessionId: session.id };
    });

    return {
      user: toPublicUserSummary(created.user),
      sessionToken: rawSessionToken,
      csrfToken: createCsrfToken(created.sessionId, this.env.SESSION_SECRET),
    };
  }

  async login(
    input: {
      email: string;
      password: string;
      previousRawSessionToken?: string;
    },
    meta: RequestMetadata,
  ): Promise<AuthSessionResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.repository.findUserByEmail(normalizedEmail);
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);
    const now = this.nowProvider();

    if (!user) {
      await verifyPassword(DUMMY_PASSWORD_HASH_FALLBACK, input.password);
      await this.recordFailedLoginAudit(null, 'Account not found', meta.requestId, ipHash);
      throw new UnauthorizedError('Invalid email or password');
    }

    const passwordValid = await verifyPassword(user.passwordHash, input.password);
    if (!passwordValid) {
      await this.recordFailedLoginAudit(
        user.id,
        'Invalid password',
        meta.requestId,
        ipHash,
      );
      throw new UnauthorizedError('Invalid email or password');
    }

    if (user.status !== UserStatus.ACTIVE) {
      await this.recordFailedLoginAudit(
        user.id,
        `Blocked login for status ${user.status}`,
        meta.requestId,
        ipHash,
      );
      throw new UnauthorizedError('Invalid email or password');
    }

    const rawSessionToken = generateOpaqueToken(32);
    const tokenHash = hashSessionToken(rawSessionToken, this.env.SESSION_SECRET);
    const expiresAt = this.computeAbsoluteExpiry(now);
    const userAgent = sanitizeUserAgent(meta.userAgent);
    const previousTokenHash = input.previousRawSessionToken
      ? hashSessionToken(input.previousRawSessionToken, this.env.SESSION_SECRET)
      : null;

    const session = await this.repository.runInTransaction(async (tx) => {
      if (previousTokenHash) {
        await tx.revokeSessionByTokenHash(previousTokenHash, now);
      }

      const createdSession = await tx.createSession({
        userId: user.id,
        tokenHash,
        expiresAt,
        lastSeenAt: now,
        userAgent,
        ipHash,
      });

      await tx.createAuditEvent({
        actorUserId: user.id,
        actorType: ActorType.USER,
        action: 'AUTH_LOGIN_SUCCESS',
        entityType: 'Session',
        entityId: createdSession.id,
        requestId: meta.requestId,
        ipHash,
        afterState: sanitizeAuditState({
          role: user.role,
          rotatedPreviousSession: Boolean(previousTokenHash),
        }) as Record<string, unknown>,
      });

      return createdSession;
    });

    return {
      user: toPublicUserSummary(user),
      sessionToken: rawSessionToken,
      csrfToken: createCsrfToken(session.id, this.env.SESSION_SECRET),
    };
  }

  async authenticateSession(rawSessionToken: string): Promise<AuthenticatedContext> {
    if (!rawSessionToken || rawSessionToken.length < 16) {
      throw new UnauthorizedError('Authentication required');
    }

    const tokenHash = hashSessionToken(rawSessionToken, this.env.SESSION_SECRET);
    const session = await this.repository.findSessionByTokenHash(tokenHash);
    if (!session) {
      throw new UnauthorizedError('Authentication required');
    }

    if (session.revokedAt !== null) {
      throw new UnauthorizedError('Session has been revoked');
    }

    const now = this.nowProvider();
    if (now.getTime() >= session.expiresAt.getTime()) {
      await this.repository.revokeSessionById(session.id, now);
      throw new UnauthorizedError('Session has expired');
    }

    const idleLimitMs = this.env.SESSION_IDLE_MINUTES * 60 * 1000;
    if (now.getTime() - session.lastSeenAt.getTime() >= idleLimitMs) {
      await this.repository.revokeSessionById(session.id, now);
      throw new UnauthorizedError('Session timed out due to inactivity');
    }

    if (session.user.status !== UserStatus.ACTIVE) {
      await this.repository.revokeSessionById(session.id, now);
      throw new UnauthorizedError('User account is not active');
    }

    await this.repository.touchSessionLastSeen(session.id, now);

    return {
      sessionId: session.id,
      userId: session.user.id,
      email: session.user.email,
      fullName: session.user.fullName,
      role: session.user.role,
      status: session.user.status,
      onboardingStatus: session.user.onboardingStatus,
    };
  }

  async logout(auth: AuthenticatedContext, meta: RequestMetadata): Promise<void> {
    const now = this.nowProvider();
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    await this.repository.runInTransaction(async (tx) => {
      await tx.revokeSessionById(auth.sessionId, now);
      await tx.createAuditEvent({
        actorUserId: auth.userId,
        actorType: ActorType.USER,
        action: 'AUTH_LOGOUT',
        entityType: 'Session',
        entityId: auth.sessionId,
        requestId: meta.requestId,
        ipHash,
      });
    });
  }

  issueCsrfTokenForSession(sessionId: string): string {
    return createCsrfToken(sessionId, this.env.SESSION_SECRET);
  }

  async listUsers(params: ListUsersParams) {
    return this.repository.listUsers(params);
  }

  async getUserDetail(userId: string): Promise<AdminUserDetail> {
    const detail = await this.repository.findUserDetailById(userId);
    if (!detail) {
      throw new NotFoundError('User not found');
    }
    return detail;
  }

  async changeUserStatus(
    params: {
      actor: AuthenticatedContext;
      targetUserId: string;
      newStatus: UserStatus;
      reason: string;
    },
    meta: RequestMetadata,
  ): Promise<PublicUserSummary> {
    if (
      params.actor.role !== UserRole.ADMIN &&
      params.actor.role !== UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenError('Administrator role required');
    }

    if (
      params.actor.userId === params.targetUserId &&
      params.newStatus !== UserStatus.ACTIVE
    ) {
      throw new ConflictError(
        'Administrators cannot disable or lock their own active account',
        'SELF_STATUS_CHANGE_FORBIDDEN',
      );
    }

    const now = this.nowProvider();
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    const updated = await this.repository.runInTransaction(async (tx) => {
      const target = await tx.findUserById(params.targetUserId);
      if (!target) {
        throw new NotFoundError('Target user not found');
      }

      if (
        target.role !== UserRole.CUSTOMER &&
        params.actor.role !== UserRole.SUPER_ADMIN
      ) {
        throw new ForbiddenError(
          'Only SUPER_ADMIN may change status of ADMIN or SUPER_ADMIN accounts',
        );
      }

      if (
        target.role === UserRole.SUPER_ADMIN &&
        target.status === UserStatus.ACTIVE &&
        params.newStatus !== UserStatus.ACTIVE
      ) {
        const superAdminCount = await tx.countActiveSuperAdmins();
        if (superAdminCount <= 1) {
          throw new ConflictError(
            'Cannot disable or lock the last active SUPER_ADMIN',
            'LAST_SUPER_ADMIN_PROTECTED',
          );
        }
      }

      if (target.status === params.newStatus) {
        return target;
      }

      const previousStatus = target.status;
      const saved = await tx.updateUserStatus(target.id, params.newStatus);
      const revokeSessions = params.newStatus !== UserStatus.ACTIVE;
      if (revokeSessions) {
        await tx.revokeAllUserSessions(target.id, now);
      }

      await tx.createAuditEvent({
        actorUserId: params.actor.userId,
        actorType: ActorType.USER,
        action: 'USER_STATUS_CHANGE',
        entityType: 'User',
        entityId: target.id,
        requestId: meta.requestId,
        reason: params.reason,
        ipHash,
        beforeState: { status: previousStatus },
        afterState: {
          status: saved.status,
          sessionsRevoked: revokeSessions,
        },
      });

      return saved;
    });

    return toPublicUserSummary(updated);
  }

  async changeUserRole(
    params: {
      actor: AuthenticatedContext;
      targetUserId: string;
      newRole: UserRole;
      reason: string;
    },
    meta: RequestMetadata,
  ): Promise<PublicUserSummary> {
    if (params.actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Only SUPER_ADMIN may change user roles');
    }

    const now = this.nowProvider();
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    const updated = await this.repository.runInTransaction(async (tx) => {
      const target = await tx.findUserById(params.targetUserId);
      if (!target) {
        throw new NotFoundError('Target user not found');
      }

      if (target.role === UserRole.SUPER_ADMIN && params.newRole !== UserRole.SUPER_ADMIN) {
        const superAdminCount = await tx.countActiveSuperAdmins();
        if (superAdminCount <= 1) {
          throw new ConflictError(
            'Cannot demote the last active SUPER_ADMIN',
            'LAST_SUPER_ADMIN_PROTECTED',
          );
        }
      }

      const previousRole = target.role;
      const saved = await tx.updateUserRole(target.id, params.newRole);
      await tx.revokeAllUserSessions(target.id, now);

      await tx.createAuditEvent({
        actorUserId: params.actor.userId,
        actorType: ActorType.USER,
        action: 'USER_ROLE_CHANGE',
        entityType: 'User',
        entityId: target.id,
        requestId: meta.requestId,
        reason: params.reason,
        ipHash,
        beforeState: { role: previousRole },
        afterState: { role: saved.role },
      });

      return saved;
    });

    return toPublicUserSummary(updated);
  }

  private computeAbsoluteExpiry(now: Date): Date {
    return new Date(now.getTime() + this.env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  }

  private async recordFailedLoginAudit(
    userId: string | null,
    reason: string,
    requestId: string,
    ipHash: string | null,
  ): Promise<void> {
    await this.repository.runInTransaction(async (tx) => {
      await tx.createAuditEvent({
        actorUserId: userId,
        actorType: userId ? ActorType.USER : ActorType.ANONYMOUS,
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'User',
        entityId: userId ?? 'unknown',
        requestId,
        reason,
        ipHash,
      });
    });
  }
}

export function toPublicUserSummary(user: UserRecord): PublicUserSummary {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    onboardingStatus: user.onboardingStatus,
    createdAt: user.createdAt,
  };
}

function sanitizeUserAgent(userAgent?: string): string | null {
  if (!userAgent) {
    return null;
  }
  return userAgent.slice(0, 160);
}
