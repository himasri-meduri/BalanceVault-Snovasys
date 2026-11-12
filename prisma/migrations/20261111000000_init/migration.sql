-- BalanceVault Initial Migration
-- Includes relational tables, check constraints, append-only immutability triggers,
-- and deferred double-entry balance verification.

CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'ADMIN', 'SUPER_ADMIN');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'PENDING', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED');
CREATE TYPE "AccountKind" AS ENUM ('CUSTOMER', 'SYSTEM_ISSUANCE');
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "JournalTransactionType" AS ENUM ('DEMO_TRANSFER', 'REVERSAL', 'ADJUSTMENT');
CREATE TYPE "JournalTransactionStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'ANONYMOUS');

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "User_email_normalized_chk" CHECK ("email" = LOWER(BTRIM("email")))
);

CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OnboardingApplication" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "contactReference" TEXT,
    "city" TEXT,
    "country" TEXT,
    "accountPurpose" TEXT,
    "acceptedSyntheticTerms" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" UUID,
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingApplication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "publicReference" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL DEFAULT 'CUSTOMER',
    "ownerUserId" UUID,
    "accountName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Account_currency_inr_chk" CHECK ("currency" = 'INR'),
    CONSTRAINT "Account_owner_and_balance_chk" CHECK (
        ("kind" = 'CUSTOMER' AND "ownerUserId" IS NOT NULL AND "balanceMinor" >= 0)
        OR ("kind" = 'SYSTEM_ISSUANCE' AND "ownerUserId" IS NULL)
    )
);

CREATE TABLE "JournalTransaction" (
    "id" UUID NOT NULL,
    "publicReference" TEXT NOT NULL,
    "type" "JournalTransactionType" NOT NULL,
    "status" "JournalTransactionStatus" NOT NULL DEFAULT 'POSTED',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "description" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "initiatedByUserId" UUID,
    "reversalOfTransactionId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalTransaction_currency_inr_chk" CHECK ("currency" = 'INR')
);

CREATE TABLE "JournalEntry" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalEntry_amount_positive_chk" CHECK ("amountMinor" > 0),
    CONSTRAINT "JournalEntry_currency_inr_chk" CHECK ("currency" = 'INR')
);

CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "transactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT NOT NULL,
    "reason" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "ipHash" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SystemBootstrapState" (
    "id" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminUserId" UUID NOT NULL,
    "note" TEXT NOT NULL,

    CONSTRAINT "SystemBootstrapState_pkey" PRIMARY KEY ("id")
);

-- Indexes & Unique Constraints
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_role_idx" ON "User"("role");
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE UNIQUE INDEX "OnboardingApplication_userId_key" ON "OnboardingApplication"("userId");
CREATE INDEX "OnboardingApplication_status_createdAt_idx" ON "OnboardingApplication"("status", "createdAt");
CREATE INDEX "OnboardingApplication_reviewedByUserId_idx" ON "OnboardingApplication"("reviewedByUserId");

CREATE UNIQUE INDEX "Account_publicReference_key" ON "Account"("publicReference");
CREATE INDEX "Account_ownerUserId_idx" ON "Account"("ownerUserId");
CREATE INDEX "Account_status_idx" ON "Account"("status");
CREATE INDEX "Account_ownerUserId_status_idx" ON "Account"("ownerUserId", "status");
CREATE INDEX "Account_kind_idx" ON "Account"("kind");

CREATE UNIQUE INDEX "JournalTransaction_publicReference_key" ON "JournalTransaction"("publicReference");
CREATE UNIQUE INDEX "JournalTransaction_reversalOfTransactionId_key" ON "JournalTransaction"("reversalOfTransactionId");
CREATE INDEX "JournalTransaction_initiatedByUserId_createdAt_idx" ON "JournalTransaction"("initiatedByUserId", "createdAt");
CREATE INDEX "JournalTransaction_createdAt_idx" ON "JournalTransaction"("createdAt");
CREATE INDEX "JournalTransaction_type_idx" ON "JournalTransaction"("type");

CREATE INDEX "JournalEntry_accountId_createdAt_idx" ON "JournalEntry"("accountId", "createdAt");
CREATE INDEX "JournalEntry_transactionId_idx" ON "JournalEntry"("transactionId");

CREATE UNIQUE INDEX "IdempotencyRecord_actorUserId_scope_key_key" ON "IdempotencyRecord"("actorUserId", "scope", "key");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");
CREATE INDEX "AuditEvent_actorUserId_occurredAt_idx" ON "AuditEvent"("actorUserId", "occurredAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

CREATE UNIQUE INDEX "SystemBootstrapState_adminUserId_key" ON "SystemBootstrapState"("adminUserId");

-- Foreign Keys
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OnboardingApplication" ADD CONSTRAINT "OnboardingApplication_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OnboardingApplication" ADD CONSTRAINT "OnboardingApplication_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Account" ADD CONSTRAINT "Account_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalTransaction" ADD CONSTRAINT "JournalTransaction_initiatedByUserId_fkey"
    FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalTransaction" ADD CONSTRAINT "JournalTransaction_reversalOfTransactionId_fkey"
    FOREIGN KEY ("reversalOfTransactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SystemBootstrapState" ADD CONSTRAINT "SystemBootstrapState_adminUserId_fkey"
    FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-Only Immutability Triggers
CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only; % operations are prohibited', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_transaction_append_only
    BEFORE UPDATE OR DELETE ON "JournalTransaction"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_journal_entry_append_only
    BEFORE UPDATE OR DELETE ON "JournalEntry"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_audit_event_append_only
    BEFORE UPDATE OR DELETE ON "AuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_bootstrap_state_append_only
    BEFORE UPDATE OR DELETE ON "SystemBootstrapState"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_append_only_mutation();

-- Double-Entry Balance Invariant Constraint Trigger (Checked at COMMIT)
CREATE OR REPLACE FUNCTION verify_balanced_journal_transaction()
RETURNS TRIGGER AS $$
DECLARE
    total_credit BIGINT;
    total_debit BIGINT;
    entry_count INTEGER;
BEGIN
    SELECT
        COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE 0 END), 0),
        COUNT(*)
    INTO total_credit, total_debit, entry_count
    FROM "JournalEntry"
    WHERE "transactionId" = NEW."transactionId";

    IF entry_count < 2 THEN
        RAISE EXCEPTION 'JournalTransaction % must contain at least 2 entries (found %)', NEW."transactionId", entry_count;
    END IF;

    IF total_credit <> total_debit THEN
        RAISE EXCEPTION 'JournalTransaction % is unbalanced: total_credit=% total_debit=%', NEW."transactionId", total_credit, total_debit;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_verify_balanced_journal_transaction
    AFTER INSERT ON "JournalEntry"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION verify_balanced_journal_transaction();
