import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { StatusBadge } from '../components/StatusBadge';
import { SystemStatusCard } from '../components/SystemStatusCard';
import { getDefaultHomePath, isAdminRole } from '../lib/format';

export function OverviewPage() {
  const { user, isBootstrapping } = useAuth();

  return (
    <>
      <section className="bv-hero">
        <h1>BalanceVault</h1>
        <p>
          Secure account onboarding, strict server-side role &amp; ownership controls,
          and an auditable synthetic INR ledger foundation.
        </p>
      </section>

      <div className="bv-grid">
        <SystemStatusCard />

        <section className="bv-card" aria-labelledby="workspace-access-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="workspace-access-heading" className="bv-card-title">
                Workspace Access
              </h2>
              <p className="bv-card-subtitle">
                Session-authenticated Customer &amp; Administrator consoles backed by
                HttpOnly cookie auth and CSRF protection.
              </p>
            </div>
            {user ? <StatusBadge value={user.role} /> : null}
          </div>

          {isBootstrapping ? (
            <p className="bv-muted">Checking active session...</p>
          ) : user ? (
            <div className="bv-stack-sm">
              <p className="bv-muted">
                Signed in as <strong>{user.fullName}</strong> ({user.email}).
              </p>
              <div className="bv-actions-row">
                <Link
                  to={getDefaultHomePath(user.role)}
                  className="bv-button bv-button--primary"
                >
                  Open {isAdminRole(user.role) ? 'Admin Console' : 'Customer Dashboard'}
                </Link>
                {user.role === 'CUSTOMER' ? (
                  <>
                    <Link to="/onboarding" className="bv-button bv-button--secondary">
                      Onboarding Status
                    </Link>
                    <Link to="/accounts" className="bv-button bv-button--secondary">
                      Accounts &amp; Ledger
                    </Link>
                  </>
                ) : (
                  <>
                    <Link to="/admin/onboarding" className="bv-button bv-button--secondary">
                      Review Onboarding Queue
                    </Link>
                    <Link to="/admin/accounts" className="bv-button bv-button--secondary">
                      Accounts &amp; Reversals
                    </Link>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="bv-stack-sm">
              <p className="bv-muted">
                Sign in with an existing account or register as a synthetic demo customer
                to submit an onboarding profile.
              </p>
              <div className="bv-actions-row">
                <Link to="/login" className="bv-button bv-button--primary">
                  Sign In
                </Link>
                <Link to="/register" className="bv-button bv-button--secondary">
                  Create Customer Account
                </Link>
              </div>
            </div>
          )}

          <ul className="bv-list">
            <li>
              Opaque HttpOnly <code>bv_sid</code> sessions, Argon2id, CSRF &amp; Redis rate
              limiting
            </li>
            <li>Customer onboarding workflow &amp; admin approval with audit trail</li>
            <li>
              RBAC &amp; <code>SUPER_ADMIN</code> role governance + append-only{' '}
              <code>AuditEvent</code> viewer
            </li>
            <li>
              Double-entry synthetic INR accounts, idempotent internal transfers, account
              lifecycle holds &amp; compensating reversals
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
