-- =============================================================================
-- BalanceVault — Non-Destructive PostgreSQL / Supabase Role & Privilege Audit
-- =============================================================================
-- Safe read-only diagnostic script. Execute BEFORE and AFTER applying
-- prisma/sql/01_setup_runtime_role.sql using the migration/operator connection
-- (DIRECT_URL on port 5432, e.g., postgres), never using the runtime role.
-- Does not modify roles, grants, tables, triggers, or data.

-- 1. Active session identity and server metadata
SELECT
    current_user AS active_role,
    session_user AS session_login,
    current_database() AS database_name,
    version() AS postgres_version;

-- 2. Application, Supabase API, and migration roles (flags & capabilities)
SELECT
    rolname,
    rolsuper,
    rolinherit,
    rolcreaterole,
    rolcreatedb,
    rolcanlogin,
    rolreplication,
    rolbypassrls,
    rolconnlimit
FROM pg_roles
WHERE rolname NOT LIKE 'pg_%'
ORDER BY rolname;

-- 3. Direct role memberships (verify app_runtime is not a member of any privileged/platform role)
SELECT
    r.rolname AS role_name,
    m.rolname AS member_name,
    am.admin_option
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE r.rolname NOT LIKE 'pg_%'
   OR m.rolname NOT LIKE 'pg_%'
ORDER BY r.rolname, m.rolname;

-- 3b. Effective app_runtime membership summary across platform, privileged, and custom roles
SELECT
    r.rolname AS target_role,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN NULL
         ELSE pg_has_role('app_runtime', r.oid, 'MEMBER')
    END AS is_member,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN NULL
         ELSE pg_has_role('app_runtime', r.oid, 'USAGE')
    END AS inherits_privileges
FROM pg_roles r
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
  AND r.rolname <> 'app_runtime'
  AND (
      r.rolname IN (
          'anon', 'authenticated', 'service_role', 'authenticator',
          'postgres', 'dashboard_user', 'supabase_admin',
          'supabase_auth_admin', 'supabase_storage_admin', 'supabase_realtime_admin'
      )
      OR r.rolname LIKE 'pg_%'
      OR CASE
          WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN false
          ELSE pg_has_role('app_runtime', r.oid, 'MEMBER')
               OR pg_has_role('app_runtime', r.oid, 'USAGE')
      END
  )
ORDER BY r.rolname;

-- 4. Schema "public" ownership, explicit PUBLIC ACL entries, and role privilege summary
SELECT
    n.nspname AS schema_name,
    pg_get_userbyid(n.nspowner) AS schema_owner,
    EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
    ) AS public_usage,
    EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'CREATE'
    ) AS public_create,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN NULL
         ELSE has_schema_privilege('anon', 'public', 'USAGE') END AS anon_usage,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN NULL
         ELSE has_schema_privilege('authenticated', 'public', 'USAGE') END AS authenticated_usage,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN NULL
         ELSE has_schema_privilege('service_role', 'public', 'USAGE') END AS service_role_usage,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN NULL
         ELSE has_schema_privilege('app_runtime', 'public', 'USAGE') END AS app_runtime_usage
FROM pg_namespace n
WHERE n.nspname = 'public';

SELECT
    n.nspname AS schema_name,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type,
    acl.is_grantable
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
WHERE n.nspname = 'public'
ORDER BY grantee, acl.privilege_type;

-- 5. Default ACLs (pg_default_acl) in schema "public" — critical on Supabase
-- Note: `defaclrole = postgres` governs objects created by Prisma migrations (`DIRECT_URL`).
-- Entries with `defaclrole = supabase_admin` govern objects created by Supabase platform/extensions
-- and cannot be altered by `postgres`; audit and re-run setup after platform changes.
SELECT
    pg_get_userbyid(d.defaclrole) AS created_by_role,
    n.nspname AS schema_name,
    CASE d.defaclobjtype
        WHEN 'r' THEN 'TABLE'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FUNCTION'
        WHEN 'T' THEN 'TYPE'
        WHEN 'n' THEN 'SCHEMA'
        ELSE d.defaclobjtype::text
    END AS object_type,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type,
    acl.is_grantable
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
WHERE n.nspname = 'public'
ORDER BY created_by_role, object_type, grantee, acl.privilege_type;

-- 6. Public tables, owners, and Row-Level Security flags
SELECT
    t.schemaname,
    t.tablename,
    t.tableowner,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS rls_forced
FROM pg_tables t
JOIN pg_namespace n ON n.nspname = t.schemaname
JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.tablename
WHERE t.schemaname = 'public'
ORDER BY t.tablename;

-- 7. Complete ACL inspection on ALL tables in schema "public" (including PUBLIC, anon, authenticated)
SELECT
    c.relname AS table_name,
    pg_get_userbyid(c.relowner) AS owner,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type,
    acl.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY c.relname, grantee, acl.privilege_type;

-- 8. Sequences and IDENTITY/nextval columns in schema "public"
-- Expected for current UUID/text schema: 0 sequences and 0 identity columns.
SELECT
    c.relname AS sequence_name,
    pg_get_userbyid(c.relowner) AS owner,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS acl
WHERE n.nspname = 'public'
  AND c.relkind = 'S'
ORDER BY sequence_name, grantee, acl.privilege_type;

SELECT
    table_name,
    column_name,
    is_identity,
    identity_generation,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (is_identity = 'YES' OR column_default LIKE 'nextval%')
ORDER BY table_name, ordinal_position;

-- 9. Function / trigger-function EXECUTE ACLs in schema "public"
-- Using COALESCE(p.proacl, acldefault('f', p.proowner)) exposes implicit PUBLIC EXECUTE grants.
SELECT
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_userbyid(p.proowner) AS owner,
    p.prosecdef AS security_definer,
    p.proconfig AS function_config,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
WHERE n.nspname = 'public'
ORDER BY p.proname, grantee, acl.privilege_type;

-- 9b. Trigger function EXECUTE audit: PUBLIC (via aclexplode) + existing roles (effective via has_function_privilege)
SELECT
    'PUBLIC' AS subject,
    CASE WHEN fn1.oid IS NULL THEN NULL
         ELSE EXISTS (
             SELECT 1
             FROM aclexplode(COALESCE(fn1.proacl, acldefault('f', fn1.proowner))) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )
    END AS exec_prevent_append_only_mutation,
    CASE WHEN fn2.oid IS NULL THEN NULL
         ELSE EXISTS (
             SELECT 1
             FROM aclexplode(COALESCE(fn2.proacl, acldefault('f', fn2.proowner))) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )
    END AS exec_verify_balanced_journal_transaction
FROM (SELECT to_regprocedure('public.prevent_append_only_mutation()') AS oid_reg) r1
LEFT JOIN pg_proc fn1 ON fn1.oid = r1.oid_reg
CROSS JOIN (SELECT to_regprocedure('public.verify_balanced_journal_transaction()') AS oid_reg) r2
LEFT JOIN pg_proc fn2 ON fn2.oid = r2.oid_reg
UNION ALL
SELECT
    role_name AS subject,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN NULL
         WHEN to_regprocedure('public.prevent_append_only_mutation()') IS NULL THEN NULL
         ELSE has_function_privilege(role_name, 'public.prevent_append_only_mutation()', 'EXECUTE')
    END AS exec_prevent_append_only_mutation,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN NULL
         WHEN to_regprocedure('public.verify_balanced_journal_transaction()') IS NULL THEN NULL
         ELSE has_function_privilege(role_name, 'public.verify_balanced_journal_transaction()', 'EXECUTE')
    END AS exec_verify_balanced_journal_transaction
FROM unnest(ARRAY['anon', 'authenticated', 'app_runtime', 'postgres']) AS role_name;

-- 10. Append-only and double-entry balance constraint triggers verification
SELECT
    c.relname AS table_name,
    tg.tgname AS trigger_name,
    CASE tg.tgenabled::text
        WHEN 'O' THEN 'ENABLED (origin)'
        WHEN 'D' THEN 'DISABLED'
        WHEN 'R' THEN 'REPLICA'
        WHEN 'A' THEN 'ALWAYS'
        ELSE tg.tgenabled::text
    END AS trigger_state,
    tg.tgdeferrable AS is_deferrable,
    tg.tginitdeferred AS initially_deferred,
    p.proname AS trigger_function
FROM pg_trigger tg
JOIN pg_class c ON c.oid = tg.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = tg.tgfoid
WHERE n.nspname = 'public'
  AND NOT tg.tgisinternal
ORDER BY c.relname, tg.tgname;
