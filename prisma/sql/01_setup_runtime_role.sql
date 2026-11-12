-- =============================================================================
-- BalanceVault — Supabase & PostgreSQL Least-Privilege Hardening Setup
-- =============================================================================
-- REVIEW CAREFULLY BEFORE EXECUTION.
-- Do NOT execute automatically against production without running
-- prisma/sql/00_inspect_roles.sql first.
--
-- EXECUTION ATOMICITY & TRANSACTIONAL SAFETY:
-- - This entire script runs inside a single explicit `BEGIN; ... COMMIT;`
--   transaction block so any failure rolls back all role, default-ACL,
--   REVOKE, and GRANT changes atomically with zero partial permission state.
-- - All statements used (`CREATE ROLE`, `ALTER ROLE`, `ALTER DEFAULT PRIVILEGES`,
--   `REVOKE`, `GRANT`, and PL/pgSQL `DO` blocks with exception-guarded
--   subtransactions) are 100% transactional in PostgreSQL 14–17 and Supabase.
-- - Recommended execution methods:
--   1) CLI `psql` over DIRECT_URL (port 5432, schema-owner `postgres`):
--        psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/01_setup_runtime_role.sql
--      (Do NOT pass `-1`/`--single-transaction` on top of internal `BEGIN`/`COMMIT`.)
--   2) Supabase Dashboard SQL Editor:
--      Paste and run this complete script as one batch (executes cleanly inside
--      the single explicit transaction block).
-- - Prerequisites:
--   1) Apply Prisma migrations FIRST (`npm run prisma:migrate:deploy`), so all
--      tables, constraints, trigger functions, and triggers exist and remain owned
--      by the migration owner (`postgres`).
--   2) Set the `app_runtime` password OUT-OF-BAND *after* `COMMIT;` in a private
--      interactive session (never store real passwords in SQL files, terminal logs,
--      PROMPTS.md, or Git):
--        psql "$DIRECT_URL" -c "\password app_runtime"
--   3) Verify with prisma/sql/02_verify_hardening.sql and `npm run db:inspect-roles -- --strict`.
--   4) Remove `public` from Exposed Schemas in Supabase Dashboard -> Settings -> API
--      because BalanceVault authenticates exclusively in Node.js (Express sessions).
--
-- SUPABASE-SPECIFIC LIMITATIONS DOCUMENTED BELOW:
-- - `postgres` on Supabase is NOT a true cluster superuser (`rolsuper = false`).
-- - On Supabase PostgreSQL 15+, `SCHEMA public` is typically owned by
--   `pg_database_owner` (which resolves to the database owner, e.g., `supabase_admin`
--   when `postgres` does not own the database). If `postgres` does not hold
--   `pg_has_role(current_user, n.nspowner, 'USAGE')`, revoking schema-level
--   `USAGE`/`CREATE` on `public` requires the database/schema owner or disabling
--   `public` exposure in Supabase Dashboard -> Settings -> API. Sections 3–5 still
--   revoke all table, sequence, and trigger-function grants cleanly because `postgres`
--   owns all Prisma-created objects.
-- - `ALTER DEFAULT PRIVILEGES IN SCHEMA public` without `FOR ROLE` modifies defaults
--   only for objects created by `current_user` (`postgres`, the migration owner).
--   Pre-existing `pg_default_acl` entries with `defaclrole = supabase_admin` govern
--   objects created by `supabase_admin` (extensions/platform) and cannot be altered
--   by `postgres`; always re-run this script after any migration or platform change.

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 1: Create & Harden `app_runtime` Role (No Password Literal, No Memberships)
-- -----------------------------------------------------------------------------
-- Creates `app_runtime` with LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
-- NOREPLICATION, and NOINHERIT (default NOBYPASSRLS). Password is omitted (NULL)
-- so no hardcoded/placeholder secret can ever authenticate before out-of-band setup.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime WITH
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOINHERIT;
    END IF;
END
$$;

-- Enforce hardened attributes idempotently on repeat runs without touching password
-- and without passing BYPASSRLS/NOBYPASSRLS unless needed (non-superusers on PG15
-- cannot alter BYPASSRLS even when identical).


-- Ensure `app_runtime` holds zero role memberships (including Supabase platform roles
-- like anon, authenticated, service_role, authenticator, postgres, or pg_* roles)
-- and never possesses BYPASSRLS. Aborts and rolls back transaction if un-revocable.
DO $$
DECLARE
    mem_rec record;
    has_bypass_rls boolean;
    residual_roles text;
BEGIN
    SELECT rolbypassrls
    INTO has_bypass_rls
    FROM pg_roles
    WHERE rolname = 'app_runtime';

    IF has_bypass_rls THEN
        RAISE EXCEPTION
            'Role "app_runtime" has BYPASSRLS enabled; revoke BYPASSRLS using a superuser before running this script.';
    END IF;

    FOR mem_rec IN
        SELECT DISTINCT r.rolname AS role_name
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
        WHERE m.rolname = 'app_runtime'
    LOOP
        BEGIN
            EXECUTE format('REVOKE %I FROM app_runtime', mem_rec.role_name);
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE EXCEPTION
                'Role "app_runtime" holds membership in "%", which active role "%" cannot revoke. Revoke it manually before applying hardening.',
                mem_rec.role_name, current_user;
        END;
    END LOOP;

    -- On PostgreSQL 16+, a non-error WARNING can occur if a membership was granted by
    -- a different admin grantor. Re-verify pg_auth_members is completely empty for
    -- app_runtime and abort/rollback if any membership remains.
    SELECT string_agg(DISTINCT r.rolname, ', ' ORDER BY r.rolname)
    INTO residual_roles
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.roleid
    JOIN pg_roles m ON m.oid = am.member
    WHERE m.rolname = 'app_runtime';

    IF residual_roles IS NOT NULL THEN
        RAISE EXCEPTION
            'Role "app_runtime" still holds residual membership(s) in [%] granted by another role; revoke them as schema/cluster admin before hardening.',
            residual_roles;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- SECTION 2: Lock Down Schema `public` & Migration-Owner Default Privileges
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    schema_owner_oid oid;
    schema_owner_name text;
    can_admin_schema boolean;
BEGIN
    SELECT n.nspowner, pg_get_userbyid(n.nspowner), pg_has_role(current_user, n.nspowner, 'USAGE')
    INTO schema_owner_oid, schema_owner_name, can_admin_schema
    FROM pg_namespace n
    WHERE n.nspname = 'public';

    IF can_admin_schema THEN
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        REVOKE USAGE ON SCHEMA public FROM PUBLIC;
        REVOKE ALL ON SCHEMA public FROM app_runtime;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE CREATE, USAGE ON SCHEMA public FROM anon;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE CREATE, USAGE ON SCHEMA public FROM authenticated;
        END IF;

        GRANT USAGE ON SCHEMA public TO app_runtime;
    ELSE
        RAISE NOTICE
            'Schema "public" is owned by "%" (active role "%"). Revoking schema-level CREATE/USAGE from PUBLIC/anon/authenticated requires the schema owner or disabling "public" exposure in Supabase Dashboard -> Settings -> API. Object-level table/sequence/function revocations in Sections 3-4 still execute cleanly.',
            schema_owner_name, current_user;

        BEGIN
            GRANT USAGE ON SCHEMA public TO app_runtime;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE
                'Active role "%" lacks GRANT OPTION for USAGE on schema "public"; if schema USAGE was revoked from PUBLIC, ask the schema owner to run: GRANT USAGE ON SCHEMA public TO app_runtime;',
                current_user;
        END;
    END IF;
END
$$;

-- Configure migration-owner default privileges so future objects created by `current_user`
-- (`postgres`) start closed to PUBLIC, app_runtime, anon, and authenticated.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON TABLES FROM PUBLIC, app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM PUBLIC, app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM PUBLIC, app_runtime;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated';
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- SECTION 3: Revoke ALL Table & Sequence Grants Across `public`
-- -----------------------------------------------------------------------------
-- Clears ALL existing table and sequence grants (including PG 17 MAINTAIN) from
-- PUBLIC, app_runtime, anon, and authenticated across all BalanceVault tables AND
-- Prisma's `_prisma_migrations`.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, app_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, app_runtime;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- SECTION 4: Restrict Application Trigger Function Execution Privileges
-- -----------------------------------------------------------------------------
-- PostgreSQL fires trigger functions attached to tables owned by `postgres` natively
-- during DML without needing direct EXECUTE grants on PUBLIC, anon, authenticated,
-- or app_runtime. If these functions are absent (migrations not applied), PostgreSQL
-- raises an error and rolls back the entire transaction cleanly.
REVOKE ALL ON FUNCTION public.prevent_append_only_mutation() FROM PUBLIC, app_runtime;
REVOKE ALL ON FUNCTION public.verify_balanced_journal_transaction() FROM PUBLIC, app_runtime;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.prevent_append_only_mutation() FROM anon';
        EXECUTE 'REVOKE ALL ON FUNCTION public.verify_balanced_journal_transaction() FROM anon';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.prevent_append_only_mutation() FROM authenticated';
        EXECUTE 'REVOKE ALL ON FUNCTION public.verify_balanced_journal_transaction() FROM authenticated';
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- SECTION 5: Minimal Explicit Table Grants for `app_runtime`
-- -----------------------------------------------------------------------------
-- Table ownership remains unchanged (`postgres`).

-- 5a. Mutable domain tables: SELECT, INSERT, UPDATE only (no DELETE/TRUNCATE/DDL).
GRANT SELECT, INSERT, UPDATE ON TABLE
    public."User",
    public."OnboardingApplication",
    public."Account"
TO app_runtime;

-- 5b. Ephemeral security/idempotency tables: SELECT, INSERT, UPDATE, DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public."Session",
    public."IdempotencyRecord"
TO app_runtime;

-- 5c. Strictly append-only ledger & audit tables: SELECT and INSERT ONLY.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
    public."JournalTransaction",
    public."JournalEntry",
    public."AuditEvent"
FROM app_runtime, PUBLIC;

GRANT SELECT, INSERT ON TABLE
    public."JournalTransaction",
    public."JournalEntry",
    public."AuditEvent"
TO app_runtime;

-- 5d. CLI-bootstrap state marker: read-only (`SELECT`) for app_runtime.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
    public."SystemBootstrapState"
FROM app_runtime, PUBLIC;

GRANT SELECT ON TABLE
    public."SystemBootstrapState"
TO app_runtime;

-- 5e. `_prisma_migrations` remains completely inaccessible (all grants stripped in Section 3).

-- -----------------------------------------------------------------------------
-- SECTION 6: Sequence Verification (Prisma Schema Uses UUID/Text Keys Only)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    seq_count integer;
BEGIN
    SELECT COUNT(*)
    INTO seq_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S';

    IF seq_count > 0 THEN
        RAISE NOTICE
            'Detected % sequence(s) in schema "public". All grants have been revoked from PUBLIC/anon/authenticated/app_runtime; review manually and grant USAGE, SELECT only on required sequences.',
            seq_count;
    END IF;
END
$$;

COMMIT;
