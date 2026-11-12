# Same-Day Build Plan — November 11, 2026

## Guiding strategy
Do not attempt to finish every conceivable feature. Build one reliable end-to-end vertical slice, then add admin and audit functionality. Preserve working code. Antigravity must inspect before editing.

## Phase 0 — Repository reconnaissance (30–45 min)
- Inspect root files, workspaces, package scripts, Prisma schema/migrations, API routes, auth/session implementation, Redis integration, env names, deployment configuration.
- Run existing tests, lint, typecheck, build.
- Inspect the deployed demo if accessible.
- Produce `docs/IMPLEMENTATION_STATUS.md` listing implemented, broken, missing, and unverified items.
- Do not change architecture until this report exists.

Exit: baseline commands and actual architecture documented.

## Phase 1 — Stabilize foundation (45–60 min)
- Fix startup, env validation, database connection, migrations, Redis configuration.
- Verify health and readiness behavior.
- Verify session login/logout and `/auth/me`.
- Verify first-admin bootstrap path in local development.
- Add/repair seed data.

Exit: frontend and API start locally; admin can log in; no secrets in repository.

## Phase 2 — Onboarding and RBAC (60–75 min)
- Complete customer registration.
- Ensure public registration always assigns CUSTOMER.
- Implement pending onboarding state.
- Admin list, detail, approve/reject.
- Enforce server-side role and ownership checks.
- Add tests for privilege escalation and IDOR.

Exit: customer can register; admin can approve; customer cannot access admin endpoints.

## Phase 3 — Accounts and ledger (75–100 min)
- Account listing and details with ownership checks.
- Admin account creation and freeze/unfreeze.
- Implement internal synthetic transfer with double-entry journal.
- Add idempotency and transaction/concurrency safeguards.
- Add ledger history and balance reconciliation test.

Exit: transfer posts balanced entries exactly once; insufficient funds/frozen account rejected.

## Phase 4 — Audit and admin UX (45–60 min)
- Audit events for onboarding, account, transfer, role actions.
- Admin audit page with filters/pagination.
- Admin dashboard summary.
- Add empty/loading/error states and confirmation dialogs.

Exit: sensitive actions are visible in append-only audit history.

## Phase 5 — E2E, deployment, evidence (60–90 min)
- Run lint, typecheck, unit/integration/E2E tests.
- Run migration on target database using migration credentials.
- Confirm runtime DB credentials are least privilege.
- Deploy API, then frontend.
- Browser-test live login, onboarding, admin approval, transfer, audit.
- Record exact verified status and remaining limitations.

Exit: demo script works on deployed environment, or limitations are explicitly listed.

## If time is short
Priority order:
1. Admin bootstrap and login
2. Registration and onboarding approval
3. Customer/admin RBAC and ownership isolation
4. Account creation/listing
5. Simulated double-entry transfer
6. Audit log
7. Visual polish and analytics

Do not sacrifice authorization, ledger correctness, or honest verification to add cosmetic features.
