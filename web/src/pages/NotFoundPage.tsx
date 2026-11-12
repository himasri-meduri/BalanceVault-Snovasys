import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { getDefaultHomePath } from '../lib/format';

export function NotFoundPage() {
  const { user } = useAuth();
  const target = user ? getDefaultHomePath(user.role) : '/';

  return (
    <section className="bv-card bv-narrow-card" aria-labelledby="not-found-heading">
      <h1 id="not-found-heading" className="bv-page-title">
        Page Not Found
      </h1>
      <p className="bv-muted">
        The requested route does not exist in BalanceVault.
      </p>
      <div className="bv-actions-row">
        <Link to={target} className="bv-button bv-button--primary">
          {user ? 'Return to Dashboard' : 'Go to Overview'}
        </Link>
      </div>
    </section>
  );
}
