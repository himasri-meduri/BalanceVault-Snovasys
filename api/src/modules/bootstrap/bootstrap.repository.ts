import {
  ActorType,
  Prisma,
  UserRole,
  UserStatus,
  type PrismaClient,
} from '@prisma/client';
import type { CreateAuditEventInput } from '../audit/audit.types.js';
import type { UserRecord } from '../auth/auth.types.js';

export interface RoleExposureSummary {
  role: 'PUBLIC' | 'anon' | 'authenticated';
  exists: boolean;
  tablesWithPrivileges: string[];
  sequencesWithPrivileges: string[];
  preventAppendOnlyExecute: boolean;
  verifyBalancedJournalExecute: boolean;
}

export interface DbPrivilegeInspection {
  currentUser: string;
  sessionUser: string;
  roleInfo: {
    rolname: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
    rolinherit: boolean;
  } | null;
  memberships: Array<{ roleName: string; adminOption: boolean }>;
  tablePrivileges: {
    userSelect: boolean;
    userInsert: boolean;
    userUpdate: boolean;
    userDelete: boolean;
    sessionSelect: boolean;
    sessionInsert: boolean;
    sessionUpdate: boolean;
    sessionDelete: boolean;
    onboardingSelect: boolean;
    onboardingInsert: boolean;
    onboardingUpdate: boolean;
    onboardingDelete: boolean;
    accountSelect: boolean;
    accountInsert: boolean;
    accountUpdate: boolean;
    accountDelete: boolean;
    journalTransactionSelect: boolean;
    journalTransactionInsert: boolean;
    journalTransactionUpdate: boolean;
    journalTransactionDelete: boolean;
    journalEntrySelect: boolean;
    journalEntryInsert: boolean;
    journalEntryUpdate: boolean;
    journalEntryDelete: boolean;
    idempotencySelect: boolean;
    idempotencyInsert: boolean;
    idempotencyUpdate: boolean;
    idempotencyDelete: boolean;
    auditSelect: boolean;
    auditInsert: boolean;
    auditUpdate: boolean;
    auditDelete: boolean;
    bootstrapSelect: boolean;
    bootstrapInsert: boolean;
    bootstrapUpdate: boolean;
    bootstrapDelete: boolean;
    prismaMigrationsAny: boolean;
  };
  functionPrivileges: {
    preventAppendOnlyExecute: boolean;
    verifyBalancedJournalExecute: boolean;
  };
  triggerIntegrity: {
    journalTransactionAppendOnly: boolean;
    journalEntryAppendOnly: boolean;
    auditEventAppendOnly: boolean;
    bootstrapStateAppendOnly: boolean;
    verifyBalancedJournal: boolean;
    verifyBalancedJournalSearchPathHardened: boolean;
  };
  sequenceCount: number;
  excessTablePrivileges: Array<{ tableName: string; privilegeType: string }>;
  untrustedRoleExposures: RoleExposureSummary[];
}

export interface BootstrapMarkerRecord {
  id: string;
  completedAt: Date;
  adminUserId: string;
  note: string;
}

export interface BootstrapTxContext {
  findBootstrapState(id: string): Promise<BootstrapMarkerRecord | null>;
  findSuperAdmins(): Promise<UserRecord[]>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  createSuperAdmin(params: {
    email: string;
    fullName: string;
    passwordHash: string;
  }): Promise<UserRecord>;
  createBootstrapState(params: {
    id: string;
    adminUserId: string;
    note: string;
  }): Promise<BootstrapMarkerRecord>;
  createAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }>;
}

export interface BootstrapRepository {
  inspectDbPrivileges(): Promise<DbPrivilegeInspection>;
  runInTransaction<T>(fn: (tx: BootstrapTxContext) => Promise<T>): Promise<T>;
}

class PrismaBootstrapTxContext implements BootstrapTxContext {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  findBootstrapState(id: string): Promise<BootstrapMarkerRecord | null> {
    return this.tx.systemBootstrapState.findUnique({ where: { id } });
  }

  async findSuperAdmins(): Promise<UserRecord[]> {
    const users = await this.tx.user.findMany({
      where: { role: UserRole.SUPER_ADMIN },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return users.map((u) => ({
      ...u,
      onboardingStatus: u.onboardingApplication?.status ?? null,
    }));
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = await this.tx.user.findUnique({
      where: { email },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return user
      ? { ...user, onboardingStatus: user.onboardingApplication?.status ?? null }
      : null;
  }

  async createSuperAdmin(params: {
    email: string;
    fullName: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    const user = await this.tx.user.create({
      data: {
        email: params.email,
        fullName: params.fullName,
        passwordHash: params.passwordHash,
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      include: { onboardingApplication: { select: { status: true } } },
    });
    return { ...user, onboardingStatus: user.onboardingApplication?.status ?? null };
  }

  createBootstrapState(params: {
    id: string;
    adminUserId: string;
    note: string;
  }): Promise<BootstrapMarkerRecord> {
    return this.tx.systemBootstrapState.create({ data: params });
  }

  async createAuditEvent(input: CreateAuditEventInput): Promise<{ id: string }> {
    return this.tx.auditEvent.create({
      data: {
        actorUserId: input.actorUserId,
        actorType: input.actorType ?? ActorType.SYSTEM,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        requestId: input.requestId,
        reason: input.reason ?? null,
        beforeState: (input.beforeState ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        afterState: (input.afterState ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        ipHash: input.ipHash ?? null,
      },
      select: { id: true },
    });
  }
}

export class PrismaBootstrapRepository implements BootstrapRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async inspectDbPrivileges(): Promise<DbPrivilegeInspection> {
    const [identity] = await this.prisma.$queryRaw<
      Array<{ current_user: string; session_user: string }>
    >`SELECT current_user, session_user`;

    const currentUser = identity?.current_user ?? 'unknown';
    const sessionUser = identity?.session_user ?? 'unknown';

    const [roleInfo] = await this.prisma.$queryRaw<
      Array<{
        rolname: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolinherit: boolean;
      }>
    >`
      SELECT
        rolname,
        rolsuper,
        rolcreaterole,
        rolcreatedb,
        rolreplication,
        rolbypassrls,
        rolcanlogin,
        rolinherit
      FROM pg_roles
      WHERE rolname = current_user
    `;

    const memberships = await this.prisma.$queryRaw<
      Array<{ roleName: string; adminOption: boolean }>
    >`
      SELECT
        r.rolname AS "roleName",
        COALESCE(bool_or(am.admin_option), false) AS "adminOption"
      FROM pg_roles r
      LEFT JOIN pg_roles m ON m.rolname = current_user
      LEFT JOIN pg_auth_members am ON am.roleid = r.oid AND am.member = m.oid
      WHERE r.rolname <> current_user
        AND (
          am.roleid IS NOT NULL
          OR pg_has_role(current_user, r.oid, 'MEMBER')
          OR pg_has_role(current_user, r.oid, 'USAGE')
        )
      GROUP BY r.rolname
      ORDER BY r.rolname
    `;

    const [privs] = await this.prisma.$queryRaw<
      Array<{
        userSelect: boolean;
        userInsert: boolean;
        userUpdate: boolean;
        userDelete: boolean;
        sessionSelect: boolean;
        sessionInsert: boolean;
        sessionUpdate: boolean;
        sessionDelete: boolean;
        onboardingSelect: boolean;
        onboardingInsert: boolean;
        onboardingUpdate: boolean;
        onboardingDelete: boolean;
        accountSelect: boolean;
        accountInsert: boolean;
        accountUpdate: boolean;
        accountDelete: boolean;
        journalTransactionSelect: boolean;
        journalTransactionInsert: boolean;
        journalTransactionUpdate: boolean;
        journalTransactionDelete: boolean;
        journalEntrySelect: boolean;
        journalEntryInsert: boolean;
        journalEntryUpdate: boolean;
        journalEntryDelete: boolean;
        idempotencySelect: boolean;
        idempotencyInsert: boolean;
        idempotencyUpdate: boolean;
        idempotencyDelete: boolean;
        auditSelect: boolean;
        auditInsert: boolean;
        auditUpdate: boolean;
        auditDelete: boolean;
        bootstrapSelect: boolean;
        bootstrapInsert: boolean;
        bootstrapUpdate: boolean;
        bootstrapDelete: boolean;
        prismaMigrationsAny: boolean;
        preventAppendOnlyExecute: boolean;
        verifyBalancedJournalExecute: boolean;
        sequenceCount: number;
      }>
    >`
      SELECT
        has_table_privilege(current_user, 'public."User"', 'SELECT') AS "userSelect",
        has_table_privilege(current_user, 'public."User"', 'INSERT') AS "userInsert",
        has_table_privilege(current_user, 'public."User"', 'UPDATE') AS "userUpdate",
        has_table_privilege(current_user, 'public."User"', 'DELETE') AS "userDelete",
        has_table_privilege(current_user, 'public."Session"', 'SELECT') AS "sessionSelect",
        has_table_privilege(current_user, 'public."Session"', 'INSERT') AS "sessionInsert",
        has_table_privilege(current_user, 'public."Session"', 'UPDATE') AS "sessionUpdate",
        has_table_privilege(current_user, 'public."Session"', 'DELETE') AS "sessionDelete",
        has_table_privilege(current_user, 'public."OnboardingApplication"', 'SELECT') AS "onboardingSelect",
        has_table_privilege(current_user, 'public."OnboardingApplication"', 'INSERT') AS "onboardingInsert",
        has_table_privilege(current_user, 'public."OnboardingApplication"', 'UPDATE') AS "onboardingUpdate",
        has_table_privilege(current_user, 'public."OnboardingApplication"', 'DELETE') AS "onboardingDelete",
        has_table_privilege(current_user, 'public."Account"', 'SELECT') AS "accountSelect",
        has_table_privilege(current_user, 'public."Account"', 'INSERT') AS "accountInsert",
        has_table_privilege(current_user, 'public."Account"', 'UPDATE') AS "accountUpdate",
        has_table_privilege(current_user, 'public."Account"', 'DELETE') AS "accountDelete",
        has_table_privilege(current_user, 'public."JournalTransaction"', 'SELECT') AS "journalTransactionSelect",
        has_table_privilege(current_user, 'public."JournalTransaction"', 'INSERT') AS "journalTransactionInsert",
        has_table_privilege(current_user, 'public."JournalTransaction"', 'UPDATE') AS "journalTransactionUpdate",
        has_table_privilege(current_user, 'public."JournalTransaction"', 'DELETE') AS "journalTransactionDelete",
        has_table_privilege(current_user, 'public."JournalEntry"', 'SELECT') AS "journalEntrySelect",
        has_table_privilege(current_user, 'public."JournalEntry"', 'INSERT') AS "journalEntryInsert",
        has_table_privilege(current_user, 'public."JournalEntry"', 'UPDATE') AS "journalEntryUpdate",
        has_table_privilege(current_user, 'public."JournalEntry"', 'DELETE') AS "journalEntryDelete",
        has_table_privilege(current_user, 'public."IdempotencyRecord"', 'SELECT') AS "idempotencySelect",
        has_table_privilege(current_user, 'public."IdempotencyRecord"', 'INSERT') AS "idempotencyInsert",
        has_table_privilege(current_user, 'public."IdempotencyRecord"', 'UPDATE') AS "idempotencyUpdate",
        has_table_privilege(current_user, 'public."IdempotencyRecord"', 'DELETE') AS "idempotencyDelete",
        has_table_privilege(current_user, 'public."AuditEvent"', 'SELECT') AS "auditSelect",
        has_table_privilege(current_user, 'public."AuditEvent"', 'INSERT') AS "auditInsert",
        has_table_privilege(current_user, 'public."AuditEvent"', 'UPDATE') AS "auditUpdate",
        has_table_privilege(current_user, 'public."AuditEvent"', 'DELETE') AS "auditDelete",
        has_table_privilege(current_user, 'public."SystemBootstrapState"', 'SELECT') AS "bootstrapSelect",
        has_table_privilege(current_user, 'public."SystemBootstrapState"', 'INSERT') AS "bootstrapInsert",
        has_table_privilege(current_user, 'public."SystemBootstrapState"', 'UPDATE') AS "bootstrapUpdate",
        has_table_privilege(current_user, 'public."SystemBootstrapState"', 'DELETE') AS "bootstrapDelete",
        CASE WHEN to_regclass('public."_prisma_migrations"') IS NULL THEN false
             ELSE (
               has_table_privilege(current_user, 'public."_prisma_migrations"', 'SELECT')
               OR has_table_privilege(current_user, 'public."_prisma_migrations"', 'INSERT')
               OR has_table_privilege(current_user, 'public."_prisma_migrations"', 'UPDATE')
               OR has_table_privilege(current_user, 'public."_prisma_migrations"', 'DELETE')
               OR has_table_privilege(current_user, 'public."_prisma_migrations"', 'TRUNCATE')
               OR has_table_privilege(current_user, 'public."_prisma_migrations"', 'REFERENCES')
               OR has_table_privilege(current_user, 'public."_prisma_migrations"', 'TRIGGER')
               OR EXISTS (
                 SELECT 1
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
                 WHERE n.nspname = 'public'
                   AND c.relname = '_prisma_migrations'
                   AND CASE
                     WHEN acl.grantee = 0 THEN true
                     ELSE pg_has_role(current_user, acl.grantee, 'USAGE')
                   END
               )
             )
        END AS "prismaMigrationsAny",
        CASE WHEN to_regprocedure('public.prevent_append_only_mutation()') IS NULL THEN false
             ELSE has_function_privilege(current_user, 'public.prevent_append_only_mutation()', 'EXECUTE')
        END AS "preventAppendOnlyExecute",
        CASE WHEN to_regprocedure('public.verify_balanced_journal_transaction()') IS NULL THEN false
             ELSE has_function_privilege(current_user, 'public.verify_balanced_journal_transaction()', 'EXECUTE')
        END AS "verifyBalancedJournalExecute",
        (
          SELECT COUNT(*)::int
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'S'
        ) AS "sequenceCount"
    `;

    const triggerRows = await this.prisma.$queryRaw<
      Array<{
        tableName: string;
        triggerName: string;
        triggerState: string;
        deferrable: boolean;
        initiallyDeferred: boolean;
        triggerFunction: string;
        securityDefiner: boolean;
        functionSource: string;
        functionConfig: string[];
      }>
    >`
      SELECT
        c.relname AS "tableName",
        tg.tgname AS "triggerName",
        tg.tgenabled::text AS "triggerState",
        tg.tgdeferrable AS "deferrable",
        tg.tginitdeferred AS "initiallyDeferred",
        p.proname AS "triggerFunction",
        p.prosecdef AS "securityDefiner",
        p.prosrc AS "functionSource",
        COALESCE(p.proconfig, ARRAY[]::text[]) AS "functionConfig"
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE n.nspname = 'public'
        AND NOT tg.tgisinternal
    `;

    const hasActiveTrigger = (tableName: string, triggerName: string, fnName: string) =>
      triggerRows.some(
        (row) =>
          row.tableName === tableName &&
          row.triggerName === triggerName &&
          row.triggerFunction === fnName &&
          row.triggerState !== 'D',
      );

    const balanceTriggerRow = triggerRows.find(
      (row) =>
        row.tableName === 'JournalEntry' &&
        row.triggerName === 'trg_verify_balanced_journal_transaction' &&
        row.triggerFunction === 'verify_balanced_journal_transaction' &&
        row.triggerState !== 'D',
    );
    const verifyBalancedJournalSearchPathHardened = Boolean(
      balanceTriggerRow &&
        balanceTriggerRow.deferrable &&
        balanceTriggerRow.initiallyDeferred &&
        !balanceTriggerRow.securityDefiner &&
        /FROM\s+public\."JournalEntry"/.test(balanceTriggerRow.functionSource) &&
        balanceTriggerRow.functionConfig.some((cfg) =>
          /^search_path=("?pg_catalog"?,\s*"?public"?)$/.test(cfg),
        ),
    );

    const untrustedRoleExposures = await this.prisma.$queryRaw<RoleExposureSummary[]>`
      WITH target_roles AS (
        SELECT
          r AS role_name,
          (r = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles p WHERE p.rolname = r)) AS role_exists
        FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated']) AS r
      ),
      app_tables AS (
        SELECT
          c.relname AS table_name,
          c.relowner,
          c.relacl,
          format('%I.%I', 'public', c.relname) AS fq_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND c.relname = ANY(ARRAY[
            'User', 'Session', 'OnboardingApplication', 'Account',
            'JournalTransaction', 'JournalEntry', 'IdempotencyRecord',
            'AuditEvent', 'SystemBootstrapState', '_prisma_migrations'
          ])
      ),
      app_sequences AS (
        SELECT
          c.relname AS seq_name,
          c.relowner,
          c.relacl,
          format('%I.%I', 'public', c.relname) AS fq_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'S'
      )
      SELECT
        tr.role_name AS "role",
        tr.role_exists AS "exists",
        COALESCE(ARRAY(
          SELECT t.table_name
          FROM app_tables t
          WHERE CASE
            WHEN NOT tr.role_exists THEN false
            WHEN tr.role_name = 'PUBLIC' THEN EXISTS (
              SELECT 1
              FROM aclexplode(COALESCE(t.relacl, acldefault('r', t.relowner))) AS acl
              WHERE acl.grantee = 0
            )
            ELSE (
              has_table_privilege(tr.role_name, t.fq_name, 'SELECT')
              OR has_table_privilege(tr.role_name, t.fq_name, 'INSERT')
              OR has_table_privilege(tr.role_name, t.fq_name, 'UPDATE')
              OR has_table_privilege(tr.role_name, t.fq_name, 'DELETE')
              OR has_table_privilege(tr.role_name, t.fq_name, 'TRUNCATE')
              OR has_table_privilege(tr.role_name, t.fq_name, 'REFERENCES')
              OR has_table_privilege(tr.role_name, t.fq_name, 'TRIGGER')
              OR EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(t.relacl, acldefault('r', t.relowner))) AS acl
                WHERE CASE
                  WHEN acl.grantee = 0 THEN true
                  ELSE pg_has_role(tr.role_name, acl.grantee, 'USAGE')
                END
              )
            )
          END
          ORDER BY t.table_name
        ), ARRAY[]::text[]) AS "tablesWithPrivileges",
        COALESCE(ARRAY(
          SELECT s.seq_name
          FROM app_sequences s
          WHERE CASE
            WHEN NOT tr.role_exists THEN false
            WHEN tr.role_name = 'PUBLIC' THEN EXISTS (
              SELECT 1
              FROM aclexplode(COALESCE(s.relacl, acldefault('S', s.relowner))) AS acl
              WHERE acl.grantee = 0
            )
            ELSE (
              has_sequence_privilege(tr.role_name, s.fq_name, 'USAGE')
              OR has_sequence_privilege(tr.role_name, s.fq_name, 'SELECT')
              OR has_sequence_privilege(tr.role_name, s.fq_name, 'UPDATE')
            )
          END
          ORDER BY s.seq_name
        ), ARRAY[]::text[]) AS "sequencesWithPrivileges",
        CASE
          WHEN NOT tr.role_exists OR to_regprocedure('public.prevent_append_only_mutation()') IS NULL THEN false
          WHEN tr.role_name = 'PUBLIC' THEN EXISTS (
            SELECT 1
            FROM pg_proc p
            CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
            WHERE p.oid = to_regprocedure('public.prevent_append_only_mutation()')
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
          )
          ELSE has_function_privilege(
            tr.role_name,
            'public.prevent_append_only_mutation()',
            'EXECUTE'
          )
        END AS "preventAppendOnlyExecute",
        CASE
          WHEN NOT tr.role_exists OR to_regprocedure('public.verify_balanced_journal_transaction()') IS NULL THEN false
          WHEN tr.role_name = 'PUBLIC' THEN EXISTS (
            SELECT 1
            FROM pg_proc p
            CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
            WHERE p.oid = to_regprocedure('public.verify_balanced_journal_transaction()')
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
          )
          ELSE has_function_privilege(
            tr.role_name,
            'public.verify_balanced_journal_transaction()',
            'EXECUTE'
          )
        END AS "verifyBalancedJournalExecute"
      FROM target_roles tr
    `;

    const excessTablePrivileges = await this.prisma.$queryRaw<
      Array<{ tableName: string; privilegeType: string }>
    >`
      SELECT
        c.relname AS "tableName",
        acl.privilege_type AS "privilegeType"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND CASE
          WHEN acl.grantee = 0 THEN true
          ELSE pg_has_role(current_user, acl.grantee, 'USAGE')
        END
        AND (
          (
            c.relname = ANY(ARRAY[
              'User', 'OnboardingApplication', 'Account',
              'Session', 'IdempotencyRecord',
              'JournalTransaction', 'JournalEntry', 'AuditEvent',
              'SystemBootstrapState'
            ])
            AND acl.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
          )
          OR c.relname = '_prisma_migrations'
        )
      ORDER BY c.relname, acl.privilege_type
    `;

    return {
      currentUser,
      sessionUser,
      roleInfo: roleInfo ?? null,
      memberships,
      tablePrivileges: {
        userSelect: Boolean(privs?.userSelect),
        userInsert: Boolean(privs?.userInsert),
        userUpdate: Boolean(privs?.userUpdate),
        userDelete: Boolean(privs?.userDelete),
        sessionSelect: Boolean(privs?.sessionSelect),
        sessionInsert: Boolean(privs?.sessionInsert),
        sessionUpdate: Boolean(privs?.sessionUpdate),
        sessionDelete: Boolean(privs?.sessionDelete),
        onboardingSelect: Boolean(privs?.onboardingSelect),
        onboardingInsert: Boolean(privs?.onboardingInsert),
        onboardingUpdate: Boolean(privs?.onboardingUpdate),
        onboardingDelete: Boolean(privs?.onboardingDelete),
        accountSelect: Boolean(privs?.accountSelect),
        accountInsert: Boolean(privs?.accountInsert),
        accountUpdate: Boolean(privs?.accountUpdate),
        accountDelete: Boolean(privs?.accountDelete),
        journalTransactionSelect: Boolean(privs?.journalTransactionSelect),
        journalTransactionInsert: Boolean(privs?.journalTransactionInsert),
        journalTransactionUpdate: Boolean(privs?.journalTransactionUpdate),
        journalTransactionDelete: Boolean(privs?.journalTransactionDelete),
        journalEntrySelect: Boolean(privs?.journalEntrySelect),
        journalEntryInsert: Boolean(privs?.journalEntryInsert),
        journalEntryUpdate: Boolean(privs?.journalEntryUpdate),
        journalEntryDelete: Boolean(privs?.journalEntryDelete),
        idempotencySelect: Boolean(privs?.idempotencySelect),
        idempotencyInsert: Boolean(privs?.idempotencyInsert),
        idempotencyUpdate: Boolean(privs?.idempotencyUpdate),
        idempotencyDelete: Boolean(privs?.idempotencyDelete),
        auditSelect: Boolean(privs?.auditSelect),
        auditInsert: Boolean(privs?.auditInsert),
        auditUpdate: Boolean(privs?.auditUpdate),
        auditDelete: Boolean(privs?.auditDelete),
        bootstrapSelect: Boolean(privs?.bootstrapSelect),
        bootstrapInsert: Boolean(privs?.bootstrapInsert),
        bootstrapUpdate: Boolean(privs?.bootstrapUpdate),
        bootstrapDelete: Boolean(privs?.bootstrapDelete),
        prismaMigrationsAny: Boolean(privs?.prismaMigrationsAny),
      },
      functionPrivileges: {
        preventAppendOnlyExecute: Boolean(privs?.preventAppendOnlyExecute),
        verifyBalancedJournalExecute: Boolean(privs?.verifyBalancedJournalExecute),
      },
      triggerIntegrity: {
        journalTransactionAppendOnly: hasActiveTrigger(
          'JournalTransaction',
          'trg_journal_transaction_append_only',
          'prevent_append_only_mutation',
        ),
        journalEntryAppendOnly: hasActiveTrigger(
          'JournalEntry',
          'trg_journal_entry_append_only',
          'prevent_append_only_mutation',
        ),
        auditEventAppendOnly: hasActiveTrigger(
          'AuditEvent',
          'trg_audit_event_append_only',
          'prevent_append_only_mutation',
        ),
        bootstrapStateAppendOnly: hasActiveTrigger(
          'SystemBootstrapState',
          'trg_bootstrap_state_append_only',
          'prevent_append_only_mutation',
        ),
        verifyBalancedJournal: hasActiveTrigger(
          'JournalEntry',
          'trg_verify_balanced_journal_transaction',
          'verify_balanced_journal_transaction',
        ),
        verifyBalancedJournalSearchPathHardened,
      },
      sequenceCount: privs?.sequenceCount ?? 0,
      excessTablePrivileges,
      untrustedRoleExposures,
    };
  }

  runInTransaction<T>(fn: (tx: BootstrapTxContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (tx) => fn(new PrismaBootstrapTxContext(tx)),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
