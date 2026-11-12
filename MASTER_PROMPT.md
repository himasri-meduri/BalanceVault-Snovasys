# MASTER PROMPT — Build BalanceVault

Act as a principal full-stack engineer, application security engineer, database architect, and QA lead. Your task is to inspect, complete, and verify **BalanceVault**, a secure account-management and auditable synthetic-money ledger web application.

The repository is the source of truth. The documents in this pack define intended behavior, but existing code and migrations must be inspected before changes. Do not assume the project description accurately reflects the current code.

## Product objective
Deliver a polished, working hackathon demonstration with:
- secure customer registration and login
- controlled first-admin bootstrap and verified admin login
- role-based access control and customer resource ownership isolation
- onboarding submission and admin approval/rejection
- account creation and account status management
- simulated internal transfers using a double-entry ledger
- immutable journal entries and reversal workflow
- audit logs for sensitive actions
- health/readiness checks
- responsive customer and admin interfaces
- automated tests and a truthful deployment verification report

This is a synthetic-data demonstration only. Do not implement real funds movement, payment rails, bank integrations, real KYC, or production banking claims.

## Phase 1: Inspect before coding
1. Inspect all relevant files, package scripts, workspace structure, Prisma schema, migrations, backend routes/services/middleware, frontend routes/components, Redis integration, environment variable names, and deployment configuration.
2. Do not reveal secret values. Redact all environment values.
3. Run baseline install/build/lint/typecheck/tests using the repository's existing package manager.
4. Inspect current deployment configuration and the demo URL if accessible.
5. Create `docs/IMPLEMENTATION_STATUS.md` with a table of each feature: implemented, partially implemented, missing, broken, tested, live-verified.
6. Identify the smallest safe implementation path. Do not rewrite functioning subsystems.

Stop after Phase 1 and present the findings and plan for approval before high-risk schema/auth/ledger changes. You may proceed with non-destructive fixes such as clear type errors only if their impact is understood.

## Phase 2: Stabilize auth and admin bootstrap
- Verify registration cannot set or submit a privileged role.
- Verify password hashing and session lifecycle.
- Verify login, logout, current-user endpoint, disabled-user handling, and rate limiting.
- Implement or repair an out-of-band, one-time first SUPER_ADMIN bootstrap.
- Never expose admin bootstrap as a public route.
- Inspect PostgreSQL role memberships, grants, object ownership, function execute permissions, and `SET ROLE` behavior before changing privileges.
- Do not grant superuser or broad role administration to solve permission errors.
- Add tests for bootstrap idempotency, unauthorized access, and admin login.

## Phase 3: Onboarding and RBAC
- Complete customer onboarding states and validation.
- Implement admin pending-application list and detail.
- Implement approve/reject with reason and audit event in the same transaction.
- Ensure customers can access only their own profile, accounts, ledger, and transactions.
- Ensure customer cannot call any admin endpoint.
- Add IDOR and privilege-escalation tests.

## Phase 4: Accounts and ledger
- Implement account list/detail and admin account creation.
- Implement freeze/unfreeze with reason and audit.
- Implement internal synthetic transfer only.
- Store amounts in integer minor units (`BIGINT`, paise for INR).
- Use an atomic database transaction.
- Lock both accounts in deterministic order and re-check status/balance inside the transaction.
- Require idempotency key and request hash.
- Create one journal transaction and balanced debit/credit entries.
- Update any balance projection in the same transaction.
- Do not allow editing/deleting posted entries.
- Implement reversal as a new compensating transaction.
- Add reconciliation test comparing projected balance with journal-derived balance.
- Reject overdraw, frozen/closed account, invalid amount, wrong owner, invalid destination, same-account transfer, and duplicate-key payload mismatch.

## Phase 5: Admin, audit, and UI
- Admin overview with meaningful counts.
- User management with search and pagination.
- Onboarding review UI.
- Account management UI.
- Audit log UI with filters and pagination.
- Customer dashboard with account summary, recent activity, and transfer form.
- Show transfer receipt only after server confirmation.
- Add clear demo/synthetic-data notice.
- Design a consistent, modern fintech interface with accessible contrast, responsive layout, loading skeletons, empty states, validation messages, and confirmation dialogs.
- Do not spend time on decorative animations before core workflows work.

## Phase 6: Tests and deployment
- Run unit, integration, and E2E tests.
- Test customer-vs-customer isolation and customer-vs-admin access.
- Test concurrent transfer race conditions and idempotent retries.
- Test audit immutability and ledger balance invariant.
- Run migrations with migration credentials only.
- Confirm runtime database credentials are least privilege.
- Verify CORS, cookies, CSRF, HTTPS/proxy settings, and Redis behavior in deployed environment.
- Deploy and browser-test the live app.
- Produce `docs/VERIFICATION_REPORT.md` with exact evidence and known limitations.

## Architecture constraints
- Prefer existing React + TypeScript frontend, Node.js + Express + TypeScript backend, PostgreSQL, Prisma, and Redis if they already exist and are healthy.
- Use a modular monolith, not microservices.
- Keep controller/service/repository boundaries.
- Use Zod or the repository's established schema validation.
- Use OpenAPI/Swagger if feasible.
- Preserve current package manager and deployment provider unless a blocker justifies change.
- Avoid broad refactoring.

## Required output
1. Working code in the existing repository.
2. Reviewed migrations and seed script with synthetic demo data.
3. Updated `.env.example` containing variable names and safe placeholders only.
4. Updated README with local setup, migration, seed, run, test, bootstrap, and deployment instructions.
5. `docs/IMPLEMENTATION_STATUS.md`
6. `docs/VERIFICATION_REPORT.md`
7. API documentation.
8. Automated tests.
9. A concise demo walkthrough for judging.

## Execution rules
- Work in small, reviewable steps.
- Before each schema migration, explain the change and data impact.
- Never delete or reset a database without explicit approval.
- Never claim a feature is complete merely because code was generated.
- If blocked, report the exact error, likely cause, safe diagnostic steps, and alternatives.
- Do not silently skip tests.
- Do not fabricate credentials, URLs, test results, or deployment status.
- Ask before making destructive or irreversible changes.

## Start now
Begin with repository reconnaissance and the implementation status report. Then show me the minimal phase-by-phase plan and the first concrete blocker or task. Do not start by rewriting the entire application.
