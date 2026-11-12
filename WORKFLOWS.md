# User Workflows and State Machines

## 1. Registration and onboarding
1. Visitor submits name, email, password.
2. API validates, normalizes email, hashes password.
3. Create CUSTOMER user and onboarding application in one transaction.
4. Create session or require explicit login (choose one consistent UX).
5. Customer sees `PENDING` onboarding state.
6. Customer completes permitted profile fields and submits.
7. Admin reviews application.
8. Admin approves or rejects with reason.
9. Every state-changing action creates an audit event.

State transitions:
- `DRAFT -> PENDING`
- `PENDING -> APPROVED`
- `PENDING -> REJECTED`
- `REJECTED -> DRAFT` only through explicit resubmission policy
- No direct customer transition to APPROVED.

## 2. Account lifecycle
- Admin creates account only for eligible/approved customer.
- New account status is ACTIVE or PENDING according to implementation policy.
- Admin can freeze active account with a reason.
- Admin can unfreeze frozen account with a reason.
- Close only when policy allows (for demo, preferably balance is zero).
- Closed accounts cannot be reopened through ordinary customer actions.

Transitions:
- `PENDING -> ACTIVE`
- `ACTIVE -> FROZEN`
- `FROZEN -> ACTIVE`
- `ACTIVE -> CLOSED` only when close policy passes
- `FROZEN -> CLOSED` only when close policy passes

## 3. Simulated internal transfer
1. Customer opens transfer form.
2. UI loads eligible owned source accounts.
3. Customer enters destination public reference and amount.
4. UI validates basic format; server validates everything authoritatively.
5. UI sends `Idempotency-Key`.
6. Server verifies session, onboarding, ownership, account states, currency, amount and balance.
7. Database transaction locks both accounts in deterministic order.
8. Server rechecks balance and creates transaction + debit/credit entries + balance projection changes + audit event.
9. Commit.
10. UI displays confirmed receipt and updated ledger.
11. On retry, same idempotency key returns original result, not a duplicate transfer.

Failure scenarios:
- Insufficient funds
- Frozen/closed source or destination
- Destination not found
- Same source and destination
- Customer not approved
- Duplicate idempotency key with changed payload
- Concurrent transfers causing insufficient funds
- Database/Redis unavailable

## 4. Admin review
1. Admin logs in.
2. Admin opens pending applications.
3. Admin views minimum necessary application data.
4. Admin approves/rejects with reason.
5. API verifies ADMIN/SUPER_ADMIN and current application state.
6. Update application and audit event atomically.
7. UI refreshes status and summary.

## 5. Audit inspection
1. Admin opens audit page.
2. API checks admin role.
3. Filters by action, actor, entity, date range.
4. Paginated results show timestamp, actor, action, target, reason, request ID.
5. Sensitive values are redacted.
6. No edit/delete UI exists.

## 6. First admin bootstrap
1. Operator reviews deployment environment and DB roles.
2. Operator runs documented one-time bootstrap script.
3. Script verifies preconditions and required grants.
4. Script creates/activates first SUPER_ADMIN.
5. Script records completion.
6. Operator logs in through the normal login flow.
7. Verify `/api/auth/me` returns expected role and admin UI is authorized.
8. Disable/remove bootstrap secret after success.
