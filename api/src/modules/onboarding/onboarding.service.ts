import { ActorType, OnboardingStatus, UserRole } from '@prisma/client';
import type { AppEnv } from '../../config/env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { hashIpAddress } from '../auth/auth.crypto.js';
import type { RequestMetadata } from '../auth/auth.service.js';
import type { AuthenticatedContext } from '../auth/auth.types.js';
import { completeOnboardingFieldsSchema } from './onboarding.schemas.js';
import type { OnboardingRepository } from './onboarding.repository.js';
import type {
  AdminOnboardingView,
  CustomerOnboardingView,
  OnboardingApplicationRecord,
} from './onboarding.types.js';

const CUSTOMER_EDITABLE_STATUSES: OnboardingStatus[] = [
  OnboardingStatus.DRAFT,
  OnboardingStatus.PENDING,
  OnboardingStatus.NEEDS_INFORMATION,
];

const CUSTOMER_SUBMITTABLE_STATUSES: OnboardingStatus[] = [
  OnboardingStatus.DRAFT,
  OnboardingStatus.PENDING,
  OnboardingStatus.NEEDS_INFORMATION,
];

export class OnboardingService {
  constructor(
    private readonly repository: OnboardingRepository,
    private readonly env: AppEnv,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  async getOwnApplication(actor: AuthenticatedContext): Promise<CustomerOnboardingView> {
    if (actor.role !== UserRole.CUSTOMER) {
      throw new ForbiddenError('Only customers have onboarding applications');
    }

    const record = await this.repository.findByUserId(actor.userId);
    if (!record) {
      throw new NotFoundError('Onboarding application not found');
    }

    return toCustomerView(record);
  }

  async updateOwnApplication(
    actor: AuthenticatedContext,
    input: {
      contactReference?: string;
      city?: string;
      country?: string;
      accountPurpose?: string;
      acceptedSyntheticTerms?: boolean;
      reopenForResubmission?: boolean;
    },
    meta: RequestMetadata,
  ): Promise<CustomerOnboardingView> {
    if (actor.role !== UserRole.CUSTOMER) {
      throw new ForbiddenError('Only customers may update onboarding applications');
    }

    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    const updated = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findByUserId(actor.userId);
      if (!existing) {
        throw new NotFoundError('Onboarding application not found');
      }

      if (existing.status === OnboardingStatus.APPROVED) {
        throw new ConflictError(
          'Approved onboarding applications cannot be modified',
          'ONBOARDING_ALREADY_APPROVED',
        );
      }

      if (existing.status === OnboardingStatus.REJECTED) {
        if (!input.reopenForResubmission) {
          throw new ConflictError(
            'Rejected applications require reopenForResubmission: true before editing',
            'EXPLICIT_RESUBMISSION_REQUIRED',
          );
        }

        const reopened = await tx.updateByIdIfStatus(
          existing.id,
          [OnboardingStatus.REJECTED],
          {
            status: OnboardingStatus.DRAFT,
            submittedAt: null,
            reviewedAt: null,
            reviewedByUserId: null,
            ...(input.contactReference !== undefined
              ? { contactReference: input.contactReference }
              : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.country !== undefined ? { country: input.country } : {}),
            ...(input.accountPurpose !== undefined
              ? { accountPurpose: input.accountPurpose }
              : {}),
            ...(input.acceptedSyntheticTerms !== undefined
              ? { acceptedSyntheticTerms: input.acceptedSyntheticTerms }
              : {}),
          },
        );

        if (!reopened) {
          throw new ConflictError(
            'Onboarding application state changed concurrently',
            'INVALID_STATE_TRANSITION',
          );
        }

        await tx.createAuditEvent({
          actorUserId: actor.userId,
          actorType: ActorType.USER,
          action: 'ONBOARDING_RESUBMISSION_DRAFTED',
          entityType: 'OnboardingApplication',
          entityId: reopened.id,
          requestId: meta.requestId,
          reason: 'Customer reopened rejected application for resubmission',
          ipHash,
          beforeState: toAuditSnapshot(existing),
          afterState: toAuditSnapshot(reopened),
        });

        return reopened;
      }

      if (!CUSTOMER_EDITABLE_STATUSES.includes(existing.status)) {
        throw new ConflictError(
          `Cannot edit onboarding application in ${existing.status} state`,
          'INVALID_STATE_TRANSITION',
        );
      }

      if (input.reopenForResubmission !== undefined) {
        throw new ConflictError(
          'Only rejected applications can be reopened for resubmission',
          'INVALID_STATE_TRANSITION',
        );
      }

      if (existing.status === OnboardingStatus.PENDING && existing.submittedAt !== null) {
        throw new ConflictError(
          'Submitted applications cannot be modified while awaiting review',
          'ONBOARDING_ALREADY_SUBMITTED',
        );
      }

      const saved = await tx.updateByIdIfStatus(
        existing.id,
        CUSTOMER_EDITABLE_STATUSES,
        {
          ...(input.contactReference !== undefined
            ? { contactReference: input.contactReference }
            : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.accountPurpose !== undefined
            ? { accountPurpose: input.accountPurpose }
            : {}),
          ...(input.acceptedSyntheticTerms !== undefined
            ? { acceptedSyntheticTerms: input.acceptedSyntheticTerms }
            : {}),
        },
        { requireUnsubmittedWhenPending: true },
      );

      if (!saved) {
        throw new ConflictError(
          'Onboarding application state changed concurrently',
          'INVALID_STATE_TRANSITION',
        );
      }

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: 'ONBOARDING_PROFILE_UPDATED',
        entityType: 'OnboardingApplication',
        entityId: saved.id,
        requestId: meta.requestId,
        ipHash,
        beforeState: toAuditSnapshot(existing),
        afterState: toAuditSnapshot(saved),
      });

      return saved;
    });

    return toCustomerView(updated);
  }

  async submitOwnApplication(
    actor: AuthenticatedContext,
    input: {
      contactReference?: string;
      city?: string;
      country?: string;
      accountPurpose?: string;
      acceptedSyntheticTerms?: boolean;
      resubmit?: boolean;
    },
    meta: RequestMetadata,
  ): Promise<CustomerOnboardingView> {
    if (actor.role !== UserRole.CUSTOMER) {
      throw new ForbiddenError('Only customers may submit onboarding applications');
    }

    const now = this.nowProvider();
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    const submitted = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findByUserId(actor.userId);
      if (!existing) {
        throw new NotFoundError('Onboarding application not found');
      }

      if (existing.status === OnboardingStatus.APPROVED) {
        throw new ConflictError(
          'Approved onboarding applications cannot be resubmitted',
          'ONBOARDING_ALREADY_APPROVED',
        );
      }

      const isResubmission = existing.status === OnboardingStatus.REJECTED;
      if (isResubmission && !input.resubmit) {
        throw new ConflictError(
          'Rejected onboarding applications require explicit resubmit: true to resubmit',
          'EXPLICIT_RESUBMISSION_REQUIRED',
        );
      }

      if (
        !isResubmission &&
        !CUSTOMER_SUBMITTABLE_STATUSES.includes(existing.status)
      ) {
        throw new ConflictError(
          `Cannot submit onboarding application from ${existing.status} state`,
          'INVALID_STATE_TRANSITION',
        );
      }

      if (
        existing.status === OnboardingStatus.PENDING &&
        existing.submittedAt !== null
      ) {
        throw new ConflictError(
          'Onboarding application has already been submitted for review',
          'ONBOARDING_ALREADY_SUBMITTED',
        );
      }

      const merged = {
        contactReference: input.contactReference ?? existing.contactReference ?? '',
        city: input.city ?? existing.city ?? '',
        country: input.country ?? existing.country ?? '',
        accountPurpose: input.accountPurpose ?? existing.accountPurpose ?? '',
        acceptedSyntheticTerms:
          input.acceptedSyntheticTerms ?? existing.acceptedSyntheticTerms,
      };

      const completeness = completeOnboardingFieldsSchema.safeParse(merged);
      if (!completeness.success) {
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of completeness.error.issues) {
          const key = issue.path.join('.') || 'body';
          fieldErrors[key] = fieldErrors[key] ?? [];
          fieldErrors[key].push(issue.message);
        }
        throw new ValidationError(
          'Onboarding profile must be complete before submission',
          fieldErrors,
        );
      }

      const expectedStatuses = isResubmission
        ? [OnboardingStatus.REJECTED]
        : CUSTOMER_SUBMITTABLE_STATUSES;

      const updated = await tx.updateByIdIfStatus(
        existing.id,
        expectedStatuses,
        {
          status: OnboardingStatus.PENDING,
          contactReference: completeness.data.contactReference,
          city: completeness.data.city,
          country: completeness.data.country,
          accountPurpose: completeness.data.accountPurpose,
          acceptedSyntheticTerms: true,
          submittedAt: now,
          reviewedAt: null,
          reviewedByUserId: null,
          reviewReason: null,
        },
        isResubmission ? undefined : { requireUnsubmittedWhenPending: true },
      );

      if (!updated) {
        throw new ConflictError(
          'Onboarding application state changed concurrently',
          'INVALID_STATE_TRANSITION',
        );
      }

      const isResubmissionAudit =
        isResubmission ||
        (existing.status === OnboardingStatus.DRAFT && existing.reviewReason !== null);

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: isResubmissionAudit ? 'ONBOARDING_RESUBMITTED' : 'ONBOARDING_SUBMITTED',
        entityType: 'OnboardingApplication',
        entityId: updated.id,
        requestId: meta.requestId,
        reason: isResubmissionAudit
          ? 'Customer explicitly resubmitted rejected onboarding application'
          : 'Customer submitted onboarding application for review',
        ipHash,
        beforeState: toAuditSnapshot(existing),
        afterState: toAuditSnapshot(updated),
      });

      return updated;
    });

    return toCustomerView(submitted);
  }

  async listAdminApplications(
    actor: AuthenticatedContext,
    params: {
      status?: OnboardingStatus;
      search?: string;
      page: number;
      pageSize: number;
    },
  ) {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Administrator role required to list onboarding applications');
    }

    const result = await this.repository.listApplications(params);
    return {
      items: result.items.map(toAdminView),
      total: result.total,
    };
  }

  async getAdminApplicationById(
    actor: AuthenticatedContext,
    applicationId: string,
  ): Promise<AdminOnboardingView> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Administrator role required to view onboarding application');
    }

    const record = await this.repository.findById(applicationId);
    if (!record) {
      throw new NotFoundError('Onboarding application not found');
    }
    return toAdminView(record);
  }

  async approveApplication(
    actor: AuthenticatedContext,
    applicationId: string,
    reason: string | undefined,
    meta: RequestMetadata,
  ): Promise<AdminOnboardingView> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Administrator role required to approve applications');
    }

    const now = this.nowProvider();
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);
    const effectiveReason = reason ?? 'Approved after synthetic onboarding review';

    const approved = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findById(applicationId);
      if (!existing) {
        throw new NotFoundError('Onboarding application not found');
      }

      if (existing.status !== OnboardingStatus.PENDING) {
        throw new ConflictError(
          `Cannot approve onboarding application in ${existing.status} state`,
          'INVALID_STATE_TRANSITION',
        );
      }

      if (existing.submittedAt === null || !existing.acceptedSyntheticTerms) {
        throw new ConflictError(
          'Onboarding application must be completed and submitted before approval',
          'ONBOARDING_NOT_SUBMITTED',
        );
      }

      const updated = await tx.updateByIdIfStatus(
        existing.id,
        [OnboardingStatus.PENDING],
        {
          status: OnboardingStatus.APPROVED,
          reviewedAt: now,
          reviewedByUserId: actor.userId,
          reviewReason: effectiveReason,
        },
        { requireSubmitted: true },
      );

      if (!updated) {
        throw new ConflictError(
          'Application was already reviewed by another concurrent request',
          'INVALID_STATE_TRANSITION',
        );
      }

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: 'ONBOARDING_APPROVED',
        entityType: 'OnboardingApplication',
        entityId: updated.id,
        requestId: meta.requestId,
        reason: effectiveReason,
        ipHash,
        beforeState: toAuditSnapshot(existing),
        afterState: toAuditSnapshot(updated),
      });

      return updated;
    });

    return toAdminView(approved);
  }

  async rejectApplication(
    actor: AuthenticatedContext,
    applicationId: string,
    reason: string,
    meta: RequestMetadata,
  ): Promise<AdminOnboardingView> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Administrator role required to reject applications');
    }

    const now = this.nowProvider();
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    const rejected = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findById(applicationId);
      if (!existing) {
        throw new NotFoundError('Onboarding application not found');
      }

      if (
        existing.status !== OnboardingStatus.PENDING &&
        existing.status !== OnboardingStatus.NEEDS_INFORMATION
      ) {
        throw new ConflictError(
          `Cannot reject onboarding application in ${existing.status} state`,
          'INVALID_STATE_TRANSITION',
        );
      }

      const updated = await tx.updateByIdIfStatus(
        existing.id,
        [OnboardingStatus.PENDING, OnboardingStatus.NEEDS_INFORMATION],
        {
          status: OnboardingStatus.REJECTED,
          reviewedAt: now,
          reviewedByUserId: actor.userId,
          reviewReason: reason,
        },
      );

      if (!updated) {
        throw new ConflictError(
          'Application was already reviewed by another concurrent request',
          'INVALID_STATE_TRANSITION',
        );
      }

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: 'ONBOARDING_REJECTED',
        entityType: 'OnboardingApplication',
        entityId: updated.id,
        requestId: meta.requestId,
        reason,
        ipHash,
        beforeState: toAuditSnapshot(existing),
        afterState: toAuditSnapshot(updated),
      });

      return updated;
    });

    return toAdminView(rejected);
  }
}

function toCustomerView(record: OnboardingApplicationRecord): CustomerOnboardingView {
  return {
    id: record.id,
    status: record.status,
    contactReference: record.contactReference,
    city: record.city,
    country: record.country,
    accountPurpose: record.accountPurpose,
    acceptedSyntheticTerms: record.acceptedSyntheticTerms,
    submittedAt: record.submittedAt,
    reviewedAt: record.reviewedAt,
    reviewReason: record.reviewReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    applicant: {
      id: record.applicant.id,
      fullName: record.applicant.fullName,
      email: record.applicant.email,
    },
  };
}

function toAdminView(record: OnboardingApplicationRecord): AdminOnboardingView {
  return {
    id: record.id,
    userId: record.userId,
    status: record.status,
    contactReference: record.contactReference,
    city: record.city,
    country: record.country,
    accountPurpose: record.accountPurpose,
    acceptedSyntheticTerms: record.acceptedSyntheticTerms,
    submittedAt: record.submittedAt,
    reviewedAt: record.reviewedAt,
    reviewedByUserId: record.reviewedByUserId,
    reviewReason: record.reviewReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    applicant: record.applicant,
  };
}

function toAuditSnapshot(record: OnboardingApplicationRecord): Record<string, unknown> {
  return {
    status: record.status,
    city: record.city,
    country: record.country,
    acceptedSyntheticTerms: record.acceptedSyntheticTerms,
    submittedAt: record.submittedAt ? record.submittedAt.toISOString() : null,
    reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    reviewReason: record.reviewReason,
  };
}
