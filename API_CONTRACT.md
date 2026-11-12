# API Contract — BalanceVault

Base path: `/api`. JSON responses. Use a consistent envelope or the existing repository convention; do not introduce two response styles.

## Common conventions
- Authentication via secure session cookie.
- `X-Request-Id` accepted/generated and returned.
- State-changing requests require CSRF protection.
- Validate all inputs with Zod.
- Use pagination: `page`, `pageSize` (cap pageSize, e.g. 100).
- Money fields are integer minor-unit strings, e.g. `"12500"` means ₹125.00.
- Errors: stable machine-readable `code`, safe `message`, optional `fieldErrors`.
- Never expose stack traces, SQL errors, secrets, password hashes, or internal role data.

## Auth
| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | Public | Create CUSTOMER and pending onboarding |
| POST | `/auth/login` | Public | Authenticate and create session |
| POST | `/auth/logout` | Authenticated | Revoke current session |
| GET | `/auth/me` | Authenticated | Current user summary |
| POST | `/auth/forgot-password` | Optional demo scope | Only implement with safe token flow; otherwise omit |

## Onboarding
| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/onboarding/me` | Customer | Own application |
| PATCH | `/onboarding/me` | Customer | Update allowed profile fields |
| POST | `/onboarding/me/submit` | Customer | Submit for review |
| GET | `/admin/onboarding` | Admin | List/filter applications |
| POST | `/admin/onboarding/:id/approve` | Admin | Approve with audit |
| POST | `/admin/onboarding/:id/reject` | Admin | Reject with reason and audit |

## Accounts
| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/accounts` | Customer/Admin | Customer sees own; admin sees permitted list |
| GET | `/accounts/:id` | Owner or Admin | Account details |
| POST | `/admin/accounts` | Admin | Create account for approved customer |
| POST | `/admin/accounts/:id/freeze` | Admin | Freeze with reason |
| POST | `/admin/accounts/:id/unfreeze` | Admin | Unfreeze with reason |
| POST | `/admin/accounts/:id/close` | Admin | Close with reason and policy checks |

## Ledger / demo transfers
| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/accounts/:id/ledger` | Owner or Admin | Paginated account entries |
| GET | `/transactions/:id` | Participant or Admin | Transaction detail |
| POST | `/transfers` | Approved customer | Simulated internal transfer |
| POST | `/transactions/:id/reverse` | Admin/Super Admin policy | Compensating reversal with reason |

### POST `/transfers` request
```json
{
  "sourceAccountId": "uuid",
  "destinationAccountReference": "public-reference",
  "amountMinor": "12500",
  "description": "Demo transfer"
}
```
Required header: `Idempotency-Key: <high-entropy-client-generated-value>`

Server must:
- Derive initiating user from session.
- Verify source account ownership.
- Verify both accounts are ACTIVE and same currency.
- Verify onboarding/eligibility.
- Verify positive bounded amount.
- Lock/re-read balance inside transaction.
- Reject insufficient funds.
- Insert journal header and debit/credit entries.
- Update balance projections in same transaction if used.
- Insert audit event.
- Return the original result for a repeated identical idempotency key; reject reuse with a different request hash.

## Admin and audit
| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/admin/users` | Admin | Search/paginate users |
| GET | `/admin/users/:id` | Admin | User details |
| PATCH | `/admin/users/:id/status` | Admin/Super Admin policy | Enable/disable with reason |
| PATCH | `/admin/users/:id/role` | Super Admin only | Role change, audited |
| GET | `/admin/audit-events` | Admin | Filtered audit trail |

## System
| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Liveness |
| GET | `/ready` | Public or internal | Dependency readiness, no secrets |

## Suggested status codes
- 200 success
- 201 created
- 400 malformed/validation error
- 401 unauthenticated
- 403 authenticated but unauthorized
- 404 missing or intentionally concealed resource
- 409 conflict, duplicate idempotency key, invalid state transition
- 422 business-rule rejection (e.g. insufficient funds), if consistently used
- 429 rate limited
- 500 generic internal error
- 503 required dependency unavailable

Do not build every endpoint if time is limited. Prioritize the vertical slice in `BUILD_PLAN.md`.
