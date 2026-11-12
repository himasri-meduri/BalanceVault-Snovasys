import crypto from 'node:crypto';
import { ActorType, UserRole } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, ValidationError } from '../../shared/errors.js';
import { hashPassword } from '../auth/auth.crypto.js';
import { normalizeEmail, passwordPolicySchema } from '../auth/auth.schemas.js';
import { toPublicUserSummary } from '../auth/auth.service.js';
import type { PublicUserSummary } from '../auth/auth.types.js';
import type {
  BootstrapRepository,
  DbPrivilegeInspection,
} from './bootstrap.repository.js';

export const BOOTSTRAP_MARKER_ID = 'FIRST_SUPER_ADMIN_BOOTSTRAP';

export interface OperatorConnectionSummary {
  url: string;
  sourceEnvVar: 'DIRECT_URL' | 'DATABASE_URL';
  host: string;
  port: string;
  database: string;
  username: string;
  isAppRuntimeUser: boolean;
  usesPgBouncerPooler: boolean;
}

/**
 * Resolves the database connection for CLI operator/migration workflows (never app_runtime).
 * Rejects Supabase/PgBouncer transaction pooling (port 6543 / pgbouncer=true) and refuses
 * to echo credentials in error messages.
 */
export function resolveOperatorDatabaseUrl(env: {
  DIRECT_URL?: string;
  DATABASE_URL?: string;
}): OperatorConnectionSummary {
  const direct = env.DIRECT_URL?.trim();
  const runtimeFallback = env.DATABASE_URL?.trim();
  const sourceEnvVar: 'DIRECT_URL' | 'DATABASE_URL' = direct
    ? 'DIRECT_URL'
    : 'DATABASE_URL';
  const rawUrl = direct || runtimeFallback;

  if (!rawUrl) {
    throw new ValidationError(
      'Missing DIRECT_URL (preferred for CLI bootstrap) or DATABASE_URL in environment/.env.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError(
      `${sourceEnvVar} is not a valid PostgreSQL connection URL (credentials redacted).`,
    );
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ValidationError(
      `${sourceEnvVar} must use the postgres:// or postgresql:// protocol.`,
    );
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : '';
  const port = parsed.port || '5432';
  const database = parsed.pathname.replace(/^\//, '') || 'postgres';
  const isAppRuntimeUser =
    username === 'app_runtime' || username.startsWith('app_runtime.');
  const usesPgBouncerPooler =
    parsed.searchParams.get('pgbouncer')?.toLowerCase() === 'true' || port === '6543';

  if (!direct && isAppRuntimeUser) {
    throw new ForbiddenError(
      `Refusing to run CLI bootstrap with least-privilege runtime role "${username}" via DATABASE_URL. Configure DIRECT_URL with your migration/operator connection (e.g., postgres or app_migrator on port 5432).`,
      'DB_PRIVILEGE_ERROR',
    );
  }

  if (usesPgBouncerPooler) {
    throw new ValidationError(
      `${sourceEnvVar} points to a transaction pooler (port ${port}). Configure DIRECT_URL on direct/session port 5432 without ?pgbouncer=true for migrations and Serializable bootstrap transactions.`,
    );
  }

  return {
    url: rawUrl,
    sourceEnvVar,
    host: parsed.hostname || 'unknown',
    port,
    database,
    username: username || 'unknown',
    isAppRuntimeUser,
    usesPgBouncerPooler,
  };
}

export interface RuntimeConnectionSummary {
  url: string;
  host: string;
  port: string;
  database: string;
  username: string;
  usesPgBouncerPooler: boolean;
}

/**
 * Validates that DATABASE_URL connects as the separate least-privilege runtime
 * role (`app_runtime` or Supabase pooler `app_runtime.<project_ref>`) and is
 * distinct from the operator/migration DIRECT_URL role when both are configured.
 */
export function resolveRuntimeDatabaseUrl(env: {
  DATABASE_URL?: string;
  DIRECT_URL?: string;
}): RuntimeConnectionSummary {
  const rawUrl = env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new ValidationError('Missing DATABASE_URL in environment/.env.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError(
      'DATABASE_URL is not a valid PostgreSQL connection URL (credentials redacted).',
    );
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ValidationError(
      'DATABASE_URL must use the postgres:// or postgresql:// protocol.',
    );
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : '';
  const port = parsed.port || '5432';
  const database = parsed.pathname.replace(/^\//, '') || 'postgres';
  const isAppRuntimeUser =
    username === 'app_runtime' || username.startsWith('app_runtime.');

  if (!isAppRuntimeUser) {
    throw new ForbiddenError(
      `DATABASE_URL must connect as the least-privilege runtime role ("app_runtime" or "app_runtime.<project_ref>"), not "${username || 'unknown'}".`,
      'DB_HARDENING_VIOLATION',
    );
  }

  const directRaw = env.DIRECT_URL?.trim();
  if (directRaw) {
    let directParsed: URL;
    try {
      directParsed = new URL(directRaw);
    } catch {
      throw new ValidationError(
        'DIRECT_URL is not a valid PostgreSQL connection URL (credentials redacted).',
      );
    }
    const directUser = directParsed.username
      ? decodeURIComponent(directParsed.username)
      : '';
    if (directUser === username) {
      throw new ForbiddenError(
        'DATABASE_URL and DIRECT_URL must use separate database roles (runtime vs operator).',
        'DB_HARDENING_VIOLATION',
      );
    }
  }

  return {
    url: rawUrl,
    host: parsed.hostname || 'unknown',
    port,
    database,
    username,
    usesPgBouncerPooler:
      parsed.searchParams.get('pgbouncer')?.toLowerCase() === 'true' || port === '6543',
  };
}

const bootstrapInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email('ADMIN_BOOTSTRAP_EMAIL must be a valid email address')
      .max(254)
      .transform(normalizeEmail),
    fullName: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .default('BalanceVault Super Admin'),
    bootstrapSecret: z
      .string()
      .min(24, 'ADMIN_BOOTSTRAP_SECRET must be at least 24 characters')
      .refine(
        (val) => !val.includes('REPLACE_WITH') && !val.includes('CHANGE_ME'),
        'ADMIN_BOOTSTRAP_SECRET must not be a placeholder value',
      ),
    password: passwordPolicySchema.refine(
      (val) => !val.includes('REPLACE_WITH') && !val.includes('CHANGE_ME'),
      'ADMIN_BOOTSTRAP_PASSWORD must not be a placeholder value',
    ),
  })
  .superRefine((data, ctx) => {
    if (data.password === data.bootstrapSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'ADMIN_BOOTSTRAP_PASSWORD must be distinct from ADMIN_BOOTSTRAP_SECRET',
      });
    }
  });

export interface BootstrapInput {
  email: string;
  fullName?: string;
  bootstrapSecret: string;
  expectedBootstrapSecret?: string;
  password: string;
}

export interface BootstrapResult {
  status: 'created' | 'already_bootstrapped';
  adminUser: PublicUserSummary;
  auditEventId: string | null;
  dbRoleSummary: {
    currentUser: string;
    isSuperuser: boolean;
    memberships: Array<{ roleName: string; adminOption: boolean }>;
    appendOnlyAuditRestricted: boolean;
    appendOnlyTriggersActive: boolean;
    untrustedExposureWarnings: string[];
  };
}

export function collectUntrustedExposureWarnings(
  inspection: DbPrivilegeInspection,
): string[] {
  const warnings: string[] = [];
  for (const exposure of inspection.untrustedRoleExposures) {
    if (!exposure.exists) {
      continue;
    }
    if (exposure.tablesWithPrivileges.length > 0) {
      warnings.push(
        `Role "${exposure.role}" holds table privileges on: ${exposure.tablesWithPrivileges.join(', ')}`,
      );
    }
    if (exposure.sequencesWithPrivileges.length > 0) {
      warnings.push(
        `Role "${exposure.role}" holds sequence privileges on: ${exposure.sequencesWithPrivileges.join(', ')}`,
      );
    }
    if (exposure.preventAppendOnlyExecute) {
      warnings.push(
        `Role "${exposure.role}" holds EXECUTE on public.prevent_append_only_mutation()`,
      );
    }
    if (exposure.verifyBalancedJournalExecute) {
      warnings.push(
        `Role "${exposure.role}" holds EXECUTE on public.verify_balanced_journal_transaction()`,
      );
    }
  }
  return warnings;
}

/**
 * Verifies that the migration/operator role used for CLI bootstrap holds required
 * table permissions and that append-only triggers are enabled, without broadening
 * privileges or requiring direct EXECUTE grants on trigger functions.
 */
export function verifyBootstrapDbPermissions(inspection: DbPrivilegeInspection) {
  const missing: string[] = [];
  if (!inspection.tablePrivileges.userSelect) missing.push('SELECT on "User"');
  if (!inspection.tablePrivileges.userInsert) missing.push('INSERT on "User"');
  if (!inspection.tablePrivileges.bootstrapSelect) {
    missing.push('SELECT on "SystemBootstrapState"');
  }
  if (!inspection.tablePrivileges.bootstrapInsert) {
    missing.push('INSERT on "SystemBootstrapState"');
  }
  if (!inspection.tablePrivileges.auditSelect) missing.push('SELECT on "AuditEvent"');
  if (!inspection.tablePrivileges.auditInsert) missing.push('INSERT on "AuditEvent"');
  if (!inspection.triggerIntegrity.auditEventAppendOnly) {
    missing.push('active trigger trg_audit_event_append_only on "AuditEvent"');
  }
  if (!inspection.triggerIntegrity.bootstrapStateAppendOnly) {
    missing.push(
      'active trigger trg_bootstrap_state_append_only on "SystemBootstrapState"',
    );
  }

  if (missing.length > 0) {
    throw new ForbiddenError(
      `Database role "${inspection.currentUser}" lacks required bootstrap privileges or triggers: ${missing.join(', ')}. Ensure CLI bootstrap uses DIRECT_URL (migration/operator role) after applying migrations and prisma/sql/01_setup_runtime_role.sql without granting superuser.`,
      'DB_PRIVILEGE_ERROR',
    );
  }

  return {
    currentUser: inspection.currentUser,
    isSuperuser: Boolean(inspection.roleInfo?.rolsuper),
    memberships: inspection.memberships,
    appendOnlyAuditRestricted:
      !inspection.tablePrivileges.auditUpdate && !inspection.tablePrivileges.auditDelete,
    appendOnlyTriggersActive:
      inspection.triggerIntegrity.auditEventAppendOnly &&
      inspection.triggerIntegrity.bootstrapStateAppendOnly,
    untrustedExposureWarnings: collectUntrustedExposureWarnings(inspection),
  };
}

/**
 * Verifies full runtime least-privilege hardening across `app_runtime`, `PUBLIC`,
 * Supabase roles (`anon`, `authenticated`), trigger integrity, and sequence posture.
 */
export function verifyRuntimeDbHardening(inspection: DbPrivilegeInspection) {
  const violations: string[] = [];

  if (inspection.currentUser !== 'app_runtime') {
    violations.push(
      `Runtime verification must execute as "app_runtime", found active role "${inspection.currentUser}".`,
    );
  }
  if (inspection.sessionUser !== inspection.currentUser) {
    violations.push(
      `Runtime verification must use a dedicated app_runtime session login, not SET ROLE (session_user="${inspection.sessionUser}", current_user="${inspection.currentUser}").`,
    );
  }

  if (!inspection.roleInfo) {
    violations.push(`Runtime role "${inspection.currentUser}" not found in pg_roles.`);
  } else {
    if (!inspection.roleInfo.rolcanlogin) {
      violations.push(`Runtime role "${inspection.currentUser}" lacks LOGIN capability.`);
    }
    if (inspection.roleInfo.rolsuper) {
      violations.push(`Runtime role "${inspection.currentUser}" must NOT have SUPERUSER.`);
    }
    if (inspection.roleInfo.rolcreaterole) {
      violations.push(`Runtime role "${inspection.currentUser}" must NOT have CREATEROLE.`);
    }
    if (inspection.roleInfo.rolcreatedb) {
      violations.push(`Runtime role "${inspection.currentUser}" must NOT have CREATEDB.`);
    }
    if (inspection.roleInfo.rolreplication) {
      violations.push(`Runtime role "${inspection.currentUser}" must NOT have REPLICATION.`);
    }
    if (inspection.roleInfo.rolbypassrls) {
      violations.push(`Runtime role "${inspection.currentUser}" must NOT have BYPASSRLS.`);
    }
    if (inspection.roleInfo.rolinherit) {
      violations.push(`Runtime role "${inspection.currentUser}" should use NOINHERIT.`);
    }
  }

  if (inspection.memberships.length > 0) {
    violations.push(
      `Runtime role "${inspection.currentUser}" must have zero role memberships (found: ${inspection.memberships.map((m) => m.roleName).join(', ')}).`,
    );
  }

  const p = inspection.tablePrivileges;

  // Required grants
  if (!p.userSelect || !p.userInsert || !p.userUpdate) {
    violations.push('Runtime role lacks SELECT/INSERT/UPDATE on "User".');
  }
  if (!p.onboardingSelect || !p.onboardingInsert || !p.onboardingUpdate) {
    violations.push(
      'Runtime role lacks SELECT/INSERT/UPDATE on "OnboardingApplication".',
    );
  }
  if (!p.accountSelect || !p.accountInsert || !p.accountUpdate) {
    violations.push('Runtime role lacks SELECT/INSERT/UPDATE on "Account".');
  }
  if (!p.sessionSelect || !p.sessionInsert || !p.sessionUpdate || !p.sessionDelete) {
    violations.push('Runtime role lacks SELECT/INSERT/UPDATE/DELETE on "Session".');
  }
  if (
    !p.idempotencySelect ||
    !p.idempotencyInsert ||
    !p.idempotencyUpdate ||
    !p.idempotencyDelete
  ) {
    violations.push(
      'Runtime role lacks SELECT/INSERT/UPDATE/DELETE on "IdempotencyRecord".',
    );
  }
  if (!p.journalTransactionSelect || !p.journalTransactionInsert) {
    violations.push('Runtime role lacks SELECT/INSERT on "JournalTransaction".');
  }
  if (!p.journalEntrySelect || !p.journalEntryInsert) {
    violations.push('Runtime role lacks SELECT/INSERT on "JournalEntry".');
  }
  if (!p.auditSelect || !p.auditInsert) {
    violations.push('Runtime role lacks SELECT/INSERT on "AuditEvent".');
  }
  if (!p.bootstrapSelect) {
    violations.push('Runtime role lacks SELECT on "SystemBootstrapState".');
  }

  // Prohibited writes / deletions on domain, append-only, bootstrap, and migration tables
  if (p.userDelete) violations.push('Runtime role must NOT hold DELETE on "User".');
  if (p.onboardingDelete) {
    violations.push('Runtime role must NOT hold DELETE on "OnboardingApplication".');
  }
  if (p.accountDelete) {
    violations.push('Runtime role must NOT hold DELETE on "Account".');
  }
  if (p.journalTransactionUpdate || p.journalTransactionDelete) {
    violations.push(
      'Runtime role must NOT hold UPDATE/DELETE on append-only "JournalTransaction".',
    );
  }
  if (p.journalEntryUpdate || p.journalEntryDelete) {
    violations.push(
      'Runtime role must NOT hold UPDATE/DELETE on append-only "JournalEntry".',
    );
  }
  if (p.auditUpdate || p.auditDelete) {
    violations.push(
      'Runtime role must NOT hold UPDATE/DELETE on append-only "AuditEvent".',
    );
  }
  if (p.bootstrapInsert || p.bootstrapUpdate || p.bootstrapDelete) {
    violations.push(
      'Runtime role must NOT hold INSERT/UPDATE/DELETE on "SystemBootstrapState".',
    );
  }
  if (p.prismaMigrationsAny) {
    violations.push('Runtime role must NOT hold privileges on "_prisma_migrations".');
  }
  if (inspection.excessTablePrivileges.length > 0) {
    const details = inspection.excessTablePrivileges
      .map((item) => `${item.privilegeType} on "${item.tableName}"`)
      .join(', ');
    violations.push(`Runtime role holds disallowed excess ACL privilege(s): ${details}.`);
  }

  // Trigger function direct execution must be revoked
  if (inspection.functionPrivileges.preventAppendOnlyExecute) {
    violations.push(
      'Runtime role should NOT hold direct EXECUTE on prevent_append_only_mutation().',
    );
  }
  if (inspection.functionPrivileges.verifyBalancedJournalExecute) {
    violations.push(
      'Runtime role should NOT hold direct EXECUTE on verify_balanced_journal_transaction().',
    );
  }

  // Append-only and double-entry balance trigger integrity
  if (!inspection.triggerIntegrity.journalTransactionAppendOnly) {
    violations.push('Missing/disabled trigger trg_journal_transaction_append_only.');
  }
  if (!inspection.triggerIntegrity.journalEntryAppendOnly) {
    violations.push('Missing/disabled trigger trg_journal_entry_append_only.');
  }
  if (!inspection.triggerIntegrity.auditEventAppendOnly) {
    violations.push('Missing/disabled trigger trg_audit_event_append_only.');
  }
  if (!inspection.triggerIntegrity.bootstrapStateAppendOnly) {
    violations.push('Missing/disabled trigger trg_bootstrap_state_append_only.');
  }
  if (!inspection.triggerIntegrity.verifyBalancedJournal) {
    violations.push(
      'Missing/disabled trigger trg_verify_balanced_journal_transaction.',
    );
  }
  if (!inspection.triggerIntegrity.verifyBalancedJournalSearchPathHardened) {
    violations.push(
      'Function verify_balanced_journal_transaction() must remain SECURITY INVOKER with public."JournalEntry" and SET search_path = pg_catalog, public.',
    );
  }

  // Untrusted roles (PUBLIC, anon, authenticated) must have zero object privileges
  const exposureViolations = collectUntrustedExposureWarnings(inspection);
  violations.push(...exposureViolations);

  if (violations.length > 0) {
    throw new ForbiddenError(
      `Database runtime hardening check failed for "${inspection.currentUser}": ${violations.join('; ')}`,
      'DB_HARDENING_VIOLATION',
    );
  }

  return {
    currentUser: inspection.currentUser,
    roleVerified: true,
    triggersVerified: true,
    sequenceCount: inspection.sequenceCount,
    checkedUntrustedRoles: inspection.untrustedRoleExposures
      .filter((r) => r.exists)
      .map((r) => r.role),
  };
}

export async function runFirstAdminBootstrap(
  repository: BootstrapRepository,
  rawInput: BootstrapInput,
): Promise<BootstrapResult> {
  const parsed = bootstrapInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid bootstrap configuration: ${issues}`);
  }

  if (rawInput.expectedBootstrapSecret !== undefined) {
    const providedBuf = Buffer.from(parsed.data.bootstrapSecret, 'utf8');
    const expectedBuf = Buffer.from(rawInput.expectedBootstrapSecret, 'utf8');
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new ForbiddenError(
        'Bootstrap secret verification failed',
        'INVALID_BOOTSTRAP_SECRET',
      );
    }
  }

  const inspection = await repository.inspectDbPrivileges();
  const dbRoleSummary = verifyBootstrapDbPermissions(inspection);

  const passwordHash = await hashPassword(parsed.data.password);
  const requestId = `cli-bootstrap-${crypto.randomUUID()}`;

  return repository.runInTransaction(async (tx) => {
    const existingMarker = await tx.findBootstrapState(BOOTSTRAP_MARKER_ID);
    const superAdmins = await tx.findSuperAdmins();
    const existingByEmail = await tx.findUserByEmail(parsed.data.email);

    if (existingMarker) {
      if (
        existingByEmail &&
        existingByEmail.id === existingMarker.adminUserId &&
        existingByEmail.role === UserRole.SUPER_ADMIN
      ) {
        return {
          status: 'already_bootstrapped' as const,
          adminUser: toPublicUserSummary(existingByEmail),
          auditEventId: null,
          dbRoleSummary,
        };
      }

      throw new ConflictError(
        'Initial SUPER_ADMIN bootstrap already completed for another identity; refusing to create a second administrator.',
        'BOOTSTRAP_ALREADY_COMPLETED',
      );
    }

    if (superAdmins.length > 0) {
      throw new ConflictError(
        'A SUPER_ADMIN user already exists without a bootstrap marker; refusing to bootstrap another.',
        'SUPER_ADMIN_ALREADY_EXISTS',
      );
    }

    if (existingByEmail) {
      throw new ConflictError(
        'Target bootstrap email already exists with a non-SUPER_ADMIN account.',
        'EMAIL_CONFLICT',
      );
    }

    const adminUser = await tx.createSuperAdmin({
      email: parsed.data.email,
      fullName: parsed.data.fullName,
      passwordHash,
    });

    await tx.createBootstrapState({
      id: BOOTSTRAP_MARKER_ID,
      adminUserId: adminUser.id,
      note: 'Controlled one-time CLI SUPER_ADMIN bootstrap',
    });

    const audit = await tx.createAuditEvent({
      actorUserId: null,
      actorType: ActorType.SYSTEM,
      action: 'ADMIN_BOOTSTRAP_COMPLETED',
      entityType: 'User',
      entityId: adminUser.id,
      requestId,
      reason: 'Controlled one-time CLI SUPER_ADMIN bootstrap',
      afterState: {
        email: adminUser.email,
        role: adminUser.role,
        status: adminUser.status,
        bootstrapMarkerId: BOOTSTRAP_MARKER_ID,
      },
    });

    return {
      status: 'created' as const,
      adminUser: toPublicUserSummary(adminUser),
      auditEventId: audit.id,
      dbRoleSummary,
    };
  });
}
