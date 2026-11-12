import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { getDefaultHomePath, sanitizeInternalRedirectPath } from '../lib/format';
import type { UserRole } from '../lib/types';
import { ForbiddenPage } from '../pages/ForbiddenPage';

function AuthLoadingState() {
  return (
    <section className="bv-card" aria-busy="true" aria-label="Verifying session">
      <div className="bv-skeleton-stack">
        <div className="bv-skeleton-line" />
        <div className="bv-skeleton-line" />
        <div className="bv-skeleton-line" />
      </div>
      <p className="bv-muted bv-mt-sm">Verifying active session...</p>
    </section>
  );
}

export function RequireAuth() {
  const { user, isBootstrapping } = useAuth();
  const location = useLocation();

  if (isBootstrapping) {
    return <AuthLoadingState />;
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <Outlet />;
}

interface RequireRoleProps {
  allowedRoles: UserRole[];
}

export function RequireRole({ allowedRoles }: RequireRoleProps) {
  const { user, isBootstrapping } = useAuth();
  const location = useLocation();

  if (isBootstrapping) {
    return <AuthLoadingState />;
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  if (!allowedRoles.includes(user.role)) {
    return <ForbiddenPage allowedRoles={allowedRoles} currentRole={user.role} />;
  }

  return <Outlet />;
}

export function GuestOnly() {
  const { user, isBootstrapping } = useAuth();
  const location = useLocation();

  if (isBootstrapping) {
    return <AuthLoadingState />;
  }

  if (user) {
    const state = location.state as { from?: unknown } | null;
    const defaultHome = getDefaultHomePath(user.role);
    const target = sanitizeInternalRedirectPath(state?.from, defaultHome);
    return <Navigate to={target} replace />;
  }

  return <Outlet />;
}
