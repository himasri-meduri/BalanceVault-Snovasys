import type { OnboardingStatus, UserRole, UserStatus } from '@prisma/client';

export interface PublicUserSummary {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  onboardingStatus: OnboardingStatus | null;
  createdAt: Date;
}

export interface AdminUserDetail extends PublicUserSummary {
  updatedAt: Date;
  accountCount: number;
  activeAccountCount: number;
  onboardingSubmittedAt: Date | null;
  onboardingReviewedAt: Date | null;
  onboardingReviewReason: string | null;
}

export interface AuthenticatedContext {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  onboardingStatus: OnboardingStatus | null;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  onboardingStatus: OnboardingStatus | null;
}

export interface SessionWithUserRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  user: {
    id: string;
    email: string;
    fullName: string;
    role: UserRole;
    status: UserStatus;
    onboardingStatus: OnboardingStatus | null;
  };
}
