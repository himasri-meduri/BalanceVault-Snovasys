# Threat Model & Security Controls — BalanceVault

> **Scope Notice:** Demo environment — synthetic data only. No real funds or bank integrations. This document captures trust boundaries, concrete attack vectors, implemented controls grounded in BalanceVault's codebase, and honest residual limitations.

---

## 1. Trust Boundaries

```text
[Browser SPA (apps/web)] --(HTTPS / JSON + HttpOnly Cookie bv_sid + X-CSRF-Token)--> [Express API (apps/api)]
                                                                                          |
      +-----------------------------------------------------------------------------------+
      |                                                                                   |
      v                                                                                   v
[Upstash Redis (rate limits)]                                    [PostgreSQL (Supabase) — app_runtime role]
                                                                                          ^
[Operator CLI Only: DIRECT_URL / postgres or app_migrator] -------------------------------+
(Migrations, Role Hardening SQL, One-Time SUPER_ADMIN Bootstrap)
```

1. **Browser <-> API (`CORS` + `bv_sid` + `X-CSRF-Token`):** All client inputs, route params, query strings, redirects, and account/transaction references are treated as untrusted. Authentication and role claims are never accepted from request bodies or browser storage.
2. **Express API <-> Redis (`ioredis` TLS):** Security rate limiting fails **closed** (`503 SERVICE_UNAVAILABLE`) so losing Redis cannot silently bypass brute-force or abuse throttles.
3. **Express API <-> PostgreSQL (`app_runtime` vs `DIRECT_URL`):** The runtime API executes as `app_runtime` (`NOINHERIT`, non-superuser, zero role memberships, no `PUBLIC`/`anon`/`authenticated` grants). Schema migrations, SQL hardening, and one-time admin bootstrap execute exclusively out-of-band via `DIRECT_URL`.

---

## 2. Threat Analysis & Implemented Mitigations

### 2.1 Authentication, Brute Force & Credential Stuffing
- **Threat:** Offline cracking of database dumps, credential stuffing, timing side channels revealing valid emails, or brute-forcing `/api/auth/login` and `/api/auth/register`.
- **Implemented Controls:**
  - Passwords hashed with **Argon2id** (`memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`) and per-password random salts in [`hashPassword`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.crypto.ts#L4-L13).
  - Password complexity enforced server-side via [`passwordPolicySchema`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.schemas.ts#L4-L14) (10–128 chars, upper, lower, digit, special char) and normalized lowercase/trimmed emails (`User_email_normalized_chk` CHECK constraint in PostgreSQL).
  - Login timing equalization against `DUMMY_PASSWORD_HASH_FALLBACK` when email is absent, plus identical generic `401 Invalid email or password` responses for unknown email, invalid password, `DISABLED`, and `LOCKED` accounts in [`AuthService.login`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.service.ts#L112-L150).
  - Redis Lua (`INCR` + conditional `PEXPIRE`) fail-closed rate limiting on `POST /api/auth/register` (`10 / 15m`), `POST /api/auth/login` (`15 / 15m`), `POST /api/onboarding/me/submit` (`10 / 15m` keyed by `userId`), and `POST /api/transfers` (`20 / 15m` keyed by `userId`) in [`IoredisRateLimitStore`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/middleware/rateLimit.ts#L9-L105).

### 2.2 Session Hijacking, Fixation & Token Leakage
- **Threat:** XSS reading session tokens from `document.cookie` or `localStorage`, session fixation across logins, or stale tokens remaining usable after logout/disable/role change.
- **Implemented Controls:**
  - Opaque 256-bit random session tokens (`crypto.randomBytes(32)`); only HMAC-SHA256 digests (`hashSessionToken(rawToken, SESSION_SECRET)`) are persisted in `Session.tokenHash` ([`auth.crypto.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.crypto.ts#L27-L36)).
  - `bv_sid` cookie is set `HttpOnly`, `Path=/`, `SameSite` configurable (`lax` local, `none` + mandatory `Secure` cross-site), validated by [`parseEnv`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/config/env.ts#L30-L58) so production cannot boot with `COOKIE_SECURE=false` or default `SESSION_SECRET`.
  - Session rotation on login revokes any prior cookie's session hash ([`AuthService.login`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.service.ts#L156-L163)); sessions enforce both idle timeout (`SESSION_IDLE_MINUTES`) and absolute lifetime (`SESSION_TTL_HOURS`) and are revoked immediately on logout, `USER_STATUS_CHANGE` to non-`ACTIVE`, or `USER_ROLE_CHANGE`.
  - Frontend [`apiClient.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/apiClient.ts#L41-L50) never persists session or CSRF tokens in `localStorage`/`sessionStorage`.

### 2.3 Cross-Site Request Forgery (CSRF), CORS & Open Redirects
- **Threat:** Malicious third-party sites submitting state-changing requests via ambient `bv_sid` cookies, overly permissive `CORS` with credentials, or phishing via post-login `state.from` redirects.
- **Implemented Controls:**
  - Single exact-origin CORS allowlist (`origin === env.APP_ORIGIN`, `credentials: true`) in [`createApp`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/app.ts#L76-L90).
  - [`createCsrfMiddleware`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/middleware/csrf.ts#L8-L37) runs **after** `requireAuth` on all cookie-authenticated mutations (`POST`, `PATCH`, `PUT`, `DELETE`): verifies optional `Origin === env.APP_ORIGIN` and validates `X-CSRF-Token` using `crypto.timingSafeEqual` against an HMAC signature bound to `sessionId` (`csrf:${sessionId}:${nonce}`).
  - Helmet security headers (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-site`) plus `vercel.json` SPA headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`).
  - [`sanitizeInternalRedirectPath`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/lib/format.ts#L108-L120) rejects protocol-relative (`//`), backslash, or external redirect targets in [`LoginPage`](file:///c:/Users/gowri/projects/BalanceVault/apps/web/src/pages/LoginPage.tsx#L46-L49).

### 2.4 Privilege Escalation, Mass Assignment & IDOR
- **Threat:** Self-registration as `ADMIN`/`SUPER_ADMIN`, customer access to admin routes or another customer's accounts/transactions/counterparty names, last-`SUPER_ADMIN` lockout, or unauthenticated admin bootstrap over HTTP.
- **Implemented Controls:**
  - Registration forces `UserRole.CUSTOMER` and rejects unexpected keys with Zod `.strict()` ([`registerSchema`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.schemas.ts#L20-L35)); all mutating Zod schemas use `.strict()`.
  - [`requireRole`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/middleware/authorize.ts#L5-L19) enforces RBAC on every admin route; role updates (`PATCH /api/admin/users/:id/role`) are restricted to `SUPER_ADMIN` only.
  - Self-disable/lock (`SELF_STATUS_CHANGE_FORBIDDEN`), non-`SUPER_ADMIN` changes to `ADMIN`/`SUPER_ADMIN` accounts, and disabling or demoting the last active `SUPER_ADMIN` (`LAST_SUPER_ADMIN_PROTECTED`) are blocked inside [`AuthService`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/auth/auth.service.ts#L293-L400).
  - First `SUPER_ADMIN` bootstrap runs strictly out-of-band via CLI ([`bootstrap-admin.ts`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/scripts/bootstrap-admin.ts)), never HTTP, protected by idempotency row `SystemBootstrapState`, secret verification, and PostgreSQL pre-flight checks.
  - IDOR concealment: customer queries filter by `ownerUserId = actor.userId`, while direct lookups (`GET /api/accounts/:id`, `GET /api/accounts/:id/ledger`, `GET /api/transactions/:id`, unauthorized transfer source/dest) return `404` rather than leaking resource existence via `403`. In [`serializeTransactionDetailDto`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.service.ts#L95-L134), counterparty internal `accountId` and `accountName` are redacted to `null` for `CUSTOMER` viewers.

### 2.5 Double-Spend, Concurrency Races, Replay & Ledger Tampering
- **Threat:** Concurrent transfers spending the same synthetic balance twice, ABBA deadlocks across opposing concurrent transfers, floating-point rounding drift, duplicate posting on network retry, unbalanced journal entries, or mutable ledger/audit history.
- **Implemented Controls:**
  - Money represented exclusively as `BIGINT` minor units (`paise`, `1 INR = 100 paise`) in PostgreSQL and string-serialized in JSON (`1` to `1,000,000,000` minor units in [`parseMinorUnits`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/shared/money.ts#L10-L44)).
  - Deterministic `SELECT ... FROM "Account" WHERE "id" IN (...) ORDER BY "id" ASC FOR UPDATE` locking in [`lockAccountsByIds`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.repository.ts#L399-L447) prevents ABBA deadlocks; eligibility, `ACTIVE` status, and `balanceMinor` are re-verified post-lock inside the transaction.
  - `Account_owner_and_balance_chk` enforces non-negative `CUSTOMER` balances at the PostgreSQL row level; `JournalEntry_amount_positive_chk` enforces `amountMinor > 0`.
  - Mandatory `Idempotency-Key` (16–128 chars) + canonical SHA-256 [`computeTransferRequestHash`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/ledger/ledger.schemas.ts#L165-L181) stored in `IdempotencyRecord` (`@@unique([actorUserId, scope, key])`) with post-lock re-check and unique-constraint race recovery (`X-Idempotent-Replay: true` for identical payloads; `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` for altered payloads).
  - Deferred PostgreSQL constraint trigger `trg_verify_balanced_journal_transaction` (`DEFERRABLE INITIALLY DEFERRED`, `SECURITY INVOKER`, `SET search_path = pg_catalog, public`, querying `public."JournalEntry"` in [`20261111181000_harden_journal_balance_trigger_search_path`](file:///c:/Users/gowri/projects/BalanceVault/prisma/migrations/20261111181000_harden_journal_balance_trigger_search_path/migration.sql)) rejects `< 2` entries or `SUM(CREDIT) != SUM(DEBIT)` at commit and prevents temporary-table shadowing attacks.
  - Append-only triggers (`prevent_append_only_mutation()`) block `UPDATE`/`DELETE` on `JournalTransaction`, `JournalEntry`, `AuditEvent`, and `SystemBootstrapState`; corrections occur strictly via compensating `REVERSAL` transactions (`@unique reversalOfTransactionId`).

### 2.6 Database Over-Privilege, Log Leakage & Secret Exposure
- **Threat:** SQL/API exposure through overly broad PostgreSQL privileges or leaked credentials/tokens in logs or audit JSON.
- **Implemented Controls:**
  - [prisma/sql/01_setup_runtime_role.sql](file:///c:/Users/gowri/projects/BalanceVault/prisma/sql/01_setup_runtime_role.sql) enforces `app_runtime` (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`), revokes all `PUBLIC`, `anon`, and `authenticated` table/sequence/function grants, leaves table ownership with `postgres`, and denies `UPDATE`/`DELETE` on append-only tables. Verified automatically via [`inspect-db-roles.mjs`](file:///c:/Users/gowri/projects/BalanceVault/scripts/inspect-db-roles.mjs) `--strict`.
  - [`createLogger`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/config/logger.ts#L3-L35) redacts `cookie`, `authorization`, `x-csrf-token`, `set-cookie`, passwords, tokens, hashes, and DB/Redis URLs.
  - [`sanitizeAuditState`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/modules/audit/audit.types.ts#L3-L28) redacts sensitive key names recursively in audit payloads, and client IPs are hashed via keyed HMAC (`hashIpAddress`).

---

## 3. Known Residual Risks & Operational Limitations

1. **Synthetic Demo Scope:** No email verification, password reset flow, MFA, or external payment rails exist by design (`PRODUCT_REQUIREMENTS.md`).
2. **Cross-Site Cookie Tradeoff (`Vercel` -> `Render`):** Hosting frontend (`*.vercel.app`) and API (`*.onrender.com`) on different registrable domains requires `COOKIE_SAME_SITE=none` + `COOKIE_SECURE=true` with strict `Origin` + HMAC CSRF token enforcement. Moving both under a single apex domain (e.g. `app.domain` + `api.domain`) would allow `COOKIE_SAME_SITE=lax`.
3. **Expired Record Retention:** Expired `Session` and `IdempotencyRecord` rows are ignored and cleaned lazily on collision/expiry check rather than by a scheduled background pruning job.
4. **Supabase Pooler Concurrency & WAN Latency:** Supavisor Session Mode (port `5432`) caps concurrent client sessions (`pool_size: 15`) and remote pooler queries incur WAN/TLS latency. [`normalizeRuntimeDatabaseUrl`](file:///c:/Users/gowri/projects/BalanceVault/apps/api/src/config/prisma.ts#L3-L31) applies conservative defaults (`connection_limit=5`, `connect_timeout=15`, `pool_timeout=20` when unset) to avoid session exhaustion, interactive transactions use `maxWait: 10_000, timeout: 20_000`, and horizontal Render scaling should use Supabase Transaction Pooler (`6543?pgbouncer=true`) for runtime queries.
5. **Frontend CSP Deployment Setting:** `apps/web/vercel.json` sets baseline security headers without a static `connect-src` CSP header so `VITE_API_BASE_URL` can target your Render API domain cleanly; operators should set `Content-Security-Policy` at the CDN/Vercel project layer once the exact API URL is fixed.
