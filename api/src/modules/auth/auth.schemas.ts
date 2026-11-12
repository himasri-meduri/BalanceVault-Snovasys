import { z } from 'zod';
import { UserRole, UserStatus } from '@prisma/client';

export const passwordPolicySchema = z
  .string()
  .min(10, 'Password must be at least 10 characters long')
  .max(128, 'Password must not exceed 128 characters')
  .refine((val) => /[A-Z]/.test(val), 'Password must contain an uppercase letter')
  .refine((val) => /[a-z]/.test(val), 'Password must contain a lowercase letter')
  .refine((val) => /[0-9]/.test(val), 'Password must contain a digit')
  .refine(
    (val) => /[^A-Za-z0-9]/.test(val),
    'Password must contain a special character',
  );

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const registerSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .max(120, 'Full name must not exceed 120 characters'),
    email: z
      .string()
      .trim()
      .email('Please provide a valid email address')
      .max(254, 'Email must not exceed 254 characters')
      .transform(normalizeEmail),
    password: passwordPolicySchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email('Please provide a valid email address')
      .max(254)
      .transform(normalizeEmail),
    password: z.string().min(1, 'Password is required').max(128),
  })
  .strict();

export const changeUserRoleSchema = z
  .object({
    role: z.enum([UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    reason: z
      .string()
      .trim()
      .min(5, 'Reason must be at least 5 characters')
      .max(500, 'Reason must not exceed 500 characters'),
  })
  .strict();

export const changeUserStatusSchema = z
  .object({
    status: z.enum([UserStatus.ACTIVE, UserStatus.DISABLED, UserStatus.LOCKED]),
    reason: z
      .string()
      .trim()
      .min(5, 'Reason must be at least 5 characters')
      .max(500, 'Reason must not exceed 500 characters'),
  })
  .strict();

function parseBoundaryDate(raw: string, bound: 'start' | 'end'): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const suffix = bound === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
    return new Date(`${raw}${suffix}`);
  }
  return new Date(raw);
}

const optionalDateQuerySchema = (bound: 'start' | 'end') =>
  z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((val) => !Number.isNaN(parseBoundaryDate(val, bound).getTime()), {
      message: 'Must be a valid ISO date or timestamp',
    })
    .transform((val) => parseBoundaryDate(val, bound))
    .optional();

export const listAdminUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
  role: z.enum([UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN]).optional(),
  status: z.enum([UserStatus.ACTIVE, UserStatus.DISABLED, UserStatus.LOCKED]).optional(),
});

export const listAdminPaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    action: z.string().trim().min(1).max(100).optional(),
    entityType: z.string().trim().min(1).max(100).optional(),
    actorUserId: z.string().uuid().optional(),
    from: optionalDateQuerySchema('start'),
    to: optionalDateQuerySchema('end'),
  })
  .refine((val) => !val.from || !val.to || val.from.getTime() <= val.to.getTime(), {
    message: '"from" timestamp must not be after "to" timestamp',
    path: ['from'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangeUserRoleInput = z.infer<typeof changeUserRoleSchema>;
export type ChangeUserStatusInput = z.infer<typeof changeUserStatusSchema>;
