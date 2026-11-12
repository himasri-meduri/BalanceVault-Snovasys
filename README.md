# BalanceVault

BalanceVault is a synthetic-data account-management and double-entry ledger web application built as an auditable modular monolith.

> **Demo Notice:** Demo environment — synthetic data only (INR integer minor units / paise, `1 INR = 100 paise`). No real funds, real KYC, or bank integrations. BalanceVault is **not** a bank, payment processor, custodian, or production financial service.

---

## Architecture Overview

- **Frontend (`apps/web`):** React 18 + TypeScript + Vite SPA with React Router v6, persistent synthetic demo notice, responsive Customer & Admin portals, in-memory CSRF handling (`HttpOnly` `bv_sid` cookie sessions with `credentials: 'include'`), integer minor-unit INR formatting, and role-aware navigation guards (`apps/web/vercel.json` for Vercel).
- **Backend (`apps/api`):** Node.js + Express + TypeScript modular monolith with Zod `.strict()` validation, Argon2id password hashing, HMAC-hashed opaque sessions, session-bound CSRF validation, RBAC enforcement, OpenAPI `3.0.3` specification (`/api/openapi.json`), Pino redacting JSON logging (`X-Request-Id`), Helmet CSP/headers, exact-origin CORS, and fail-closed Redis rate limiting (`render.yaml` for Render).
- **Database (`prisma/`):** PostgreSQL with Prisma ORM, `BIGINT` minor-unit money (`paise`), ordered `SELECT ... FOR UPDATE` deterministic row locking, idempotency records (`Idempotency-Key` + canonical request-hash comparison), append-only immutability triggers (`JournalTransaction`, `JournalEntry`, `AuditEvent`, `SystemBootstrapState`), `search_path`-hardened deferred double-entry balance constraint trigger (`public."JournalEntry"`), and separate operator (`DIRECT_URL`) vs. least-privilege runtime (`app_runtime`) roles.

---

## Local Development Setup (Windows + Managed PostgreSQL & Redis)

BalanceVault runs natively on Windows (Node.js `>=22`, npm `>=10`) against managed PostgreSQL and Redis services (or native local instances) configured via environment variables—no Docker required.

### 1. Install dependencies & generate Prisma client

```powershell
npm install
npm run prisma:generate
```

### 2. Configure environment variables

Copy [.env.example](.env.example) to `.env` (never commit `.env`) and fill in your PostgreSQL, Redis, and session values:

- `DATABASE_URL` — PostgreSQL connection string for the **least-privilege runtime role** (`app_runtime`)
- `DIRECT_URL` — PostgreSQL connection string for the **migration / schema-owner role** (`postgres` on Supabase or `app_migrator`, port `5432` direct/session without `?pgbouncer=true`)
- `REDIS_URL` — Managed Redis (`rediss://...`) or local Redis (`redis://localhost:6379`)
- `SESSION_SECRET` — High-entropy secret (`>= 32` characters)
- `APP_ORIGIN` — Frontend origin (e.g., `http://localhost:5173`)
- `API_PUBLIC_URL` — Public API URL (e.g., `http://localhost:4000`)
- `VITE_API_BASE_URL` — API base URL for Vite (e.g., `http://localhost:4000/api`)

### 3. Inspect PostgreSQL roles, run migrations, and set up least-privilege runtime grants

1. Inspect existing PostgreSQL roles, memberships, table ownership, schema ACLs, sequences, functions, and triggers:

```powershell
npm run db:inspect-roles
```

2. Run reviewed Prisma migrations (including schema initialization and the `verify_balanced_journal_transaction()` `search_path` / `public."JournalEntry"` hardening migration) using `DIRECT_URL`:

```powershell
npm run prisma:migrate:deploy
```

3. Apply least-privilege hardening from [prisma/sql/01_setup_runtime_role.sql](prisma/sql/01_setup_runtime_role.sql) inside its single explicit `BEGIN; ... COMMIT;` transaction using `DIRECT_URL` on port `5432`:
   - CLI: `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/01_setup_runtime_role.sql` *(or Supabase Dashboard SQL Editor as one batch; never stack `psql -1` on top of explicit `BEGIN`/`COMMIT`)*.
   - Sets up `app_runtime` (`NOINHERIT`, zero memberships, **no password literal in SQL**) and revokes `PUBLIC`, `anon`, and `authenticated` table, sequence, and trigger-function grants across `public`.
   - Set the `app_runtime` password **out-of-band** after `COMMIT;` and store it in `DATABASE_URL` in your local `.env` (never commit secrets).
   - Verify with [prisma/sql/02_verify_hardening.sql](prisma/sql/02_verify_hardening.sql) and `node scripts/inspect-db-roles.mjs --strict`.
   - On Supabase, remove `public` from Exposed Schemas in **Dashboard -> Settings -> API** since BalanceVault authenticates exclusively in Node.js.

### 4. One-time first `SUPER_ADMIN` bootstrap (CLI only)

Never expose admin creation over HTTP. Configure `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_SECRET`, and `ADMIN_BOOTSTRAP_PASSWORD` temporarily in `.env` (or an operator shell) and run:

```powershell
npm run bootstrap:admin
```

The bootstrap CLI inspects PostgreSQL role permissions without escalating privileges, enforces idempotency via `SystemBootstrapState`, records an `ADMIN_BOOTSTRAP_COMPLETED` audit event, and never prints secrets. Remove `ADMIN_BOOTSTRAP_SECRET` and `ADMIN_BOOTSTRAP_PASSWORD` after verifying login.

### 5. Seed synthetic demo data (non-production)

```powershell
npm run prisma:seed
```

The seed script creates synthetic `CUSTOMER` accounts (`APPROVED`, `PENDING`, `REJECTED` onboarding states), the `BV-SYS-TREASURY-01` `SYSTEM_ISSUANCE` reserve account, active and frozen synthetic vaults, and a balanced opening sample transfer.

### 6. Run API and Web locally

```powershell
# Terminal 1 — API (default http://localhost:4000)
npm run dev:api

# Terminal 2 — Frontend (default http://localhost:5173)
npm run dev:web
```

### 7. Quality & Verification Commands

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run build
```

---

## Implemented Scope & API Surface

- **System & OpenAPI Spec:** `GET /health`, `GET /api/health`, `GET /ready`, `GET /api/ready`, `GET /api`, `GET /api/openapi.json` (OpenAPI `3.0.3` JSON).
- **Authentication & Sessions:** `POST /api/auth/register` (`CUSTOMER` only), `POST /api/auth/login`, `POST /api/auth/logout` (CSRF-protected), `GET /api/auth/me` (Argon2id passwords, HMAC-hashed opaque `HttpOnly` sessions, session rotation, idle/absolute TTL).
- **Customer Onboarding (`CUSTOMER`):** `GET /api/onboarding/me`, `PATCH /api/onboarding/me`, `POST /api/onboarding/me/submit` (CSRF-protected, Redis rate-limited, supports explicit `REJECTED` reopening/resubmission and blocks edits after `APPROVED`).
- **Admin Onboarding Review (`ADMIN` / `SUPER_ADMIN`):** `GET /api/admin/onboarding/applications` (plus `/api/admin/onboarding`), `GET /api/admin/onboarding/applications/:id`, `POST .../approve`, `POST .../reject` (mandatory 10–500 char reason, atomic CAS locking & audit).
- **Synthetic Accounts, Double-Entry Transfers & Compensating Reversals:**
  - Customer & Admin reads: `GET /api/accounts` (`includeSystem=true` admin-only for `BV-SYS-TREASURY-01`), `GET /api/accounts/:id`, `GET /api/accounts/:id/ledger`, `GET /api/transactions/:id` (counterparty details redacted for `CUSTOMER`; IDOR concealed with `404`).
  - Customer transfers: `POST /api/transfers` (CSRF-protected, Upstash rate-limited `20 / 15m`, mandatory `Idempotency-Key` + canonical hash check, `ACTIVE` + `APPROVED` eligibility, deterministic `FOR UPDATE` ordered locking, double-entry journal rows).
  - Admin account lifecycle & reversals: `POST /api/admin/accounts`, `POST /api/admin/accounts/:id/{activate,freeze,unfreeze,close}`, `POST /api/transactions/:id/reverse` (compensating `REVERSAL` transaction without altering posted rows).
- **Admin Summary, User Governance & Audit Trail:** `GET /api/admin/summary`, `GET /api/admin/users` (searchable/filterable), `GET /api/admin/users/:id`, `PATCH /api/admin/users/:id/status` (self-lock blocked, last `SUPER_ADMIN` protected, active sessions revoked), `PATCH /api/admin/users/:id/role` (`SUPER_ADMIN` only), `GET /api/admin/audit-events`.
- **Customer & Admin Frontend (`apps/web`):** Overview (`/`), Login (`/login`), Registration (`/register`), Customer Dashboard (`/customer`), Onboarding Application (`/onboarding`), Synthetic Vaults, Ledger Statements & Transfers (`/accounts`), Admin Overview (`/admin`), Onboarding Queue (`/admin/onboarding`), Accounts & Ledger/Reversals Console (`/admin/accounts`), User & Role Governance (`/admin/users`), and Audit Event Viewer (`/admin/audit`).

### Latest Verified Checks

- `npm run typecheck` (`0`) & `npm run lint` (`0` warnings)
- `npm run build` (`0` — `@balancevault/api` `tsc` + `@balancevault/web` `vite build` `61` modules)
- `npm run test` (`0` — **82 passed**: `7` script tests, `55` API unit/HTTP tests across 9 files, `20` Web tests across 5 files)
- `npm run test:integration` (`0` against live Supabase PostgreSQL 17.11 & Upstash Redis — **3 files / 6 tests passed**, zero leaked Redis keys)
- Live headless Chrome CDP E2E walkthrough against `http://localhost:5173` & `http://localhost:4000` (`8/8` scenarios passed, `0` JS/console errors)
- `npm run prisma:migrate:status` (`0` — **2 migrations** applied) & `node scripts/inspect-db-roles.mjs --strict` (`0` — `PASS`)

See [docs/VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md) and [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for complete verification evidence and deployment status.

---

## Documentation Index

- **Security, Architecture & Verification:**
  - [THREATS.md](THREATS.md) — threat model, trust boundaries, implemented mitigations, residual risks
  - [docs/API.md](docs/API.md) — HTTP endpoint contract & OpenAPI `3.0.3` reference
  - [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Supabase + Upstash + Render + Vercel deployment runbook
  - [docs/VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md) — automated & live Chrome CDP verification report
  - [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) — phase-by-phase completion & check log
  - [PROMPTS.md](PROMPTS.md) — dated engineering prompts, debugging notes, and architectural decisions
- **Core Specifications:**
  - [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [API_CONTRACT.md](API_CONTRACT.md), [RBAC_SECURITY.md](RBAC_SECURITY.md), [WORKFLOWS.md](WORKFLOWS.md), [TEST_PLAN.md](TEST_PLAN.md)
- **Hosting Blueprints:**
  - [render.yaml](render.yaml), [apps/web/vercel.json](apps/web/vercel.json)

---

## Non-Negotiable Engineering Rules

- Never claim a feature or remote deployment is verified unless automated tests or live execution prove it.
- Never use real financial data, real identity documents, or real money.
- Never store plaintext passwords, session tokens, or secrets in source control.
- Posted journal entries and audit events are strictly append-only.
- Every posted journal transaction balances: `SUM(DEBIT) = SUM(CREDIT)`.
- Use `BIGINT` integer minor units for money; never use floating-point arithmetic.
