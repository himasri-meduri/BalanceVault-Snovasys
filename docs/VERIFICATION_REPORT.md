# Verification Report — BalanceVault

**Date:** 2026-11-11  
**Workspace:** `c:\Users\gowri\projects\BalanceVault`  
**Scope:** Full-Stack Implementation (Phases 1–6), Database & Security Hardening, Live Integration Suite, and Live Headless Chrome CDP E2E Walkthrough

> **Deployment Honesty Notice:** BalanceVault was verified end-to-end across its local Vite/React frontend (`http://localhost:5173`), local Express API (`http://localhost:4000`), live **Supabase PostgreSQL 17.11**, and live **Upstash Redis (`rediss://`)**. Remote cloud provisioning on **Render** and **Vercel** has **not** been executed externally; [`render.yaml`](../render.yaml), [`apps/web/vercel.json`](../apps/web/vercel.json), and [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) provide deployment-ready configuration.

---

## 1. Automated Verification Summary

| Suite / Check | Command | Result | Scope & Exact Counts |
|---|---|---|---|
| **TypeScript Typecheck** | `npm run typecheck` | **PASS (Exit `0`)** | `@balancevault/api` + `@balancevault/web` (`tsc --noEmit`) |
| **ESLint Static Analysis** | `npm run lint` | **PASS (Exit `0`)** | `eslint apps prisma scripts` (`0` errors, `0` warnings) |
| **Offline Unit & Component Suites** | `npm run test` | **PASS (Exit `0`, `82/82`)** | `scripts`: **7** passed (`db-connection-utils.test.mjs`, `sql-hardening.test.mjs`)<br>`@balancevault/api`: **9 files / 55** passed (`money`, `env`, `auth.crypto`, `health`, `rateLimit`, `bootstrap`, `ledger`, `auth.rbac`, `onboarding`)<br>`@balancevault/web`: **5 files / 20** passed (`money`, `DemoBanner`, `authAndRouting`, `customerWorkflows`, `adminWorkflows`) |
| **Production Build** | `npm run build` | **PASS (Exit `0`)** | Compiled `@balancevault/api` (`dist/`) and `@balancevault/web` (`vite build` -> `dist/`) |
| **Live PostgreSQL + Redis Integration** | `npm run test:integration` | **PASS (Exit `0`, `3/3` files, `6/6` tests)** | `125.55s` against live Supabase PostgreSQL 17.11 (`app_runtime`) + Upstash Redis via `IsolatedIntegrationRateLimitStore`; `0` leaked `inttest:*` Redis keys |
| **Migration Status** | `npm run prisma:migrate:status` | **PASS (Exit `0`)** | `2` migrations applied (`20261111000000_init`, `20261111181000_harden_journal_balance_trigger_search_path`), schema up to date |
| **Strict DB Role & Trigger Audit** | `node scripts/inspect-db-roles.mjs --strict` | **PASS (Exit `0`)** | Verified `app_runtime` `NOINHERIT` + `NOSUPERUSER` + zero role memberships, zero `PUBLIC`/`anon`/`authenticated` grants, `postgres` ownership, and all 5 immutability/balance triggers |
| **Git Secret Tracking Audit** | `git ls-files .env` & `git check-ignore -v .env` | **PASS (Exit `0`)** | Empty `ls-files` output; `.gitignore` ignores `.env` |

---

## 2. Live Integration Coverage (`npm run test:integration`)

1. **`tests/integration/ledger.integration.test.ts` (3 passed — `89,884 ms`):**
   - Verified `/api/openapi.json` (`3.0.3` spec), pre-onboarding account ineligibility (`409`), customer synthetic account provisioning (`BV-XXXX-XXXX`) debited from `BV-SYS-TREASURY-01`, IDOR `404` isolation, idempotency replay (`X-Idempotent-Replay: true`) and key mismatch rejection (`409`), 5-way concurrent double-spend transfer test (`Promise.all` -> exactly 3 succeeded `201`, 2 rejected `422 INSUFFICIENT_FUNDS`), and 3-way identical `Idempotency-Key` race (`Promise.all` -> exactly 1 `JournalTransaction` created).
   - Verified compensating `POST /api/transactions/:id/reverse` (`REVERSAL` transaction preserving original rows, append-only SQL triggers blocking `UPDATE`/`DELETE` on `JournalTransaction` & `JournalEntry`), account freeze/unfreeze/close (`409 ACCOUNT_BALANCE_NON_ZERO` when non-zero; `409 SYSTEM_ACCOUNT_PROTECTED` on system reserve), `GET /api/admin/summary`, and `PATCH /api/admin/users/:id/status` revoking active sessions.
   - Verified fail-closed Upstash Redis transfer throttling (`429 RATE_LIMITED`) using isolated test-run namespaces.
2. **`tests/integration/onboarding.integration.test.ts` (1 passed — `13,564 ms`):**
   - Verified registration starting `PENDING` (`submittedAt: null`), draft save & submission, both `REJECTED` resubmission paths (`reopenForResubmission: true` and `resubmit: true`), concurrent approve vs reject (`Promise.all` -> `[200, 409]`), and atomic PostgreSQL audit triggers.
3. **`tests/integration/auth.integration.test.ts` (2 passed — `18,319 ms`):**
   - Verified `app_runtime` session hardening (`current_user = session_user = 'app_runtime'`), `permission denied` on `DELETE`/`SET LOCAL ROLE`, `pg_temp."JournalEntry"` shadowing resistance, and live HTTP registration/login session rotation/logout revocation/rate limiting.

---

## 3. Live Headless Chrome CDP End-to-End Walkthrough (`8/8` Scenarios PASS)

Executed against live `http://localhost:5173` + `http://localhost:4000` (with Supabase PostgreSQL 17.11 and Upstash Redis) in headless Google Chrome (`--headless=new`), with **`0` uncaught JS exceptions** and **`0` unexpected console errors**:

1. **Public Overview & Unauthenticated Guards:** `/` rendered `BalanceVault`, persistent `"Demo environment — synthetic data only"` banner, and live `READY` status (`database: ok`, `redis: ok`); guest visits to `/customer`, `/accounts`, and `/admin/accounts` redirected cleanly to `/login`.
2. **Customer Registration, Cookie Isolation & Onboarding Submission:** Synthetic customer Beta registered (`POST /api/auth/register` -> `201`), confirmed `bv_sid` is `HttpOnly` (`document.cookie` empty of `bv_sid`, `localStorage.length === 0`, `sessionStorage.length === 0`), saved partial draft (`PATCH /api/onboarding/me` -> `200`), and submitted (`POST /api/onboarding/me/submit` -> `200`).
3. **Reload Persistence, CSRF & Cross-Role Defense:** Customer Alpha submitted onboarding, survived full browser reload (`Page.reload()`), confirmed missing `X-CSRF-Token` returned `403 CSRF_INVALID`, and confirmed `CUSTOMER` access to `/admin/accounts` rendered `"Access Denied"` (API `403`).
4. **Admin Onboarding Review & Synthetic Account Provisioning:** Ephemeral test `ADMIN` account (`e2e-admin-*@balancevault.test`, created transiently without altering existing `SUPER_ADMIN`) logged in via UI -> verified `/admin` live KPIs -> approved Alpha and Beta on `/admin/onboarding` -> provisioned `BV-PJF6-2UE9` (`₹5,000.00`) and `BV-23EB-5K2Q` (`₹1,000.00`) on `/admin/accounts` -> toggled `"Include System Issuance Reserve"` (`BV-SYS-TREASURY-01`).
5. **Customer Transfers, IDOR Defense, Insufficient Funds & Counterparty Redaction:** Customer Alpha confirmed `GET /api/accounts/<betaId>` returned `404`, transferred `₹1,500.50` (`TXN-X2JB-74GE-UY7S`, balance `₹3,499.50`), saw `422 INSUFFICIENT_FUNDS` on `₹4,000.00`, reloaded `/accounts` with persisted balance, and verified counterparty details showed `"Counterparty details redacted"`.
6. **Compensating Reversal, Account Freeze/Unfreeze, User Governance & Audit Diffs:** Ephemeral `ADMIN` reversed `TXN-X2JB-74GE-UY7S` (`₹5,000.00` restored), froze and unfroze `BV-PJF6-2UE9`, verified `/admin/users` hid `Change Role` controls for non-`SUPER_ADMIN` (`count === 0`), inspected Beta (`1 (1 ACTIVE)`), set Beta `DISABLED` (revoking Beta's sessions), and filtered `/admin/audit` to inspect the `TRANSACTION_REVERSED` diff JSON.
7. **Disabled Customer Blocking:** Disabled Customer Beta was rejected on UI login (`401 Invalid email or password`).
8. **Final Cleanliness Assertions:** Verified the pre-existing `SUPER_ADMIN` record remained untouched (`1` `ACTIVE`, `updatedAt` unchanged) and set ephemeral test `ADMIN` to `DISABLED` with `0` active sessions.

---

## 4. Pool Concurrency Fix Verified During E2E + Integration Runs

During concurrent `Promise.all` integration runs alongside the running `dev:api` process, Supabase Supavisor Session Mode (`pool_size: 15`) previously returned `EMAXCONNSESSION` (`500`). [`normalizeRuntimeDatabaseUrl`](../apps/api/src/config/prisma.ts) (`connection_limit=5`, `connect_timeout=15`, `pool_timeout=20` defaults) and [`buildIntegrationDatabaseUrl`](../apps/api/tests/helpers/integrationDb.ts) (`connection_limit=6`) resolved pool exhaustion cleanly, verified both by a direct 6-way concurrent `$transaction` probe alongside `dev:api` and by the clean `6/6` integration run above.
