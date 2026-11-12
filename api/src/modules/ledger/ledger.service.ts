import {
  AccountKind,
  AccountStatus,
  ActorType,
  EntryDirection,
  JournalTransactionStatus,
  JournalTransactionType,
  OnboardingStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../shared/errors.js';
import { parseMinorUnits, serializeMinorUnits } from '../../shared/money.js';
import {
  generateAccountReference,
  generateTransactionReference,
} from '../../shared/reference.js';
import { hashIpAddress } from '../auth/auth.crypto.js';
import type { RequestMetadata } from '../auth/auth.service.js';
import type { AuthenticatedContext } from '../auth/auth.types.js';
import {
  AccountReferenceCollisionError,
  IdempotencyKeyRaceError,
  ReversalAlreadyExistsError,
  TransactionReferenceCollisionError,
  type LedgerRepository,
  type LedgerTxContext,
} from './ledger.repository.js';
import { computeTransferRequestHash } from './ledger.schemas.js';
import type {
  AccountDto,
  AccountLedgerItemDto,
  AccountLedgerItemRecord,
  AccountRecord,
  AdminSummaryCounts,
  JournalTransactionRecord,
  TransactionDetailDto,
} from './ledger.types.js';

const IDEMPOTENCY_SCOPE_TRANSFER = 'POST:/api/transfers';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REFERENCE_RETRIES = 5;

function isAdminRole(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
}

export function serializeAccountDto(
  account: AccountRecord,
  includeOwner: boolean,
): AccountDto {
  return {
    id: account.id,
    publicReference: account.publicReference,
    kind: account.kind,
    ownerUserId: account.ownerUserId,
    ...(includeOwner && account.owner ? { owner: account.owner } : {}),
    accountName: account.accountName,
    currency: account.currency,
    status: account.status,
    balanceMinor: serializeMinorUnits(account.balanceMinor),
    version: account.version,
    statusReason: account.statusReason,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

export function serializeLedgerEntryDto(
  item: AccountLedgerItemRecord,
): AccountLedgerItemDto {
  return {
    id: item.id,
    transactionId: item.transactionId,
    transactionPublicReference: item.transactionPublicReference,
    transactionType: item.transactionType,
    transactionStatus: item.transactionStatus,
    direction: item.direction,
    amountMinor: serializeMinorUnits(item.amountMinor),
    currency: item.currency,
    description: item.description,
    counterpartyReference: item.counterpartyReference,
    reversalOfTransactionId: item.reversalOfTransactionId,
    reversedByTransactionId: item.reversedByTransactionId,
    createdAt: item.createdAt.toISOString(),
  };
}

export function serializeTransactionDetailDto(
  txn: JournalTransactionRecord,
  viewer: AuthenticatedContext,
): TransactionDetailDto {
  const viewerIsAdmin = isAdminRole(viewer.role);

  return {
    id: txn.id,
    publicReference: txn.publicReference,
    type: txn.type,
    status: txn.effectiveStatus,
    currency: txn.currency,
    description: txn.description,
    initiatedByUserId: viewerIsAdmin
      ? txn.initiatedByUserId
      : txn.initiatedByUserId === viewer.userId
        ? viewer.userId
        : null,
    reversalOfTransactionId: txn.reversalOfTransactionId,
    reversalOfPublicReference: txn.reversalOfPublicReference,
    reversedByTransactionId: txn.reversedByTransactionId,
    reversedByPublicReference: txn.reversedByPublicReference,
    createdAt: txn.createdAt.toISOString(),
    entries: txn.entries.map((entry) => {
      const canSeePrivateAccountDetails =
        viewerIsAdmin || entry.accountOwnerUserId === viewer.userId;

      return {
        id: entry.id,
        accountId: canSeePrivateAccountDetails ? entry.accountId : null,
        accountPublicReference: entry.accountPublicReference,
        accountKind: entry.accountKind,
        accountName: canSeePrivateAccountDetails ? entry.accountName : null,
        direction: entry.direction,
        amountMinor: serializeMinorUnits(entry.amountMinor),
        currency: entry.currency,
      };
    }),
  };
}

export class LedgerService {
  constructor(
    private readonly repository: LedgerRepository,
    private readonly env: AppEnv,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  async listAccounts(
    actor: AuthenticatedContext,
    query: {
      page: number;
      pageSize: number;
      status?: AccountStatus;
      search?: string;
      ownerUserId?: string;
      includeSystem?: boolean;
    },
  ): Promise<{ items: AccountDto[]; total: number }> {
    const admin = isAdminRole(actor.role);

    if (!admin && query.ownerUserId && query.ownerUserId !== actor.userId) {
      throw new ForbiddenError('Cannot list another customer account');
    }

    const result = await this.repository.listAccounts({
      ownerUserId: admin ? query.ownerUserId : actor.userId,
      status: query.status,
      search: admin ? query.search : undefined,
      includeSystem: admin ? Boolean(query.includeSystem) : false,
      includeOwnerDetails: admin,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: result.items.map((acc) => serializeAccountDto(acc, admin)),
      total: result.total,
    };
  }

  async getAccountById(
    actor: AuthenticatedContext,
    accountId: string,
  ): Promise<AccountDto> {
    const admin = isAdminRole(actor.role);
    const account = await this.repository.findAccountById(accountId, {
      includeOwnerDetails: admin,
    });

    if (!account) {
      throw new NotFoundError('Account not found');
    }

    if (!admin) {
      if (account.kind !== AccountKind.CUSTOMER || account.ownerUserId !== actor.userId) {
        throw new NotFoundError('Account not found');
      }
    }

    return serializeAccountDto(account, admin);
  }

  async getAccountLedger(
    actor: AuthenticatedContext,
    accountId: string,
    query: {
      page: number;
      pageSize: number;
      direction?: EntryDirection;
      type?: JournalTransactionType;
    },
  ): Promise<{
    account: AccountDto;
    items: AccountLedgerItemDto[];
    total: number;
  }> {
    const admin = isAdminRole(actor.role);
    const account = await this.repository.findAccountById(accountId, {
      includeOwnerDetails: admin,
    });

    if (!account) {
      throw new NotFoundError('Account not found');
    }

    if (!admin) {
      if (account.kind !== AccountKind.CUSTOMER || account.ownerUserId !== actor.userId) {
        throw new NotFoundError('Account not found');
      }
    }

    const entries = await this.repository.listAccountLedgerEntries({
      accountId: account.id,
      direction: query.direction,
      type: query.type,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      account: serializeAccountDto(account, admin),
      items: entries.items.map(serializeLedgerEntryDto),
      total: entries.total,
    };
  }

  async getTransactionById(
    actor: AuthenticatedContext,
    transactionId: string,
  ): Promise<TransactionDetailDto> {
    const txn = await this.repository.findTransactionById(transactionId);
    if (!txn) {
      throw new NotFoundError('Transaction not found');
    }

    if (!isAdminRole(actor.role)) {
      const isParticipant = txn.entries.some(
        (entry) => entry.accountOwnerUserId === actor.userId,
      );
      if (!isParticipant) {
        throw new NotFoundError('Transaction not found');
      }
    }

    return serializeTransactionDetailDto(txn, actor);
  }

  async createCustomerAccount(
    actor: AuthenticatedContext,
    input: {
      ownerUserId: string;
      accountName: string;
      initialStatus: AccountStatus;
      initialCreditMinor: string;
      reason: string;
    },
    meta: RequestMetadata,
  ): Promise<{
    account: AccountDto;
    openingTransaction: TransactionDetailDto | null;
  }> {
    if (!isAdminRole(actor.role)) {
      throw new ForbiddenError('Administrator role required to create customer accounts');
    }

    const creditMinor = parseMinorUnits(input.initialCreditMinor, {
      requirePositive: false,
    });

    if (input.initialStatus === AccountStatus.PENDING && creditMinor > 0n) {
      throw new UnprocessableError(
        'PENDING accounts cannot receive an opening balance until activated',
        'INVALID_INITIAL_ALLOCATION',
      );
    }

    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    return this.repository.runInTransaction(async (tx) => {
      const targetUser = await tx.findUserById(input.ownerUserId);
      if (!targetUser) {
        throw new NotFoundError('Target customer user not found');
      }

      if (targetUser.role !== UserRole.CUSTOMER) {
        throw new UnprocessableError(
          'Synthetic accounts can only be created for CUSTOMER users',
          'CUSTOMER_NOT_ELIGIBLE',
        );
      }

      if (
        targetUser.status !== UserStatus.ACTIVE ||
        targetUser.onboardingStatus !== OnboardingStatus.APPROVED
      ) {
        throw new ConflictError(
          'Customer must be ACTIVE with APPROVED onboarding before opening an account',
          'CUSTOMER_NOT_ELIGIBLE',
        );
      }

      const account = await this.createAccountWithUniqueReference(tx, {
        kind: AccountKind.CUSTOMER,
        ownerUserId: targetUser.id,
        accountName: input.accountName,
        status: input.initialStatus,
        balanceMinor: creditMinor,
        statusReason: input.reason,
      });

      let openingTxn: JournalTransactionRecord | null = null;
      if (creditMinor > 0n) {
        const treasuryRef = await tx.findOrCreateSystemTreasuryAccount();
        const locked = await tx.lockAccountsByIds([treasuryRef.id]);
        const lockedTreasury = locked.find((acc) => acc.id === treasuryRef.id);
        if (!lockedTreasury) {
          throw new ConflictError('Issuance treasury account lock failed');
        }

        await tx.updateAccountBalance(
          lockedTreasury.id,
          lockedTreasury.balanceMinor - creditMinor,
        );

        openingTxn = await this.createTransactionWithUniqueReference(tx, {
          type: JournalTransactionType.ADJUSTMENT,
          description: `Synthetic opening allocation for ${account.publicReference}`,
          initiatedByUserId: actor.userId,
          metadata: {
            openingAllocation: true,
            reason: input.reason,
          },
          entries: [
            {
              accountId: lockedTreasury.id,
              direction: EntryDirection.DEBIT,
              amountMinor: creditMinor,
            },
            {
              accountId: account.id,
              direction: EntryDirection.CREDIT,
              amountMinor: creditMinor,
            },
          ],
        });
      }

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: 'ACCOUNT_CREATED',
        entityType: 'Account',
        entityId: account.id,
        requestId: meta.requestId,
        reason: input.reason,
        ipHash,
        afterState: {
          publicReference: account.publicReference,
          ownerUserId: account.ownerUserId,
          status: account.status,
          balanceMinor: serializeMinorUnits(account.balanceMinor),
          openingTransactionReference: openingTxn?.publicReference ?? null,
        },
      });

      return {
        account: serializeAccountDto(account, true),
        openingTransaction: openingTxn
          ? serializeTransactionDetailDto(openingTxn, actor)
          : null,
      };
    });
  }

  async activateAccount(
    actor: AuthenticatedContext,
    accountId: string,
    reason: string,
    meta: RequestMetadata,
  ): Promise<AccountDto> {
    return this.transitionAccountStatus({
      actor,
      accountId,
      expectedStatuses: [AccountStatus.PENDING],
      newStatus: AccountStatus.ACTIVE,
      reason,
      auditAction: 'ACCOUNT_ACTIVATED',
      invalidTransitionMessage: 'Only PENDING accounts can be activated',
      meta,
    });
  }

  async freezeAccount(
    actor: AuthenticatedContext,
    accountId: string,
    reason: string,
    meta: RequestMetadata,
  ): Promise<AccountDto> {
    return this.transitionAccountStatus({
      actor,
      accountId,
      expectedStatuses: [AccountStatus.ACTIVE],
      newStatus: AccountStatus.FROZEN,
      reason,
      auditAction: 'ACCOUNT_FROZEN',
      invalidTransitionMessage: 'Only ACTIVE accounts can be frozen',
      meta,
    });
  }

  async unfreezeAccount(
    actor: AuthenticatedContext,
    accountId: string,
    reason: string,
    meta: RequestMetadata,
  ): Promise<AccountDto> {
    return this.transitionAccountStatus({
      actor,
      accountId,
      expectedStatuses: [AccountStatus.FROZEN],
      newStatus: AccountStatus.ACTIVE,
      reason,
      auditAction: 'ACCOUNT_UNFROZEN',
      invalidTransitionMessage: 'Only FROZEN accounts can be unfrozen',
      meta,
    });
  }

  async closeAccount(
    actor: AuthenticatedContext,
    accountId: string,
    reason: string,
    meta: RequestMetadata,
  ): Promise<AccountDto> {
    if (!isAdminRole(actor.role)) {
      throw new ForbiddenError('Administrator role required to close accounts');
    }

    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    const updated = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findAccountById(accountId);
      if (!existing) {
        throw new NotFoundError('Account not found');
      }

      if (existing.kind !== AccountKind.CUSTOMER) {
        throw new ConflictError(
          'System issuance reserve account cannot be closed',
          'SYSTEM_ACCOUNT_PROTECTED',
        );
      }

      const locked = await tx.lockAccountsByIds([existing.id]);
      const lockedAccount = locked[0];
      if (!lockedAccount) {
        throw new NotFoundError('Account not found');
      }

      if (
        lockedAccount.status !== AccountStatus.ACTIVE &&
        lockedAccount.status !== AccountStatus.FROZEN
      ) {
        throw new ConflictError(
          `Cannot close account from status ${lockedAccount.status}`,
          'INVALID_STATE_TRANSITION',
        );
      }

      if (lockedAccount.balanceMinor !== 0n) {
        throw new ConflictError(
          'Account balance must be zero before closing',
          'ACCOUNT_BALANCE_NON_ZERO',
        );
      }

      const saved = await tx.updateAccountStatusIfMatches({
        accountId: lockedAccount.id,
        expectedStatuses: [AccountStatus.ACTIVE, AccountStatus.FROZEN],
        newStatus: AccountStatus.CLOSED,
        statusReason: reason,
        requireZeroBalance: true,
      });

      if (!saved) {
        throw new ConflictError(
          'Account state or balance changed concurrently; retry close request',
          'INVALID_STATE_TRANSITION',
        );
      }

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: 'ACCOUNT_CLOSED',
        entityType: 'Account',
        entityId: saved.id,
        requestId: meta.requestId,
        reason,
        ipHash,
        beforeState: {
          status: lockedAccount.status,
          balanceMinor: serializeMinorUnits(lockedAccount.balanceMinor),
        },
        afterState: {
          status: saved.status,
          balanceMinor: serializeMinorUnits(saved.balanceMinor),
        },
      });

      return saved;
    });

    return serializeAccountDto(updated, true);
  }

  async executeTransfer(
    actor: AuthenticatedContext,
    idempotencyKey: string,
    input: {
      sourceAccountId: string;
      destinationAccountReference: string;
      amountMinor: string;
      description: string;
    },
    meta: RequestMetadata,
  ): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
    replayed: boolean;
  }> {
    if (actor.role !== UserRole.CUSTOMER) {
      throw new ForbiddenError('Only CUSTOMER users may initiate demo transfers');
    }

    const amountMinor = parseMinorUnits(input.amountMinor, { requirePositive: true });
    const requestHash = computeTransferRequestHash({
      actorUserId: actor.userId,
      sourceAccountId: input.sourceAccountId,
      destinationAccountReference: input.destinationAccountReference,
      amountMinor: serializeMinorUnits(amountMinor),
      description: input.description,
    });
    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);
    const now = this.nowProvider();

    try {
      return await this.repository.runInTransaction(async (tx) => {
        const existingIdempotency = await tx.findIdempotencyRecord(
          actor.userId,
          IDEMPOTENCY_SCOPE_TRANSFER,
          idempotencyKey,
        );

        if (existingIdempotency) {
          if (existingIdempotency.expiresAt.getTime() > now.getTime()) {
            if (existingIdempotency.requestHash !== requestHash) {
              throw new ConflictError(
                'Idempotency-Key was already used with a different transfer payload',
                'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
              );
            }
            return {
              statusCode: existingIdempotency.responseStatus,
              body: existingIdempotency.responseBody,
              replayed: true,
            };
          }
          await tx.deleteIdempotencyRecord(existingIdempotency.id);
        }

        const initiator = await tx.findUserById(actor.userId);
        if (
          !initiator ||
          initiator.status !== UserStatus.ACTIVE ||
          initiator.onboardingStatus !== OnboardingStatus.APPROVED
        ) {
          throw new ForbiddenError(
            'Active customer account with APPROVED onboarding is required to transfer',
            'CUSTOMER_NOT_ELIGIBLE',
          );
        }

        const sourceRef = await tx.findAccountById(input.sourceAccountId);
        if (
          !sourceRef ||
          sourceRef.kind !== AccountKind.CUSTOMER ||
          sourceRef.ownerUserId !== actor.userId
        ) {
          throw new NotFoundError('Source account not found');
        }

        const destRef = await tx.findAccountByPublicReference(
          input.destinationAccountReference.trim().toUpperCase(),
        );
        if (!destRef || destRef.kind !== AccountKind.CUSTOMER) {
          throw new NotFoundError('Destination account not found');
        }

        if (sourceRef.id === destRef.id) {
          throw new UnprocessableError(
            'Source and destination accounts must be different',
            'SAME_ACCOUNT_TRANSFER',
          );
        }

        if (sourceRef.currency !== 'INR' || destRef.currency !== 'INR') {
          throw new UnprocessableError(
            'Synthetic transfers support INR currency only',
            'CURRENCY_MISMATCH',
          );
        }

        const locked = await tx.lockAccountsByIds([sourceRef.id, destRef.id]);

        // Re-check idempotency after acquiring FOR UPDATE row locks so a concurrent
        // identical retry waking up after commit replays cleanly even if balance reached zero.
        const postLockIdempotency = await tx.findIdempotencyRecord(
          actor.userId,
          IDEMPOTENCY_SCOPE_TRANSFER,
          idempotencyKey,
        );
        if (postLockIdempotency && postLockIdempotency.expiresAt.getTime() > now.getTime()) {
          if (postLockIdempotency.requestHash !== requestHash) {
            throw new ConflictError(
              'Idempotency-Key was already used with a different transfer payload',
              'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            );
          }
          return {
            statusCode: postLockIdempotency.responseStatus,
            body: postLockIdempotency.responseBody,
            replayed: true,
          };
        }

        const lockedSource = locked.find((acc) => acc.id === sourceRef.id);
        const lockedDest = locked.find((acc) => acc.id === destRef.id);

        if (!lockedSource || !lockedDest) {
          throw new ConflictError('Failed to lock transfer accounts');
        }

        if (lockedSource.status !== AccountStatus.ACTIVE) {
          throw new ConflictError(
            `Source account is ${lockedSource.status} and cannot send transfers`,
            'ACCOUNT_NOT_ACTIVE',
          );
        }

        if (lockedDest.status !== AccountStatus.ACTIVE) {
          throw new ConflictError(
            `Destination account is ${lockedDest.status} and cannot receive transfers`,
            'ACCOUNT_NOT_ACTIVE',
          );
        }

        if (lockedDest.ownerUserId) {
          const destOwner = await tx.findUserById(lockedDest.ownerUserId);
          if (!destOwner || destOwner.status !== UserStatus.ACTIVE) {
            throw new ConflictError(
              'Destination account owner is not active',
              'DESTINATION_OWNER_INACTIVE',
            );
          }
        }

        if (lockedSource.balanceMinor < amountMinor) {
          throw new UnprocessableError(
            'Insufficient synthetic balance for this transfer',
            'INSUFFICIENT_FUNDS',
          );
        }

        const updatedSource = await tx.updateAccountBalance(
          lockedSource.id,
          lockedSource.balanceMinor - amountMinor,
        );
        const updatedDest = await tx.updateAccountBalance(
          lockedDest.id,
          lockedDest.balanceMinor + amountMinor,
        );

        const txn = await this.createTransactionWithUniqueReference(tx, {
          type: JournalTransactionType.DEMO_TRANSFER,
          description: input.description.trim(),
          idempotencyKey,
          initiatedByUserId: actor.userId,
          metadata: {
            sourcePublicReference: updatedSource.publicReference,
            destinationPublicReference: updatedDest.publicReference,
          },
          entries: [
            {
              accountId: updatedSource.id,
              direction: EntryDirection.DEBIT,
              amountMinor,
            },
            {
              accountId: updatedDest.id,
              direction: EntryDirection.CREDIT,
              amountMinor,
            },
          ],
        });

        await tx.createAuditEvent({
          actorUserId: actor.userId,
          actorType: ActorType.USER,
          action: 'TRANSFER_POSTED',
          entityType: 'JournalTransaction',
          entityId: txn.id,
          requestId: meta.requestId,
          reason: input.description.trim(),
          ipHash,
          beforeState: {
            sourceAccountId: lockedSource.id,
            sourceBalanceMinor: serializeMinorUnits(lockedSource.balanceMinor),
          },
          afterState: {
            publicReference: txn.publicReference,
            sourceAccountId: updatedSource.id,
            sourceBalanceMinor: serializeMinorUnits(updatedSource.balanceMinor),
            destinationReference: updatedDest.publicReference,
            amountMinor: serializeMinorUnits(amountMinor),
          },
        });

        const responseBody: Record<string, unknown> = {
          transaction: serializeTransactionDetailDto(txn, actor),
          sourceAccount: serializeAccountDto(updatedSource, false),
          idempotentReplay: false,
        };

        await tx.createIdempotencyRecord({
          actorUserId: actor.userId,
          scope: IDEMPOTENCY_SCOPE_TRANSFER,
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody,
          transactionId: txn.id,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        });

        return {
          statusCode: 201,
          body: responseBody,
          replayed: false,
        };
      });
    } catch (err) {
      if (err instanceof IdempotencyKeyRaceError) {
        const existing = await this.repository.findIdempotencyRecord(
          actor.userId,
          IDEMPOTENCY_SCOPE_TRANSFER,
          idempotencyKey,
        );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            await this.recordRejectedTransferAudit({
              actorUserId: actor.userId,
              requestId: meta.requestId,
              ipHash,
              code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
              destinationAccountReference: input.destinationAccountReference,
              amountMinor,
            });
            throw new ConflictError(
              'Idempotency-Key was already used with a different transfer payload',
              'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            );
          }
          return {
            statusCode: existing.responseStatus,
            body: existing.responseBody,
            replayed: true,
          };
        }
      }

      if (
        err instanceof ConflictError ||
        err instanceof UnprocessableError ||
        err instanceof ForbiddenError
      ) {
        await this.recordRejectedTransferAudit({
          actorUserId: actor.userId,
          requestId: meta.requestId,
          ipHash,
          code: err.code,
          destinationAccountReference: input.destinationAccountReference,
          amountMinor,
        });
      }

      throw err;
    }
  }

  async reverseTransaction(
    actor: AuthenticatedContext,
    transactionId: string,
    reason: string,
    meta: RequestMetadata,
  ): Promise<{
    reversalTransaction: TransactionDetailDto;
    reversedTransactionId: string;
    reversedTransactionStatus: JournalTransactionStatus;
  }> {
    if (!isAdminRole(actor.role)) {
      throw new ForbiddenError('Administrator role required to reverse transactions');
    }

    const ipHash = hashIpAddress(meta.ip, this.env.SESSION_SECRET);

    return this.repository.runInTransaction(async (tx) => {
      const original = await tx.findTransactionById(transactionId);
      if (!original) {
        throw new NotFoundError('Transaction not found');
      }

      if (original.type === JournalTransactionType.REVERSAL) {
        throw new ConflictError(
          'Reversal transactions cannot themselves be reversed',
          'CANNOT_REVERSE_REVERSAL',
        );
      }

      if (original.reversedByTransactionId !== null) {
        throw new ConflictError(
          'Transaction has already been reversed',
          'TRANSACTION_ALREADY_REVERSED',
        );
      }

      const accountIds = original.entries.map((e) => e.accountId);
      const lockedAccounts = await tx.lockAccountsByIds(accountIds);
      const accountById = new Map(lockedAccounts.map((acc) => [acc.id, acc]));

      const netDeltaByAccount = new Map<string, bigint>();
      for (const entry of original.entries) {
        const account = accountById.get(entry.accountId);
        if (!account) {
          throw new ConflictError('Transaction participant account could not be locked');
        }
        if (account.status === AccountStatus.CLOSED) {
          throw new ConflictError(
            `Account ${account.publicReference} is CLOSED and cannot participate in reversal`,
            'ACCOUNT_CLOSED_CANNOT_REVERSE',
          );
        }

        // Original CREDIT must be DEBITed (-amount); original DEBIT must be CREDITed (+amount)
        const compensatingDelta =
          entry.direction === EntryDirection.CREDIT
            ? -entry.amountMinor
            : entry.amountMinor;
        netDeltaByAccount.set(
          entry.accountId,
          (netDeltaByAccount.get(entry.accountId) ?? 0n) + compensatingDelta,
        );
      }

      for (const [accountId, netDelta] of netDeltaByAccount.entries()) {
        const account = accountById.get(accountId)!;
        const projected = account.balanceMinor + netDelta;
        if (account.kind === AccountKind.CUSTOMER && projected < 0n) {
          throw new UnprocessableError(
            `Account ${account.publicReference} has insufficient funds to reverse this transaction`,
            'INSUFFICIENT_FUNDS_FOR_REVERSAL',
          );
        }
      }

      for (const [accountId, netDelta] of netDeltaByAccount.entries()) {
        const account = accountById.get(accountId)!;
        await tx.updateAccountBalance(accountId, account.balanceMinor + netDelta);
      }

      let reversalTxn: JournalTransactionRecord;
      try {
        reversalTxn = await this.createTransactionWithUniqueReference(tx, {
          type: JournalTransactionType.REVERSAL,
          description: `Reversal of ${original.publicReference}: ${reason}`,
          initiatedByUserId: actor.userId,
          reversalOfTransactionId: original.id,
          metadata: {
            reversalReason: reason,
            originalTransactionId: original.id,
            originalPublicReference: original.publicReference,
          },
          entries: original.entries.map((entry) => ({
            accountId: entry.accountId,
            direction:
              entry.direction === EntryDirection.CREDIT
                ? EntryDirection.DEBIT
                : EntryDirection.CREDIT,
            amountMinor: entry.amountMinor,
          })),
        });
      } catch (err) {
        if (err instanceof ReversalAlreadyExistsError) {
          throw new ConflictError(
            'Transaction has already been reversed',
            'TRANSACTION_ALREADY_REVERSED',
          );
        }
        throw err;
      }

      await tx.createAuditEvent({
        actorUserId: actor.userId,
        actorType: ActorType.USER,
        action: 'TRANSACTION_REVERSED',
        entityType: 'JournalTransaction',
        entityId: original.id,
        requestId: meta.requestId,
        reason,
        ipHash,
        beforeState: {
          originalPublicReference: original.publicReference,
          status: JournalTransactionStatus.POSTED,
        },
        afterState: {
          status: JournalTransactionStatus.REVERSED,
          reversalTransactionId: reversalTxn.id,
          reversalPublicReference: reversalTxn.publicReference,
        },
      });

      return {
        reversalTransaction: serializeTransactionDetailDto(reversalTxn, actor),
        reversedTransactionId: original.id,
        reversedTransactionStatus: JournalTransactionStatus.REVERSED,
      };
    });
  }

  async getAdminSummary(actor: AuthenticatedContext): Promise<AdminSummaryCounts> {
    if (!isAdminRole(actor.role)) {
      throw new ForbiddenError('Administrator role required');
    }
    return this.repository.getAdminSummaryCounts();
  }

  private async transitionAccountStatus(params: {
    actor: AuthenticatedContext;
    accountId: string;
    expectedStatuses: AccountStatus[];
    newStatus: AccountStatus;
    reason: string;
    auditAction: string;
    invalidTransitionMessage: string;
    meta: RequestMetadata;
  }): Promise<AccountDto> {
    if (!isAdminRole(params.actor.role)) {
      throw new ForbiddenError('Administrator role required');
    }

    const ipHash = hashIpAddress(params.meta.ip, this.env.SESSION_SECRET);

    const updated = await this.repository.runInTransaction(async (tx) => {
      const existing = await tx.findAccountById(params.accountId);
      if (!existing) {
        throw new NotFoundError('Account not found');
      }

      if (existing.kind !== AccountKind.CUSTOMER) {
        throw new ConflictError(
          'System issuance reserve account status cannot be modified',
          'SYSTEM_ACCOUNT_PROTECTED',
        );
      }

      if (!params.expectedStatuses.includes(existing.status)) {
        throw new ConflictError(
          `${params.invalidTransitionMessage} (current status: ${existing.status})`,
          'INVALID_STATE_TRANSITION',
        );
      }

      const saved = await tx.updateAccountStatusIfMatches({
        accountId: existing.id,
        expectedStatuses: params.expectedStatuses,
        newStatus: params.newStatus,
        statusReason: params.reason,
      });

      if (!saved) {
        throw new ConflictError(
          'Account status was modified concurrently; refresh and retry',
          'INVALID_STATE_TRANSITION',
        );
      }

      await tx.createAuditEvent({
        actorUserId: params.actor.userId,
        actorType: ActorType.USER,
        action: params.auditAction,
        entityType: 'Account',
        entityId: saved.id,
        requestId: params.meta.requestId,
        reason: params.reason,
        ipHash,
        beforeState: {
          status: existing.status,
          statusReason: existing.statusReason,
        },
        afterState: {
          status: saved.status,
          statusReason: saved.statusReason,
        },
      });

      return saved;
    });

    return serializeAccountDto(updated, true);
  }

  private async createAccountWithUniqueReference(
    tx: LedgerTxContext,
    params: {
      kind: AccountKind;
      ownerUserId: string | null;
      accountName: string;
      status: AccountStatus;
      balanceMinor: bigint;
      statusReason: string | null;
    },
  ): Promise<AccountRecord> {
    for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES; attempt += 1) {
      try {
        return await tx.createAccount({
          publicReference: generateAccountReference(),
          kind: params.kind,
          ownerUserId: params.ownerUserId,
          accountName: params.accountName,
          status: params.status,
          balanceMinor: params.balanceMinor,
          statusReason: params.statusReason,
        });
      } catch (err) {
        if (err instanceof AccountReferenceCollisionError && attempt < MAX_REFERENCE_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new ConflictError('Unable to allocate unique account reference');
  }

  private async createTransactionWithUniqueReference(
    tx: LedgerTxContext,
    params: {
      type: JournalTransactionType;
      description: string;
      idempotencyKey?: string | null;
      initiatedByUserId: string | null;
      reversalOfTransactionId?: string | null;
      metadata?: Record<string, unknown> | null;
      entries: Array<{
        accountId: string;
        direction: EntryDirection;
        amountMinor: bigint;
      }>;
    },
  ): Promise<JournalTransactionRecord> {
    let totalCredit = 0n;
    let totalDebit = 0n;
    for (const entry of params.entries) {
      if (entry.amountMinor <= 0n) {
        throw new UnprocessableError('Journal entry amounts must be positive');
      }
      if (entry.direction === EntryDirection.CREDIT) {
        totalCredit += entry.amountMinor;
      } else {
        totalDebit += entry.amountMinor;
      }
    }
    if (params.entries.length < 2 || totalCredit !== totalDebit) {
      throw new UnprocessableError(
        'Double-entry ledger invariant violation: transaction is not balanced',
      );
    }

    for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES; attempt += 1) {
      try {
        return await tx.createPostedJournalTransaction({
          publicReference: generateTransactionReference(),
          ...params,
        });
      } catch (err) {
        if (
          err instanceof TransactionReferenceCollisionError &&
          attempt < MAX_REFERENCE_RETRIES - 1
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new ConflictError('Unable to allocate unique transaction reference');
  }

  private async recordRejectedTransferAudit(params: {
    actorUserId: string;
    requestId: string;
    ipHash: string | null;
    code: string;
    destinationAccountReference: string;
    amountMinor: bigint;
  }): Promise<void> {
    try {
      await this.repository.createRejectedAuditEvent({
        actorUserId: params.actorUserId,
        actorType: ActorType.USER,
        action: 'TRANSFER_REJECTED',
        entityType: 'JournalTransaction',
        entityId: params.actorUserId,
        requestId: params.requestId,
        reason: params.code,
        ipHash: params.ipHash,
        afterState: {
          code: params.code,
          destinationAccountReference: params.destinationAccountReference
            .trim()
            .toUpperCase(),
          amountMinor: serializeMinorUnits(params.amountMinor),
        },
      });
    } catch {
      // Best-effort audit of rejected attempt should never mask the domain error
    }
  }
}
