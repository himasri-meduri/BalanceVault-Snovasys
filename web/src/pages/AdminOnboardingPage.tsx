import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { PaginationControls } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { adminApi } from '../lib/api';
import {
  canAdminApproveOnboarding,
  canAdminRejectOnboarding,
  formatDateTime,
} from '../lib/format';
import type { AdminOnboardingApplication, OnboardingStatus } from '../lib/types';

const STATUS_OPTIONS: Array<{ label: string; value: '' | OnboardingStatus }> = [
  { label: 'All statuses', value: '' },
  { label: 'PENDING', value: 'PENDING' },
  { label: 'DRAFT', value: 'DRAFT' },
  { label: 'NEEDS_INFORMATION', value: 'NEEDS_INFORMATION' },
  { label: 'APPROVED', value: 'APPROVED' },
  { label: 'REJECTED', value: 'REJECTED' },
];

export function AdminOnboardingPage() {
  const [statusFilter, setStatusFilter] = useState<'' | OnboardingStatus>('');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [items, setItems] = useState<AdminOnboardingApplication[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<unknown>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<AdminOnboardingApplication | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [approveReason, setApproveReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [confirmRejectPending, setConfirmRejectPending] = useState(false);
  const [actionBusy, setActionBusy] = useState<'approve' | 'reject' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionValidation, setActionValidation] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const detailRequestSeq = useRef(0);

  const loadApplications = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await adminApi.listOnboardingApplications({
        status: statusFilter || undefined,
        search: appliedSearch || undefined,
        page,
        pageSize,
      });
      setItems(res.items);
      setTotal(res.total);

      setSelectedDetail((current) => {
        if (!current) return res.items[0] ?? null;
        return res.items.find((item) => item.id === current.id) ?? res.items[0] ?? null;
      });
      setSelectedId((currentId) => {
        if (currentId && res.items.some((item) => item.id === currentId)) {
          return currentId;
        }
        return res.items[0]?.id ?? null;
      });
    } catch (err) {
      setListError(err);
    } finally {
      setLoadingList(false);
    }
  }, [appliedSearch, page, pageSize, statusFilter]);

  useEffect(() => {
    void loadApplications();
  }, [loadApplications]);

  const handleSelectApplication = async (item: AdminOnboardingApplication) => {
    const reqSeq = ++detailRequestSeq.current;
    setSelectedId(item.id);
    setSelectedDetail(item);
    setApproveReason('');
    setRejectReason('');
    setConfirmRejectPending(false);
    setActionError(null);
    setActionValidation(null);
    setActionSuccess(null);

    setLoadingDetail(true);
    try {
      const res = await adminApi.getOnboardingApplication(item.id);
      if (detailRequestSeq.current === reqSeq) {
        setSelectedDetail(res.application);
      }
    } catch {
      // Keep list item view visible if detail reload fails transiently
    } finally {
      if (detailRequestSeq.current === reqSeq) {
        setLoadingDetail(false);
      }
    }
  };

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(searchInput.trim());
  };

  const handleApprove = async () => {
    if (!selectedDetail) return;
    setActionError(null);
    setActionValidation(null);
    setActionSuccess(null);

    const trimmedReason = approveReason.trim();
    if (trimmedReason.length > 0 && (trimmedReason.length < 3 || trimmedReason.length > 500)) {
      setActionValidation('Approval reason must be 3 to 500 characters if provided.');
      return;
    }

    setActionBusy('approve');
    try {
      const res = await adminApi.approveOnboardingApplication(
        selectedDetail.id,
        trimmedReason || undefined,
      );
      setSelectedDetail(res.application);
      setApproveReason('');
      setActionSuccess(
        `Application for ${res.application.applicant.fullName} approved and audited.`,
      );
      await loadApplications();
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(null);
    }
  };

  const handleReject = async () => {
    if (!selectedDetail) return;
    setActionError(null);
    setActionValidation(null);
    setActionSuccess(null);

    const trimmedReason = rejectReason.trim();
    if (trimmedReason.length < 10 || trimmedReason.length > 500) {
      setActionValidation('Rejection reason must be between 10 and 500 characters.');
      setConfirmRejectPending(false);
      return;
    }

    if (!confirmRejectPending) {
      setConfirmRejectPending(true);
      return;
    }

    setActionBusy('reject');
    try {
      const res = await adminApi.rejectOnboardingApplication(
        selectedDetail.id,
        trimmedReason,
      );
      setSelectedDetail(res.application);
      setRejectReason('');
      setConfirmRejectPending(false);
      setActionSuccess(
        `Application for ${res.application.applicant.fullName} rejected with audit log.`,
      );
      await loadApplications();
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(null);
    }
  };

  const canApprove = selectedDetail ? canAdminApproveOnboarding(selectedDetail) : false;
  const canReject = selectedDetail ? canAdminRejectOnboarding(selectedDetail) : false;

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <h1>Onboarding Review</h1>
        <p>
          Filter customer onboarding applications, inspect submitted synthetic profile
          details, and record audited approvals or rejections.
        </p>
      </section>

      <section className="bv-card" aria-label="Onboarding filters">
        <form
          className="bv-filter-bar"
          onSubmit={(e) => handleSearchSubmit(e)}
        >
          <div className="bv-field">
            <label htmlFor="ob-filter-status">Status</label>
            <select
              id="ob-filter-status"
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value as '' | OnboardingStatus);
              }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="bv-field bv-field--grow">
            <label htmlFor="ob-filter-search">Search Applicant</label>
            <input
              id="ob-filter-search"
              type="search"
              placeholder="Name or email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          <div className="bv-field">
            <label htmlFor="ob-page-size">Per Page</label>
            <select
              id="ob-page-size"
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(Number(e.target.value));
              }}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>

          <div className="bv-filter-actions">
            <button type="submit" className="bv-button bv-button--primary">
              Apply
            </button>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => {
                setSearchInput('');
                setAppliedSearch('');
                setStatusFilter('');
                setPage(1);
              }}
            >
              Reset
            </button>
          </div>
        </form>
      </section>

      <ApiErrorAlert error={listError} title="Unable to load onboarding applications" />

      {actionSuccess ? (
        <div className="bv-alert bv-alert--success" role="status">
          <div className="bv-alert-row">
            <span>{actionSuccess}</span>
            <button
              type="button"
              className="bv-button bv-button--ghost"
              onClick={() => setActionSuccess(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="bv-split-layout">
        <section className="bv-card" aria-labelledby="onboarding-list-heading">
          <div className="bv-card-header">
            <h2 id="onboarding-list-heading" className="bv-card-title">
              Applications ({total})
            </h2>
            <button
              type="button"
              className="bv-button bv-button--secondary"
              onClick={() => void loadApplications()}
              disabled={loadingList}
            >
              Refresh
            </button>
          </div>

          {loadingList ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : items.length === 0 ? (
            <div className="bv-empty-state">
              No onboarding applications match the selected filters.
            </div>
          ) : (
            <>
              <div className="bv-table-wrap">
                <table className="bv-table">
                  <thead>
                    <tr>
                      <th>Applicant</th>
                      <th>Location</th>
                      <th>Submitted</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const active = item.id === selectedId;
                      return (
                        <tr
                          key={item.id}
                          className={active ? 'bv-row-selected' : 'bv-row-clickable'}
                        >
                          <td>
                            <button
                              type="button"
                              className="bv-table-select-btn"
                              onClick={() => void handleSelectApplication(item)}
                            >
                              <span className="bv-cell-primary">
                                {item.applicant.fullName}
                              </span>
                              <span className="bv-cell-secondary">
                                {item.applicant.email}
                              </span>
                            </button>
                          </td>
                          <td>
                            {item.city || item.country
                              ? `${item.city ?? '—'}, ${item.country ?? '—'}`
                              : 'Not provided'}
                          </td>
                          <td>
                            {item.submittedAt
                              ? formatDateTime(item.submittedAt)
                              : 'Not submitted'}
                          </td>
                          <td>
                            <StatusBadge value={item.status} />
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
                disabled={loadingList}
                onPageChange={setPage}
              />
            </>
          )}
        </section>

        <section className="bv-card" aria-labelledby="onboarding-detail-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="onboarding-detail-heading" className="bv-card-title">
                Application Review
              </h2>
              <p className="bv-card-subtitle">
                Minimum necessary applicant profile and server-enforced review state.
              </p>
            </div>
            {selectedDetail ? <StatusBadge value={selectedDetail.status} /> : null}
          </div>

          {!selectedDetail ? (
            <div className="bv-empty-state">
              Select an application from the list to inspect and review it.
            </div>
          ) : (
            <div className="bv-stack-md">
              {loadingDetail ? (
                <p className="bv-muted">Refreshing latest application record...</p>
              ) : null}

              <ApiErrorAlert error={actionError} title="Review decision failed" />

              {actionValidation ? (
                <div className="bv-alert bv-alert--error" role="alert">
                  {actionValidation}
                </div>
              ) : null}

              <dl className="bv-kv-grid">
                <div className="bv-kv-item">
                  <dt>Applicant Name</dt>
                  <dd>{selectedDetail.applicant.fullName}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Email</dt>
                  <dd>{selectedDetail.applicant.email}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>User Status / Role</dt>
                  <dd className="bv-badges-inline">
                    <StatusBadge value={selectedDetail.applicant.status} />
                    <StatusBadge value={selectedDetail.applicant.role} />
                  </dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Synthetic Terms Accepted</dt>
                  <dd>{selectedDetail.acceptedSyntheticTerms ? 'Yes' : 'No'}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Contact Reference</dt>
                  <dd>{selectedDetail.contactReference ?? '—'}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>City / Country</dt>
                  <dd>
                    {selectedDetail.city ?? '—'} / {selectedDetail.country ?? '—'}
                  </dd>
                </div>
                <div className="bv-kv-item bv-kv-span-2">
                  <dt>Account Purpose</dt>
                  <dd>{selectedDetail.accountPurpose ?? '—'}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Submitted At</dt>
                  <dd>{formatDateTime(selectedDetail.submittedAt)}</dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Reviewed At</dt>
                  <dd>{formatDateTime(selectedDetail.reviewedAt)}</dd>
                </div>
                {selectedDetail.reviewReason ? (
                  <div className="bv-kv-item bv-kv-span-2">
                    <dt>Latest Review Reason</dt>
                    <dd>{selectedDetail.reviewReason}</dd>
                  </div>
                ) : null}
              </dl>

              {selectedDetail.status === 'PENDING' && !selectedDetail.submittedAt ? (
                <div className="bv-alert bv-alert--warning" role="status">
                  This customer has registered but has <strong>not yet submitted</strong>{' '}
                  their onboarding profile. Approval is blocked until submission, though
                  rejection with an explicit reason remains permitted.
                </div>
              ) : null}

              {canApprove || canReject ? (
                <div className="bv-review-actions bv-stack-md">
                  {canApprove ? (
                    <div className="bv-review-box">
                      <h3>Approve Application</h3>
                      <div className="bv-field">
                        <label htmlFor="approve-reason">
                          Approval Reason (optional, min 3 chars if entered)
                        </label>
                        <input
                          id="approve-reason"
                          type="text"
                          placeholder="e.g. Approved after synthetic onboarding review"
                          value={approveReason}
                          onChange={(e) => setApproveReason(e.target.value)}
                          disabled={actionBusy !== null}
                        />
                      </div>
                      <button
                        type="button"
                        className="bv-button bv-button--primary"
                        onClick={() => void handleApprove()}
                        disabled={actionBusy !== null}
                      >
                        {actionBusy === 'approve'
                          ? 'Approving...'
                          : 'Approve Application'}
                      </button>
                    </div>
                  ) : null}

                  {canReject ? (
                    <div className="bv-review-box bv-review-box--danger">
                      <h3>Reject Application</h3>
                      <div className="bv-field">
                        <label htmlFor="reject-reason">
                          Rejection Reason (required, 10–500 characters)
                        </label>
                        <textarea
                          id="reject-reason"
                          rows={2}
                          placeholder="Provide a clear reason recorded in the audit log..."
                          value={rejectReason}
                          onChange={(e) => {
                            setRejectReason(e.target.value);
                            setConfirmRejectPending(false);
                          }}
                          disabled={actionBusy !== null}
                        />
                      </div>
                      <div className="bv-actions-row">
                        <button
                          type="button"
                          className="bv-button bv-button--danger"
                          onClick={() => void handleReject()}
                          disabled={actionBusy !== null}
                        >
                          {actionBusy === 'reject'
                            ? 'Rejecting...'
                            : confirmRejectPending
                              ? 'Confirm Rejection'
                              : 'Reject Application'}
                        </button>
                        {confirmRejectPending ? (
                          <button
                            type="button"
                            className="bv-button bv-button--secondary"
                            onClick={() => setConfirmRejectPending(false)}
                            disabled={actionBusy !== null}
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="bv-muted">
                  No review actions available in <code>{selectedDetail.status}</code>{' '}
                  state.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
