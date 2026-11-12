# Data Model — BalanceVault

This is a proposed logical model. Inspect the existing Prisma schema and migrations first; merge or adapt rather than blindly replacing existing tables.

## 1. Entities

### User
- `id` UUID primary key
- `email` unique, normalized
- `passwordHash`
- `fullName`
- `role` enum: CUSTOMER, ADMIN, SUPER_ADMIN
- `status` enum: ACTIVE, DISABLED, LOCKED
- `createdAt`, `updatedAt`

### Session
- `id` UUID
- `userId` FK
- `tokenHash` unique
- `createdAt`, `expiresAt`, `lastSeenAt`, `revokedAt`
- Optional metadata: coarse user agent, IP hash; do not store unnecessary personal data.

### OnboardingApplication
- `id` UUID
- `userId` FK unique or allow history through versioned applications
- `status`: PENDING, APPROVED, REJECTED, NEEDS_INFORMATION
- `submittedAt`, `reviewedAt`
- `reviewedByUserId` nullable FK
- `reviewReason` nullable
- profile fields required for the demo only; minimize personal data.

### Account
- `id` UUID
- `publicReference` unique, non-sequential
- `ownerUserId` FK
- `currency` fixed to INR for demo unless multi-currency is genuinely required
- `status`: PENDING, ACTIVE, FROZEN, CLOSED
- `balanceMinor` BIGINT projection, default 0
- `createdAt`, `updatedAt`
- `version` integer for optimistic concurrency if used

### JournalTransaction
- `id` UUID
- `publicReference` unique
- `type`: DEMO_TRANSFER, REVERSAL, ADJUSTMENT
- `status`: POSTED, REVERSED (avoid a mutable pending state unless required)
- `description`
- `idempotencyKey` unique within actor/scope
- `initiatedByUserId` nullable for controlled system operations
- `reversalOfTransactionId` nullable unique FK
- `createdAt`
- `metadata` JSON with strict allowlist; never store secrets

### JournalEntry
- `id` UUID
- `transactionId` FK
- `accountId` FK
- `direction`: DEBIT or CREDIT
- `amountMinor` BIGINT, strictly positive
- `createdAt`
- Optional index on `(accountId, createdAt)` and `(transactionId)`

### AuditEvent
- `id` UUID
- `actorUserId` nullable FK
- `actorType`: USER, SYSTEM
- `action` string/enum
- `entityType`, `entityId`
- `occurredAt`
- `requestId`
- `reason` nullable
- `before` JSON nullable, `after` JSON nullable (redacted allowlist only)
- `ipHash` or limited metadata if needed
- append-only: no update/delete through application runtime role

### IdempotencyRecord (if not represented on JournalTransaction)
- `id` UUID
- `actorUserId`
- `key`
- `requestHash`
- `responseStatus`
- `responseBody` sanitized
- `createdAt`, `expiresAt`
- unique `(actorUserId, key)`

## 2. Relationships
- User 1:N Session
- User 1:0..N OnboardingApplication
- User 1:N Account
- JournalTransaction 1:N JournalEntry
- Account 1:N JournalEntry
- User 1:N AuditEvent as actor
- JournalTransaction optionally references the transaction it reverses.

## 3. Ledger invariants
For every posted transaction:
1. At least two journal entries.
2. Every entry amount is positive.
3. All entries use the transaction currency.
4. Sum(DEBIT) = Sum(CREDIT).
5. A transfer has one debit from source and one credit to destination.
6. No entry is updated or deleted after posting.
7. A reversal is a new transaction with opposite directions and equal amounts.
8. No transfer may overdraw an account.
9. Idempotency key cannot post more than once for the same actor/scope.

## 4. Balance calculation
For a customer account:
`balanceMinor = SUM(CREDIT.amountMinor) - SUM(DEBIT.amountMinor)`.

If the account projection column is maintained for performance, update it in the same database transaction as journal entries. Build a reconciliation test that recalculates from journal entries and compares to the projection.

## 5. Prisma implementation notes
- Use `BigInt` for `amountMinor` and `balanceMinor`.
- Add indexes for owner, status, createdAt, accountId, transactionId.
- Use restrictive foreign keys where deleting financial records would be unsafe.
- Do not cascade-delete posted ledger or audit records.
- Use migrations, not `db push`, for shared/deployed environments.
- Add database constraints where possible; application checks alone are insufficient.
- Consider a PostgreSQL trigger or restricted posting function for enforcing append-only behavior and balanced posting if appropriate to the existing deployment model.
- Ensure runtime database role cannot update/delete journal entries or audit rows.
