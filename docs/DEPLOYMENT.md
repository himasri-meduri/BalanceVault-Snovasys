# Deployment Runbook — BalanceVault

> **Deployment Honesty Notice:** As of the latest verification date in [`docs/VERIFICATION_REPORT.md`](VERIFICATION_REPORT.md), remote cloud provisioning on **Render** and **Vercel** has **not** been executed externally. This repository provides production-ready configuration ([`render.yaml`](../render.yaml), [`apps/web/vercel.json`](../apps/web/vercel.json)) and exact operator instructions; local API + frontend + live Supabase PostgreSQL + live Upstash Redis have been verified end-to-end.

---

## 1. Architecture & Hosted Services

| Component | Target Host | Notes |
|---|---|---|
| **Database** | Managed PostgreSQL (Supabase) | Separate schema-owner `DIRECT_URL` (port `5432` direct/session) vs least-privilege `app_runtime` `DATABASE_URL`. |
| **Rate-Limit Cache** | Managed Redis (Upstash TLS) | `rediss://...` connection string in `REDIS_URL`. Fail-closed rate limiters require healthy connectivity. |
| **Backend API** | Render (`@balancevault/api`) | Configured via [`render.yaml`](../render.yaml). Runs compiled `node apps/api/dist/server.js`. |
| **Frontend SPA** | Vercel (`@balancevault/web`) | Configured via [`apps/web/vercel.json`](../apps/web/vercel.json) with Root Directory `apps/web`. |

---

## 2. Database & Security Pre-Flight (Supabase)

Run these steps from an operator workstation **before** enabling public Render traffic:

1. **Inspect existing PostgreSQL roles and grants:**
   ```powershell
   npm run db:inspect-roles
   ```
2. **Apply reviewed Prisma migrations using `DIRECT_URL` (never `app_runtime`):**
   ```powershell
   npm run prisma:migrate:deploy
   ```
   Confirms both `20261111000000_init` and `20261111181000_harden_journal_balance_trigger_search_path` are applied (`npm run prisma:migrate:status`).
3. **Apply least-privilege role hardening ([`prisma/sql/01_setup_runtime_role.sql`](../prisma/sql/01_setup_runtime_role.sql)):**
   - Execute `01_setup_runtime_role.sql` via `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/01_setup_runtime_role.sql` (or Supabase SQL Editor as one batch; do not wrap inside another `psql -1` transaction).
   - Set the `app_runtime` password **out-of-band** (`\password app_runtime` or SQL Editor `ALTER ROLE app_runtime WITH PASSWORD '...'`) — never commit passwords into SQL files.
   - Verify hardening strictly:
     ```powershell
     node scripts/inspect-db-roles.mjs --strict
     ```
   - On Supabase Dashboard -> **Settings -> API**, remove `public` from Exposed Schemas (BalanceVault uses Express sessions, not Supabase PostgREST).
4. **One-time CLI `SUPER_ADMIN` bootstrap (never exposed over HTTP):**
   Temporarily provide `DIRECT_URL`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_SECRET`, and `ADMIN_BOOTSTRAP_PASSWORD` in your operator environment:
   ```powershell
   npm run bootstrap:admin
   ```
   Remove `ADMIN_BOOTSTRAP_SECRET` and `ADMIN_BOOTSTRAP_PASSWORD` immediately after verifying login.
5. **Optional non-production demo seed:**
   ```powershell
   npm run prisma:seed
   ```
   *(Refuses to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true` and `SEED_DEMO_PASSWORD` >= 10 chars are explicitly provided.)*

---

## 3. Deploy Backend API on Render (`apps/api`)

1. Connect your repository in Render using [`render.yaml`](../render.yaml) (or configure a **Web Service** in the repository root):
   - **Build Command:** `npm ci --include=dev && npm run prisma:generate && npm run build --workspace=@balancevault/api` *(uses `--include=dev` so `prisma` and `typescript` install even when `NODE_ENV=production` is set during build)*
   - **Start Command:** `node apps/api/dist/server.js`
   - **Health Check Path:** `/api/ready`
2. Set the secret / environment variables in Render Dashboard (`sync: false` in `render.yaml`):
   - `NODE_ENV=production`
   - `PORT=4000`
   - `TRUST_PROXY=1`
   - `LOG_LEVEL=info`
   - `COOKIE_SECURE=true`
   - `COOKIE_SAME_SITE=none` *(required when `APP_ORIGIN` is `https://<project>.vercel.app` and `API_PUBLIC_URL` is `https://<service>.onrender.com`; switch to `lax` only if both share one registrable apex domain via custom domains)*
   - `APP_ORIGIN=https://<your-vercel-domain>.vercel.app` *(exact HTTPS origin, no trailing slash)*
   - `API_PUBLIC_URL=https://<your-render-service>.onrender.com` *(no trailing slash)*
   - `DATABASE_URL=<app_runtime PostgreSQL URI>` *(least-privilege `app_runtime`, e.g. Supabase pooler port `5432` or `6543?pgbouncer=true`; [`createPrismaClient`](../apps/api/src/config/prisma.ts) defaults `connection_limit=5`, `connect_timeout=15`, and `pool_timeout=20` when unset so single-instance API + maintenance/integration sessions stay within Supabase Supavisor Session Mode's `pool_size: 15` limit—prefer `:6543?pgbouncer=true` if scaling horizontally; **never** put `DIRECT_URL` or schema-owner credentials in Render runtime)*
   - `REDIS_URL=<Upstash rediss://... TLS URI>`
   - `SESSION_SECRET=<32+ character high-entropy secret>`
3. Wait for Render deploy health check `GET /api/ready` to return `HTTP 200` (`{"status":"ready","checks":{"database":"ok","redis":"ok"}}`).

---

## 4. Deploy Frontend SPA on Vercel (`apps/web`)

1. Import the repository in Vercel and configure:
   - **Root Directory:** `apps/web`
   - Ensure **"Include files outside of the Root Directory in the Build Step"** is enabled (Vercel default for monorepos so `cd ../.. && npm ci --include=dev` sees root `package-lock.json` workspaces).
   - [`apps/web/vercel.json`](../apps/web/vercel.json) supplies `framework: vite`, `installCommand`, `buildCommand`, `outputDirectory: dist`, SPA fallback rewrites (`/(.*) -> /index.html`), and baseline security headers (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`).
2. Configure **Environment Variables** in Vercel Project Settings:
   - `VITE_API_BASE_URL=https://<your-render-service>.onrender.com/api`
3. Deploy and then copy the resulting exact production origin (`https://<your-vercel-domain>.vercel.app`) back into Render's `APP_ORIGIN` env var (no wildcard allowed).

---

## 5. Post-Deploy Production Verification Checklist

Run against your live HTTPS Vercel + Render URLs:

1. `GET https://<api>/api/health` -> `200`, `X-Request-Id` header present.
2. `GET https://<api>/api/ready` -> `200`, `checks: { database: "ok", redis: "ok" }` (zero URLs/secrets returned).
3. `GET https://<api>/api/openapi.json` -> `200` OpenAPI `3.0.3` spec.
4. Load Vercel URL -> confirm `Demo environment — synthetic data only` banner and `READY` badge.
5. Verify cross-origin cookie/CSRF round-trip (`POST /api/auth/register` or `/login` -> `Set-Cookie: bv_sid=...; HttpOnly; Secure; SameSite=None`, reload `/customer`, execute draft save/transfer, confirm `document.cookie` hides `bv_sid` and `localStorage` is empty).
6. Sign in with the bootstrapped `SUPER_ADMIN` account -> open `/admin`, `/admin/onboarding`, `/admin/accounts`, `/admin/users`, `/admin/audit`, confirm no errors in Render Pino logs or browser console.
