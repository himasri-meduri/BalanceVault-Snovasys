# RBAC and Security Policy — BalanceVault

## 1. Authorization model
Use RBAC plus resource ownership checks. A role alone is not enough: CUSTOMER access must be constrained to resources owned by that customer.

| Capability | CUSTOMER | ADMIN | SUPER_ADMIN |
|---|---:|---:|---:|
| View own profile | Yes | Yes | Yes |
| Update own permitted profile | Yes | Yes | Yes |
| View own accounts | Yes | Yes | Yes |
| View own ledger | Yes | Yes | Yes |
| Initiate eligible demo transfer | Yes | No by default | No by default |
| Review onboarding | No | Yes | Yes |
| Create/freeze/unfreeze accounts | No | Yes | Yes |
| View audit events | No | Yes | Yes |
| Change user role | No | No | Yes |
| Bootstrap first admin | No | No | Out-of-band only |

System identities must be separate from human roles.

## 2. Mandatory authorization checks
- Authenticate before authorization.
- Resolve user and role from trusted server-side session.
- Check role on every admin route.
- Check resource ownership for every customer account/ledger/transaction request.
- Never accept `ownerUserId`, `role`, `createdBy`, or `isAdmin` as trusted client input.
- Prevent IDOR by using scoped queries and consistent 404/403 policy.
- Re-check account status and balance inside the transfer transaction.

## 3. Passwords and sessions
- Argon2id with parameters appropriate to hosting limits.
- Unique salt handled by password library.
- Never log or return password hashes.
- Use opaque random session tokens; store token hashes.
- Cookie flags: HttpOnly, Secure in production, SameSite=Lax/Strict, Path=/.
- Rotate on login and privilege changes.
- Revoke on logout, password reset, account disable, and role downgrade.
- Idle and absolute expiry.
- CSRF token or robust same-site strategy for cookie-authenticated mutations.
- Generic login failure response.

## 4. Web/API protections
- Zod validation and output serialization.
- CORS allowlist with credentials only for exact trusted origin.
- Helmet and secure headers.
- Rate limits on login, registration, onboarding submission, and transfer creation.
- Request body size limits.
- Parameterized ORM queries; no string-built SQL.
- Prevent mass assignment: map allowed fields explicitly.
- Avoid verbose production errors.
- Validate redirect destinations.
- Use HTTPS in deployment.
- Secrets only in hosting secret manager/environment, never committed.

## 5. Ledger protections
- Money as integer minor units.
- Transactional posting.
- Deterministic account locking order.
- Idempotency key and request hash.
- Double-entry balance invariant.
- Immutable posted records.
- Reversal entries, never edit/delete.
- Reconciliation between journal and any balance projection.
- Audit event in same transaction for sensitive mutations.
- No arbitrary admin balance editing endpoint. If a demo adjustment is needed, use a controlled, reasoned, audited journal transaction.

## 6. Audit policy
Audit at minimum:
- Registration and login security events (avoid sensitive payloads)
- Onboarding submission/approval/rejection
- Account creation/freeze/unfreeze/close
- Transfer posted/rejected where useful (avoid excessive sensitive data)
- Transaction reversal
- User status and role changes
- Admin bootstrap
- Relevant configuration changes

Audit record should include actor, action, entity, timestamp, request ID, reason, and redacted before/after fields. Audit events are append-only for the application runtime role.

## 7. Database privileges
- Separate migration/schema-owner credential from runtime application credential.
- Runtime role should not own schema/tables and should not be superuser.
- Grant only required SELECT/INSERT/UPDATE privileges.
- Deny UPDATE/DELETE on journal entries and audit events where feasible.
- Do not assume membership implies permission to administer another role.
- Before changing grants, inspect `pg_roles`, `pg_auth_members`, ownership, object grants, function EXECUTE grants, and `SET ROLE` behavior.
- Never solve permission errors by granting superuser or broad role administration.

## 8. First-admin bootstrap
- No public admin-registration route.
- Bootstrap through a one-time script or operator-controlled process.
- Require strong secret/configuration and verify no existing super-admin.
- Do not expose secret in logs or command history.
- Run with a narrowly scoped database identity that has only necessary permissions.
- Make operation auditable and safe to retry.
- Provide documented recovery procedure; do not silently create a second admin.

## 9. Demo warning
The UI and README must state: “Demo environment — synthetic data only. No real funds or bank integrations.” Do not market the app as a bank or claim compliance certification.
