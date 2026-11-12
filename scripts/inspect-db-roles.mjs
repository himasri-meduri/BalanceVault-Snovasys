import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { inspectPostgresConnectionUrl } from './db-connection-utils.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const envPath = resolve(rootDir, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const strictMode = process.argv.includes('--strict');
const hasDirectUrl = Boolean(process.env.DIRECT_URL);
const inspectUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const sourceEnvVar = hasDirectUrl ? 'DIRECT_URL' : 'DATABASE_URL';

if (!inspectUrl) {
  console.error('Missing DIRECT_URL or DATABASE_URL in environment/.env.');
  process.exit(1);
}

let connectionSummary;
try {
  connectionSummary = inspectPostgresConnectionUrl(inspectUrl, sourceEnvVar);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Invalid database connection URL.');
  process.exit(1);
}

if (!hasDirectUrl) {
  console.warn(
    `Warning: DIRECT_URL is not set; inspecting using DATABASE_URL (${connectionSummary.username}). Use DIRECT_URL when auditing Supabase/PostgreSQL schema defaults.`,
  );
}

console.log('Redacted connection target:', {
  sourceEnvVar: connectionSummary.sourceEnvVar,
  host: connectionSummary.host,
  port: connectionSummary.port,
  database: connectionSummary.database,
  username: connectionSummary.username,
  usesPgBouncerPooler: connectionSummary.usesPgBouncerPooler,
});

const prisma = new PrismaClient({
  datasources: {
    db: { url: inspectUrl },
  },
});

const EXPECTED_TABLES = [
  'User',
  'Session',
  'OnboardingApplication',
  'Account',
  'JournalTransaction',
  'JournalEntry',
  'IdempotencyRecord',
  'AuditEvent',
  'SystemBootstrapState',
  '_prisma_migrations',
];

const EXPECTED_TRIGGERS = [
  ['JournalTransaction', 'trg_journal_transaction_append_only', 'prevent_append_only_mutation'],
  ['JournalEntry', 'trg_journal_entry_append_only', 'prevent_append_only_mutation'],
  ['AuditEvent', 'trg_audit_event_append_only', 'prevent_append_only_mutation'],
  ['SystemBootstrapState', 'trg_bootstrap_state_append_only', 'prevent_append_only_mutation'],
  ['JournalEntry', 'trg_verify_balanced_journal_transaction', 'verify_balanced_journal_transaction'],
];

async function main() {
  const identityRows = await prisma.$queryRaw`
    SELECT
      current_user AS active_role,
      session_user AS session_login,
      current_database() AS database_name,
      version() AS postgres_version
  `;
  console.log('\n[1] Session identity:', identityRows[0]);

  const roles = await prisma.$queryRaw`
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
    ORDER BY rolname
  `;
  console.log('\n[2] Database roles:', roles);

  const memberships = await prisma.$queryRaw`
    SELECT r.rolname AS role_name, m.rolname AS member_name, am.admin_option
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.roleid
    JOIN pg_roles m ON m.oid = am.member
    WHERE r.rolname NOT LIKE 'pg_%' OR m.rolname NOT LIKE 'pg_%'
    ORDER BY r.rolname, m.rolname
  `;
  console.log('\n[3] Role memberships:', memberships);

  const schemaRows = await prisma.$queryRaw`
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
    WHERE n.nspname = 'public'
  `;
  console.log('\n[4] Schema "public" ownership & privileges:', schemaRows[0]);

  const defaultAcls = await prisma.$queryRaw`
    SELECT
      pg_get_userbyid(d.defaclrole) AS created_by_role,
      CASE d.defaclobjtype
        WHEN 'r' THEN 'TABLE'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FUNCTION'
        ELSE d.defaclobjtype::text
      END AS object_type,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
      acl.privilege_type
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
    WHERE n.nspname = 'public'
    ORDER BY created_by_role, object_type, grantee, acl.privilege_type
  `;
  console.log('\n[5] Default ACLs in schema "public":', defaultAcls);

  const tables = await prisma.$queryRaw`
    SELECT
      t.tablename,
      t.tableowner,
      c.relrowsecurity AS rls_enabled
    FROM pg_tables t
    JOIN pg_namespace n ON n.nspname = t.schemaname
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.tablename
    WHERE t.schemaname = 'public'
    ORDER BY t.tablename
  `;
  console.log('\n[6] Public tables, owners, and RLS status:', tables);

  const tableAcls = await prisma.$queryRaw`
    SELECT
      c.relname AS table_name,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
      acl.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY c.relname, grantee, acl.privilege_type
  `;
  console.log('\n[7] Table ACLs (including PUBLIC, anon, authenticated, app_runtime):', tableAcls);

  const sequences = await prisma.$queryRaw`
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
    ORDER BY sequence_name, grantee, acl.privilege_type
  `;

  const identityColumns = await prisma.$queryRaw`
    SELECT table_name, column_name, is_identity, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (is_identity = 'YES' OR column_default LIKE 'nextval%')
    ORDER BY table_name, ordinal_position
  `;
  console.log('\n[8] Sequences in schema "public":', sequences);
  console.log('    IDENTITY / nextval columns:', identityColumns);

  const functions = await prisma.$queryRaw`
    SELECT
      p.proname AS function_name,
      p.prosecdef AS security_definer,
      pg_get_userbyid(p.proowner) AS owner,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
      acl.privilege_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE n.nspname = 'public'
    ORDER BY p.proname, grantee, acl.privilege_type
  `;
  console.log('\n[9] Function EXECUTE ACLs in schema "public":', functions);

  const triggers = await prisma.$queryRaw`
    SELECT
      c.relname AS table_name,
      tg.tgname AS trigger_name,
      tg.tgenabled::text AS trigger_state,
      tg.tgdeferrable AS is_deferrable,
      tg.tginitdeferred AS initially_deferred,
      p.proname AS trigger_function,
      p.prosecdef AS security_definer,
      p.prosrc AS function_source,
      COALESCE(p.proconfig, ARRAY[]::text[]) AS function_config
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = tg.tgfoid
    WHERE n.nspname = 'public'
      AND NOT tg.tgisinternal
    ORDER BY c.relname, tg.tgname
  `;
  console.log(
    '\n[10] Active triggers in schema "public":',
    triggers.map(({ function_source: _functionSource, ...summary }) => summary),
  );

  // Hardening compliance evaluation
  const findings = [];
  const warnings = [];

  const appRuntimeRole = roles.find((r) => r.rolname === 'app_runtime');
  if (!appRuntimeRole) {
    findings.push('Role "app_runtime" does not exist.');
  } else {
    if (
      appRuntimeRole.rolsuper ||
      appRuntimeRole.rolcreaterole ||
      appRuntimeRole.rolcreatedb ||
      appRuntimeRole.rolreplication ||
      appRuntimeRole.rolbypassrls ||
      appRuntimeRole.rolinherit ||
      !appRuntimeRole.rolcanlogin
    ) {
      findings.push(
        `Role "app_runtime" has unsafe flags: ${JSON.stringify(appRuntimeRole)}`,
      );
    }

    const appMemberships = memberships.filter((m) => m.member_name === 'app_runtime');
    if (appMemberships.length > 0) {
      findings.push(
        `Role "app_runtime" must have zero role memberships (found: ${appMemberships.map((m) => m.role_name).join(', ')}).`,
      );
    }
  }

  for (const untrustedRole of ['PUBLIC', 'anon', 'authenticated']) {
    const exposedTables = new Set(
      tableAcls
        .filter(
          (row) =>
            row.grantee === untrustedRole && EXPECTED_TABLES.includes(row.table_name),
        )
        .map((row) => row.table_name),
    );
    if (exposedTables.size > 0) {
      findings.push(
        `Role "${untrustedRole}" still holds privileges on table(s): ${Array.from(exposedTables).join(', ')}`,
      );
    }

    const exposedSequences = new Set(
      sequences
        .filter((row) => row.grantee === untrustedRole)
        .map((row) => row.sequence_name),
    );
    if (exposedSequences.size > 0) {
      findings.push(
        `Role "${untrustedRole}" holds sequence privilege(s): ${Array.from(exposedSequences).join(', ')}`,
      );
    }

    const exposedFunctions = new Set(
      functions
        .filter(
          (row) =>
            row.grantee === untrustedRole &&
            (row.function_name === 'prevent_append_only_mutation' ||
              row.function_name === 'verify_balanced_journal_transaction'),
        )
        .map((row) => row.function_name),
    );
    if (exposedFunctions.size > 0) {
      findings.push(
        `Role "${untrustedRole}" holds EXECUTE on trigger function(s): ${Array.from(exposedFunctions).join(', ')}`,
      );
    }
  }

  // Verify app_runtime table grants & absence of prohibited DML/migration/function grants
  const appTablePrivMap = new Map();
  for (const row of tableAcls) {
    if (row.grantee === 'app_runtime') {
      const set = appTablePrivMap.get(row.table_name) ?? new Set();
      set.add(row.privilege_type);
      appTablePrivMap.set(row.table_name, set);
    }
  }

  const expectedMatrix = {
    User: ['SELECT', 'INSERT', 'UPDATE'],
    OnboardingApplication: ['SELECT', 'INSERT', 'UPDATE'],
    Account: ['SELECT', 'INSERT', 'UPDATE'],
    Session: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    IdempotencyRecord: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    JournalTransaction: ['SELECT', 'INSERT'],
    JournalEntry: ['SELECT', 'INSERT'],
    AuditEvent: ['SELECT', 'INSERT'],
    SystemBootstrapState: ['SELECT'],
    _prisma_migrations: [],
  };

  for (const [tableName, expectedPrivs] of Object.entries(expectedMatrix)) {
    const tableExists = tables.some((t) => t.tablename === tableName);
    if (!tableExists) {
      continue;
    }
    const actualPrivs = appTablePrivMap.get(tableName) ?? new Set();
    for (const reqPriv of expectedPrivs) {
      if (!actualPrivs.has(reqPriv)) {
        findings.push(`app_runtime lacks ${reqPriv} on "${tableName}".`);
      }
    }
    for (const actualPriv of actualPrivs) {
      if (!expectedPrivs.includes(actualPriv)) {
        findings.push(`app_runtime holds excess privilege ${actualPriv} on "${tableName}".`);
      }
    }
  }

  const appFnExec = functions.filter((row) => row.grantee === 'app_runtime');
  if (appFnExec.length > 0) {
    findings.push(
      `app_runtime should not hold direct EXECUTE on functions: ${appFnExec.map((f) => f.function_name).join(', ')}`,
    );
  }

  for (const [tableName, triggerName, fnName] of EXPECTED_TRIGGERS) {
    const match = triggers.find(
      (t) =>
        t.table_name === tableName &&
        t.trigger_name === triggerName &&
        t.trigger_function === fnName,
    );
    if (!match || match.trigger_state === 'D') {
      findings.push(`Trigger "${triggerName}" on "${tableName}" (${fnName}) is missing or disabled.`);
    } else if (fnName === 'verify_balanced_journal_transaction') {
      if (!match.is_deferrable || !match.initially_deferred) {
        findings.push(
          `Trigger "${triggerName}" must be DEFERRABLE INITIALLY DEFERRED.`,
        );
      }
      if (match.security_definer) {
        findings.push(
          'Function verify_balanced_journal_transaction() must remain SECURITY INVOKER.',
        );
      }
      if (!/FROM\s+public\."JournalEntry"/.test(match.function_source ?? '')) {
        findings.push(
          'Function verify_balanced_journal_transaction() must qualify public."JournalEntry".',
        );
      }
      const cfgList = Array.isArray(match.function_config) ? match.function_config : [];
      if (
        !cfgList.some((cfg) =>
          /^search_path=("?pg_catalog"?,\s*"?public"?)$/.test(cfg),
        )
      ) {
        findings.push(
          'Function verify_balanced_journal_transaction() must pin SET search_path = pg_catalog, public.',
        );
      }
    }
  }

  const schemaRow = schemaRows[0];
  if (schemaRow?.anon_usage || schemaRow?.authenticated_usage || schemaRow?.public_usage) {
    warnings.push(
      `Schema "public" USAGE is still granted to PUBLIC/anon/authenticated (owner: "${schemaRow.schema_owner}"). On Supabase (PG 15+ where pg_database_owner / supabase_admin controls schema "public"), also unexpose "public" under Dashboard -> Settings -> API -> Exposed Schemas.`,
    );
  }

  console.log('\n[11] Compliance summary:');
  if (findings.length === 0) {
    console.log('PASS: Least-privilege table, sequence, function, role, and trigger invariants verified.');
  } else {
    console.log(`FAIL (${findings.length} issue(s) found):`);
    for (const issue of findings) {
      console.log(`  - ${issue}`);
    }
    if (strictMode) {
      process.exitCode = 1;
    }
  }

  if (warnings.length > 0) {
    console.log('Notes / Supabase manual recommendations:');
    for (const note of warnings) {
      console.log(`  - ${note}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('Role inspection failed:', err instanceof Error ? err.message : 'Unknown database error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
