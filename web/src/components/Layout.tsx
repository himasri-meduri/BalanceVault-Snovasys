import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { isAdminRole } from '../lib/format';
import { DemoBanner } from './DemoBanner';
import { StatusBadge } from './StatusBadge';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const {
    user,
    isBootstrapping,
    bootstrapError,
    sessionNotice,
    logout,
    clearSessionNotice,
  } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = async () => {
    setSigningOut(true);
    setLogoutError(null);
    try {
      await logout();
      setMobileMenuOpen(false);
      navigate('/login', { replace: true });
    } catch (err) {
      setLogoutError(
        err instanceof Error ? err.message : 'Unable to sign out cleanly. Try again.',
      );
    } finally {
      setSigningOut(false);
    }
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? 'bv-nav-link bv-nav-link--active' : 'bv-nav-link';

  return (
    <div className="bv-shell">
      <DemoBanner />
      <header className="bv-header">
        <div className="bv-container bv-header-inner">
          <Link
            to="/"
            className="bv-brand bv-brand-link"
            onClick={() => setMobileMenuOpen(false)}
          >
            <span className="bv-brand-mark" aria-hidden="true">
              BV
            </span>
            <div>
              <div className="bv-brand-name">BalanceVault</div>
              <div className="bv-brand-tagline">
                Auditable Synthetic Ledger &amp; Account Demo
              </div>
            </div>
          </Link>

          <button
            type="button"
            className="bv-mobile-toggle bv-button bv-button--secondary"
            aria-expanded={mobileMenuOpen}
            aria-controls="primary-navigation"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
          >
            {mobileMenuOpen ? 'Close Menu' : 'Menu'}
          </button>

          <div
            id="primary-navigation"
            className={`bv-header-nav-wrap ${mobileMenuOpen ? 'bv-header-nav-wrap--open' : ''}`}
          >
            <nav aria-label="Primary" className="bv-nav">
              {!user ? (
                <>
                  <NavLink
                    to="/"
                    end
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    System Status
                  </NavLink>
                  <NavLink
                    to="/login"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Sign In
                  </NavLink>
                  <NavLink
                    to="/register"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Register
                  </NavLink>
                </>
              ) : isAdminRole(user.role) ? (
                <>
                  <NavLink
                    to="/admin"
                    end
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Admin Overview
                  </NavLink>
                  <NavLink
                    to="/admin/onboarding"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Onboarding Review
                  </NavLink>
                  <NavLink
                    to="/admin/accounts"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Accounts
                  </NavLink>
                  <NavLink
                    to="/admin/users"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {user.role === 'SUPER_ADMIN' ? 'Users & Roles' : 'Users'}
                  </NavLink>
                  <NavLink
                    to="/admin/audit"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Audit Events
                  </NavLink>
                  <NavLink
                    to="/"
                    end
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Status
                  </NavLink>
                </>
              ) : (
                <>
                  <NavLink
                    to="/customer"
                    end
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Dashboard
                  </NavLink>
                  <NavLink
                    to="/onboarding"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Onboarding
                  </NavLink>
                  <NavLink
                    to="/accounts"
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Accounts
                  </NavLink>
                  <NavLink
                    to="/"
                    end
                    className={navClass}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Status
                  </NavLink>
                </>
              )}
            </nav>

            {user ? (
              <div className="bv-user-bar">
                <div className="bv-user-chip">
                  <span className="bv-user-name">{user.fullName}</span>
                  <StatusBadge value={user.role} />
                </div>
                <button
                  type="button"
                  className="bv-button bv-button--secondary"
                  onClick={() => void handleLogout()}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out...' : 'Sign Out'}
                </button>
              </div>
            ) : isBootstrapping ? (
              <span className="bv-nav-note">Checking session...</span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="bv-main">
        <div className="bv-container">
          {sessionNotice ? (
            <div className="bv-alert bv-alert--warning bv-mb-md" role="status">
              <div className="bv-alert-row">
                <span>{sessionNotice}</span>
                <button
                  type="button"
                  className="bv-button bv-button--ghost"
                  onClick={clearSessionNotice}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          {bootstrapError ? (
            <div className="bv-alert bv-alert--error bv-mb-md" role="alert">
              <strong>Session check unavailable:</strong> {bootstrapError}
            </div>
          ) : null}

          {logoutError ? (
            <div className="bv-alert bv-alert--error bv-mb-md" role="alert">
              <strong>Sign out error:</strong> {logoutError}
            </div>
          ) : null}

          {children}
        </div>
      </main>

      <footer className="bv-footer">
        <div className="bv-container">
          BalanceVault Hackathon Demonstration — Synthetic ledger entries only. Not a
          bank or payment service.
        </div>
      </footer>
    </div>
  );
}
