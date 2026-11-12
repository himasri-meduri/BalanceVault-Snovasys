import type { OnboardingStatus, UserRole, UserStatus } from '@prisma/client';

export interface OnboardingApplicantSummary {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

export interface OnboardingApplicationRecord {
  id: string;
  userId: string;
  status: OnboardingStatus;
  contactReference: string | null;
  city: string | null;
  country: string | null;
  accountPurpose: string | null;
  acceptedSyntheticTerms: boolean;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  reviewReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  applicant: OnboardingApplicantSummary;
}

export interface CustomerOnboardingView {
  id: string;
  status: OnboardingStatus;
  contactReference: string | null;
  city: string | null;
  country: string | null;
  accountPurpose: string | null;
  acceptedSyntheticTerms: boolean;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  applicant: {
    id: string;
    fullName: string;
    email: string;
  };
}

export interface AdminOnboardingView {
  id: string;
  userId: string;
  status: OnboardingStatus;
  contactReference: string | null;
  city: string | null;
  country: string | null;
  accountPurpose: string | null;
  acceptedSyntheticTerms: boolean;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  reviewReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  applicant: OnboardingApplicantSummary;
}
