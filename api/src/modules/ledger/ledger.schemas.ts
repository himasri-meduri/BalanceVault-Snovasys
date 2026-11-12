import crypto from 'node:crypto';
import {
  AccountStatus,
  EntryDirection,
  JournalTransactionType,
} from '@prisma/client';
import { z } from 'zod';
import { MAX_SYNTHETIC_AMOUNT_MINOR, parseMinorUnits } from '../../shared/money.js';

export const accountIdParamSchema = z.object({
  id: z.string().uuid('Invalid account ID format'),
});

export const transactionIdParamSchema = z.object({
  id: z.string().uuid('Invalid transaction ID format'),
});

export const listAccountsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      AccountStatus.PENDING,
      AccountStatus.ACTIVE,
      AccountStatus.FROZEN,
      AccountStatus.CLOSED,
    ])
    .optional(),
  search: z.string().trim().min(1).max(80).optional(),
  ownerUserId: z.string().uuid('Invalid owner user ID filter').optional(),
  includeSystem: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const adminCreateAccountSchema = z
  .object({
    ownerUserId: z.string().uuid('Customer user ID must be a valid UUID'),
    accountName: z
      .string()
      .trim()
      .min(3, 'Account name must be at least 3 characters')
      .max(80, 'Account name must not exceed 80 characters'),
    initialStatus: z
      .enum([AccountStatus.ACTIVE, AccountStatus.PENDING])
      .default(AccountStatus.ACTIVE),
    initialCreditMinor: z
      .string()
      .trim()
      .regex(/^\d+$/, 'Initial credit must be a non-negative integer minor-unit string')
      .optional()
      .default('0'),
    reason: z
      .string()
      .trim()
      .min(5, 'Reason must be at least 5 characters')
      .max(500, 'Reason must not exceed 500 characters'),
  })
  .strict()
  .superRefine((data, ctx) => {
    let credit = 0n;
    try {
      credit = parseMinorUnits(data.initialCreditMinor, { requirePositive: false });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['initialCreditMinor'],
        message: `Initial credit must not exceed ${MAX_SYNTHETIC_AMOUNT_MINOR.toString()} minor units`,
      });
      return;
    }

    if (data.initialStatus === AccountStatus.PENDING && credit > 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['initialCreditMinor'],
        message: 'PENDING accounts cannot receive an opening balance until activated',
      });
    }
  });

export const freezeOrCloseAccountSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Reason must be at least 10 characters')
      .max(500, 'Reason must not exceed 500 characters'),
  })
  .strict();

export const unfreezeOrActivateAccountSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(5, 'Reason must be at least 5 characters')
      .max(500, 'Reason must not exceed 500 characters'),
  })
  .strict();

export const listLedgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  direction: z.enum([EntryDirection.DEBIT, EntryDirection.CREDIT]).optional(),
  type: z
    .enum([
      JournalTransactionType.DEMO_TRANSFER,
      JournalTransactionType.REVERSAL,
      JournalTransactionType.ADJUSTMENT,
    ])
    .optional(),
});

export const idempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .trim()
  .min(16, 'Idempotency-Key must be at least 16 characters')
  .max(128, 'Idempotency-Key must not exceed 128 characters')
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    'Idempotency-Key may only contain letters, digits, dots, underscores, colons, and hyphens',
  );

export const createTransferSchema = z
  .object({
    sourceAccountId: z.string().uuid('Source account ID must be a valid UUID'),
    destinationAccountReference: z
      .string()
      .trim()
      .min(6, 'Destination account reference is required')
      .max(40, 'Destination account reference is too long')
      .transform((val) => val.toUpperCase()),
    amountMinor: z
      .string()
      .trim()
      .regex(/^\d+$/, 'Amount must be a positive integer string in minor units')
      .refine((val) => {
        try {
          parseMinorUnits(val, { requirePositive: true });
          return true;
        } catch {
          return false;
        }
      }, `Amount must be between 1 and ${MAX_SYNTHETIC_AMOUNT_MINOR.toString()} minor units`),
    description: z
      .string()
      .trim()
      .min(3, 'Description must be at least 3 characters')
      .max(140, 'Description must not exceed 140 characters'),
  })
  .strict();

export const reverseTransactionSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Reversal reason must be at least 10 characters')
      .max(500, 'Reversal reason must not exceed 500 characters'),
  })
  .strict();

export function computeTransferRequestHash(params: {
  actorUserId: string;
  sourceAccountId: string;
  destinationAccountReference: string;
  amountMinor: string;
  description: string;
}): string {
  const normalizedAmount = BigInt(params.amountMinor).toString(10);
  const canonical = JSON.stringify({
    actorUserId: params.actorUserId,
    sourceAccountId: params.sourceAccountId.toLowerCase(),
    destinationAccountReference: params.destinationAccountReference.trim().toUpperCase(),
    amountMinor: normalizedAmount,
    description: params.description.trim(),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
