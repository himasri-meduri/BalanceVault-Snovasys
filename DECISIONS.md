# Architecture Decision Records

## ADR-001: Modular monolith
Decision: Keep one backend API with clear domain modules.
Reason: Same-day delivery, simpler deployment and transactions, less operational overhead.
Revisit only when scaling needs justify service separation.

## ADR-002: PostgreSQL is source of truth
Decision: PostgreSQL stores users, sessions, onboarding, accounts, journal entries, and audit events.
Reason: ACID transactions and relational integrity are essential for the demo's account/ledger model.

## ADR-003: Double-entry ledger
Decision: Represent transfers as immutable debit/credit journal entries.
Reason: A balance is provable from entries; edits to a mutable balance alone are not auditable.
Invariant: total debits equal total credits per posted transaction.

## ADR-004: Integer minor-unit money
Decision: Store money as integer paise using BIGINT.
Reason: Avoid floating-point rounding errors.
API representation: decimal string in minor units.

## ADR-005: Opaque server-side sessions
Decision: Prefer secure cookie-backed server-side sessions if compatible with existing implementation.
Reason: Revocation and privilege changes are straightforward.
Constraint: If existing JWT auth is already implemented, inspect and assess before replacing it.

## ADR-006: One-time out-of-band admin bootstrap
Decision: First SUPER_ADMIN is created through a controlled operator process, never public registration.
Reason: Prevent privilege escalation and public admin creation.

## ADR-007: Synthetic data only
Decision: No real funds, bank integrations, KYC documents, or external payment rails.
Reason: This is a hackathon demonstration, not a regulated financial product.

## ADR-008: Preserve working implementation
Decision: Inspect repository and deployed behavior before making changes.
Reason: Avoid destroying existing migrations, auth, role grants, or deployment configuration.
