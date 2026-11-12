import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { PaginationControls } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { adminApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AdminUserDetail, AdminUserItem, UserRole, UserStatus } from '../lib/types';

const ROLE_OPTIONS: UserRole[] = ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'];
const STATUS_OPTIONS: UserStatus[] = ['ACTIVE', 'DISABLED', 'LOCKED'];

export function AdminUsersPage() {
  const { user: currentUser, refreshSession } = useAuth();
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';

  const [searchInput, setSearchInput] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | UserRole>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | UserStatus>('ALL');
  const [appliedSearch, setAppliedSearch] = useState('');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Selected single user detail
  const [detailUser, setDetailUser] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);

  // Status governance form
  const [statusTarget, setStatusTarget] = useState<AdminUserItem | null>(null);
  const [nextStatus, setNextStatus] = useState<UserStatus>('ACTIVE');
  const [statusReason, setStatusReason] = useState('');
  const [confirmStatusChange, setConfirmStatusChange] = useState(false);
  const [statusValidation, setStatusValidation] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [statusSuccess, setStatusSuccess] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);

  // Role governance form (SUPER_ADMIN only)
  const [editingUser, setEditingUser] = useState<AdminUserItem | null>(null);
  const [nextRole, setNextRole] = useState<UserRole>('CUSTOMER');
  const [reason, setReason] = useState('');
  const [roleError, setRoleError] = useState<unknown>(null);
  const [roleValidation, setRoleValidation] = useState<string | null>(null);
  const [roleSuccess, setRoleSuccess] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminApi.listUsers({
        page,
        pageSize,
        search: appliedSearch || undefined,
        role: roleFilter === 'ALL' ? undefined : roleFilter,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
      });
      setUsers(res.items);
      setTotal(res.total);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, appliedSearch, roleFilter, statusFilter]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleFilterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(searchInput.trim());
  };

  const inspectUser = async (userId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await adminApi.getUser(userId);
      setDetailUser(res.user);
    } catch (err) {
      setDetailError(err);
    } finally {
      setDetailLoading(false);
    }
  };

  const openStatusEditor = (target: AdminUserItem) => {
    setStatusTarget(target);
    setNextStatus(target.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE');
    setStatusReason('');
    setConfirmStatusChange(false);
    setStatusValidation(null);
    setStatusError(null);
    setStatusSuccess(null);
  };

  const handleStatusSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!statusTarget) return;

    setStatusValidation(null);
    setStatusError(null);
    setStatusSuccess(null);

    const trimmedReason = statusReason.trim();
    if (trimmedReason.length < 5 || trimmedReason.length > 500) {
      setStatusValidation('Status change reason must be between 5 and 500 characters.');
      return;
    }

    if (nextStatus !== 'ACTIVE' && !confirmStatusChange) {
      setConfirmStatusChange(true);
      return;
    }

    setSavingStatus(true);
    try {
      const res = await adminApi.changeUserStatus(statusTarget.id, {
        status: nextStatus,
        reason: trimmedReason,
      });

      setStatusSuccess(
        `Updated ${res.user.fullName} status to ${res.user.status}${res.user.status !== 'ACTIVE' ? ' and revoked active sessions' : ''}.`,
      );
      setStatusTarget(null);
      setStatusReason('');
      setConfirmStatusChange(false);

      await loadUsers();
      if (detailUser?.id === res.user.id) {
        await inspectUser(res.user.id);
      }
    } catch (err) {
      setStatusError(err);
    } finally {
      setSavingStatus(false);
    }
  };

  const openRoleEditor = (target: AdminUserItem) => {
    setEditingUser(target);
    setNextRole(target.role);
    setReason('');
    setRoleError(null);
    setRoleValidation(null);
    setRoleSuccess(null);
  };

  const handleRoleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingUser) return;

    setRoleError(null);
    setRoleValidation(null);
    setRoleSuccess(null);

    const trimmedReason = reason.trim();
    if (trimmedReason.length < 5 || trimmedReason.length > 500) {
      setRoleValidation('Role change reason must be between 5 and 500 characters.');
      return;
    }

    setSavingRole(true);
    try {
      const res = await adminApi.changeUserRole(editingUser.id, {
        role: nextRole,
        reason: trimmedReason,
      });

      setRoleSuccess(
        `Updated ${res.user.fullName} role to ${res.user.role} and revoked active user sessions.`,
      );
      setEditingUser(null);
      setReason('');

      if (res.user.id === currentUser?.id) {
        await refreshSession();
        return;
      }

      await loadUsers();
      if (detailUser?.id === res.user.id) {
        await inspectUser(res.user.id);
      }
    } catch (err) {
      setRoleError(err);
    } finally {
      setSavingRole(false);
    }
  };

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <h1>{isSuperAdmin ? 'User & Role Management' : 'User Directory'}</h1>
        <p>
          Searchable directory of BalanceVault accounts (
          <code>GET /api/admin/users</code>, <code>GET /api/admin/users/:id</code>, and{' '}
          <code>PATCH /api/admin/users/:id/status</code>).{' '}
          {isSuperAdmin
            ? 'As SUPER_ADMIN, you may govern all eligible user statuses and reassign roles with mandatory audit justification.'
            : 'ADMIN users may inspect users and govern CUSTOMER statuses; ADMIN/SUPER_ADMIN status and role changes require SUPER_ADMIN.'}
        </p>
      </section>

      {roleSuccess ? (
        <div className="bv-alert bv-alert--success" role="status">
          {roleSuccess}
        </div>
      ) : null}

      {statusSuccess ? (
        <div className="bv-alert bv-alert--success" role="status">
          {statusSuccess}
        </div>
      ) : null}

      <section className="bv-card" aria-label="User filters">
        <form className="bv-filter-bar" onSubmit={(e) => handleFilterSubmit(e)}>
          <div className="bv-field bv-field--grow">
            <label htmlFor="users-search-input">Search Name or Email</label>
            <input
              id="users-search-input"
              type="text"
              placeholder="Search registered user name or email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          <div className="bv-field">
            <label htmlFor="users-role-filter">Role</label>
            <select
              id="users-role-filter"
              value={roleFilter}
              onChange={(e) => {
                setPage(1);
                setRoleFilter(e.target.value as 'ALL' | UserRole);
              }}
            >
              <option value="ALL">All roles</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <div className="bv-field">
            <label htmlFor="users-status-filter">Status</label>
            <select
              id="users-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value as 'ALL' | UserStatus);
              }}
            >
              <option value="ALL">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="bv-filter-actions">
            <button type="submit" className="bv-button bv-button--primary">
              Search
            </button>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => {
                setSearchInput('');
                setAppliedSearch('');
                setRoleFilter('ALL');
                setStatusFilter('ALL');
                setPage(1);
              }}
            >
              Reset
            </button>
          </div>
        </form>
      </section>

      {detailLoading || detailError || detailUser ? (
        <section className="bv-card" aria-labelledby="user-detail-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="user-detail-heading" className="bv-card-title">
                User Account Detail
              </h2>
              <p className="bv-card-subtitle">
                Server-verified account status, onboarding state, and synthetic vault
                count.
              </p>
            </div>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => setDetailUser(null)}
            >
              Close Detail
            </button>
          </div>

          {detailLoading ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : null}

          <ApiErrorAlert error={detailError} title="Unable to load user detail" />

          {!detailLoading && detailUser ? (
            <dl className="bv-kv-grid">
              <div className="bv-kv-item">
                <dt>User</dt>
                <dd>
                  <strong>{detailUser.fullName}</strong> ({detailUser.email})
                </dd>
              </div>
              <div className="bv-kv-item">
                <dt>Role &amp; Account Status</dt>
                <dd className="bv-badges-inline">
                  <StatusBadge value={detailUser.role} />
                  <StatusBadge value={detailUser.status} />
                </dd>
              </div>
              <div className="bv-kv-item">
                <dt>Onboarding Status</dt>
                <dd>
                  {detailUser.onboardingStatus ? (
                    <StatusBadge value={detailUser.onboardingStatus} />
                  ) : (
                    'None'
                  )}
                </dd>
              </div>
              <div className="bv-kv-item">
                <dt>Provisioned Synthetic Accounts</dt>
                <dd>
                  <strong>{detailUser.accountCount}</strong> ({detailUser.activeAccountCount}{' '}
                  ACTIVE)
                </dd>
              </div>
              <div className="bv-kv-item">
                <dt>Created At</dt>
                <dd>{formatDateTime(detailUser.createdAt)}</dd>
              </div>
              <div className="bv-kv-item">
                <dt>Onboarding Submitted / Reviewed</dt>
                <dd>
                  {formatDateTime(detailUser.onboardingSubmittedAt)} /{' '}
                  {formatDateTime(detailUser.onboardingReviewedAt)}
                </dd>
              </div>
              {detailUser.onboardingReviewReason ? (
                <div className="bv-kv-item bv-kv-span-2">
                  <dt>Onboarding Review Note</dt>
                  <dd>{detailUser.onboardingReviewReason}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </section>
      ) : null}

      {statusTarget ? (
        <section className="bv-card" aria-labelledby="status-editor-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="status-editor-heading" className="bv-card-title">
                Change Account Status for {statusTarget.fullName}
              </h2>
              <p className="bv-card-subtitle">
                {statusTarget.email} — current status:{' '}
                <strong>{statusTarget.status}</strong>. Transitioning to{' '}
                <code>DISABLED</code> or <code>LOCKED</code> immediately revokes all
                active sessions and records a <code>USER_STATUS_CHANGE</code> audit
                event.
              </p>
            </div>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => setStatusTarget(null)}
              disabled={savingStatus}
            >
              Cancel
            </button>
          </div>

          <form
            className="bv-form"
            onSubmit={(e) => void handleStatusSubmit(e)}
            noValidate
          >
            <ApiErrorAlert error={statusError} title="Status update failed" />

            {statusValidation ? (
              <div className="bv-alert bv-alert--error" role="alert">
                {statusValidation}
              </div>
            ) : null}

            <div className="bv-form-grid">
              <div className="bv-field">
                <label htmlFor="target-status-select">New Account Status</label>
                <select
                  id="target-status-select"
                  value={nextStatus}
                  onChange={(e) => {
                    setNextStatus(e.target.value as UserStatus);
                    setConfirmStatusChange(false);
                  }}
                  disabled={savingStatus}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div className="bv-field bv-field--grow">
                <label htmlFor="status-change-reason">
                  Status Audit Reason (required, 5–500 chars)
                </label>
                <input
                  id="status-change-reason"
                  type="text"
                  placeholder="Document security or administrative justification..."
                  value={statusReason}
                  onChange={(e) => {
                    setStatusReason(e.target.value);
                    setConfirmStatusChange(false);
                  }}
                  disabled={savingStatus}
                />
              </div>
            </div>

            {confirmStatusChange && nextStatus !== 'ACTIVE' ? (
              <div className="bv-alert bv-alert--warning" role="alert">
                <p className="bv-mb-sm">
                  Confirm setting <strong>{statusTarget.email}</strong> to{' '}
                  <code>{nextStatus}</code>? Active sessions will be revoked immediately.
                </p>
                <div className="bv-actions-row">
                  <button
                    type="submit"
                    className="bv-button bv-button--danger"
                    disabled={savingStatus}
                  >
                    {savingStatus ? 'Updating Status...' : 'Confirm Status Change'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="bv-actions-row">
                <button
                  type="submit"
                  className={
                    nextStatus === 'ACTIVE'
                      ? 'bv-button bv-button--primary'
                      : 'bv-button bv-button--danger'
                  }
                  disabled={savingStatus}
                >
                  {savingStatus
                    ? 'Updating Status...'
                    : nextStatus === 'ACTIVE'
                      ? 'Activate User'
                      : 'Review Status Change'}
                </button>
              </div>
            )}
          </form>
        </section>
      ) : null}

      {editingUser && isSuperAdmin ? (
        <section className="bv-card" aria-labelledby="role-editor-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="role-editor-heading" className="bv-card-title">
                Change Role for {editingUser.fullName}
              </h2>
              <p className="bv-card-subtitle">
                {editingUser.email} — current role: <strong>{editingUser.role}</strong>.
                Changing a role revokes all active sessions for this user and records a{' '}
                <code>USER_ROLE_CHANGE</code> audit event.
              </p>
            </div>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => setEditingUser(null)}
              disabled={savingRole}
            >
              Cancel
            </button>
          </div>

          <form
            className="bv-form"
            onSubmit={(e) => void handleRoleSubmit(e)}
            noValidate
          >
            <ApiErrorAlert error={roleError} title="Role change failed" />

            {roleValidation ? (
              <div className="bv-alert bv-alert--error" role="alert">
                {roleValidation}
              </div>
            ) : null}

            {editingUser.id === currentUser?.id && nextRole !== 'SUPER_ADMIN' ? (
              <div className="bv-alert bv-alert--warning" role="status">
                Warning: Changing your own role revokes your active session immediately.
              </div>
            ) : null}

            <div className="bv-form-grid">
              <div className="bv-field">
                <label htmlFor="target-role-select">New Role</label>
                <select
                  id="target-role-select"
                  value={nextRole}
                  onChange={(e) => setNextRole(e.target.value as UserRole)}
                  disabled={savingRole}
                >
                  {ROLE_OPTIONS.map((roleOpt) => (
                    <option key={roleOpt} value={roleOpt}>
                      {roleOpt}
                    </option>
                  ))}
                </select>
              </div>

              <div className="bv-field bv-field--grow">
                <label htmlFor="role-change-reason">
                  Audit Reason (required, 5–500 chars)
                </label>
                <input
                  id="role-change-reason"
                  type="text"
                  placeholder="Explain why this role assignment is authorized..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={savingRole}
                  required
                />
              </div>
            </div>

            <div className="bv-actions-row">
              <button
                type="submit"
                className="bv-button bv-button--primary"
                disabled={savingRole}
              >
                {savingRole ? 'Updating Role...' : 'Confirm Role Change'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <ApiErrorAlert error={loadError} title="Unable to load users" />

      <section className="bv-card" aria-labelledby="users-table-heading">
        <div className="bv-card-header">
          <h2 id="users-table-heading" className="bv-card-title">
            Registered Users ({total})
          </h2>
          <div className="bv-actions-row">
            <label htmlFor="users-page-size" className="bv-sr-only">
              Users per page
            </label>
            <select
              id="users-page-size"
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(Number(e.target.value));
              }}
            >
              <option value={10}>10 / page</option>
              <option value={20}>20 / page</option>
              <option value={50}>50 / page</option>
            </select>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => void loadUsers()}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bv-skeleton-stack" aria-busy="true">
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
          </div>
        ) : users.length === 0 ? (
          <div className="bv-empty-state">No users match the active filters.</div>
        ) : (
          <>
            <div className="bv-table-wrap">
              <table className="bv-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Account Status</th>
                    <th>Onboarding</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((item) => {
                    const canGovernStatus =
                      item.id !== currentUser?.id &&
                      (isSuperAdmin || item.role === 'CUSTOMER');
                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="bv-cell-primary">{item.fullName}</div>
                          <div className="bv-cell-secondary">{item.email}</div>
                        </td>
                        <td>
                          <StatusBadge value={item.role} />
                        </td>
                        <td>
                          <StatusBadge value={item.status} />
                        </td>
                        <td>
                          {item.onboardingStatus ? (
                            <StatusBadge value={item.onboardingStatus} />
                          ) : (
                            <span className="bv-muted">None</span>
                          )}
                        </td>
                        <td>{formatDateTime(item.createdAt)}</td>
                        <td>
                          <div className="bv-actions-row">
                            <button
                              type="button"
                              className="bv-button bv-button--secondary"
                              onClick={() => void inspectUser(item.id)}
                            >
                              Inspect
                            </button>
                            {canGovernStatus ? (
                              <button
                                type="button"
                                className="bv-button bv-button--secondary"
                                onClick={() => openStatusEditor(item)}
                              >
                                Change Status
                              </button>
                            ) : null}
                            {isSuperAdmin ? (
                              <button
                                type="button"
                                className="bv-button bv-button--secondary"
                                onClick={() => openRoleEditor(item)}
                              >
                                Change Role
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationControls
              page={page}
              pageSize={pageSize}
              total={total}
              disabled={loading}
              onPageChange={setPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
