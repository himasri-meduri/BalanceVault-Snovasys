# Product Requirements — BalanceVault

## 1. Product summary
BalanceVault is a secure account-management web application with onboarding, role-based access, auditable administrative operations, and a provable double-entry ledger. The hackathon build uses synthetic data and simulated internal transfers only.

## 2. Goals
1. Demonstrate secure registration, login, logout, and session handling.
2. Demonstrate account-holder onboarding and administrator approval.
3. Enforce role and resource-level authorization on the server.
4. Represent money movement as immutable, balanced journal postings.
5. Provide an audit trail for sensitive actions.
6. Provide a usable user dashboard and administrator console.
7. Make deployment status and verification evidence transparent.

## 3. Out of scope
- Real deposits, withdrawals, payment rails, UPI, cards, or bank integrations.
- Real KYC/AML decisions or regulatory compliance claims.
- Lending, interest, investment, or foreign exchange.
- Production-grade banking guarantees or certification.
- Sending money to external accounts.
- Storing real identity documents or sensitive financial information.

## 4. Personas and roles
- `CUSTOMER`: completes own profile, views own accounts and ledger activity, performs permitted simulated transfers between eligible demo accounts.
- `ADMIN`: reviews onboarding, manages users and accounts, views audit logs, performs permitted administrative account actions.
- `SUPER_ADMIN`: restricted bootstrap/administrative role management. Must not be self-assigned through public registration.
- `SYSTEM`: internal service identity for narrowly scoped system actions; not a human login.

Default public registration role is always `CUSTOMER`.

## 5. Functional requirements

### Authentication
- Register using name, email, and password.
- Normalize email consistently and enforce uniqueness.
- Hash passwords with Argon2id (or a documented secure fallback).
- Login creates a server-managed session.
- Logout revokes the current session.
- Rate-limit login and registration.
- Return generic authentication errors to reduce account enumeration.
- Provide session identity endpoint (`GET /api/auth/me`).

### Onboarding
- New customer starts with status `PENDING`.
- Customer can view and update permitted profile fields while pending.
- Admin can approve or reject with a reason.
- Approval and rejection create audit events.
- Only approved customers can receive an active account or initiate demo transfers, according to policy.
- Rejected applications can be resubmitted only through an explicit documented transition.

### Accounts
- Admin or approved workflow creates a customer account.
- Customer can view only accounts they own.
- Account status: `PENDING`, `ACTIVE`, `FROZEN`, `CLOSED`.
- Frozen or closed accounts cannot send or receive demo transfers.
- Account number/reference is unique and must not expose sequential database IDs.
- Balance is derived from posted ledger entries or maintained as a transactionally updated projection that can be reconciled against the ledger. The ledger is the source of truth.

### Ledger and simulated transfers
- Use a double-entry journal.
- A transfer creates one journal transaction and at least two entries: debit source account, credit destination account.
- Total debits must equal total credits.
- Amount must be a positive integer in minor units.
- Reject insufficient funds.
- Reject same-account transfers unless explicitly supported and safely modeled.
- Use an idempotency key for transfer creation.
- Prevent duplicate posting on retry.
- Use a database transaction and row-level locking or equivalent concurrency protection.
- Posted entries cannot be edited or deleted.
- Reverse a posted transaction with a separate compensating transaction.
- Show reference, date, amount, direction, status, and description.

### Administration
- Admin dashboard summary: customer counts, pending onboarding, active accounts, frozen accounts, demo transaction count.
- Search and paginate users.
- View user detail and onboarding status.
- Approve/reject onboarding.
- Freeze/unfreeze accounts with a reason.
- View audit events with filters and pagination.
- Role changes restricted to `SUPER_ADMIN` and always audited.

### System
- `GET /health`: process liveness only.
- `GET /ready`: dependency readiness for database and Redis, without leaking secrets.
- Structured logs with request/correlation IDs.
- Central error handler.
- OpenAPI documentation for implemented routes.

## 6. Non-functional requirements
- Server-side authorization for every protected operation.
- Validate all request bodies, query parameters, and path parameters.
- Use secure, HTTP-only, SameSite cookies for sessions in production.
- CSRF protection for cookie-authenticated state-changing requests.
- CORS allowlist; never wildcard credentials.
- Helmet/security headers and appropriate content security policy.
- Redis-backed rate limits where configured; fail safely if Redis is required for a security control.
- Database least privilege; separate migration/owner role from runtime application role.
- No sensitive data in logs.
- Accessible, responsive UI with loading, empty, error, and success states.
- Automated unit, integration, and browser tests.

## 7. UX requirements
- Clean fintech visual language; trustworthy, restrained, accessible.
- Desktop-first responsive dashboard, still usable on mobile.
- Clear status chips and confirmation for sensitive actions.
- Never display a success state before the API confirms success.
- Show synthetic/demo environment notice in the app.
- Use skeleton/loading states and meaningful empty states.
- Tables support search, filters, pagination, and clear labels.
- Avoid showing raw database IDs to end users.

## 8. Acceptance criteria
The release candidate is accepted only when:
1. A new user can register, log in, complete onboarding, and see pending status.
2. An authorized admin can approve the user.
3. An account can be created for an approved user.
4. The customer can see only their own account and activity.
5. A valid simulated transfer posts balanced journal entries.
6. Invalid, duplicate, unauthorized, or insufficient-funds transfers are rejected.
7. A frozen account cannot transfer.
8. A posted transaction cannot be modified or deleted.
9. Admin actions produce audit records.
10. Admin endpoints reject customer access.
11. Health/readiness endpoints report accurate status.
12. The core flows pass automated tests and a browser walkthrough.
13. Deployment status and known limitations are documented honestly.
