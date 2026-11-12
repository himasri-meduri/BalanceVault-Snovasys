import { OnboardingStatus } from '@prisma/client';
import { z } from 'zod';

const profileFieldsShape = {
  contactReference: z
    .string()
    .trim()
    .min(5, 'Contact reference must be at least 5 characters')
    .max(40, 'Contact reference must not exceed 40 characters')
    .regex(
      /^[+0-9A-Za-z -]+$/,
      'Contact reference may contain only letters, digits, spaces, + and -',
    ),
  city: z
    .string()
    .trim()
    .min(2, 'City must be at least 2 characters')
    .max(80, 'City must not exceed 80 characters'),
  country: z
    .string()
    .trim()
    .min(2, 'Country must be at least 2 characters')
    .max(60, 'Country must not exceed 60 characters'),
  accountPurpose: z
    .string()
    .trim()
    .min(10, 'Account purpose must be at least 10 characters')
    .max(300, 'Account purpose must not exceed 300 characters'),
  acceptedSyntheticTerms: z.boolean(),
};

export const updateOnboardingSchema = z
  .object({
    contactReference: profileFieldsShape.contactReference.optional(),
    city: profileFieldsShape.city.optional(),
    country: profileFieldsShape.country.optional(),
    accountPurpose: profileFieldsShape.accountPurpose.optional(),
    acceptedSyntheticTerms: profileFieldsShape.acceptedSyntheticTerms.optional(),
    reopenForResubmission: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.contactReference !== undefined ||
      data.city !== undefined ||
      data.country !== undefined ||
      data.accountPurpose !== undefined ||
      data.acceptedSyntheticTerms !== undefined ||
      data.reopenForResubmission !== undefined,
    { message: 'At least one onboarding field must be provided' },
  );

export const submitOnboardingSchema = z
  .object({
    contactReference: profileFieldsShape.contactReference.optional(),
    city: profileFieldsShape.city.optional(),
    country: profileFieldsShape.country.optional(),
    accountPurpose: profileFieldsShape.accountPurpose.optional(),
    acceptedSyntheticTerms: profileFieldsShape.acceptedSyntheticTerms.optional(),
    resubmit: z.boolean().optional(),
  })
  .strict()
  .default({});

export const completeOnboardingFieldsSchema = z.object({
  contactReference: profileFieldsShape.contactReference,
  city: profileFieldsShape.city,
  country: profileFieldsShape.country,
  accountPurpose: profileFieldsShape.accountPurpose,
  acceptedSyntheticTerms: z.literal(true, {
    errorMap: () => ({
      message: 'You must accept the synthetic demonstration terms before submitting',
    }),
  }),
});

export const listAdminOnboardingSchema = z.object({
  status: z.nativeEnum(OnboardingStatus).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const approveOnboardingSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, 'Approval reason must be at least 3 characters when provided')
      .max(500, 'Approval reason must not exceed 500 characters')
      .optional(),
  })
  .strict()
  .default({});

export const rejectOnboardingSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Rejection reason must be at least 10 characters')
      .max(500, 'Rejection reason must not exceed 500 characters'),
  })
  .strict();

export const applicationIdParamSchema = z.object({
  id: z.string().uuid('Invalid application ID format'),
});
