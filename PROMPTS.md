# BalanceVault — Development Prompt & Decision Log

This log records genuine engineering prompts, architectural decisions, security checks, and implementation milestones across the development of BalanceVault. GitHub commit links will be added after pushing to the public repository; local commit hashes recorded below reflect actual local commits on `main`.

---

## Entry 1 — 2026-11-11 (Phase 1: Repository Reconnaissance & Gap Analysis)

**Focus:** Inspect repository truth before writing code; identify missing codebase and runtime dependencies.

**Prompt Summary:**
- Inspected all starter documentation files (`MASTER_PROMPT.md`, `ANTIGRAVITY_INSTRUCTIONS.md`, `PRODUCT_REQUIREMENTS.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `API_CONTRACT.md`, `RBAC_SECURITY.md`, `WORKFLOWS.md`, `TEST_PLAN.md`, `BUILD_PLAN.md`, `DECISIONS.md`, `.env.example`).
- Verified actual workspace state on Windows: no application source code, `package.json`, Prisma schema, migrations, or deployment manifests existed yet.
- Recorded baseline runtime findings and feature gap matrix in `docs/IMPLEMENTATION_STATUS.md`.

**Local Commit:** `2742e53` (`docs: initialize BalanceVault specifications`)

---

## Entry 2 — 2026-11-11 (Foundation: Windows/Managed-Service Workspaces, Schema, Least-Privilege DB Roles & Health/Readiness)

**Focus:** Scaffold npm workspaces (`apps/api`, `apps/web`), PostgreSQL/Prisma schema with append-only and balance-invariant enforcement, Redis rate-limit middleware foundation, and health/readiness probes without Docker.

**Prompt Summary:**
- Corrected environment strategy for local Windows development using managed PostgreSQL and Redis via environment variables (no Docker/Docker Compose dependency).
- Designed `prisma/schema.prisma` and initial SQL migration (`prisma/migrations/20261111000000_init/migration.sql`) including `BIGINT` minor-unit money, PostgreSQL append-only triggers (`prevent_append_only_mutation`), and a deferred `CONSTRAINT TRIGGER` (`verify_balanced_journal_transaction`).
- Added non-destructive DB role inspection (`prisma/sql/00_inspect_roles.sql`, `scripts/inspect-db-roles.mjs`), least-privilege `app_runtime` SQL template (`prisma/sql/01_setup_runtime_role.sql`), and `scripts/run-prisma-migrate.mjs`.
- Built Express foundation + Vite React TypeScript shell (`14` API tests and `3` Web tests passing locally).

**Local Commits:** `b2e591b`, `302afb3`, `838894b`, `15438b7`, `d4dedac`

---

## Entry 3 — 2026-11-11 (Phase 2 — Authorization, Sessions, CSRF & Access Control)

**Prompt Given:**
Implement secure Phase 2 authentication, database-backed opaque sessions, CSRF protection, RBAC authorization middleware, and audit logging (`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, plus RBAC-protected admin endpoints) without modifying existing Phase 1 migrations.

**Implementation & Security Decisions:**
- Password hashing uses Argon2id (`memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`) via `apps/api/src/modules/auth/auth.crypto.ts`, with password complexity enforcement and dummy-hash verification on missing email to reduce timing side channels.
- `POST /api/auth/register` validates inputs with strict Zod schema (`.strict()`, rejecting unexpected `role` fields) and atomically creates a `User` (`role: CUSTOMER` hardcoded server-side), `OnboardingApplication` (`PENDING`), opaque `Session` (HMAC-SHA256 hashed token stored in DB, raw token only in `HttpOnly` `bv_sid` cookie), and `AUTH_REGISTER` `AuditEvent`.
- `POST /api/auth/login` rotates any prior session cookie token hash (`revokedAt = now`), checks `UserStatus === ACTIVE`, enforces generic `401` errors on bad credentials or disabled/locked status, and records audit events without passwords or hashes.
- `createAuthenticateMiddleware` runs strictly before `createCsrfMiddleware` and `requireRole`; sessions enforce both absolute (`SESSION_TTL_HOURS`) and idle (`SESSION_IDLE_MINUTES`) expiration, and disablement revokes active sessions immediately.
- `createCsrfMiddleware` verifies `Origin === APP_ORIGIN` (when present) and timing-safe HMAC signature of `X-CSRF-Token` cryptographically bound to `req.auth.sessionId`.

**Actual Tool Output & Corrections During Verification:**
1. Initial `npm run typecheck` failed (`exit code 2`) with:
   - `src/middleware/rateLimit.ts` vs `src/server.ts(27,52)` `TS2345`: `ioredis` `Redis.eval` expects `(script: string | Buffer, numkeys: number, ...)` rather than generic `(...args: Array<string | number>)`.
   - `tests/helpers/inMemoryStore.ts(227,9)` `TS2322`: `AuthTxContext.createAuditEvent` returned `Promise<void>` while `BootstrapTxContext.createAuditEvent` returned `Promise<{ id: string }>`.
   - `tests/bootstrap.test.ts(136,72)` `TS2769`: Supertest `.set('Cookie', ...)` rejected `string | string[] | undefined`.
   - **Corrections:** Updated `IoredisRateLimitStore` constructor type signature to match `ioredis` `eval(script: string, numkeys: number, ...)`, unified `AuthTxContext.createAuditEvent` to return `Promise<{ id: string }>`, and normalized `set-cookie` header to `string[]` in tests.
2. Initial `npm run test` (`apps/api`) failed 2 of 32 tests in `tests/bootstrap.test.ts`:
   - `POST /api/admin/bootstrap` returned `401` instead of `404` because `createAdminRouter` mounted `router.use(deps.requireAuth)` globally on `/api/admin`, intercepting unknown `/api/admin/*` paths before Express's 404 handler.
   - `GET /api/admin/audit-events` returned `AUTH_LOGIN_SUCCESS` at `items[0]` instead of `ADMIN_BOOTSTRAP_COMPLETED` because the super-admin login occurred after bootstrap and audit events are sorted descending by timestamp.
   - **Corrections:** Moved `deps.requireAuth` onto each explicit route in `apps/api/src/modules/admin/admin.routes.ts` so nonexistent `/api/admin/bootstrap` returns `404` while real admin routes enforce `requireAuth` -> `requireRole`, and updated the test query to filter `?action=ADMIN_BOOTSTRAP_COMPLETED`.

**Relevant Local Commit:** `0423a2d` (`feat(auth): implement Argon2id auth, opaque DB sessions, CSRF, RBAC, and audit service`)

---

## Entry 4 — 2026-11-11 (Phase 2 — Out-of-Band CLI `SUPER_ADMIN` Bootstrap & Authorization Tests)

**Prompt Given:**
Implement a CLI-only idempotent first `SUPER_ADMIN` bootstrap script (`npm run bootstrap:admin`) with DB privilege verification (without broadening database privileges), audit logging, and all 16 authorization, session, CSRF, and bootstrap tests.

**Actual Tool Output & Notes:**
- After applying the corrections in Entry 3, `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` all exited `0`:
  - `@balancevault/api`: `7 test files passed (32 tests passed)` covering Argon2id crypto, all 16 required auth/RBAC/CSRF/bootstrap tests, rate limiting, and health/readiness.
  - `@balancevault/web`: `2 test files passed (3 tests passed)`.
- `npm run bootstrap:admin` without `.env` exited `1` with `Missing DATABASE_URL in environment/.env.` without printing any secrets.
- `npm run test:integration` exited `1` (`Integration tests blocked: DATABASE_URL and REDIS_URL must be configured in .env or process environment.`), confirming live PostgreSQL and Redis tests remain honestly blocked until `.env` credentials are supplied.

**Relevant Local Commits:**
- `d55fa24` (`feat(bootstrap): add CLI-only idempotent SUPER_ADMIN bootstrap and DB privilege checks`)
- `15c5fd0` (`test(auth): add auth, CSRF, RBAC, bootstrap, and integration tests`)
- `3a2c1bb` (`docs: document Phase 2 auth, RBAC, CSRF, and CLI bootstrap history and status`)

---

## Entry 5 — 2026-11-11 (Phase 3 — Customer Onboarding, Admin Review, IDOR Protection & Concurrency Control)

**Prompt Given:**
Implement customer onboarding (`GET /api/onboarding/me`, `PATCH /api/onboarding/me`, `POST /api/onboarding/me/submit`) and administrator review (`GET /api/admin/onboarding/applications`, `GET /api/admin/onboarding/applications/:id`, `POST /api/admin/onboarding/applications/:id/approve`, `POST /api/admin/onboarding/applications/:id/reject`), enforce RBAC/IDOR/CSRF/resubmission/audit rules without unnecessary schema migrations, prove all 12 security & workflow requirements with tests, and update documentation and local commits.

**Authorization, State-Machine & Integrity Decisions:**
- Reviewed `prisma/schema.prisma`, `API_CONTRACT.md`, `WORKFLOWS.md`, and `RBAC_SECURITY.md`: zero Prisma schema or SQL migration changes were needed because `OnboardingApplication` already models `DRAFT`, `PENDING`, `NEEDS_INFORMATION`, `APPROVED`, `REJECTED`, `submittedAt`, `reviewedAt`, `reviewedByUserId`, and `reviewReason`.
- **IDOR Prevention & Mass-Assignment Blocking:** Customer onboarding endpoints operate strictly on `/api/onboarding/me*` using `req.auth.userId` resolved from the verified session cookie. Strict Zod schemas (`.strict()`) reject unexpected identity/state fields (`userId`, `id`, `status`, `role`, `reviewedByUserId`) with `400 VALIDATION_ERROR`. Customer probes against `/api/admin/onboarding/*` hit `requireAuth` -> `requireRole(ADMIN, SUPER_ADMIN)` before `:id` parameter parsing, returning `403 FORBIDDEN` without leaking resource existence.
- **Explicit Resubmission & Immutable Approval:** `APPROVED` applications reject all `PATCH` and `POST /submit` requests (`409 ONBOARDING_ALREADY_APPROVED`). `REJECTED` applications reject implicit edits/submissions (`409 EXPLICIT_RESUBMISSION_REQUIRED`) unless the customer explicitly passes `reopenForResubmission: true` (`REJECTED -> DRAFT`) or `resubmit: true` (`REJECTED -> PENDING`). Submitted `PENDING` applications reject customer edits while under review (`409 ONBOARDING_ALREADY_SUBMITTED`).
- **Concurrency & Secret Redaction:** Admin reviews run inside a database transaction using conditional `updateMany` compare-and-swap (`updateByIdIfStatus`) plus same-transaction `AuditEvent` insertion, preventing conflicting parallel reviews (`409 INVALID_STATE_TRANSITION`). Customer and admin response serializers never select or emit `passwordHash`, session tokens, or internal hashes.

**Issues Found & Corrections Made:**
1. **Un-submitted Approval Edge Case:** Initially `approveApplication` checked `existing.status === OnboardingStatus.PENDING` without verifying that the customer had completed/submitted their profile and accepted synthetic terms (`submittedAt !== null && acceptedSyntheticTerms`).
   - **Correction:** Enforced `ONBOARDING_NOT_SUBMITTED` (`409`) check in `OnboardingService.approveApplication` and added `requireSubmitted: true` to `updateByIdIfStatus` (`submittedAt: { not: null }`, `acceptedSyntheticTerms: true`), plus `requireUnsubmittedWhenPending: true` for first-time edits/submissions.
2. **Defense-in-Depth Role Check on Admin Reads & Reopen Validation:** Added explicit `ADMIN`/`SUPER_ADMIN` role checks inside `listAdminApplications` and `getAdminApplicationById`, and rejected `reopenForResubmission` when the application is not `REJECTED`.
3. **In-Memory Transaction Mutex for Concurrent Test Correctness:** Without serialization in `InMemoryAuthAuditBootstrapStore.runInTransaction`, a losing concurrent `Promise.all` transaction could roll back to a pre-commit snapshot after a winning transaction committed.
   - **Correction:** Added an async transaction mutex (`withTxLock`) in `apps/api/tests/helpers/inMemoryStore.ts` AND added an explicit simulated `READ COMMITTED` stale-read repository race test inside `tests/onboarding.test.ts` #11 alongside HTTP `Promise.all([approve, reject])`.
4. **Actual Test Failure (`tests/onboarding.test.ts` #12 on initial run):** `vitest run` reported `42 passed | 1 failed` (`AssertionError` on audit action array: received `'ONBOARDING_SUBMITTED'` instead of `'ONBOARDING_RESUBMITTED'` after reopening `REJECTED -> DRAFT` via `PATCH /me` before calling `POST /me/submit`).
   - **Correction:** Updated `OnboardingService.submitOwnApplication` so `isResubmissionAudit` detects both direct `REJECTED -> PENDING` (`{ resubmit: true }`) and reopened `REJECTED -> DRAFT -> PENDING` (`existing.status === OnboardingStatus.DRAFT && existing.reviewReason !== null`), emitting `ONBOARDING_RESUBMITTED` consistently.

**Actual Verification Output (After Final Fix):**
- `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
- `npm run lint`: exited `0` (`eslint apps prisma scripts`).
- `npm run test`: exited `0` — `@balancevault/api`: **8 files / 43 tests passed** (including all 11 test blocks covering requirements 1–12 in `tests/onboarding.test.ts`); `@balancevault/web`: **2 files / 3 tests passed** (**46 tests passed total**).
- `npm run build`: exited `0` (`tsc` + `vite build`).
- `.env` / `DATABASE_URL` / `REDIS_URL` check: all `False` — live PostgreSQL/Redis integration tests (`tests/integration/auth.integration.test.ts` and `tests/integration/onboarding.integration.test.ts`) were not run and remain blocked until valid PostgreSQL and Redis credentials are configured.

**Relevant Local Commits:**
- `f3c27fe` (`feat(onboarding): implement customer onboarding and admin review API`)
- `f3b92ee` (`test(onboarding): add IDOR, RBAC, concurrency, and audit immutability tests`)
- `c54957e` (`docs: document Phase 3 onboarding, IDOR protection, and verification status`)

---

## Entry 6 — 2026-11-11 (Integration Verification Milestone — Onboarding State Consistency, Atomic Rollback & Environment Blocker Check)

**Prompt Given:**
Before Phase 4, run the Integration Verification Milestone: (1) inspect onboarding state consistency across registration, Prisma schema, onboarding service, and documented workflow without resetting existing DBs, verifying both `REJECTED` resubmission paths and atomic audit creation; (2) configure `.env` from `.env.example` for dev/test PostgreSQL and Redis without Docker; (3) run role inspection and migrations; (4) run `test:integration`, `typecheck`, `lint`, `test`, `build`; and (5) update docs & commit locally without pushing.

**Task 1 Onboarding State Audit & Hardening:**
- Audited `AuthService.registerCustomer` (`OnboardingStatus.PENDING`, `submittedAt: null`), `prisma/schema.prisma` (`@default(PENDING)`), `PRODUCT_REQUIREMENTS.md` ("New customer starts with status PENDING"), `WORKFLOWS.md` ("Customer sees PENDING onboarding state"), and `OnboardingService`.
- Confirmed there is no defect where registration `PENDING` blocks initial customer edits/submission: `OnboardingService` distinguishes unsubmitted `PENDING` (`submittedAt === null`) from submitted `PENDING` (`submittedAt !== null`), allowing `PATCH /api/onboarding/me` and `POST /api/onboarding/me/submit` immediately after registration while blocking edits after submission (`409 ONBOARDING_ALREADY_SUBMITTED`) and blocking admin approval before submission (`409 ONBOARDING_NOT_SUBMITTED`). Zero schema migration needed.
- Added test #13 and expanded test #8 in `apps/api/tests/onboarding.test.ts` to verify standalone `{ reopenForResubmission: true }` -> `DRAFT` edit -> `POST /me/submit`, direct `{ resubmit: true }`, and atomic transaction rollback if `createAuditEvent` throws mid-transaction.
- Expanded `apps/api/tests/integration/auth.integration.test.ts` and `apps/api/tests/integration/onboarding.integration.test.ts` with `NODE_ENV !== 'production'` safety guards, DB constraint/balance-trigger/append-only checks, HTTP + Redis rate-limit + session rotation tests, and full live resubmission + concurrency tests.

**Actual Tool Output, Errors & Corrections:**
1. **TypeScript Error on New Atomic Rollback Test:** Running `npm run typecheck` failed (`exit code 2`) with `tests/onboarding.test.ts(905,44): error TS7006: Parameter 'tx' implicitly has an 'any' type` because `InMemoryAuthAuditBootstrapStore.runInTransaction` is an overloaded union signature.
   - **Correction:** Added explicit `(tx: OnboardingTxContext)` annotation in `tests/onboarding.test.ts`, then re-ran `npm run typecheck` (`exit 0`).
2. **Offline Verification Suite (`exit 0`):**
   - `npm run typecheck`: `0` (`@balancevault/api` + `@balancevault/web`).
   - `npm run lint`: `0` (`eslint apps prisma scripts`).
   - `npm run test`: `0` — `@balancevault/api`: **8 files / 44 tests passed**; `@balancevault/web`: **2 files / 3 tests passed** (**47 tests total**).
   - `npm run build`: `0` (`tsc` + `vite build`).
3. **Environment & Live Service Blockers Verified:**
   - Windows inspection (`IS_ADMIN=False`) confirmed no native PostgreSQL or Redis/Memurai service/CLI is installed (`C:\Program Files\PostgreSQL` is `False`, ports `5432`/`6379` unused, `wsl --list --quiet` shows only `docker-desktop` which is forbidden by project policy), and `.env` / `DATABASE_URL` / `DIRECT_URL` / `REDIS_URL` are not present.
   - `npm run db:inspect-roles` -> `exit 1` (`Missing DIRECT_URL or DATABASE_URL in environment/.env.`).
   - `npm run prisma:migrate:deploy` -> `exit 1` (`Missing DIRECT_URL (preferred for migrations) or DATABASE_URL in environment/.env.`).
   - `npm run bootstrap:admin` -> `exit 1` (`Missing DATABASE_URL in environment/.env.`).
   - `npm run test:integration` -> `exit 1` (both `auth.integration.test.ts` and `onboarding.integration.test.ts` failed cleanly with `Integration tests blocked: DATABASE_URL and REDIS_URL must be configured in .env or process environment.`).

**Relevant Local Commits:**
- `5ee7764` (`test(verification): add atomic audit rollback, standalone reopen, and live DB/Redis integration checks`)
- `177f4ea` (`docs: record integration verification milestone results and live DB/Redis blockers`)

---

## Entry 7 — 2026-11-11 (Supabase Database Least-Privilege Hardening & Operator Connection Separation)

**Prompt Given:**
Review and harden `prisma/sql/00_inspect_roles.sql`, `prisma/sql/01_setup_runtime_role.sql`, `scripts/inspect-db-roles.mjs`, `scripts/run-prisma-migrate.mjs`, and `apps/api/src/scripts/bootstrap-admin.ts` for a fresh Supabase PostgreSQL deployment where `postgres` owns all Prisma-created tables and trigger functions (`prevent_append_only_mutation()`, `verify_balanced_journal_transaction()`), revoking broad `PUBLIC`, `anon`, and `authenticated` table, sequence, and function privileges, creating least-privilege `app_runtime` without hardcoded passwords, preserving triggers/ownership, separating migration/bootstrap (`DIRECT_URL`) from runtime (`DATABASE_URL`), keeping bootstrap permission checks free of privilege escalation, and adding full SQL/code tests.

**Authorization, Database Security & Supabase Decisions:**
- **Eliminated Password Literals in SQL:** Removed `CHANGE_ME` / password literals from [prisma/sql/01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql). Created `app_runtime` idempotently with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT` and null initial password; documented out-of-band password assignment via `psql "$DIRECT_URL" -c "\password app_runtime"` (or private SQL Editor session).
- **Revoked `PUBLIC`, `anon`, and `authenticated` Exposure:** Expanded [prisma/sql/01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql) to wipe all table (including PG 17 `MAINTAIN`) and sequence privileges on `public` across all 9 BalanceVault models and `_prisma_migrations`, revoke `EXECUTE` on both trigger functions (`prevent_append_only_mutation()` and `verify_balanced_journal_transaction()`) from `PUBLIC`, `anon`, `authenticated`, and `app_runtime`, conditionally revoke schema `public` `USAGE`/`CREATE` when owned/controlled by `current_user`, and configure migration-owner `ALTER DEFAULT PRIVILEGES` to start closed to untrusted roles.
- **Minimal `app_runtime` Grants & Sequence Verification:** Verified schema uses UUID/text primary keys (`0` sequences, `0` `IDENTITY` columns), granting zero sequence privileges. Granted `app_runtime` strictly `SELECT, INSERT, UPDATE` on `User`/`OnboardingApplication`/`Account`; `SELECT, INSERT, UPDATE, DELETE` on `Session`/`IdempotencyRecord`; `SELECT, INSERT` only on append-only `JournalTransaction`/`JournalEntry`/`AuditEvent`; `SELECT` only on `SystemBootstrapState`; and zero access to `_prisma_migrations`. Kept `postgres` ownership and all 5 enabled triggers untouched.
- **Migration & CLI Bootstrap Connection Separation:** Added [scripts/db-connection-utils.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/db-connection-utils.mjs), updated [scripts/run-prisma-migrate.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/run-prisma-migrate.mjs), [scripts/inspect-db-roles.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/inspect-db-roles.mjs), and `resolveOperatorDatabaseUrl` in [apps/api/src/modules/bootstrap/bootstrap.service.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.service.ts) to enforce direct/session `DIRECT_URL` (`port 5432`, no `?pgbouncer=true` or port `6543`), reject `app_runtime` fallback when `DIRECT_URL` is unset, and redact all credentials.
- **Trigger-Aware Bootstrap Checks & Hardening Verifier:** Updated [apps/api/src/modules/bootstrap/bootstrap.repository.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.repository.ts) and [apps/api/src/modules/bootstrap/bootstrap.service.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.service.ts) so `verifyBootstrapDbPermissions` checks active triggers via `pg_trigger` instead of requiring direct `EXECUTE` grants on `prevent_append_only_mutation()`, added `verifyRuntimeDbHardening` plus transactional `BEGIN ... ROLLBACK` SQL suite [prisma/sql/02_verify_hardening.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/02_verify_hardening.sql), and added live negative DML + balanced/unbalanced journal tests in [apps/api/tests/integration/auth.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/auth.integration.test.ts).

**Actual Tool Output, Errors & Corrections:**
1. **URI Fragment Test Failure in Initial `npm run test` (`scripts/db-connection-utils.test.mjs`):**
   - Test #2 used an unencoded `#` inside a synthetic test password string, causing `new URL()` to treat `@host:port/db` as a URL fragment and throw `DATABASE_URL is not a valid PostgreSQL connection URL`.
   - **Correction:** Replaced `#` in the valid-URL fixture with `!` and added an explicit test verifying malformed URLs redact all password/token fragments before throwing.
2. **Offline Verification Suite (`exit 0`):**
   - `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
   - `npm run lint`: exited `0` (`eslint apps prisma scripts`).
   - `npm run test`: exited `0` — `node --test scripts/*.test.mjs`: **2 passed**; `@balancevault/api`: **8 files / 46 tests passed** (`6` in `bootstrap.test.ts`); `@balancevault/web`: **2 files / 3 tests passed** (**51 tests total**).
   - `npm run build`: exited `0` (`tsc` + `vite build`).
3. **Read-Only Live Supabase Catalog Snapshot (No SQL Hardening or Mutations Executed):**
   - After local `.env` configuration was added by the user, read-only catalog inspection (`npm run db:inspect-roles`) on the fresh Supabase PostgreSQL 17.11 target (without printing credentials/hostnames and without executing `01_setup_runtime_role.sql` or altering any DB state) confirmed:
     - `active_role: postgres` (`rolsuper: false`, `rolcreaterole: true`, `rolcreatedb: true`, `rolbypassrls: true`), owner of all 10 tables and both trigger functions.
     - `public` schema owned by `pg_database_owner`; `pg_default_acl` contains defaults created by both `postgres` and `supabase_admin` (including PG 17 `MAINTAIN`).
     - `0` sequences and `0` `IDENTITY`/`nextval` columns; all 5 triggers active (`tgenabled = 'O'`).
     - Pre-hardening baseline: `app_runtime` does not exist yet and `PUBLIC`/`anon`/`authenticated` hold default privileges (`30` findings flagged cleanly by the strict auditor), ready for manual operator execution of [prisma/sql/01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql) and out-of-band password assignment.

**Relevant Local Commits:**
- `eab1f71` (`fix(db): enforce Supabase least-privilege SQL hardening and migration connection guards`)
- `c6e5d72` (`feat(bootstrap): align operator bootstrap checks and verify runtime DB hardening`)
- `73a4ea5` (`docs: document Supabase least-privilege DB hardening and audit findings`)

---

## Entry 8 — 2026-11-11 (Final SQL Verification Fix — `aclexplode` PUBLIC Checks, Individual Privilege Checks, Membership Isolation & Atomicity)

**Prompt Given:**
Apply the final SQL verification review fixes across [prisma/sql/00_inspect_roles.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/00_inspect_roles.sql), [prisma/sql/01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql), and [prisma/sql/02_verify_hardening.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/02_verify_hardening.sql): (1) never pass `'public'` as a role name to `has_*_privilege` — inspect explicit/default `PUBLIC` ACLs with `aclexplode` and check `anon`/`authenticated` separately including inherited `PUBLIC` grants; (2) replace comma-separated `has_*_privilege` privilege strings with individual single-privilege checks combined via `OR`/`AND`; (3) verify `app_runtime` keeps `NOINHERIT` and has zero memberships or privilege escalation paths (`pg_auth_members`, `pg_has_role`); (4) wrap setup SQL atomically and document Supabase/PostgreSQL transactional execution compatibility; (5) preserve schema, ownership, and append-only/trigger restrictions without executing SQL against Supabase; and (6) review for any other subtle syntax or rollback flaws, state PostgreSQL local syntax validation availability honestly, run offline checks, and update docs.

**SQL & Repository Corrections Applied:**
- **Eliminated Pseudo-Role `'public'` in `has_*_privilege` Calls:** Updated [prisma/sql/02_verify_hardening.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/02_verify_hardening.sql), [prisma/sql/00_inspect_roles.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/00_inspect_roles.sql), [scripts/inspect-db-roles.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/inspect-db-roles.mjs), and [apps/api/src/modules/bootstrap/bootstrap.repository.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.repository.ts) to inspect `PUBLIC` ACL entries (`acl.grantee = 0`) using `aclexplode(COALESCE(..., acldefault(...)))`, and evaluate `anon` and `authenticated` separately via `has_*_privilege` (which natively incorporates inherited `PUBLIC` grants and role memberships).
- **Eliminated Comma-Separated Privilege Strings & Added PG 17 `MAINTAIN` Checks:** Rewrote every `has_table_privilege`, `has_sequence_privilege`, and `has_function_privilege` assertion across `02_verify_hardening.sql` and `bootstrap.repository.ts` to check single privilege names joined by `OR`/`AND`, plus version-gated PG 17 `MAINTAIN` assertions inside `IF is_pg17 THEN` PL/pgSQL branches so PG 14–16 never eagerly evaluates `MAINTAIN`. Also guarded `pg_has_role` with `CASE WHEN acl.grantee = 0 THEN true` in `bootstrap.repository.ts` so `grantee = 0` (`InvalidOid`) is never passed to `pg_has_role`.
- **Runtime Role Membership & Escalation Proof:** Updated `01_setup_runtime_role.sql` to check `rolbypassrls` and revoke/reject any preexisting `pg_auth_members` entries for `app_runtime` inside the atomic transaction; updated `02_verify_hardening.sql` Section 1 to verify zero rows in `pg_auth_members` and check `pg_has_role('app_runtime', r.rolname, 'MEMBER' | 'USAGE' | 'SET')` against every non-`app_runtime` role; added live `SET LOCAL ROLE` negative tests in `auth.integration.test.ts` and `NOINHERIT` / platform-role membership tests in `bootstrap.test.ts`.
- **Execution Atomicity & Self-Rolling-Back Verification Subtransactions:** Wrapped all of `01_setup_runtime_role.sql` (`CREATE ROLE`, `ALTER ROLE`, `ALTER DEFAULT PRIVILEGES`, `REVOKE`, `GRANT`, `DO` blocks) in `BEGIN; ... COMMIT;` with `psql "$DIRECT_URL" -v ON_ERROR_STOP=1` and Supabase SQL Editor single-batch documentation. Reworked Sections 5 and 6 of `02_verify_hardening.sql` to use nested PL/pgSQL subtransactions (`BEGIN ... RAISE EXCEPTION USING ERRCODE = 'BV999'; EXCEPTION WHEN SQLSTATE 'BV999' THEN NULL; END;`) inside `BEGIN; ... ROLLBACK;` with `gen_random_uuid()` temp data covering all 4 append-only triggers (`AuditEvent`, `SystemBootstrapState`, `JournalTransaction`, `JournalEntry`), deferred journal checks, and `SET LOCAL ROLE app_runtime` rollback restoration.

**Actual Tool Output & Constraints Disclosed:**
- Local PostgreSQL CLI (`Get-Command psql` / `C:\Program Files\PostgreSQL`) returned `False` — live PostgreSQL SQL syntax validation is unavailable locally, and SQL was intentionally NOT executed against Supabase.
- Added automated static invariant suite [scripts/sql-hardening.test.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/sql-hardening.test.mjs) verifying balanced `BEGIN`/`COMMIT`/`ROLLBACK`, balanced `$$` delimiters, zero password literals, zero `has_*_privilege('public', ...)`, zero comma-separated privilege strings, `aclexplode` `PUBLIC` inspection, `pg_has_role` checks, and `'BV999'` rollback handling.
- Ran offline verification (`exit 0`): `npm run typecheck`, `npm run lint`, `npm run test` (**5 script tests + 46 API tests across 8 files + 3 Web tests across 2 files = 54 tests passed**), and `npm run build`.

**Relevant Local Commits:**
- `96b9360` (`fix(sql): use aclexplode PUBLIC checks, single-privilege assertions, and transactional setup`)
- `9bb1f4d` (`docs: document final SQL hardening verification fixes and commit history`)

---

## Entry 9 — 2026-11-11 (Final Static Security Review — Dedicated `app_runtime` Connection Checks, PG 14–17 Membership Isolation & Trigger Message/Rollback Verification)

**Prompt Given:**
Perform a final static security review of `prisma/sql/00_inspect_roles.sql`, `prisma/sql/01_setup_runtime_role.sql`, `prisma/sql/02_verify_hardening.sql`, `apps/api/src/modules/bootstrap/bootstrap.repository.ts`, `apps/api/tests/bootstrap.test.ts`, `apps/api/tests/integration/auth.integration.test.ts`, `scripts/inspect-db-roles.mjs`, and `scripts/sql-hardening.test.mjs` covering trigger execution without direct `EXECUTE`, append-only/deferred balance failure detection & rollback, separate `app_runtime` connection enforcement vs `SET LOCAL ROLE`, PG 14–17 membership/`SET ROLE` semantics, schema-owner & Supabase default-ACL limitations, and SQL transaction safety — without executing SQL against Supabase or altering migrations/schema/credentials/ownership.

**Issues Found & Fixes Applied:**
1. **Runtime Connection Spoofing & Masked ACL Failures (`Check 3`):**
   - `verifyRuntimeDbHardening` in [bootstrap.service.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.service.ts) previously did not verify `currentUser === 'app_runtime'` or `sessionUser === currentUser` (allowing `SET ROLE app_runtime` on a privileged session to pass). Added `resolveRuntimeDatabaseUrl` (requiring `app_runtime` / `app_runtime.<project_ref>` and distinct operator vs runtime credentials) and enforced strict `currentUser === 'app_runtime'` + `sessionUser === currentUser` checks.
   - [auth.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/auth.integration.test.ts) previously matched `/permission denied|append-only/i` on `AuditEvent`/`JournalTransaction`/`JournalEntry`, which could mask unrevoked table privileges behind the row trigger, and skipped testing `DELETE` on `User`/`OnboardingApplication`/`Account` or `UPDATE`/`DELETE` on `SystemBootstrapState`. Split checks strictly into `/permission denied/i` on the dedicated `app_runtime` connection (`DATABASE_URL`) and rolled-back `/Table .* is append-only/i` `$transaction` checks on all 4 append-only tables via `DIRECT_URL`, plus `< 2` entries and mismatched debit/credit checks running as `app_runtime` without direct `EXECUTE`. Updated [onboarding.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/onboarding.integration.test.ts) to also enforce `resolveRuntimeDatabaseUrl`.
2. **PG 16+ Multi-Grantor Membership Revocation & PG 14–17 Detection (`Check 4` & `Check 6`):**
   - In PostgreSQL 16+, `REVOKE <role> FROM app_runtime` run by `postgres` can emit only a `WARNING` and skip a membership granted by another admin role. Added a post-loop `pg_auth_members` emptiness assertion (`residual_roles`) inside [01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql) so any residual membership aborts and rolls back atomically.
   - Guarded `pg_has_role('app_runtime', ...)` in [00_inspect_roles.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/00_inspect_roles.sql) Section `3b` with `CASE WHEN NOT EXISTS (...)` for safe pre-hardening runs and broadened the filter using `pg_has_role` across custom/extension roles.
   - Updated [`PrismaBootstrapRepository.inspectDbPrivileges`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.repository.ts) to detect both direct `pg_auth_members` entries and indirect/`pg_database_owner` capabilities via `pg_has_role` across PG 14–17, catch PG 17 `MAINTAIN` (via `aclexplode` into `excessTablePrivileges` and `prismaMigrationsAny`), and include `c.relkind = 'f'` consistently across SQL and TS/MJS queries.
3. **Trigger Message Specificity, Schema-Owner Clarity & Subtransaction Verification (`Check 2` & `Check 5`):**
   - Updated [02_verify_hardening.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/02_verify_hardening.sql) Section 5 to assert `SQLERRM ILIKE '%append-only%'` for all 4 append-only tables and verify both single-entry (`at least 2 entries`) and mismatched debit/credit (`unbalanced`) failures inside `'BV999'` rollback subtransactions, added schema-`public` `USAGE` notice in `2b`, and added balanced/unbalanced journal + `OnboardingApplication`/`Account` `DELETE` denial checks in optional Section 6 (`SET LOCAL ROLE`).
   - Updated Supabase limitation notes in [01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql) and [inspect-db-roles.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/inspect-db-roles.mjs) to reference PG 15+ `pg_database_owner` schema ownership accurately.
4. **Minor Static Finding Documented (Not Altered Due to Migration Freeze):**
   - `verify_balanced_journal_transaction()` in the applied migration executes `FROM "JournalEntry"` (`SECURITY INVOKER`) without an explicit `SET search_path`; works cleanly under normal `app_runtime` Prisma execution (`USAGE` on `public` + `SELECT` on `"JournalEntry"`), and hardening the function's `search_path` is noted as a future migration improvement.

**Actual Local Verification Output (`exit 0`, SQL Not Executed Live):**
- `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
- `npm run lint`: exited `0` (`eslint apps prisma scripts`).
- `npm run test`: exited `0` — **`56` passed** (`scripts/*.test.mjs`: `6 passed` including `00_inspect_roles.sql`, `01_setup_runtime_role.sql`, and `02_verify_hardening.sql` static checks; `@balancevault/api`: `8 files / 47 passed` including new `bootstrap.test.ts` cases; `@balancevault/web`: `2 files / 3 passed`).
- `npm run build`: exited `0` (`tsc` + `vite build`).
- Local PostgreSQL CLI (`psql`) unavailable and Supabase SQL execution prohibited by task instructions; live execution of [01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql), [02_verify_hardening.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/02_verify_hardening.sql), `npm run db:inspect-roles -- --strict`, `npm run bootstrap:admin`, and `npm run test:integration` still requires live PostgreSQL 17 operator run.

**Relevant Local Commits:**
- `da99ec6` (`fix(sql): harden PG 16+ role revocation, SQLERRM assertions, and schema-owner notices`)
- `2ee9f10` (`fix(security): enforce dedicated app_runtime session checks, PG17 MAINTAIN detection, and strict integration isolation`)
- `0cd3cf3` (`docs: record final static security review findings and commit history`)

---

## Entry 10 — 2026-11-11 (Focused Security Correction — `verify_balanced_journal_transaction()` Relation Qualification & Pinned `search_path`)

**Prompt Given:**
Harden BalanceVault's deferred journal-balance trigger function (`verify_balanced_journal_transaction()`, `SECURITY INVOKER`) against `pg_temp."JournalEntry"` temporary-table and operator shadowing: create a **new** Prisma migration (without modifying the applied initial migration) using `CREATE OR REPLACE FUNCTION`, qualify `public."JournalEntry"`, set `search_path = pg_catalog, public`, preserve exact business logic, exception messages, `SECURITY INVOKER`, trigger `trg_verify_balanced_journal_transaction` (`DEFERRABLE INITIALLY DEFERRED`), ownership, and revoked ACLs, add temporary-table shadowing regression tests, run offline verification (`typecheck`, `lint`, `test`, `build`) without connecting to Supabase, update docs, and commit locally without pushing.

**Migration & Function Changes Applied:**
- Preserved [prisma/migrations/20261111000000_init/migration.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/migrations/20261111000000_init/migration.sql) completely untouched (`git diff` empty).
- Added [prisma/migrations/20261111181000_harden_journal_balance_trigger_search_path/migration.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/migrations/20261111181000_harden_journal_balance_trigger_search_path/migration.sql):
  - Uses `CREATE OR REPLACE FUNCTION public.verify_balanced_journal_transaction() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$ ... $$;`.
  - Changes relation lookup from `FROM "JournalEntry"` to `FROM public."JournalEntry"` so implicit `pg_temp` resolution ahead of `pg_catalog, public` can never shadow the ledger table with `CREATE TEMP TABLE "JournalEntry"`.
  - Verified dependency compatibility under `search_path = pg_catalog, public` (`BIGINT`, `INTEGER`, `COALESCE`, `SUM`, `COUNT`, `<>`, `public."EntryDirection"` equality, and `uuid` equality resolve cleanly from `pg_catalog`).
  - Preserves exact entry-count (`< 2`) and balance (`total_credit <> total_debit`) logic, exact `RAISE EXCEPTION` strings, `SECURITY INVOKER` (`prosecdef = false`), existing `pg_proc.oid`/`proowner`/`proacl` (zero `GRANT` or `OWNER TO`), and `trg_verify_balanced_journal_transaction` (`DEFERRABLE INITIALLY DEFERRED`, zero trigger DDL).

**Inspection, Enforcement & Regression Coverage Added:**
- [prisma/sql/00_inspect_roles.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/00_inspect_roles.sql): Added `p.proconfig AS function_config` to Section 9 catalog audit.
- [prisma/sql/02_verify_hardening.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/02_verify_hardening.sql): Section 4 now asserts `prosecdef = false`, `prosrc ~ 'FROM\s+public\."JournalEntry"'`, and `proconfig` matches `^search_path=("?pg_catalog"?,\s*"?public"?)$`; Section 5 adds two nested `'BV999'` rollback regression tests (when `TEMP` privilege exists) proving balanced decoy rows in `pg_temp."JournalEntry"` cannot hide unbalanced rows in `public."JournalEntry"` and an unbalanced decoy row in `pg_temp."JournalEntry"` does not interfere with balanced rows in `public."JournalEntry"`.
- [scripts/inspect-db-roles.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/inspect-db-roles.mjs) & [`PrismaBootstrapRepository.inspectDbPrivileges`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.repository.ts) & [`verifyRuntimeDbHardening`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/bootstrap/bootstrap.service.ts): Added `verifyBalancedJournalSearchPathHardened` inspection/compliance failure checks without logging raw function SQL in console output.
- [apps/api/tests/bootstrap.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/bootstrap.test.ts) & [apps/api/tests/helpers/inMemoryStore.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/helpers/inMemoryStore.ts): Added unit assertion that `verifyRuntimeDbHardening` rejects `verifyBalancedJournalSearchPathHardened = false`.
- [apps/api/tests/integration/auth.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/auth.integration.test.ts): Added two rolled-back `$transaction` regression tests running as dedicated `app_runtime` using `CREATE TEMP TABLE "JournalEntry" ... ON COMMIT DROP`, inserting decoy rows into `pg_temp."JournalEntry"` and real entries into `public."JournalEntry"`.
- [scripts/sql-hardening.test.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/sql-hardening.test.mjs): Expanded static verification to validate `20261111000000_init` immutability, all required clauses and exception messages in `20261111181000_harden_journal_balance_trigger_search_path/migration.sql`, absence of `GRANT`/`OWNER TO`/trigger DDL, and temp-table regression test presence across `02_verify_hardening.sql` and `auth.integration.test.ts`.

**Actual Local Verification Output (`exit 0`, No Live DB Connection Made):**
- `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
- `npm run lint`: exited `0` (`eslint apps prisma scripts`).
- `npm run test`: exited `0` — **`57` passed** (`scripts/*.test.mjs`: `7 passed`; `@balancevault/api`: `8 files / 47 passed` including `7` in `bootstrap.test.ts`; `@balancevault/web`: `2 files / 3 passed`).
- `npm run build`: exited `0` (`tsc` + `vite build`).
- Live PostgreSQL execution was intentionally not run per task rules; `20261111181000_harden_journal_balance_trigger_search_path`, `02_verify_hardening.sql` Section 5, and `auth.integration.test.ts` temp-table regression tests require live execution after running `npm run prisma:migrate:deploy` and `01_setup_runtime_role.sql`.

**Relevant Local Commits:**
- `e775d3c` (`fix(db): harden verify_balanced_journal_transaction search_path and relation qualification`)
- `d38caeb` (`test(security): add temporary-table shadowing regression tests and trigger search_path checks`)
- `6ead810` (`docs: document journal-balance trigger search_path migration and regression tests`)

---

## Entry 11 — 2026-11-11 (Integration Test Timeout Configuration & Live Supabase Reachability Check)

**Prompt Given:**
Update the BalanceVault API integration test configuration to accommodate slower live Supabase PostgreSQL operations: inspect `apps/api/vitest.integration.config.ts`, set `testTimeout: 30_000` and `hookTimeout: 30_000` (if supported), avoid modifying application logic, test assertions, database migrations, or security settings, run `npm run test:integration`, report exact passed/failed/skipped results and any issues, update `PROMPTS.md`, and commit locally on `main` without pushing to GitHub.

**Changes Applied:**
- Verified Vitest `3.2.7` `RuntimeConfig` type declarations (`node_modules/vitest/dist/chunks/config.d.BKdhh7Zx.d.ts`) support both `testTimeout` and `hookTimeout`.
- Updated [apps/api/vitest.integration.config.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/vitest.integration.config.ts) to set `testTimeout: 30_000` and `hookTimeout: 30_000`.
- Preserved all application logic, test assertions, Prisma migrations, and security settings unchanged.

**Actual Tool Output & Issues Found:**
1. `npm run lint`: exited `0` (`eslint apps prisma scripts`).
2. `npm run test:integration` (`vitest run --config vitest.integration.config.ts`): exited `1` (`Duration 7.37s`):
   - **Test Files:** `2 failed (2)` (`tests/integration/auth.integration.test.ts` `5060ms`, `tests/integration/onboarding.integration.test.ts` `5081ms`)
   - **Tests:** `0 passed`, `0 failed` (individually), `3 skipped (3)` (`2 skipped` in `tests/integration/auth.integration.test.ts`, `1 skipped` in `tests/integration/onboarding.integration.test.ts`)
   - **Issue Encountered:** Both integration suites aborted during `beforeAll` (``await prisma.$queryRaw`SELECT 1` ``) with `PrismaClientInitializationError: Can't reach database server at aws-0-ap-south-1.pooler.supabase.com:5432` before any test assertions or Redis health checks executed. The failure was network/database reachability to the configured Supabase pooler host/port in `.env`, not a Vitest timeout.

**Relevant Local Commit:**
- `d3f20ed` (`chore(test): increase integration test and hook timeouts to 30s`)

---

## Entry 12 — 2026-11-11 (Live Integration Test Determinism: Upstash Rate-Limit Isolation & Supabase Connectivity/Transaction Investigation)

**Prompt Given:**
Investigate remaining BalanceVault live integration test failures (HTTP `429` on `POST /api/auth/login` in `auth.integration.test.ts` and prior `beforeAll` Supabase pooler reachability failure): inspect rate-limit key construction and stale Upstash counters without disabling rate limiting or weakening production security, make integration tests deterministic via isolated test-specific keys/cleanup, investigate Supabase connectivity separately without modifying DB permissions or credentials without evidence, run `npm run test:integration`, update `PROMPTS.md`, and commit verified changes locally on `main` without pushing (keeping pre-existing unstaged edits to `prisma/sql/01_setup_runtime_role.sql` untouched).

**Root-Cause Investigation:**
1. **Rate-Limit HTTP `429` Root Cause:**
   - Verified `POST /api/auth/register` and `POST /api/auth/login` do **not** share a Redis key: [apps/api/src/app.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/app.ts) sets `keyPrefix: 'auth:register'` (`rl:auth:register:<ip>`) and `keyPrefix: 'auth:login'` (`rl:auth:login:<ip>`).
   - Instead, both [auth.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/auth.integration.test.ts) (`loginMax: 3, windowMs: 60_000`) and [onboarding.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/onboarding.integration.test.ts) (default `loginMax: 15, windowMs: 900_000`) executed HTTP Supertest requests from loopback (`127.0.0.1`) against live Upstash Redis using the unisolated production key `rl:auth:login:127.0.0.1`. Because [`IoredisRateLimitStore`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/middleware/rateLimit.ts#L9-L46) sets `PEXPIRE` in Lua only when `current == 1`, a 15-minute TTL counter created by `onboarding.integration.test.ts` or repeated runs persisted across test invocations (observed in Upstash: `rl:auth:login:127.0.0.1` = `'4'`, `pttlMs: 291648`), exceeding `loginMax: 3` on the first login call in `auth.integration.test.ts`.
2. **Supabase Connectivity & Transaction Latency Findings:**
   - Redacted inspection of `.env` URLs (zero credentials printed) confirmed `DATABASE_URL` (`app_runtime.<project_ref>`) and `DIRECT_URL` (`postgres.<project_ref>`) point to `aws-0-ap-south-1.pooler.supabase.com:5432` with empty query parameters, leaving Prisma/SQLx at its default `connect_timeout=5` seconds.
   - The earlier ~`5.06s` / `5.08s` `beforeAll` `P1001` failure matched that 5-second connect timeout during a transient remote Supavisor/WAN stall (subsequent TCP probes succeeded in `46–92ms` and Prisma `SELECT 1` in `713–1376ms`). Live catalog checks confirmed both Prisma migrations are applied, `max_connections = 60`, `app_runtime` `rolconnlimit = -1`, and all hardening invariants pass without changing any DB permissions or credentials.
   - An intermediate run after fixing rate-limit isolation also exposed Prisma's default `5,000 ms` interactive `$transaction` timeout firing at `5330 ms` on the temp-table shadowing multi-statement block in `auth.integration.test.ts` over remote WAN RTT.

**Changes Applied:**
- Added [`IsolatedIntegrationRateLimitStore`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/helpers/isolatedRateLimitStore.ts#L17-L47) (`implements RedisRateLimitStore`) to prefix every Redis rate-limit key per suite run with `inttest:<suiteTag>:<uuid>:` while running the unmodified `IoredisRateLimitStore` Lua `INCR`/`PEXPIRE`/`PTTL` enforcement against Upstash and deleting `touchedKeys` in `cleanup()`. Preserved production `app.ts` and `rateLimit.ts` security defaults unchanged.
- Updated [apps/api/vitest.integration.config.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/vitest.integration.config.ts) to set `fileParallelism: false` alongside `testTimeout: 30_000` and `hookTimeout: 30_000` to avoid parallel pooler bursts against Supabase Session Pooler.
- Updated [auth.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/auth.integration.test.ts) and [onboarding.integration.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/integration/onboarding.integration.test.ts) to wire `IsolatedIntegrationRateLimitStore` with `try ... finally` cleanup, verify `x-ratelimit-limit: '3'` and `x-ratelimit-remaining: '2'` on login, batch the 10-role `pg_roles` check into a single query, and pass `{ maxWait: 10_000, timeout: 20_000 }` (`txOptions`) to rolled-back raw-SQL `$transaction` blocks.

**Actual Tool Output & Verification Results (`exit 0`):**
1. **`npm run test:integration` — Run 1 (`exit 0`, `Duration 41.67s`):**
   - `tests/integration/auth.integration.test.ts`: `2 passed` (`23537ms`: `16817ms` + `5247ms`).
   - `tests/integration/onboarding.integration.test.ts`: `1 passed` (`14477ms`: `13214ms`).
   - Total: `Test Files 2 passed (2)`, `Tests 3 passed (3)`, `0` failed, `0` skipped.
2. **`npm run test:integration` — Run 2 Back-to-Back Determinism Check (`exit 0`, `Duration 40.53s`):**
   - `tests/integration/auth.integration.test.ts`: `2 passed` (`22837ms`: `17075ms` + `4603ms`).
   - `tests/integration/onboarding.integration.test.ts`: `1 passed` (`14129ms`: `12895ms`).
   - Total: `Test Files 2 passed (2)`, `Tests 3 passed (3)`, `0` failed, `0` skipped.
3. **Redis Test Key Cleanup Check (`exit 0`):** Verified `inttest:*` key count in Upstash `= 0` after both live integration runs.
4. **Offline Suite on Final Code (`exit 0`):**
   - `npm run typecheck`: `0` (`@balancevault/api` + `@balancevault/web`).
   - `npm run lint`: `0` (`eslint apps prisma scripts`).
   - `npm run test`: `0` (`7` script tests + `47` API tests across `8` files + `3` Web tests across `2` files = `57` passed).
   - `npm run build`: `0` (`tsc` + `vite build`).

**Relevant Local Commit:**
- `291c9f9` (`test(integration): isolate Redis rate-limit keys and stabilize live Supabase test runs`)

---

## Entry 13 — 2026-11-11 (Customer & Administrator Frontend Implementation & Honest Blocked-Screen Reporting)

**Prompt Given:**
Implement the remaining BalanceVault React + Vite + TypeScript frontend (`apps/web`) covering login and customer registration, customer dashboard, customer onboarding application/status, account overview and transaction history (only where backend APIs exist), admin dashboard, admin onboarding review and approval/rejection, admin user and role management, and admin audit event viewer — integrating strictly with implemented backend routes (`bv_sid` HttpOnly cookie with `credentials: 'include'`, `X-CSRF-Token` for mutations, role-aware navigation and route guards backed by server authorization, persistent synthetic-demo warning, zero mock endpoints or secret/token exposure, clear blocked reporting where backend APIs do not exist), running `typecheck`, `lint`, `test`, and `build`, and updating `PROMPTS.md` and `docs/IMPLEMENTATION_STATUS.md`.

**Backend Contract & Security Decisions:**
- **HttpOnly Session & In-Memory CSRF Handling:** Extended [apiClient.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/apiClient.ts) and implemented [AuthProvider.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/auth/AuthProvider.tsx) to bootstrap sessions via `GET /api/auth/me` (`credentials: 'include'`), store `csrfToken` strictly in volatile module memory (`setCsrfToken` — never in `localStorage`/`sessionStorage`), clear client auth state and surface an expiry banner on unexpected mid-session `401` responses, and refresh CSRF once if `POST /api/auth/logout` receives `403 CSRF_INVALID`.
- **Typed Endpoint Client & Validation Parity:** Created [types.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/types.ts), [validation.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/validation.ts), [format.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/format.ts), and [api.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/api.ts) matching actual Express routes and Zod schemas in [apps/api/src/](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/app.ts).
- **Screens Implemented & Live-Integrated (`apps/web/src/pages/`):**
  1. **Login & Registration:** [LoginPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/LoginPage.tsx), [RegisterPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/RegisterPage.tsx) (open-redirect-sanitized post-login redirects, live password-policy checklist, inline `fieldErrors`, and structured `ApiErrorAlert`).
  2. **Customer Dashboard:** [CustomerDashboardPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/CustomerDashboardPage.tsx) (session profile, live `GET /api/onboarding/me` summary, and explicit blocked panel for Accounts & Transactions).
  3. **Customer Onboarding Application & Status:** [CustomerOnboardingPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/CustomerOnboardingPage.tsx) (full support for unsubmitted `PENDING`/`DRAFT`/`NEEDS_INFORMATION` draft edits, submission, locked awaiting-review/approved states, and both `REJECTED` paths: `reopenForResubmission: true` draft reopening and direct `resubmit: true`).
  5. **Admin Dashboard:** [AdminDashboardPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminDashboardPage.tsx) (live onboarding queue counts, registered users total, recent `AuditEvent` table, `SystemStatusCard`, and blocked notice for Admin Account Lifecycle/Reversals).
  6. **Admin Onboarding Review:** [AdminOnboardingPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminOnboardingPage.tsx) (status filter, applicant search, pagination, detail drawer, unsubmitted `PENDING` approval block, submitted approval, two-step reject confirmation with mandatory >=10-char reason, and `409` concurrency error handling).
  7. **Admin User & Role Management:** [AdminUsersPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminUsersPage.tsx) (paginated `GET /api/admin/users` directory, `ADMIN` read-only notice, and `SUPER_ADMIN`-only `PATCH /api/admin/users/:id/role` with mandatory 5–500-char reason and self-demotion session refresh).
  8. **Admin Audit Event Viewer:** [AdminAuditPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminAuditPage.tsx) (filterable by `action`, `entityType`, UUID-validated `actorUserId`, paginated table with expandable `beforeState`/`afterState` JSON and `requestId`).
  - **Shared UI & Routing:** Added [RouteGuards.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/RouteGuards.tsx) (`RequireAuth`, `RequireRole`, `GuestOnly`), updated [Layout.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/Layout.tsx) (role-aware header navigation, mobile drawer, persistent `<DemoBanner />`, `Sign Out`), [OverviewPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/OverviewPage.tsx), [ForbiddenPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/ForbiddenPage.tsx), [NotFoundPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/NotFoundPage.tsx), [StatusBadge.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/StatusBadge.tsx), [ApiErrorAlert.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/ApiErrorAlert.tsx), [BlockedFeaturePanel.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/BlockedFeaturePanel.tsx), [PaginationControls.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/PaginationControls.tsx), [App.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/app/App.tsx), and [index.css](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/styles/index.css).
- **Explicitly Blocked Screens & Missing Backend Endpoints (Zero Mock APIs or Fabricated Balances):**
  - **Screen 4 — Account Overview & Transaction History** ([AccountsBlockedPage.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AccountsBlockedPage.tsx) and Dashboard ledger panel): Blocked on unimplemented Phase 4 endpoints (`GET /api/accounts`, `GET /api/accounts/:id`, `GET /api/accounts/:id/ledger`, `GET /api/transactions/:id`, `POST /api/transfers`).
  - **Sub-features Blocked on Other Admin Screens:** Admin account provisioning/freeze/unfreeze/close and ledger reversals (`POST /api/admin/accounts`, `POST /api/admin/accounts/:id/{freeze,unfreeze,close}`, `POST /api/transactions/:id/reverse`) on `/admin`; user search filtering, single-user detail (`GET /api/admin/users/:id`), and account status toggle (`PATCH /api/admin/users/:id/status`) on `/admin/users`.

**Actual Verification Output After Final Edits (`exit 0`, Zero Backend/Schema Changes):**
- `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
- `npm run lint`: exited `0` (`eslint apps prisma scripts`, `0` errors, `0` warnings).
- `npm run test`: exited `0` — **`72` passed total**:
  - `scripts/*.test.mjs`: `7` passed
  - `@balancevault/api`: `8` files / `47` passed
  - `@balancevault/web`: `5` files / `18` passed ([money.test.ts](file:///c:/Users/gowri/projects/BalanceVault/apps/web/tests/money.test.ts), [DemoBanner.test.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/tests/DemoBanner.test.tsx), [authAndRouting.test.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/tests/authAndRouting.test.tsx), [customerWorkflows.test.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/tests/customerWorkflows.test.tsx), [adminWorkflows.test.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/tests/adminWorkflows.test.tsx))
- `npm run build`: exited `0` (`@balancevault/api` `tsc` + `@balancevault/web` `tsc` and `vite build`, `59` modules bundled into `dist/`).
- Live browser E2E testing against a running local API/Vite stack was not executed in this verification step (`apps/api`, `prisma/`, and `prisma/sql/01_setup_runtime_role.sql` were preserved untouched).

---

## Entry 14 — 2026-11-11 (Live Browser Smoke Test Against `http://localhost:5173` & `http://localhost:4000`)

**Prompt Given:**
Perform a live browser smoke test of the completed BalanceVault frontend (`http://localhost:5173`) against the existing local API (`http://localhost:4000`), configured PostgreSQL, and Upstash Redis using synthetic test data only — testing public overview/navigation, fresh customer registration, customer login + dashboard + session persistence after refresh, customer onboarding draft save & submission, admin login & role-aware navigation, admin onboarding listing & review, admin user directory, admin audit event viewer, logout & protected-route behavior, and CSRF protection — without modifying backend code, schema, migrations, security config, or resetting the existing `SUPER_ADMIN` account, and without exposing credentials, cookies, or tokens; record actual pass/fail results and blockers in `PROMPTS.md` and `docs/IMPLEMENTATION_STATUS.md` without committing or pushing.

**Environment & Execution Method:**
- Verified live `http://localhost:4000/api/ready` (`HTTP 200`, `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`) and `http://localhost:5173` (`HTTP 200`).
- Executed an automated headless Google Chrome (`--headless=new` over Chrome DevTools Protocol WebSocket in temporary isolated `--user-data-dir`) without adding packages or altering repository files.

**Actual Live Results & Blocker Summary:**
- **Passed (`Tests 1, 2, 3, 4, 9, 10` — `0` uncaught JS exceptions / console errors):**
  1. **Public Overview & Navigation (`/`) — PASS:** Rendered `BalanceVault`, persistent synthetic `<DemoBanner />`, live `READY` badge, guest navigation (`System Status`, `Sign In`, `Register`), and client navigation to `/login`.
  2. **Customer Registration (`/register`) — PASS:** Registered fresh synthetic user `smoketest.1794413462450@balancevault.test` (`POST /api/auth/register` -> `HTTP 201`), verified 5/5 password-policy indicators, navigated to `/onboarding`, and confirmed `bv_sid` is `HttpOnly` (`document.cookie` does not expose `bv_sid`) with `localStorage.length === 0` and `sessionStorage.length === 0`.
  3. **Customer Login, Dashboard, Accounts Blocked Notice & Refresh Persistence — PASS:** Signed in (`POST /api/auth/login` -> `200`), reached `/customer` showing `"Submitted — awaiting administrator review"` and explicit `BLOCKED — BACKEND PENDING` notice for accounts/transactions, executed full browser `Page.reload()` confirming persistent authenticated session (`GET /api/auth/me` -> `200`), and opened `/accounts` showing honest blocked phase status.
  4. **Customer Onboarding Draft Save & Submission (`/onboarding`) — PASS:** Saved partial draft (`PATCH /api/onboarding/me` -> `200`, `"Onboarding profile draft saved."`), submitted completed synthetic profile (`POST /api/onboarding/me/submit` -> `200`, `"Onboarding application submitted for administrator review."`), and verified form inputs locked cleanly (`disabled === true`).
  5. **Logout & Protected-Route Behavior — PASS:** Before login, `/customer`, `/onboarding`, `/accounts`, `/admin`, `/admin/onboarding`, `/admin/users`, and `/admin/audit` redirected to `/login` (and `/api/admin/users` returned `401`). While signed in as `CUSTOMER`, all four `/admin/*` UI routes displayed `"Access Denied"` (`GET /api/admin/users` returned `403 FORBIDDEN`). After `Sign Out` (`POST /api/auth/logout` -> `200`), `/customer` and `/onboarding` redirected back to `/login` (`GET /api/auth/me` -> `401`).
  6. **CSRF Protection on Authenticated Mutations — PASS:** From authenticated Chrome context, `PATCH /api/onboarding/me` omitted `X-CSRF-Token` -> `403 CSRF_INVALID`, forged `X-CSRF-Token` -> `403 CSRF_INVALID`, and valid UI mutations (`PATCH /api/onboarding/me`, `POST /api/onboarding/me/submit`, `POST /api/auth/logout`) included `X-CSRF-Token` and returned `200`.
- **Database Verification (Read-Only):** Confirmed synthetic test customer (`role: CUSTOMER`, `status: ACTIVE`, `onboarding.status: PENDING`, `submittedAt: 2026-11-11T16:11:13.489Z`) and 6 persisted `AuditEvent` records (`AUTH_REGISTER`, `ONBOARDING_PROFILE_UPDATED`, `ONBOARDING_SUBMITTED`, `AUTH_LOGOUT`, `AUTH_LOGIN_SUCCESS`, `AUTH_LOGOUT`); confirmed existing `SUPER_ADMIN` record was unmodified (`updatedAt` unchanged).
- **Blocked (`Tests 5, 6, 7, 8` — Admin Login, Onboarding Review, User Directory, Audit Event Viewer):**
  - **Blocker:** `ADMIN_BOOTSTRAP_PASSWORD` was intentionally removed from local `.env` after bootstrap (`ADMIN_BOOTSTRAP_EMAIL` present only). Under the rule prohibiting resetting/modifying the existing `SUPER_ADMIN` account, altering security/DB directly, or exposing credentials, unattended headless Chrome cannot authenticate as `SUPER_ADMIN` to interactively test Admin UI screens (`5–8`). Authenticated Admin UI rendering & actions remain verified via Vitest mocked `fetch` tests ([adminWorkflows.test.tsx](file:///c:/Users/gowri/projects/BalanceVault/apps/web/tests/adminWorkflows.test.tsx)) and await interactive manual browser verification by an operator holding the `SUPER_ADMIN` password.

---

## Entry 15 — 2026-11-11 (Master End-to-End Completion: Phases 4–6, Ledger, Full Frontend, Pool Hardening, Chrome CDP E2E & Deployment Docs)

**Prompt Summary:**
Complete BalanceVault end-to-end across all remaining phases — synthetic accounts, double-entry INR transfers with deterministic `FOR UPDATE` locking and `Idempotency-Key` concurrency safety, compensating reversals, admin lifecycle/summary/user status governance, OpenAPI `3.0.3` specification, full interactive Customer & Admin React screens, threat model, deployment configurations, live browser & integration verification, and complete documentation — while preserving database role least-privilege, existing `SUPER_ADMIN`, and the unstaged SQL edit in `prisma/sql/01_setup_runtime_role.sql`.

**Implemented Functionality & Technical Fixes:**
- **Phase 4 Backend Ledger & Admin Governance (`apps/api`):**
  - Built [`LedgerRepository`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.repository.ts), [`LedgerService`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.service.ts), [`ledger.schemas.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.schemas.ts), [`ledger.controller.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.controller.ts), and [`ledger.routes.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.routes.ts):
    - Implemented `GET /api/accounts`, `GET /api/accounts/:id`, `GET /api/accounts/:id/ledger`, `GET /api/transactions/:id` with owner filtering, IDOR `404` concealment, and customer counterparty `accountId`/`accountName` redaction.
    - Implemented `POST /api/transfers` with CSRF, fail-closed Redis throttling (`20 / 15m` per `userId`), canonical request-hash `IdempotencyRecord` (`X-Idempotent-Replay: true` vs `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`), ordered `SELECT ... FOR UPDATE` row locking, integer minor-unit `BIGINT` updates, balanced `JournalTransaction` + 2 `JournalEntry` rows validated by PostgreSQL's deferred trigger, and `TRANSFER_POSTED` audit events.
    - Implemented `POST /api/admin/accounts`, `POST /api/admin/accounts/:id/{activate,freeze,unfreeze,close}`, `POST /api/transactions/:id/reverse` (compensating `REVERSAL` transaction), `GET /api/admin/summary`, `GET /api/admin/users/:id`, `PATCH /api/admin/users/:id/status` (self-lock guard, non-`CUSTOMER` protection, last active `SUPER_ADMIN` guard, immediate session revocation), user search/filter, audit date filtering (`from`/`to`), and `GET /api/openapi.json` ([`openapi.spec.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/openapi/openapi.spec.ts)).
- **Phase 5 Interactive Customer & Admin UI (`apps/web`):**
  - Replaced all blocked placeholders with [`AccountsPage.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AccountsPage.tsx), updated [`CustomerDashboardPage.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/CustomerDashboardPage.tsx), [`TransactionDetailPanel.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/components/TransactionDetailPanel.tsx), [`AdminDashboardPage.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminDashboardPage.tsx), [`AdminAccountsPage.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminAccountsPage.tsx), [`AdminUsersPage.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminUsersPage.tsx), and [`AdminAuditPage.tsx`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/AdminAuditPage.tsx).
- **Supavisor Session Pooler (`pool_size: 15`) Resolution:**
  - Diagnosed concurrent integration `500` errors as Supabase Supavisor Session Mode `EMAXCONNSESSION` exhaustion caused by unbounded Prisma connection pools alongside `dev:api`.
  - Added [`normalizeRuntimeDatabaseUrl`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/config/prisma.ts#L3-L31) (`connection_limit=5`, `connect_timeout=15`, `pool_timeout=20` defaults) and [`buildIntegrationDatabaseUrl`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/tests/helpers/integrationDb.ts#L8-L20) (`connection_limit=6`).
- **Phase 6 Threat Model, API/Deployment/Verification Docs & Blueprints:**
  - Authored [THREATS.md](file:///c:/Users/gowri/projects/BalanceVault/THREATS.md), [render.yaml](file:///c:/Users/gowri/projects/BalanceVault/render.yaml), [vercel.json](file:///c:/Users/gowri/projects/BalanceVault/apps/web/vercel.json), [API.md](file:///c:/Users/gowri/projects/BalanceVault/docs/API.md), [DEPLOYMENT.md](file:///c:/Users/gowri/projects/BalanceVault/docs/DEPLOYMENT.md), [VERIFICATION_REPORT.md](file:///c:/Users/gowri/projects/BalanceVault/docs/VERIFICATION_REPORT.md), and updated [README.md](file:///c:/Users/gowri/projects/BalanceVault/README.md) & [IMPLEMENTATION_STATUS.md](file:///c:/Users/gowri/projects/BalanceVault/docs/IMPLEMENTATION_STATUS.md).

**Verification Results:**
- **Offline Suite (`exit 0`):** `npm run typecheck`, `npm run lint` (`0` warnings), `npm run build` (`vite build` `61` modules), and `npm run test` (**82 passed**: `7` script tests, `55` API tests across `9` files, `20` Web tests across `5` files).
- **Live Supabase + Upstash Integration Suite (`exit 0`):** `npm run test:integration` passed **`3/3` files / `6/6` tests** (`125.55s`) with **`0` leaked `inttest:*` keys** in Redis.
- **Live Headless Chrome CDP E2E (`exit 0`):** All **`8/8` scenarios** (public readiness/guards, registration/`HttpOnly` `bv_sid`/onboarding submit, CSRF `403`/cross-role `Access Denied`, ephemeral test `ADMIN` onboarding approval & vault provisioning, IDOR `404`/transfer/insufficient funds/redaction, compensating reversal/freeze-unfreeze/user disable + session revocation/audit diff, disabled login block, and clean `SUPER_ADMIN` preservation) passed against `http://localhost:5173` & `http://localhost:4000` with **`0` JS/console errors**.
- **Database & Secret Checks (`exit 0`):** `npm run prisma:migrate:status` (`2` migrations applied), `node scripts/inspect-db-roles.mjs --strict` (`PASS`, PostgreSQL 17.11), `git ls-files .env` (empty).
- **Honest Deployment Disclosure:** Remote cloud provisioning on Render and Vercel was not executed externally; local runtime, Supabase PostgreSQL, Upstash Redis, and local Vite + API builds are verified end-to-end.

---

## Entry 16 — 2026-11-11 (First Cloud Deployment Prep: Validating & Committing Supabase PG 17.11 `01_setup_runtime_role.sql` Compatibility Fix)

**Prompt Summary:**
Prepare BalanceVault for its first cloud deployment on `main`: inspect the branch, commit history, and working tree; review and preserve the remaining compatibility change in [01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql); confirm it is the verified Supabase PostgreSQL 17.11 fix; record the correction, verification evidence, and real commit hash in `PROMPTS.md`; commit only the validated SQL fix and its documentation locally without pushing or modifying production data; verify `.env` tracking and zero secrets in staged changes; and execute full typecheck, lint, test, build, migration, and strict DB role checks.

**SQL Compatibility Verification ([01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql#L72-L76)):**
- **Exact Change (`edc7605 -> df831f3`):** Removed the standalone `ALTER ROLE app_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;` statement while preserving the conditional creation `DO` block (`CREATE ROLE app_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;` when `app_runtime` does not exist), `rolbypassrls` and `pg_auth_members` assertions, schema/table/sequence/function revocations, and minimal `app_runtime` grants.
- **Live Supabase PostgreSQL 17.11 Reproduction Evidence:** Executed inside a rolled-back `$transaction` over `DIRECT_URL` (`postgres` has `rolsuper = false`, `rolcreaterole = true`, `postgres_admin_of_app_runtime = true`); executing `ALTER ROLE app_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT` failed with SQLSTATE `42501` (`ERROR: permission denied to alter role / DETAIL: Only roles with the SUPERUSER attribute may alter roles with the SUPERUSER attribute.`). Meanwhile `app_runtime` holds exact least-privilege attributes (`rolsuper: false`, `rolinherit: false`, `rolcreaterole: false`, `rolcreatedb: false`, `rolcanlogin: true`, `rolreplication: false`, `rolbypassrls: false`, zero memberships).
- **Local Commit on `main`:** `958575e` (`fix(sql): omit superuser-only ALTER ROLE attributes for Supabase PG 17.11`).

**Verification Output (`exit 0`, Verified Against `958575e`):**
- `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
- `npm run lint`: exited `0` (`eslint apps prisma scripts`, `0` errors, `0` warnings).
- `npm run test`: exited `0` — **`82` passed**: `scripts/*.test.mjs` (**7** passed, including [sql-hardening.test.mjs](file:///c:/Users/gowri/projects/BalanceVault/scripts/sql-hardening.test.mjs) validating `01_setup_runtime_role.sql`), `@balancevault/api` (**9 files / 55 passed**), and `@balancevault/web` (**5 files / 20 passed**).
- `npm run build`: exited `0` (`@balancevault/api` `tsc` + `@balancevault/web` `vite build` `61` modules -> `dist/`).
- `npm run prisma:migrate:status`: exited `0` (`2 migrations found in prisma/migrations`, `Database schema is up to date!`).
- `node scripts/inspect-db-roles.mjs --strict`: exited `0` (`PASS: Least-privilege table, sequence, function, role, and trigger invariants verified.` on PostgreSQL 17.11).
- **Secret & Working-Tree Hygiene:** `.env` ignored by `.gitignore` (`git ls-files .env` empty; `git check-ignore -v .env` -> `.gitignore:5:.env`), zero secrets in staged diffs; nothing pushed to GitHub and no production records modified.

---

## Entry 17 — 2026-11-11 (Final GitHub Connection Audit, Secret Hygiene Verification & Render/Vercel `--include=dev` Build Hardening)

**Prompt Summary:**
Perform final GitHub connection and release preparation for `https://github.com/himasri-meduri/Balancevault.git`: inspect Git remote/branch/history/visibility without rewriting history or pushing to a public/unverified repository, audit secret hygiene across `.env` and tracked files, validate Render and Vercel deployment blueprints (`render.yaml`, `apps/web/vercel.json`, `docs/DEPLOYMENT.md`), verify builds/tests, and report exact required variable names and next manual steps.

**Findings & Deployment Hardening Corrections:**
1. **GitHub Remote & Visibility Audit (Read-Only):**
   - Verified local branch `main` (`36` commits ahead of release prep commit on top of `4ae071c`), clean prior history, and placeholder `origin` (`YOUR_GITHUB_REPOSITORY_URL`).
   - Queried GitHub REST API (`https://api.github.com/users/himasri-meduri/repos` -> `8` public repos listed without `Balancevault`; `https://api.github.com/repos/himasri-meduri/Balancevault` -> `HTTP 404`), and tested `git ls-remote https://github.com/himasri-meduri/Balancevault.git` (`exit 128`, `remote: Repository not found.`). Because private authenticated repository reachability could not be verified from this shell, `origin` was preserved untouched and zero pushes were attempted.
2. **Render & Vercel `NODE_ENV=production` Build Fix:**
   - Diagnosed a cloud build pitfall: `render.yaml` sets `NODE_ENV: production`, causing `npm ci` without `--include=dev` to omit `devDependencies` (`prisma` CLI and `typescript`) required for `prisma:generate` and `tsc` compilation; similarly hardened `apps/web/vercel.json` (`installCommand: "cd ../.. && npm ci --include=dev"` so Vite, TypeScript, and React types always install even if `NODE_ENV=production` is set in Vercel).
   - Updated [render.yaml](file:///c:/Users/gowri/projects/BalanceVault/render.yaml), [apps/web/vercel.json](file:///c:/Users/gowri/projects/BalanceVault/apps/web/vercel.json), and [docs/DEPLOYMENT.md](file:///c:/Users/gowri/projects/BalanceVault/docs/DEPLOYMENT.md), preserving rootless `apps/web/vercel.json` layout (`Root Directory: apps/web` + `"Include files outside of the Root Directory in the Build Step"`), `buildCommand: npm run build`, `outputDirectory: dist`, SPA rewrite `/(.*) -> /index.html`, and API startup `node apps/api/dist/server.js`.
3. **Verification & Secret Hygiene (`exit 0`):**
   - `npm run typecheck`: exited `0` (`@balancevault/api` + `@balancevault/web`).
   - `npm run lint`: exited `0` (`eslint apps prisma scripts`, `0` warnings).
   - `npm run test`: exited `0` (**82 passed**: `7` script tests, `9 files / 55` API tests, `5 files / 20` Web tests).
   - `npm run build`: exited `0` (`@balancevault/api` `tsc` -> `apps/api/dist/server.js` + `@balancevault/web` `vite build` `61` modules -> `apps/web/dist/`).
   - `npm ci --include=dev --dry-run --ignore-scripts`: exited `0` (`package-lock.json` tracked & up to date).
   - `npm run prisma:migrate:status`: exited `0` (`2` migrations applied, up to date) & `node scripts/inspect-db-roles.mjs --strict`: exited `0` (`PASS` on Supabase PostgreSQL 17.11).
   - `git check-ignore -v .env` (`.gitignore:5:.env`), `git ls-files .env*` (`.env.example` only), and tracked regex secret scan confirmed zero exposed passwords, tokens, or connection strings.
