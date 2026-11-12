-- =============================================================================
-- BalanceVault — Non-Destructive Hardening & Invariant Verification Script
-- =============================================================================
-- Run as the migration/operator role (`DIRECT_URL`, port 5432) AFTER applying
-- prisma/sql/01_setup_runtime_role.sql to verify every security invariant.
--
-- ROLLBACK & ATOMICITY GUARANTEE:
-- - Wrapped in `BEGIN; ... ROLLBACK;`.
-- - All temporary DML tests (Sections 5 & 6) additionally execute inside nested
--   PL/pgSQL subtransactions (`BEGIN ... RAISE EXCEPTION USING ERRCODE = 'BV999';
--   EXCEPTION WHEN SQLSTATE 'BV999' THEN ... END;`) that unconditionally roll
--   back temporary test records cleanly—even if an assertion fails or triggers
--   reject mid-way—leaving zero persistent test rows in the database.

BEGIN;

-- 1. Verify `app_runtime` attributes, zero role memberships, and zero privilege inheritance/assumption
DO $$
DECLARE
    role_rec record;
    member_roles text;
    priv_role record;
    is_pg16 boolean := current_setting('server_version_num')::int >= 160000;
    can_assume_via_set boolean := false;
BEGIN
    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin, rolinherit
    INTO role_rec
    FROM pg_roles
    WHERE rolname = 'app_runtime';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Verification failed: role "app_runtime" does not exist.';
    END IF;

    IF role_rec.rolsuper OR role_rec.rolcreaterole OR role_rec.rolcreatedb
       OR role_rec.rolreplication OR role_rec.rolbypassrls OR NOT role_rec.rolcanlogin
       OR role_rec.rolinherit THEN
        RAISE EXCEPTION 'Verification failed: app_runtime holds unsafe role flags (expected LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT): %', row_to_json(role_rec);
    END IF;

    -- Confirm app_runtime is not a direct member of any role (prevents inheritance or SET ROLE)
    SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO member_roles
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.roleid
    JOIN pg_roles m ON m.oid = am.member
    WHERE m.rolname = 'app_runtime';

    IF member_roles IS NOT NULL THEN
        RAISE EXCEPTION
            'Verification failed: app_runtime holds direct role membership(s) in [%]; expected none.',
            member_roles;
    END IF;

    -- Confirm app_runtime cannot inherit (`USAGE`), hold membership (`MEMBER`), or assume (`SET`)
    -- privileges from any other role (Supabase platform roles, migration roles, or `pg_*` roles).
    FOR priv_role IN
        SELECT rolname
        FROM pg_roles
        WHERE rolname <> 'app_runtime'
        ORDER BY rolname
    LOOP
        IF pg_has_role('app_runtime', priv_role.rolname, 'MEMBER')
           OR pg_has_role('app_runtime', priv_role.rolname, 'USAGE') THEN
            RAISE EXCEPTION
                'Verification failed: app_runtime is a member of or inherits privileges from role "%".',
                priv_role.rolname;
        END IF;

        IF is_pg16 THEN
            can_assume_via_set := pg_has_role('app_runtime', priv_role.rolname, 'SET');
            IF can_assume_via_set THEN
                RAISE EXCEPTION
                    'Verification failed: app_runtime holds SET ROLE permission on role "%".',
                    priv_role.rolname;
            END IF;
        END IF;
    END LOOP;
END
$$;

-- 2. Verify PUBLIC ACL entries via `aclexplode` AND check effective privileges
--    separately for `anon` and `authenticated` (including inherited PUBLIC privileges)
--    using individual single-privilege `has_*_privilege` assertions.
DO $$
DECLARE
    tables_to_check text[] := ARRAY[
        'User', 'Session', 'OnboardingApplication', 'Account',
        'JournalTransaction', 'JournalEntry', 'IdempotencyRecord',
        'AuditEvent', 'SystemBootstrapState', '_prisma_migrations'
    ];
    required_domain_tables text[] := ARRAY[
        'User', 'Session', 'OnboardingApplication', 'Account',
        'JournalTransaction', 'JournalEntry', 'IdempotencyRecord',
        'AuditEvent', 'SystemBootstrapState'
    ];
    target_table text;
    target_role text;
    fq_table text;
    seq_rec record;
    fq_seq text;
    public_priv text;
    schema_owner_oid oid;
    schema_owner_name text;
    can_admin_schema boolean;
    has_table_priv boolean;
    has_seq_priv boolean;
    is_pg17 boolean := current_setting('server_version_num')::int >= 170000;
BEGIN
    -- 2a. Required domain tables & trigger functions must exist before privilege checks
    FOREACH target_table IN ARRAY required_domain_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = target_table
        ) THEN
            RAISE EXCEPTION 'Verification failed: required application table "public"."%" does not exist.', target_table;
        END IF;
    END LOOP;

    IF to_regprocedure('public.prevent_append_only_mutation()') IS NULL THEN
        RAISE EXCEPTION 'Verification failed: function public.prevent_append_only_mutation() does not exist.';
    END IF;
    IF to_regprocedure('public.verify_balanced_journal_transaction()') IS NULL THEN
        RAISE EXCEPTION 'Verification failed: function public.verify_balanced_journal_transaction() does not exist.';
    END IF;

    -- 2b. Explicit/default PUBLIC ACL checks via aclexplode (grantee = 0)
    SELECT n.nspowner, pg_get_userbyid(n.nspowner), pg_has_role(current_user, n.nspowner, 'USAGE')
    INTO schema_owner_oid, schema_owner_name, can_admin_schema
    FROM pg_namespace n
    WHERE n.nspname = 'public';

    SELECT string_agg(acl.privilege_type, ', ' ORDER BY acl.privilege_type)
    INTO public_priv
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
    WHERE n.nspname = 'public'
      AND acl.grantee = 0
      AND (acl.privilege_type = 'CREATE' OR (can_admin_schema AND acl.privilege_type = 'USAGE'));

    IF public_priv IS NOT NULL THEN
        RAISE EXCEPTION
            'Verification failed: pseudo-role PUBLIC holds disallowed privilege(s) [%] on schema "public".',
            public_priv;
    END IF;

    IF NOT can_admin_schema AND EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE((SELECT nspacl FROM pg_namespace WHERE nspname = 'public'), acldefault('n', schema_owner_oid))) AS acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
    ) THEN
        RAISE NOTICE
            'Schema "public" USAGE remains on PUBLIC because schema owner is "%" (active role "%"); remove "public" from Exposed Schemas in Supabase Dashboard -> Settings -> API.',
            schema_owner_name, current_user;
    END IF;

    FOREACH target_table IN ARRAY tables_to_check LOOP
        SELECT string_agg(acl.privilege_type, ', ' ORDER BY acl.privilege_type)
        INTO public_priv
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
        WHERE n.nspname = 'public'
          AND c.relname = target_table
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND acl.grantee = 0;

        IF public_priv IS NOT NULL THEN
            RAISE EXCEPTION
                'Verification failed: pseudo-role PUBLIC holds ACL privilege(s) [%] on table "public"."%".',
                public_priv, target_table;
        END IF;
    END LOOP;

    FOR seq_rec IN
        SELECT
            c.relname AS seq_name,
            string_agg(acl.privilege_type, ', ' ORDER BY acl.privilege_type) AS privs
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
        WHERE n.nspname = 'public'
          AND c.relkind = 'S'
          AND acl.grantee = 0
        GROUP BY c.relname
    LOOP
        RAISE EXCEPTION
            'Verification failed: pseudo-role PUBLIC holds ACL privilege(s) [%] on sequence "public"."%".',
            seq_rec.privs, seq_rec.seq_name;
    END LOOP;

    SELECT string_agg(acl.privilege_type, ', ' ORDER BY acl.privilege_type)
    INTO public_priv
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE p.oid = to_regprocedure('public.prevent_append_only_mutation()')
      AND acl.grantee = 0;

    IF public_priv IS NOT NULL THEN
        RAISE EXCEPTION
            'Verification failed: pseudo-role PUBLIC holds ACL privilege(s) [%] on public.prevent_append_only_mutation().',
            public_priv;
    END IF;

    SELECT string_agg(acl.privilege_type, ', ' ORDER BY acl.privilege_type)
    INTO public_priv
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE p.oid = to_regprocedure('public.verify_balanced_journal_transaction()')
      AND acl.grantee = 0;

    IF public_priv IS NOT NULL THEN
        RAISE EXCEPTION
            'Verification failed: pseudo-role PUBLIC holds ACL privilege(s) [%] on public.verify_balanced_journal_transaction().',
            public_priv;
    END IF;

    -- 2c. Effective privilege checks separately for existing `anon` and `authenticated`
    -- PostgreSQL `has_*_privilege(role, ...)` evaluates direct grants, inherited role grants,
    -- AND inherited PUBLIC grants automatically.
    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
            IF has_schema_privilege(target_role, 'public', 'CREATE') THEN
                RAISE EXCEPTION 'Verification failed: role "%" holds CREATE on schema "public".', target_role;
            END IF;
            IF can_admin_schema AND has_schema_privilege(target_role, 'public', 'USAGE') THEN
                RAISE EXCEPTION 'Verification failed: role "%" still holds USAGE on schema "public".', target_role;
            ELSIF NOT can_admin_schema AND has_schema_privilege(target_role, 'public', 'USAGE') THEN
                RAISE NOTICE
                    'Schema "public" USAGE remains on "%" because schema owner is "%"; remove "public" from Exposed Schemas in Supabase Dashboard -> Settings -> API.',
                    target_role, schema_owner_name;
            END IF;

            FOREACH target_table IN ARRAY tables_to_check LOOP
                IF EXISTS (
                    SELECT 1 FROM pg_tables
                    WHERE schemaname = 'public' AND tablename = target_table
                ) THEN
                    fq_table := format('%I.%I', 'public', target_table);
                    has_table_priv :=
                        has_table_privilege(target_role, fq_table, 'SELECT')
                        OR has_table_privilege(target_role, fq_table, 'INSERT')
                        OR has_table_privilege(target_role, fq_table, 'UPDATE')
                        OR has_table_privilege(target_role, fq_table, 'DELETE')
                        OR has_table_privilege(target_role, fq_table, 'TRUNCATE')
                        OR has_table_privilege(target_role, fq_table, 'REFERENCES')
                        OR has_table_privilege(target_role, fq_table, 'TRIGGER');

                    IF is_pg17 THEN
                        has_table_priv := has_table_priv OR has_table_privilege(target_role, fq_table, 'MAINTAIN');
                    END IF;

                    IF has_table_priv THEN
                        RAISE EXCEPTION
                            'Verification failed: role "%" holds effective privilege(s) on table "%".',
                            target_role, fq_table;
                    END IF;
                END IF;
            END LOOP;

            FOR seq_rec IN
                SELECT c.relname AS seq_name
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'S'
            LOOP
                fq_seq := format('%I.%I', 'public', seq_rec.seq_name);
                has_seq_priv :=
                    has_sequence_privilege(target_role, fq_seq, 'USAGE')
                    OR has_sequence_privilege(target_role, fq_seq, 'SELECT')
                    OR has_sequence_privilege(target_role, fq_seq, 'UPDATE');

                IF has_seq_priv THEN
                    RAISE EXCEPTION
                        'Verification failed: role "%" holds effective privilege(s) on sequence "%".',
                        target_role, fq_seq;
                END IF;
            END LOOP;

            IF has_function_privilege(target_role, 'public.prevent_append_only_mutation()', 'EXECUTE') THEN
                RAISE EXCEPTION
                    'Verification failed: role "%" holds effective EXECUTE on public.prevent_append_only_mutation().',
                    target_role;
            END IF;

            IF has_function_privilege(target_role, 'public.verify_balanced_journal_transaction()', 'EXECUTE') THEN
                RAISE EXCEPTION
                    'Verification failed: role "%" holds effective EXECUTE on public.verify_balanced_journal_transaction().',
                    target_role;
            END IF;
        END IF;
    END LOOP;
END
$$;

-- 3. Verify exact `app_runtime` privilege matrix (individual privilege calls only)
DO $$
DECLARE
    tbl text;
    fq_table text;
    seq_rec record;
    fq_seq text;
    has_excess boolean;
    is_pg17 boolean := current_setting('server_version_num')::int >= 170000;
BEGIN
    IF NOT has_schema_privilege('app_runtime', 'public', 'USAGE') THEN
        RAISE EXCEPTION 'Verification failed: app_runtime lacks USAGE on schema "public".';
    END IF;
    IF has_schema_privilege('app_runtime', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'Verification failed: app_runtime must NOT hold CREATE on schema "public".';
    END IF;

    -- Mutable operational tables: SELECT/INSERT/UPDATE yes; DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN no
    FOREACH tbl IN ARRAY ARRAY['User', 'OnboardingApplication', 'Account'] LOOP
        fq_table := format('%I.%I', 'public', tbl);
        IF NOT (
            has_table_privilege('app_runtime', fq_table, 'SELECT')
            AND has_table_privilege('app_runtime', fq_table, 'INSERT')
            AND has_table_privilege('app_runtime', fq_table, 'UPDATE')
        ) THEN
            RAISE EXCEPTION 'Verification failed: app_runtime lacks SELECT/INSERT/UPDATE on "%".', fq_table;
        END IF;

        has_excess :=
            has_table_privilege('app_runtime', fq_table, 'DELETE')
            OR has_table_privilege('app_runtime', fq_table, 'TRUNCATE')
            OR has_table_privilege('app_runtime', fq_table, 'REFERENCES')
            OR has_table_privilege('app_runtime', fq_table, 'TRIGGER');
        IF is_pg17 THEN
            has_excess := has_excess OR has_table_privilege('app_runtime', fq_table, 'MAINTAIN');
        END IF;

        IF has_excess THEN
            RAISE EXCEPTION 'Verification failed: app_runtime holds disallowed privilege(s) on "%".', fq_table;
        END IF;
    END LOOP;

    -- Ephemeral session/idempotency tables: SELECT/INSERT/UPDATE/DELETE yes; TRUNCATE/REFERENCES/TRIGGER/MAINTAIN no
    FOREACH tbl IN ARRAY ARRAY['Session', 'IdempotencyRecord'] LOOP
        fq_table := format('%I.%I', 'public', tbl);
        IF NOT (
            has_table_privilege('app_runtime', fq_table, 'SELECT')
            AND has_table_privilege('app_runtime', fq_table, 'INSERT')
            AND has_table_privilege('app_runtime', fq_table, 'UPDATE')
            AND has_table_privilege('app_runtime', fq_table, 'DELETE')
        ) THEN
            RAISE EXCEPTION 'Verification failed: app_runtime lacks SELECT/INSERT/UPDATE/DELETE on "%".', fq_table;
        END IF;

        has_excess :=
            has_table_privilege('app_runtime', fq_table, 'TRUNCATE')
            OR has_table_privilege('app_runtime', fq_table, 'REFERENCES')
            OR has_table_privilege('app_runtime', fq_table, 'TRIGGER');
        IF is_pg17 THEN
            has_excess := has_excess OR has_table_privilege('app_runtime', fq_table, 'MAINTAIN');
        END IF;

        IF has_excess THEN
            RAISE EXCEPTION 'Verification failed: app_runtime holds disallowed privilege(s) on "%".', fq_table;
        END IF;
    END LOOP;

    -- Append-only ledger & audit tables: SELECT/INSERT yes; UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN no
    FOREACH tbl IN ARRAY ARRAY['JournalTransaction', 'JournalEntry', 'AuditEvent'] LOOP
        fq_table := format('%I.%I', 'public', tbl);
        IF NOT (
            has_table_privilege('app_runtime', fq_table, 'SELECT')
            AND has_table_privilege('app_runtime', fq_table, 'INSERT')
        ) THEN
            RAISE EXCEPTION 'Verification failed: app_runtime lacks SELECT/INSERT on "%".', fq_table;
        END IF;

        has_excess :=
            has_table_privilege('app_runtime', fq_table, 'UPDATE')
            OR has_table_privilege('app_runtime', fq_table, 'DELETE')
            OR has_table_privilege('app_runtime', fq_table, 'TRUNCATE')
            OR has_table_privilege('app_runtime', fq_table, 'REFERENCES')
            OR has_table_privilege('app_runtime', fq_table, 'TRIGGER');
        IF is_pg17 THEN
            has_excess := has_excess OR has_table_privilege('app_runtime', fq_table, 'MAINTAIN');
        END IF;

        IF has_excess THEN
            RAISE EXCEPTION 'Verification failed: app_runtime must NOT hold UPDATE/DELETE/DDL privilege(s) on "%".', fq_table;
        END IF;
    END LOOP;

    -- SystemBootstrapState: SELECT yes; INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN no
    IF NOT has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'SELECT') THEN
        RAISE EXCEPTION 'Verification failed: app_runtime lacks SELECT on "SystemBootstrapState".';
    END IF;

    has_excess :=
        has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'INSERT')
        OR has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'UPDATE')
        OR has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'DELETE')
        OR has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'TRUNCATE')
        OR has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'REFERENCES')
        OR has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'TRIGGER');
    IF is_pg17 THEN
        has_excess := has_excess OR has_table_privilege('app_runtime', 'public."SystemBootstrapState"', 'MAINTAIN');
    END IF;

    IF has_excess THEN
        RAISE EXCEPTION 'Verification failed: app_runtime must NOT hold write/delete/DDL privileges on "SystemBootstrapState".';
    END IF;

    -- Migration table must not be accessible to app_runtime
    IF EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'
    ) THEN
        has_excess :=
            has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'SELECT')
            OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'INSERT')
            OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'UPDATE')
            OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'DELETE')
            OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'TRUNCATE')
            OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'REFERENCES')
            OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'TRIGGER');
        IF is_pg17 THEN
            has_excess := has_excess OR has_table_privilege('app_runtime', 'public."_prisma_migrations"', 'MAINTAIN');
        END IF;

        IF has_excess THEN
            RAISE EXCEPTION 'Verification failed: app_runtime must NOT hold any privilege on "_prisma_migrations".';
        END IF;
    END IF;

    -- Any existing sequences in schema public must NOT be granted to app_runtime unintentionally
    FOR seq_rec IN
        SELECT c.relname AS seq_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
    LOOP
        fq_seq := format('%I.%I', 'public', seq_rec.seq_name);
        IF has_sequence_privilege('app_runtime', fq_seq, 'USAGE')
           OR has_sequence_privilege('app_runtime', fq_seq, 'SELECT')
           OR has_sequence_privilege('app_runtime', fq_seq, 'UPDATE') THEN
            RAISE EXCEPTION 'Verification failed: app_runtime holds unintended privilege(s) on sequence "%".', fq_seq;
        END IF;
    END LOOP;

    -- Trigger functions must not grant direct EXECUTE to app_runtime
    IF has_function_privilege('app_runtime', 'public.prevent_append_only_mutation()', 'EXECUTE')
       OR has_function_privilege('app_runtime', 'public.verify_balanced_journal_transaction()', 'EXECUTE') THEN
        RAISE EXCEPTION 'Verification failed: app_runtime must NOT hold direct EXECUTE on trigger functions.';
    END IF;
END
$$;

-- 4. Verify append-only triggers, deferred balance trigger + function search_path hardening, and unchanged object ownership
DO $$
DECLARE
    expected_trigger record;
    found_trigger record;
    balance_fn record;
    owned_by_runtime integer;
BEGIN
    FOR expected_trigger IN
        SELECT * FROM (VALUES
            ('JournalTransaction', 'trg_journal_transaction_append_only', 'prevent_append_only_mutation', false, false),
            ('JournalEntry', 'trg_journal_entry_append_only', 'prevent_append_only_mutation', false, false),
            ('AuditEvent', 'trg_audit_event_append_only', 'prevent_append_only_mutation', false, false),
            ('SystemBootstrapState', 'trg_bootstrap_state_append_only', 'prevent_append_only_mutation', false, false),
            ('JournalEntry', 'trg_verify_balanced_journal_transaction', 'verify_balanced_journal_transaction', true, true)
        ) AS t(tbl, tgname, fn, expected_deferrable, expected_initdeferred)
    LOOP
        SELECT tg.tgenabled::text AS state, tg.tgdeferrable, tg.tginitdeferred
        INTO found_trigger
        FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = tg.tgfoid
        WHERE n.nspname = 'public'
          AND c.relname = expected_trigger.tbl
          AND tg.tgname = expected_trigger.tgname
          AND p.proname = expected_trigger.fn
          AND NOT tg.tgisinternal;

        IF NOT FOUND OR found_trigger.state = 'D' THEN
            RAISE EXCEPTION
                'Verification failed: expected trigger "%" on "%" using "%" is missing or disabled.',
                expected_trigger.tgname, expected_trigger.tbl, expected_trigger.fn;
        END IF;

        IF found_trigger.tgdeferrable IS DISTINCT FROM expected_trigger.expected_deferrable
           OR found_trigger.tginitdeferred IS DISTINCT FROM expected_trigger.expected_initdeferred THEN
            RAISE EXCEPTION
                'Verification failed: trigger "%" on "%" changed deferrable properties (deferrable=%, initdeferred=%).',
                expected_trigger.tgname, expected_trigger.tbl, found_trigger.tgdeferrable, found_trigger.tginitdeferred;
        END IF;
    END LOOP;

    SELECT p.prosecdef, p.prosrc, COALESCE(p.proconfig, ARRAY[]::text[]) AS proconfig
    INTO balance_fn
    FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.verify_balanced_journal_transaction()');

    IF balance_fn.prosecdef THEN
        RAISE EXCEPTION 'Verification failed: public.verify_balanced_journal_transaction() must remain SECURITY INVOKER.';
    END IF;

    IF balance_fn.prosrc !~ 'FROM\s+public\."JournalEntry"' THEN
        RAISE EXCEPTION 'Verification failed: public.verify_balanced_journal_transaction() must schema-qualify public."JournalEntry".';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM unnest(balance_fn.proconfig) AS cfg
        WHERE cfg ~ '^search_path=("?pg_catalog"?,\s*"?public"?)$'
    ) THEN
        RAISE EXCEPTION
            'Verification failed: public.verify_balanced_journal_transaction() must pin SET search_path = pg_catalog, public (proconfig=%).',
            balance_fn.proconfig;
    END IF;

    SELECT COUNT(*)
    INTO owned_by_runtime
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND pg_get_userbyid(c.relowner) = 'app_runtime';

    IF owned_by_runtime > 0 THEN
        RAISE EXCEPTION 'Verification failed: % object(s) in schema "public" are owned by app_runtime.', owned_by_runtime;
    END IF;
END
$$;

-- 5. Behavioral trigger & deferred balance verification inside self-rolling-back subtransaction
DO $$
DECLARE
    test_user_id uuid := gen_random_uuid();
    test_audit_id uuid := gen_random_uuid();
    test_acct_1 uuid := gen_random_uuid();
    test_acct_2 uuid := gen_random_uuid();
    test_txn_ok uuid := gen_random_uuid();
    test_txn_single uuid := gen_random_uuid();
    test_txn_bad uuid := gen_random_uuid();
    test_txn_shadow uuid := gen_random_uuid();
    test_txn_shadow_ok uuid := gen_random_uuid();
    test_entry_1 uuid := gen_random_uuid();
    test_entry_2 uuid := gen_random_uuid();
    test_bootstrap_id text := 'VERIFY_TMP_' || replace(gen_random_uuid()::text, '-', '');
    blocked_audit_upd boolean := false;
    blocked_audit_del boolean := false;
    blocked_txn_upd boolean := false;
    blocked_txn_del boolean := false;
    blocked_entry_upd boolean := false;
    blocked_entry_del boolean := false;
    blocked_boot_upd boolean := false;
    blocked_boot_del boolean := false;
    blocked_single_entry boolean := false;
    blocked_unbalanced boolean := false;
    blocked_temp_shadow boolean := false;
    passed_temp_non_shadow boolean := false;
BEGIN
    BEGIN
        INSERT INTO public."User" ("id", "email", "passwordHash", "fullName", "updatedAt")
        VALUES (test_user_id, 'verify-trig-' || test_user_id::text || '@balancevault.test', '$argon2id$tmp', 'Verify Trigger Admin', NOW());

        INSERT INTO public."SystemBootstrapState" ("id", "adminUserId", "note")
        VALUES (test_bootstrap_id, test_user_id, 'Temporary append-only trigger check');

        INSERT INTO public."AuditEvent" ("id", "actorType", "action", "entityType", "entityId", "requestId")
        VALUES (test_audit_id, 'SYSTEM', 'HARDENING_VERIFY_TEMP', 'Verification', test_audit_id::text, 'verify-req-1');

        -- AuditEvent append-only trigger
        BEGIN
            UPDATE public."AuditEvent" SET "reason" = 'tamper' WHERE "id" = test_audit_id;
        EXCEPTION WHEN raise_exception THEN
            blocked_audit_upd := (SQLERRM ILIKE '%append-only%');
        END;
        BEGIN
            DELETE FROM public."AuditEvent" WHERE "id" = test_audit_id;
        EXCEPTION WHEN raise_exception THEN
            blocked_audit_del := (SQLERRM ILIKE '%append-only%');
        END;

        -- SystemBootstrapState append-only trigger
        BEGIN
            UPDATE public."SystemBootstrapState" SET "note" = 'tamper' WHERE "id" = test_bootstrap_id;
        EXCEPTION WHEN raise_exception THEN
            blocked_boot_upd := (SQLERRM ILIKE '%append-only%');
        END;
        BEGIN
            DELETE FROM public."SystemBootstrapState" WHERE "id" = test_bootstrap_id;
        EXCEPTION WHEN raise_exception THEN
            blocked_boot_del := (SQLERRM ILIKE '%append-only%');
        END;

        -- Balanced multi-statement deferred JournalTransaction / JournalEntry checks
        INSERT INTO public."Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
        VALUES
            (test_acct_1, 'BV-VERIFY-A-' || test_acct_1::text, 'SYSTEM_ISSUANCE', NULL, 'Verify Issuance A', 'INR', 'ACTIVE', 0, NOW()),
            (test_acct_2, 'BV-VERIFY-B-' || test_acct_2::text, 'SYSTEM_ISSUANCE', NULL, 'Verify Issuance B', 'INR', 'ACTIVE', 0, NOW());

        INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
        VALUES (test_txn_ok, 'TXN-VERIFY-BAL-' || test_txn_ok::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Balanced verification transaction');

        INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
        VALUES (test_entry_1, test_txn_ok, test_acct_1, 'DEBIT', 5000, 'INR');

        INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
        VALUES (test_entry_2, test_txn_ok, test_acct_2, 'CREDIT', 5000, 'INR');

        SET CONSTRAINTS ALL IMMEDIATE;

        -- JournalTransaction & JournalEntry append-only triggers
        BEGIN
            UPDATE public."JournalTransaction" SET "description" = 'tamper' WHERE "id" = test_txn_ok;
        EXCEPTION WHEN raise_exception THEN
            blocked_txn_upd := (SQLERRM ILIKE '%append-only%');
        END;
        BEGIN
            DELETE FROM public."JournalTransaction" WHERE "id" = test_txn_ok;
        EXCEPTION WHEN raise_exception THEN
            blocked_txn_del := (SQLERRM ILIKE '%append-only%');
        END;

        BEGIN
            UPDATE public."JournalEntry" SET "amountMinor" = 1 WHERE "id" = test_entry_1;
        EXCEPTION WHEN raise_exception THEN
            blocked_entry_upd := (SQLERRM ILIKE '%append-only%');
        END;
        BEGIN
            DELETE FROM public."JournalEntry" WHERE "id" = test_entry_1;
        EXCEPTION WHEN raise_exception THEN
            blocked_entry_del := (SQLERRM ILIKE '%append-only%');
        END;

        -- Restore DEFERRED mode for single-entry and unbalanced journal checks
        SET CONSTRAINTS ALL DEFERRED;

        BEGIN
            INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
            VALUES (test_txn_single, 'TXN-VERIFY-ONE-' || test_txn_single::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Single-entry verification transaction');

            INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
            VALUES (gen_random_uuid(), test_txn_single, test_acct_1, 'DEBIT', 5000, 'INR');

            SET CONSTRAINTS ALL IMMEDIATE;
        EXCEPTION WHEN raise_exception THEN
            blocked_single_entry := (SQLERRM ILIKE '%at least 2 entries%');
        END;

        SET CONSTRAINTS ALL DEFERRED;

        BEGIN
            INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
            VALUES (test_txn_bad, 'TXN-VERIFY-UNBAL-' || test_txn_bad::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Unbalanced verification transaction');

            INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
            VALUES
                (gen_random_uuid(), test_txn_bad, test_acct_1, 'DEBIT', 5000, 'INR'),
                (gen_random_uuid(), test_txn_bad, test_acct_2, 'CREDIT', 4000, 'INR');

            SET CONSTRAINTS ALL IMMEDIATE;
        EXCEPTION WHEN raise_exception THEN
            blocked_unbalanced := (SQLERRM ILIKE '%unbalanced%');
        END;

        -- Temporary-table shadowing regression check: pg_temp."JournalEntry" must never shadow public."JournalEntry"
        IF has_database_privilege(current_user, current_database(), 'TEMP') THEN
            SET CONSTRAINTS ALL DEFERRED;

            BEGIN
                CREATE TEMP TABLE "JournalEntry" (
                    "transactionId" uuid,
                    "direction" text,
                    "amountMinor" bigint
                ) ON COMMIT DROP;

                INSERT INTO pg_temp."JournalEntry" ("transactionId", "direction", "amountMinor")
                VALUES
                    (test_txn_shadow, 'DEBIT', 5000),
                    (test_txn_shadow, 'CREDIT', 5000);

                INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
                VALUES (test_txn_shadow, 'TXN-VERIFY-SHAD-' || test_txn_shadow::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Temp table shadow bypass check');

                INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
                VALUES
                    (gen_random_uuid(), test_txn_shadow, test_acct_1, 'DEBIT', 5000, 'INR'),
                    (gen_random_uuid(), test_txn_shadow, test_acct_2, 'CREDIT', 4000, 'INR');

                SET CONSTRAINTS ALL IMMEDIATE;
            EXCEPTION WHEN raise_exception THEN
                blocked_temp_shadow := (SQLERRM ILIKE '%unbalanced%');
            END;

            SET CONSTRAINTS ALL DEFERRED;
            CREATE TEMP TABLE IF NOT EXISTS "JournalEntry" (
                "transactionId" uuid,
                "direction" text,
                "amountMinor" bigint
            ) ON COMMIT DROP;
            DELETE FROM pg_temp."JournalEntry";

            INSERT INTO pg_temp."JournalEntry" ("transactionId", "direction", "amountMinor")
            VALUES (test_txn_shadow_ok, 'DEBIT', 9999);

            INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
            VALUES (test_txn_shadow_ok, 'TXN-VERIFY-SHADOK-' || test_txn_shadow_ok::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Temp table non-interference check');

            INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
            VALUES
                (gen_random_uuid(), test_txn_shadow_ok, test_acct_1, 'DEBIT', 5000, 'INR'),
                (gen_random_uuid(), test_txn_shadow_ok, test_acct_2, 'CREDIT', 5000, 'INR');

            SET CONSTRAINTS ALL IMMEDIATE;
            passed_temp_non_shadow := true;
            DROP TABLE IF EXISTS pg_temp."JournalEntry";
        ELSE
            RAISE NOTICE 'TEMP database privilege disabled for "%"; pg_temp table shadowing prevented by DB privilege.', current_user;
            blocked_temp_shadow := true;
            passed_temp_non_shadow := true;
        END IF;

        IF NOT (
            blocked_audit_upd AND blocked_audit_del
            AND blocked_boot_upd AND blocked_boot_del
            AND blocked_txn_upd AND blocked_txn_del
            AND blocked_entry_upd AND blocked_entry_del
            AND blocked_single_entry AND blocked_unbalanced
            AND blocked_temp_shadow AND passed_temp_non_shadow
        ) THEN
            RAISE EXCEPTION
                'Verification failed: trigger checks failed (audit=%/%, boot=%/%, txn=%/%, entry=%/%, single=%, unbalanced=%, shadow=%/%).',
                blocked_audit_upd, blocked_audit_del,
                blocked_boot_upd, blocked_boot_del,
                blocked_txn_upd, blocked_txn_del,
                blocked_entry_upd, blocked_entry_del,
                blocked_single_entry, blocked_unbalanced,
                blocked_temp_shadow, passed_temp_non_shadow;
        END IF;

        -- Force clean subtransaction rollback of all temporary Section 5 rows
        RAISE EXCEPTION 'Clean subtransaction rollback sentinel' USING ERRCODE = 'BV999';
    EXCEPTION
        WHEN SQLSTATE 'BV999' THEN
            NULL;
    END;
END
$$;

-- 6. Optional best-effort local runtime DML sanity check via SET LOCAL ROLE.
-- IMPORTANT: On Supabase/PG16+, `postgres` cannot usually `SET LOCAL ROLE app_runtime`
-- (and `SET LOCAL ROLE` still leaves `session_user = postgres`). Authoritative runtime
-- enforcement MUST be verified over a dedicated `app_runtime` login connection (`DATABASE_URL`)
-- via `npm run test:integration`.
DO $$
DECLARE
    can_set_runtime boolean := false;
    test_user_id uuid := gen_random_uuid();
    test_audit_id uuid := gen_random_uuid();
    test_acct_1 uuid := gen_random_uuid();
    test_acct_2 uuid := gen_random_uuid();
    test_txn_ok uuid := gen_random_uuid();
    test_txn_bad uuid := gen_random_uuid();
    denied_user_delete boolean := false;
    denied_onboarding_delete boolean := false;
    denied_account_delete boolean := false;
    denied_audit_update boolean := false;
    denied_audit_delete boolean := false;
    denied_txn_update boolean := false;
    denied_txn_delete boolean := false;
    denied_entry_update boolean := false;
    denied_entry_delete boolean := false;
    denied_bootstrap_insert boolean := false;
    denied_bootstrap_update boolean := false;
    denied_bootstrap_delete boolean := false;
    denied_migrations_select boolean := false;
    blocked_runtime_unbalanced boolean := false;
BEGIN
    BEGIN
        BEGIN
            EXECUTE 'SET LOCAL ROLE app_runtime';
            can_set_runtime := true;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE
                'Skipping local SET LOCAL ROLE app_runtime sanity check: active role "%" cannot assume app_runtime directly without password login (normal on Supabase/PG16+). Verify via separate app_runtime DATABASE_URL connection in `npm run test:integration`.',
                current_user;
        END;

        IF can_set_runtime THEN
            -- Allowed runtime operations (including deferred balance trigger firing without direct EXECUTE grant)
            INSERT INTO public."User" ("id", "email", "passwordHash", "fullName", "updatedAt")
            VALUES (test_user_id, 'verify-runtime-' || test_user_id::text || '@balancevault.test', '$argon2id$tmp', 'Verify Runtime', NOW());

            UPDATE public."User" SET "fullName" = 'Verify Runtime Updated' WHERE "id" = test_user_id;

            INSERT INTO public."AuditEvent" ("id", "actorType", "action", "entityType", "entityId", "requestId")
            VALUES (test_audit_id, 'SYSTEM', 'RUNTIME_ROLE_VERIFY_TEMP', 'User', test_user_id::text, 'verify-req-2');

            INSERT INTO public."Account" ("id", "publicReference", "kind", "ownerUserId", "accountName", "currency", "status", "balanceMinor", "updatedAt")
            VALUES
                (test_acct_1, 'BV-RT-A-' || test_acct_1::text, 'SYSTEM_ISSUANCE', NULL, 'Runtime Verify A', 'INR', 'ACTIVE', 0, NOW()),
                (test_acct_2, 'BV-RT-B-' || test_acct_2::text, 'SYSTEM_ISSUANCE', NULL, 'Runtime Verify B', 'INR', 'ACTIVE', 0, NOW());

            INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
            VALUES (test_txn_ok, 'TXN-RT-BAL-' || test_txn_ok::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Runtime balanced trigger execution check');

            INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
            VALUES
                (gen_random_uuid(), test_txn_ok, test_acct_1, 'DEBIT', 3000, 'INR'),
                (gen_random_uuid(), test_txn_ok, test_acct_2, 'CREDIT', 3000, 'INR');

            SET CONSTRAINTS ALL IMMEDIATE;
            SET CONSTRAINTS ALL DEFERRED;

            BEGIN
                INSERT INTO public."JournalTransaction" ("id", "publicReference", "type", "status", "currency", "description")
                VALUES (test_txn_bad, 'TXN-RT-UNBAL-' || test_txn_bad::text, 'ADJUSTMENT', 'POSTED', 'INR', 'Runtime unbalanced trigger rejection check');

                INSERT INTO public."JournalEntry" ("id", "transactionId", "accountId", "direction", "amountMinor", "currency")
                VALUES
                    (gen_random_uuid(), test_txn_bad, test_acct_1, 'DEBIT', 3000, 'INR'),
                    (gen_random_uuid(), test_txn_bad, test_acct_2, 'CREDIT', 2000, 'INR');

                SET CONSTRAINTS ALL IMMEDIATE;
            EXCEPTION WHEN raise_exception THEN
                blocked_runtime_unbalanced := (SQLERRM ILIKE '%unbalanced%');
            END;

            -- Prohibited operations must fail at role privilege layer (insufficient_privilege / 42501)
            BEGIN
                DELETE FROM public."User" WHERE "id" = test_user_id;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_user_delete := true;
            END;

            BEGIN
                DELETE FROM public."OnboardingApplication" WHERE false;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_onboarding_delete := true;
            END;

            BEGIN
                DELETE FROM public."Account" WHERE "id" = test_acct_1;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_account_delete := true;
            END;

            BEGIN
                UPDATE public."AuditEvent" SET "reason" = 'tamper' WHERE "id" = test_audit_id;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_audit_update := true;
            END;

            BEGIN
                DELETE FROM public."AuditEvent" WHERE "id" = test_audit_id;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_audit_delete := true;
            END;

            BEGIN
                UPDATE public."JournalTransaction" SET "description" = 'tamper' WHERE "id" = test_txn_ok;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_txn_update := true;
            END;

            BEGIN
                DELETE FROM public."JournalTransaction" WHERE "id" = test_txn_ok;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_txn_delete := true;
            END;

            BEGIN
                UPDATE public."JournalEntry" SET "amountMinor" = 1 WHERE false;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_entry_update := true;
            END;

            BEGIN
                DELETE FROM public."JournalEntry" WHERE false;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_entry_delete := true;
            END;

            BEGIN
                INSERT INTO public."SystemBootstrapState" ("id", "adminUserId", "note")
                VALUES ('RUNTIME_TAMPER_' || test_user_id::text, test_user_id, 'should fail');
            EXCEPTION WHEN insufficient_privilege THEN
                denied_bootstrap_insert := true;
            END;

            BEGIN
                UPDATE public."SystemBootstrapState" SET "note" = 'tamper' WHERE false;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_bootstrap_update := true;
            END;

            BEGIN
                DELETE FROM public."SystemBootstrapState" WHERE false;
            EXCEPTION WHEN insufficient_privilege THEN
                denied_bootstrap_delete := true;
            END;

            IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations') THEN
                BEGIN
                    EXECUTE 'SELECT COUNT(*) FROM public."_prisma_migrations"';
                EXCEPTION WHEN insufficient_privilege THEN
                    denied_migrations_select := true;
                END;
            ELSE
                denied_migrations_select := true;
            END IF;

            IF NOT (
                denied_user_delete AND denied_onboarding_delete AND denied_account_delete
                AND denied_audit_update AND denied_audit_delete
                AND denied_txn_update AND denied_txn_delete
                AND denied_entry_update AND denied_entry_delete
                AND denied_bootstrap_insert AND denied_bootstrap_update AND denied_bootstrap_delete
                AND denied_migrations_select AND blocked_runtime_unbalanced
            ) THEN
                RAISE EXCEPTION
                    'Verification failed during app_runtime negative DML checks: user_del=%, onb_del=%, acct_del=%, audit=%/%, txn=%/%, entry=%/%, boot=%/%/%, migrations=%, unbal=%',
                    denied_user_delete, denied_onboarding_delete, denied_account_delete,
                    denied_audit_update, denied_audit_delete,
                    denied_txn_update, denied_txn_delete,
                    denied_entry_update, denied_entry_delete,
                    denied_bootstrap_insert, denied_bootstrap_update, denied_bootstrap_delete,
                    denied_migrations_select, blocked_runtime_unbalanced;
            END IF;
        END IF;

        -- Force clean subtransaction rollback of temporary Section 6 rows and SET LOCAL ROLE
        -- (PostgreSQL automatically reverts SET LOCAL ROLE when a subtransaction rolls back)
        RAISE EXCEPTION 'Clean runtime verification rollback sentinel' USING ERRCODE = 'BV999';
    EXCEPTION
        WHEN SQLSTATE 'BV999' THEN
            NULL;
    END;
END
$$;

ROLLBACK;
