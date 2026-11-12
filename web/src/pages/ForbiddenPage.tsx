import { Link } from 'react-router-dom';
import { getDefaultHomePath } from '../lib/format';
import type { UserRole } from '../lib/types';
import { StatusBadge } from '../components/StatusBadge';

interface ForbiddenPageProps {
  allowedRoles: UserRole[];
  currentRole: UserRole;
}

export function ForbiddenPage({ allowedRoles, currentRole }: ForbiddenPageProps) {
  const homePath = getDefaultHomePath(currentRole);

  return (
    <section className="bv-card bv-narrow-card" aria-labelledby="forbidden-heading">
      <div className="bv-card-header">
        <div>
          <h1 id="forbidden-heading" className="bv-page-title">
            Access Denied
          </h1>
          <p className="bv-card-subtitle">
            Your signed-in role does not have permission to open this workspace.
          </p>
        </div>
        <StatusBadge value={currentRole} />
      </div>

      <p className="bv-muted">
        Required role: <strong>{allowedRoles.join(' or ')}</strong>. BalanceVault enforces
        all role and ownership checks authoritatively on the backend API.
      </p>

      <div className="bv-actions-row">
        <Link to={homePath} className="bv-button bv-button--primary">
          Return to My Workspace
        </Link>
        <Link to="/" className="bv-button bv-button--secondary">
          System Status
        </Link>
      </div>
    </section>
  );
}
