# Architecture — BalanceVault

## 1. Architecture style
Use a modular monolith for the hackathon: one backend deployable, one frontend deployable, one PostgreSQL database, and Redis for rate limiting/session support if already integrated. Keep module boundaries clear; do not introduce microservices.

## 2. Logical architecture

```text
Browser
  |
  | HTTPS
  v
React + TypeScript SPA
  |
  | JSON API / secure session cookie
  v
Node.js + Express API
  |-- Auth & Session module
  |-- User & Onboarding module
  |-- RBAC / Policy module
  |-- Account module
  |-- Ledger / Transfer module
  |-- Audit module
  |-- Admin module
  |-- Health / Observability module
  |
  |-- Prisma
  |      |
  |      v
  |   PostgreSQL
  |
  |-- Redis (rate limits / optional session store)
  |
  v
Structured logs / deployment monitoring
```

## 3. Backend layering
Recommended request path:
1. Route registration
2. Authentication middleware (where required)
3. Authorization policy middleware/service
4. Zod input validation
5. Controller (HTTP translation only)
6. Application/service layer (business rules)
7. Repository/data-access layer (Prisma)
8. Database transaction
9. Audit event creation in the same transaction for sensitive mutations
10. Response serializer

Controllers must not contain ledger business logic. Avoid direct Prisma calls scattered through routes.

## 4. Suggested project layout
Adapt to the existing repository rather than forcing a rewrite.

```text
/
  apps/
    web/
      src/
        app/
        components/
        features/
          auth/
          onboarding/
          accounts/
          ledger/
          admin/
        lib/
        routes/
    api/
      src/
        config/
        middleware/
        modules/
          auth/
          users/
          onboarding/
          accounts/
          ledger/
          audit/
          admin/
          health/
        shared/
        app.ts
        server.ts
  prisma/
    schema.prisma
    migrations/
    seed.ts
  docs/
  tests/
  package.json
```

If the current repository uses a different workspace layout, preserve it and document the mapping.

## 5. Trust boundaries
- Browser input is untrusted.
- Authenticated identity comes from a validated server-side session, not a user ID in request JSON.
- Role claims are loaded/validated server-side; never trust a role sent by the client.
- Customer resource access must be scoped by ownership in the query/service, not just hidden in the UI.
- Database runtime role must have only required privileges.
- Admin bootstrap is a controlled, one-time, out-of-band operation.

## 6. Ledger design
Use immutable journal transactions and entries. For each posted transaction:
- Create transaction header.
- Create debit and credit entries.
- Enforce equal total debit and credit.
- Enforce valid account states and available balance.
- Record idempotency key.
- Create audit event.
- Commit all changes atomically.

Recommended approach: PostgreSQL transaction with row locks on affected account balance/projection rows in deterministic account-ID order to reduce deadlocks. Re-read balances inside the transaction. If maintaining a cached account balance, update it in the same transaction and provide a reconciliation query/job. The journal remains authoritative.

## 7. Money representation
Use integer minor units (`BIGINT` in PostgreSQL). For INR, 1 rupee = 100 paise. Convert to formatted decimal strings only at the API/UI boundary. Validate safe integer/range constraints. Do not use JS `Number` for arbitrary large money values; use `BigInt` or decimal-safe serialization. JSON does not serialize BigInt natively, so serialize money as a decimal string representing minor units or a formatted decimal string.

## 8. Authentication/session
Prefer opaque server-side sessions:
- Generate high-entropy random session token.
- Store only a hash of the token in the database/session store.
- Cookie: HttpOnly, Secure in production, SameSite=Lax or Strict as compatible, Path=/.
- Rotate session after login and privilege changes.
- Revoke on logout and password change.
- Set idle and absolute expiry.
- Add CSRF protection for cookie-authenticated mutations.
If the existing implementation uses JWT, inspect it and document tradeoffs before changing. Do not mix incompatible auth approaches.

## 9. Admin bootstrap
- No public endpoint may create an admin or elevate a role.
- Provide a one-time CLI/script or controlled deployment operation.
- Require explicit environment-provided bootstrap identity/secret or a secure operator workflow.
- Make it idempotent and refuse to run if bootstrap is already completed unless an explicit safe recovery procedure is used.
- Never log bootstrap secrets.
- Verify database role membership, function EXECUTE grants, ownership, and role inheritance rather than granting broad privileges.
- Record bootstrap completion and resulting admin identity in a protected audit/system event.

## 10. Deployment
Frontend: Vercel or existing host.
Backend: Render/Railway or existing host.
Database: managed PostgreSQL (e.g. Neon) with separate migration and runtime credentials.
Redis: managed Redis.
Run migrations as a deployment/release step using migration credentials. API runtime must not use the schema-owner credential.
Configure exact frontend origin in CORS. Configure secure cookies and proxy trust correctly for the hosting platform.

## 11. Observability
- JSON logs with timestamp, severity, requestId, route, status, duration.
- Never log passwords, cookies, authorization headers, raw session tokens, or full sensitive payloads.
- Health is liveness; readiness checks required dependencies.
- Add error monitoring if already available; do not spend hackathon time building a custom monitoring platform.
