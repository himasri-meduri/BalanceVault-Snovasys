import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { StatusBadge } from '../components/StatusBadge';
import { accountsApi, onboardingApi } from '../lib/api';
import {
  canCustomerEditOnboarding,
  describeOnboardingStage,
  formatDateTime,
  sumAccountBalancesMinor,
} from '../lib/format';
import { formatMinorInr } from '../lib/money';
import type { AccountItem, CustomerOnboardingApplication } from '../lib/types';

export function CustomerDashboardPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [application, setApplication] =
    useState<CustomerOnboardingApplication | null>(null);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [accountsTotal, setAccountsTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [accountsError, setAccountsError] = useState<unknown>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAccountsError(null);
    const [obResult, accResult] = await Promise.allSettled([
      onboardingApi.getOwn(),
      accountsApi.list({ page: 1, pageSize: 10 }),
    ]);

    if (obResult.status === 'fulfilled') {
      setApplication(obResult.value.application);
    } else {
      setError(obResult.reason);
    }

    if (accResult.status === 'fulfilled') {
      setAccounts(accResult.value.items);
      setAccountsTotal(accResult.value.total);
    } else {
      setAccountsError(accResult.reason);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const editable = application ? canCustomerEditOnboarding(application) : false;
  const effectiveOnboardingStatus =
    application?.status ?? user?.onboardingStatus ?? 'PENDING';
  const totalBalanceMinor = sumAccountBalancesMinor(accounts);

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <h1>Customer Dashboard</h1>
        <p>
          Welcome back, <strong>{user?.fullName}</strong>. Track your synthetic
          onboarding status, inspect owned INR vaults, and initiate simulated internal
          transfers.
        </p>
      </section>

      <div className="bv-grid">
        <section className="bv-card" aria-labelledby="customer-profile-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="customer-profile-heading" className="bv-card-title">
                Profile &amp; Session
              </h2>
              <p className="bv-card-subtitle">
                Authenticated via server-verified HttpOnly session (<code>bv_sid</code>).
              </p>
            </div>
            {user ? <StatusBadge value={user.status} /> : null}
          </div>

          <dl className="bv-kv-grid">
            <div className="bv-kv-item">
              <dt>Full Name</dt>
              <dd>{user?.fullName ?? '—'}</dd>
            </div>
            <div className="bv-kv-item">
              <dt>Email</dt>
              <dd>{user?.email ?? '—'}</dd>
            </div>
            <div className="bv-kv-item">
              <dt>Role</dt>
              <dd>{user ? <StatusBadge value={user.role} /> : '—'}</dd>
            </div>
            <div className="bv-kv-item">
              <dt>Onboarding Status</dt>
              <dd>
                {application ? (
                  <StatusBadge value={application.status} />
                ) : user?.onboardingStatus ? (
                  <StatusBadge value={user.onboardingStatus} />
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="bv-card" aria-labelledby="customer-onboarding-summary">
          <div className="bv-card-header">
            <div>
              <h2 id="customer-onboarding-summary" className="bv-card-title">
                Onboarding Application
              </h2>
              <p className="bv-card-subtitle">
                Approval is required before synthetic ledger accounts can be provisioned.
              </p>
            </div>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => void loadDashboard()}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {loading ? (
            <div
              className="bv-skeleton-stack"
              aria-busy="true"
              aria-label="Loading onboarding status"
            >
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : error ? (
            <ApiErrorAlert error={error} title="Unable to load onboarding application" />
          ) : application ? (
            <div className="bv-stack-sm">
              <div className="bv-status-row">
                <StatusBadge value={application.status} />
                <span>{describeOnboardingStage(application)}</span>
              </div>

              {application.reviewReason ? (
                <div
                  className={`bv-alert ${
                    application.status === 'REJECTED'
                      ? 'bv-alert--error'
                      : 'bv-alert--info'
                  }`}
                >
                  <strong>Review note:</strong> {application.reviewReason}
                </div>
              ) : null}

              <dl className="bv-kv-grid">
                <div className="bv-kv-item">
                  <dt>Submitted At</dt>
                  <dd>{formatDateTime(application.submittedAt)}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Reviewed At</dt>
                  <dd>{formatDateTime(application.reviewedAt)}</dd>
                </div>
              </dl>

              <div className="bv-actions-row">
                <Link to="/onboarding" className="bv-button bv-button--primary">
                  {application.status === 'REJECTED'
                    ? 'Review Rejection & Resubmit'
                    : editable
                      ? 'Complete Onboarding Profile'
                      : 'View Onboarding Details'}
                </Link>
              </div>
            </div>
          ) : (
            <p className="bv-muted">No onboarding application found for this account.</p>
          )}
        </section>
      </div>

      <section className="bv-card" aria-labelledby="customer-accounts-overview">
        <div className="bv-card-header">
          <div>
            <h2 id="customer-accounts-overview" className="bv-card-title">
              Accounts Overview &amp; Transaction History
            </h2>
            <p className="bv-card-subtitle">
              Live synthetic INR balances and double-entry vaults ({accountsTotal}{' '}
              total). Total balance:{' '}
              <strong className="bv-amount-mono">
                {loading ? '—' : formatMinorInr(totalBalanceMinor)}
              </strong>
            </p>
          </div>
          <Link to="/accounts" className="bv-button bv-button--primary">
            Open Accounts &amp; Transfers
          </Link>
        </div>

        <ApiErrorAlert error={accountsError} title="Unable to load owned accounts" />

        {loading ? (
          <div className="bv-skeleton-stack" aria-busy="true">
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="bv-empty-state">
            {effectiveOnboardingStatus === 'APPROVED'
              ? 'Your onboarding is APPROVED, and no synthetic vaults have been provisioned yet. An administrator can open and credit a synthetic vault for you.'
              : `No synthetic accounts exist yet (current onboarding status: ${effectiveOnboardingStatus}).`}
          </div>
        ) : (
          <div className="bv-table-wrap">
            <table className="bv-table">
              <thead>
                <tr>
                  <th>Vault Name</th>
                  <th>Public Reference</th>
                  <th>Status</th>
                  <th className="bv-text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.id}>
                    <td>
                      <div className="bv-cell-primary">{acc.accountName}</div>
                      {acc.statusReason ? (
                        <div className="bv-cell-secondary">{acc.statusReason}</div>
                      ) : null}
                    </td>
                    <td>
                      <code>{acc.publicReference}</code>
                    </td>
                    <td>
                      <StatusBadge value={acc.status} />
                    </td>
                    <td className="bv-text-right bv-amount-mono">
                      {formatMinorInr(acc.balanceMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
