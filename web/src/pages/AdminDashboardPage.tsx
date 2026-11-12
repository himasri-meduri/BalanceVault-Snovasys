import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { StatusBadge } from '../components/StatusBadge';
import { SystemStatusCard } from '../components/SystemStatusCard';
import { adminApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type {
  AdminOnboardingApplication,
  AdminSummaryCounts,
  AuditEventItem,
} from '../lib/types';

export function AdminDashboardPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [summary, setSummary] = useState<AdminSummaryCounts | null>(null);
  const [recentPending, setRecentPending] = useState<AdminOnboardingApplication[]>([]);
  const [recentAudit, setRecentAudit] = useState<AuditEventItem[]>([]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, pendingRes, auditRes] = await Promise.all([
        adminApi.getSummary(),
        adminApi.listOnboardingApplications({ status: 'PENDING', page: 1, pageSize: 5 }),
        adminApi.listAuditEvents({ page: 1, pageSize: 5 }),
      ]);

      setSummary(summaryRes);
      setRecentPending(pendingRes.items);
      setRecentAudit(auditRes.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <div className="bv-hero-row">
          <div>
            <h1>Administrator Console</h1>
            <p>
              Signed in as <strong>{user?.fullName}</strong> ({user?.role}). Review
              synthetic onboarding applications, provision and govern ledger vaults,
              manage users, and monitor the append-only audit trail.
            </p>
          </div>
          <div className="bv-actions-row">
            <Link to="/admin/accounts" className="bv-button bv-button--primary">
              Accounts &amp; Ledger
            </Link>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => void loadOverview()}
              disabled={loading}
            >
              {loading ? 'Refreshing...' : 'Refresh Overview'}
            </button>
          </div>
        </div>
      </section>

      <ApiErrorAlert error={error} title="Unable to load administrator metrics" />

      <div className="bv-kpi-grid" aria-label="Live administrative totals">
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Pending Onboarding</div>
          <div className="bv-kpi-value">
            {loading ? '—' : (summary?.pendingOnboarding ?? '—')}
          </div>
          <Link to="/admin/onboarding" className="bv-text-link">
            Review Queue (Approved: {loading ? '—' : (summary?.approvedOnboarding ?? 0)}
            )
          </Link>
        </div>
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Registered Customers</div>
          <div className="bv-kpi-value">
            {loading ? '—' : (summary?.customersTotal ?? '—')}
          </div>
          <Link to="/admin/users" className="bv-text-link">
            {user?.role === 'SUPER_ADMIN' ? 'Manage Users & Roles' : 'Search Directory'}
          </Link>
        </div>
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Active / Frozen Vaults</div>
          <div className="bv-kpi-value">
            {loading
              ? '—'
              : summary
                ? `${summary.activeAccounts} / ${summary.frozenAccounts}`
                : '—'}
          </div>
          <Link to="/admin/accounts" className="bv-text-link">
            Manage Accounts (Pending: {loading ? '—' : (summary?.pendingAccounts ?? 0)},
            Closed: {loading ? '—' : (summary?.closedAccounts ?? 0)})
          </Link>
        </div>
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Journal Transactions</div>
          <div className="bv-kpi-value">
            {loading ? '—' : (summary?.demoTransactionsTotal ?? '—')}
          </div>
          <Link to="/admin/accounts" className="bv-text-link">
            Inspect Ledger &amp; Reversals
          </Link>
        </div>
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Audit Events Logged</div>
          <div className="bv-kpi-value">
            {loading ? '—' : (summary?.auditEventsTotal ?? '—')}
          </div>
          <Link to="/admin/audit" className="bv-text-link">
            Inspect Audit Trail
          </Link>
        </div>
      </div>

      <div className="bv-grid">
        <section className="bv-card" aria-labelledby="recent-pending-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="recent-pending-heading" className="bv-card-title">
                Pending Onboarding Queue
              </h2>
              <p className="bv-card-subtitle">
                Most recent <code>PENDING</code> applications (rejected total:{' '}
                {loading ? '—' : (summary?.rejectedOnboarding ?? 0)}).
              </p>
            </div>
            <Link to="/admin/onboarding" className="bv-button bv-button--secondary">
              Open Review Queue
            </Link>
          </div>

          {loading ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : recentPending.length > 0 ? (
            <div className="bv-table-wrap">
              <table className="bv-table">
                <thead>
                  <tr>
                    <th>Applicant</th>
                    <th>Submitted</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPending.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div className="bv-cell-primary">{item.applicant.fullName}</div>
                        <div className="bv-cell-secondary">{item.applicant.email}</div>
                      </td>
                      <td>
                        {item.submittedAt
                          ? formatDateTime(item.submittedAt)
                          : 'Unsubmitted draft'}
                      </td>
                      <td>
                        <StatusBadge value={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="bv-muted">No pending onboarding applications in the queue.</p>
          )}
        </section>

        <section className="bv-card" aria-labelledby="recent-audit-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="recent-audit-heading" className="bv-card-title">
                Recent Audit Events
              </h2>
              <p className="bv-card-subtitle">
                Append-only security &amp; workflow log from PostgreSQL.
              </p>
            </div>
            <Link to="/admin/audit" className="bv-button bv-button--secondary">
              Full Audit Viewer
            </Link>
          </div>

          {loading ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : recentAudit.length > 0 ? (
            <div className="bv-table-wrap">
              <table className="bv-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Occurred</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAudit.map((evt) => (
                    <tr key={evt.id}>
                      <td>
                        <code>{evt.action}</code>
                      </td>
                      <td>
                        <StatusBadge value={evt.actorType} /> {evt.entityType}
                      </td>
                      <td>{formatDateTime(evt.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="bv-muted">No audit events recorded yet.</p>
          )}
        </section>
      </div>

      <SystemStatusCard />
    </div>
  );
}
