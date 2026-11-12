# Test Plan and Definition of Done

## 1. Test layers
- Unit: validators, policy decisions, ledger balancing, money conversion.
- Integration: API + test PostgreSQL + Redis where needed.
- Browser/E2E: Playwright for registration, onboarding, admin approval, account and transfer flows.
- Deployment smoke: health, readiness, login, role checks, core workflow.

## 2. Critical tests

### Authentication
- Valid registration creates CUSTOMER only.
- Duplicate normalized email rejected.
- Password hash differs from plaintext and is never returned.
- Valid login creates session.
- Invalid login returns generic error.
- Logout revokes session.
- Disabled user cannot log in or use old session.
- Rate limit is enforced.

### RBAC / ownership
- Customer cannot call admin routes.
- Customer A cannot read Customer B's account.
- Customer A cannot read Customer B's ledger or transaction.
- Client cannot self-assign ADMIN/SUPER_ADMIN.
- Only SUPER_ADMIN can change roles.
- Unauthenticated request returns 401.

### Onboarding
- New application starts PENDING.
- Customer cannot approve own application.
- Admin can approve pending application.
- Admin can reject only with reason.
- Invalid state transitions return conflict.
- Approval/rejection creates audit event.

### Accounts
- Account can only be created for eligible customer.
- Customer sees only own accounts.
- Frozen/closed accounts cannot transfer.
- Freeze/unfreeze requires reason and creates audit event.

### Ledger
- Valid transfer creates one transaction and balanced debit/credit entries.
- Amount must be positive.
- Insufficient funds rejected.
- Same-account transfer rejected.
- Duplicate idempotency key does not duplicate posting.
- Reusing key with different payload rejected.
- Concurrent transfers cannot overdraw.
- Posted journal entries cannot be updated/deleted by app runtime role.
- Reversal creates a new opposite transaction and leaves original unchanged.
- Balance projection equals journal-derived balance.

### Audit
- Sensitive admin actions create events.
- Audit event includes actor, action, entity, timestamp, request ID.
- Secrets and password data are not recorded.
- Runtime application role cannot edit/delete audit events where DB grants enforce it.

### Health
- `/health` responds when process is alive.
- `/ready` fails when required DB/Redis dependency is unavailable.
- Readiness output contains no credentials or connection strings.

## 3. Manual browser walkthrough
Use synthetic seed accounts:
- one SUPER_ADMIN
- one ADMIN (optional)
- two CUSTOMER users
- at least two active accounts
- one frozen account
- one pending onboarding application

Walkthrough:
1. Log in as customer; verify own dashboard.
2. Attempt another customer's account URL; verify denial.
3. Log in as admin; approve pending customer.
4. Create account for approved customer.
5. Log in as customer; perform transfer.
6. Verify debit and credit ledger rows and matching reference.
7. Retry same request; verify no duplicate.
8. Attempt overdraw; verify rejection.
9. Freeze account; verify transfer blocked.
10. Inspect audit log as admin.
11. Verify customer cannot access audit endpoint.
12. Test logout and expired/revoked session.

## 4. Definition of done
A feature is done only when:
- UI exists and handles loading/error/empty/success.
- API and server-side authorization work.
- Database migration is included.
- Relevant automated tests pass.
- Browser walkthrough is completed where applicable.
- No secrets or sensitive data leak.
- Documentation reflects actual behavior.

## 5. Verification reporting
Use these labels:
- `IMPLEMENTED`: code exists.
- `TESTED`: automated or manual test passed.
- `LIVE-VERIFIED`: tested against deployed environment.
- `NOT VERIFIED`: not yet proven.
Never describe `IMPLEMENTED` as `LIVE-VERIFIED`.
