# API Documentation — BalanceVault

> **Demo Notice:** Demo environment — synthetic INR data only (integer minor units / paise, `1 INR = 100 paise`). No real funds, real KYC, or real bank integrations.

Machine-readable OpenAPI 3.0.3 JSON is served live by the API at **`GET /api/openapi.json`** (and referenced from `GET /api`).

---

## 1. Conventions, Auth, CSRF & Errors

- **Base URL:** `http://localhost:4000/api` locally (`https://<your-render-api>/api` in deployment).
- **Session Cookie:** `bv_sid` (`HttpOnly`, `Path=/`, `Secure` in production). Requests from browsers must set `credentials: 'include'`.
- **CSRF Protection:** All authenticated state-changing requests (`POST`, `PATCH`, `PUT`, `DELETE`) require header `X-CSRF-Token: <token>` returned in `/api/auth/register`, `/api/auth/login`, and `/api/auth/me` (and verified against `Origin === APP_ORIGIN` when `Origin` is present). Authentication runs before CSRF validation.
- **Request Correlation:** `X-Request-Id` is propagated or generated on every response.
- **Money Format:** All ledger balances and transfer amounts use positive or non-negative integer minor-unit strings (e.g. `"150050"` = `₹1,500.50` paise, bounded at `1,000,000,000` paise per synthetic operation).
- **Standard Error Envelope:**
  ```json
  {
    "error": {
      "code": "STRING_ERROR_CODE",
      "message": "Human-readable safe message",
      "fieldErrors": { "field": ["Reason"] },
      "requestId": "uuid"
    }
  }
  ```

---

## 2. Implemented Endpoints Reference

### 2.1 System & OpenAPI
| Method | Path | Auth / Role | Rate Limit | Response |
|---|---|---|---|---|
| `GET` | `/health`, `/api/health` | Public | None | `200` process liveness (`status: "ok"`) |
| `GET` | `/ready`, `/api/ready` | Public | None | `200` (`ready`, `database: "ok"`, `redis: "ok"`) or `503` (`degraded`) |
| `GET` | `/api` | Public | None | `200` service metadata + `openApiUrl` |
| `GET` | `/api/openapi.json` | Public | None | `200` OpenAPI `3.0.3` specification JSON |

### 2.2 Authentication & Sessions
| Method | Path | Auth / Role | CSRF | Rate Limit | Key Semantics & Errors |
|---|---|---|---|---|---|
| `POST` | `/api/auth/register` | Public | No | `10 / 15m` per IP | Creates `CUSTOMER` (`ACTIVE`) + `PENDING` (`submittedAt: null`) onboarding + session + `AUTH_REGISTER` audit (`201`). Rejects extra fields (`400`) & duplicate email (`409 EMAIL_ALREADY_EXISTS`). |
| `POST` | `/api/auth/login` | Public | No | `15 / 15m` per IP | Rotates previous session if cookie supplied, issues `bv_sid` + `csrfToken` (`200`). Unknown email / bad password / `DISABLED` / `LOCKED` all return generic `401 Invalid email or password`. |
| `POST` | `/api/auth/logout` | Any Authenticated | Yes | None | Revokes current session & clears `bv_sid` (`200 { loggedOut: true }`). |
| `GET` | `/api/auth/me` | Any Authenticated | No | None | Returns safe `user` summary (`id, email, fullName, role, status, onboardingStatus`) and fresh session-bound `csrfToken` (`200`). |

### 2.3 Customer Onboarding (`CUSTOMER` Only)
| Method | Path | Auth / Role | CSRF | Rate Limit | Key Semantics & Errors |
|---|---|---|---|---|---|
| `GET` | `/api/onboarding/me` | `CUSTOMER` | No | None | Returns customer's onboarding application & status. |
| `PATCH` | `/api/onboarding/me` | `CUSTOMER` | Yes | None | Updates draft fields (`contactReference`, `city`, `country`, `accountPurpose`, `acceptedSyntheticTerms`) while unsubmitted `PENDING`/`DRAFT`/`NEEDS_INFORMATION`, or reopens `REJECTED` via `{ reopenForResubmission: true }`. Locked once submitted `PENDING` (`409`) or `APPROVED` (`409`). |
| `POST` | `/api/onboarding/me/submit` | `CUSTOMER` | Yes | `10 / 15m` per `userId` | Validates complete fields + `acceptedSyntheticTerms: true` and submits to `PENDING` (`submittedAt` set). Supports direct resubmission from `REJECTED` with `{ ..., resubmit: true }` (`ONBOARDING_RESUBMITTED` audit). |

### 2.4 Admin Onboarding Review (`ADMIN`, `SUPER_ADMIN`)
| Method | Path | Auth / Role | CSRF | Query / Body / Key Semantics |
|---|---|---|---|---|
| `GET` | `/api/admin/onboarding`, `/api/admin/onboarding/applications` | `ADMIN`, `SUPER_ADMIN` | No | Query: `status`, `search`, `page` (>=1), `pageSize` (1..100). Returns paginated applications with applicant summary. |
| `GET` | `/api/admin/onboarding/applications/:id` | `ADMIN`, `SUPER_ADMIN` | No | Returns single onboarding application detail (`404` if missing). |
| `POST` | `/api/admin/onboarding/applications/:id/approve`, `/api/admin/onboarding/:id/approve` | `ADMIN`, `SUPER_ADMIN` | Yes | Optional `{ reason }` (`3..500` chars). Requires submitted `PENDING` + `acceptedSyntheticTerms: true`. Atomic CAS update + `ONBOARDING_APPROVED` audit (`409` on unsubmitted or concurrent race). |
| `POST` | `/api/admin/onboarding/applications/:id/reject`, `/api/admin/onboarding/:id/reject` | `ADMIN`, `SUPER_ADMIN` | Yes | Mandatory `{ reason }` (`10..500` chars). Permits `PENDING` or `NEEDS_INFORMATION`. Atomic CAS update + `ONBOARDING_REJECTED` audit (`200` / `409`). |

### 2.5 Accounts, Double-Entry Ledger, Transfers & Reversals
| Method | Path | Auth / Role | CSRF | Rate Limit | Key Semantics & Errors |
|---|---|---|---|---|---|
| `GET` | `/api/accounts` | `CUSTOMER`, `ADMIN`, `SUPER_ADMIN` | No | None | Customers see **only** their own `CUSTOMER` accounts (`403` if querying another `ownerUserId`). Admins can search/filter by `status`, `search`, `ownerUserId`, and `includeSystem=true` (shows `BV-SYS-TREASURY-01`). |
| `GET` | `/api/accounts/:id` | Owner or Admin | No | None | Returns account detail (`404` concealed if customer does not own account or system account). |
| `GET` | `/api/accounts/:id/ledger` | Owner or Admin | No | None | Query: `page`, `pageSize`, `direction` (`DEBIT`/`CREDIT`), `type` (`DEMO_TRANSFER`/`REVERSAL`/`ADJUSTMENT`). Returns paginated `JournalEntry` rows with `counterpartyReference`. (`404` if not owner/admin). |
| `POST` | `/api/transfers` | `CUSTOMER` (ACTIVE + `APPROVED` onboarding) | Yes | `20 / 15m` per `userId` | Required header: `Idempotency-Key` (`16..128` chars matching `^[A-Za-z0-9._:-]+$`). Body: `{ sourceAccountId, destinationAccountReference, amountMinor, description }`. Acquires deterministic ordered `FOR UPDATE` row locks, checks `ACTIVE` statuses & sufficient funds, posts 2 balanced entries + `TRANSFER_POSTED` audit + `IdempotencyRecord` (`201`). Replays identical retry (`X-Idempotent-Replay: true`); rejects different payload (`409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`), insufficient funds (`422 INSUFFICIENT_FUNDS`), same account (`422 SAME_ACCOUNT_TRANSFER`), non-active account (`409 ACCOUNT_NOT_ACTIVE`), IDOR source/dest (`404`), Redis down (`503`). |
| `GET` | `/api/transactions/:id` | Participant or Admin | No | None | Returns balanced journal entries & reversal links (`404` if customer is not participant). Counterparty `accountId` & `accountName` are redacted to `null` for `CUSTOMER` viewers. |
| `POST` | `/api/transactions/:id/reverse` | `ADMIN`, `SUPER_ADMIN` | Yes | None | Mandatory `{ reason }` (`10..500` chars). Creates a compensating `REVERSAL` transaction without altering original rows, updates balances under `FOR UPDATE` lock (`409` if already reversed, target is `REVERSAL`, or `CLOSED` account; `422 INSUFFICIENT_FUNDS_FOR_REVERSAL` if recipient lacks funds), logs `TRANSACTION_REVERSED` audit (`201`). |
| `POST` | `/api/admin/accounts` | `ADMIN`, `SUPER_ADMIN` | Yes | None | Body: `{ ownerUserId, accountName, initialStatus: "ACTIVE"|"PENDING", initialCreditMinor?, reason }`. Requires customer `ACTIVE` + `APPROVED` (`409 CUSTOMER_NOT_ELIGIBLE`). Allocates `BV-XXXX-XXXX`; if `initialCreditMinor > 0`, posts balanced `ADJUSTMENT` from `BV-SYS-TREASURY-01` + `ACCOUNT_CREATED` audit (`201`). |
| `POST` | `/api/admin/accounts/:id/activate` | `ADMIN`, `SUPER_ADMIN` | Yes | None | `{ reason }` (`5..500` chars). `PENDING -> ACTIVE` + `ACCOUNT_ACTIVATED` audit (`200`/`409`). |
| `POST` | `/api/admin/accounts/:id/freeze` | `ADMIN`, `SUPER_ADMIN` | Yes | None | `{ reason }` (`10..500` chars). `ACTIVE -> FROZEN` + `ACCOUNT_FROZEN` audit (`200`/`409`). |
| `POST` | `/api/admin/accounts/:id/unfreeze` | `ADMIN`, `SUPER_ADMIN` | Yes | None | `{ reason }` (`5..500` chars). `FROZEN -> ACTIVE` + `ACCOUNT_UNFROZEN` audit (`200`/`409`). |
| `POST` | `/api/admin/accounts/:id/close` | `ADMIN`, `SUPER_ADMIN` | Yes | None | `{ reason }` (`10..500` chars). Requires `balanceMinor == "0"` (`409 ACCOUNT_BALANCE_NON_ZERO`) & protects `SYSTEM_ISSUANCE` (`409 SYSTEM_ACCOUNT_PROTECTED`). `ACTIVE/FROZEN -> CLOSED` + `ACCOUNT_CLOSED` audit. |

### 2.6 Admin Dashboard Summary, User Governance & Audit Trail
| Method | Path | Auth / Role | CSRF | Query / Body / Key Semantics |
|---|---|---|---|---|
| `GET` | `/api/admin/summary` | `ADMIN`, `SUPER_ADMIN` | No | Returns aggregate KPI counts (`customersTotal`, `pendingOnboarding`, `approvedOnboarding`, `rejectedOnboarding`, `activeAccounts`, `frozenAccounts`, `pendingAccounts`, `closedAccounts`, `demoTransactionsTotal`, `auditEventsTotal`). |
| `GET` | `/api/admin/users` | `ADMIN`, `SUPER_ADMIN` | No | Query: `page`, `pageSize`, `search` (name/email), `role`, `status`. Returns safe user summaries (`passwordHash` omitted). |
| `GET` | `/api/admin/users/:id` | `ADMIN`, `SUPER_ADMIN` | No | Returns safe user detail (`accountCount`, `activeAccountCount`, onboarding timestamps/review reason; never exposes secrets/hashes). |
| `PATCH` | `/api/admin/users/:id/status` | `ADMIN`, `SUPER_ADMIN` | Yes | `{ status: "ACTIVE"|"DISABLED"|"LOCKED", reason }` (`5..500` chars). Blocks self-disable/lock (`409`), restricts non-`CUSTOMER` targets to `SUPER_ADMIN` (`403`), protects last active `SUPER_ADMIN` (`409`), revokes active sessions & logs `USER_STATUS_CHANGE`. |
| `PATCH` | `/api/admin/users/:id/role` | `SUPER_ADMIN` only | Yes | `{ role: "CUSTOMER"|"ADMIN"|"SUPER_ADMIN", reason }` (`5..500` chars). Protects last active `SUPER_ADMIN` (`409`), revokes target's sessions, logs `USER_ROLE_CHANGE`. |
| `GET` | `/api/admin/audit-events` | `ADMIN`, `SUPER_ADMIN` | No | Query: `page`, `pageSize`, `action`, `entityType`, `actorUserId` (UUID), `from`, `to` (ISO date `YYYY-MM-DD` or timestamp; `from <= to`). Returns redacted append-only `AuditEvent` records. |
