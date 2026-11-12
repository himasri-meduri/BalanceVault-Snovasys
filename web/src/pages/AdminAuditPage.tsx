import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { PaginationControls } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { adminApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AuditEventItem } from '../lib/types';
import { isValidUuid } from '../lib/validation';

const KNOWN_ACTIONS = [
  'AUTH_REGISTER',
  'AUTH_LOGIN_SUCCESS',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',
  'ADMIN_BOOTSTRAP_COMPLETED',
  'USER_ROLE_CHANGE',
  'USER_STATUS_CHANGE',
  'ONBOARDING_PROFILE_UPDATED',
  'ONBOARDING_SUBMITTED',
  'ONBOARDING_RESUBMITTED',
  'ONBOARDING_RESUBMISSION_DRAFTED',
  'ONBOARDING_APPROVED',
  'ONBOARDING_REJECTED',
  'ACCOUNT_CREATED',
  'ACCOUNT_ACTIVATED',
  'ACCOUNT_FROZEN',
  'ACCOUNT_UNFROZEN',
  'ACCOUNT_CLOSED',
  'TRANSFER_POSTED',
  'TRANSFER_REJECTED',
  'TRANSACTION_REVERSED',
];

const KNOWN_ENTITIES = [
  'User',
  'Session',
  'OnboardingApplication',
  'Account',
  'JournalTransaction',
];

export function AdminAuditPage() {
  const [actionInput, setActionInput] = useState('');
  const [entityInput, setEntityInput] = useState('');
  const [actorIdInput, setActorIdInput] = useState('');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');

  const [appliedFilters, setAppliedFilters] = useState<{
    action?: string;
    entityType?: string;
    actorUserId?: string;
    from?: string;
    to?: string;
  }>({});
  const [filterError, setFilterError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadAuditEvents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminApi.listAuditEvents({
        page,
        pageSize,
        ...appliedFilters,
      });
      setEvents(res.items);
      setTotal(res.total);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page, pageSize]);

  useEffect(() => {
    void loadAuditEvents();
  }, [loadAuditEvents]);

  const handleFilterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilterError(null);

    const trimmedActor = actorIdInput.trim();
    if (trimmedActor && !isValidUuid(trimmedActor)) {
      setFilterError('Actor User ID filter must be a valid UUID.');
      return;
    }

    if (fromInput && toInput && fromInput > toInput) {
      setFilterError('"From" date must not be after "To" date.');
      return;
    }

    setPage(1);
    setAppliedFilters({
      action: actionInput.trim() || undefined,
      entityType: entityInput.trim() || undefined,
      actorUserId: trimmedActor || undefined,
      from: fromInput || undefined,
      to: toInput || undefined,
    });
  };

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <h1>Audit Event Viewer</h1>
        <p>
          Read-only inspection of BalanceVault&apos;s append-only{' '}
          <code>AuditEvent</code> log. PostgreSQL triggers prohibit updates or
          deletions, and sensitive values are redacted server-side.
        </p>
      </section>

      <section className="bv-card" aria-label="Audit filters">
        <form className="bv-filter-bar" onSubmit={(e) => handleFilterSubmit(e)}>
          <div className="bv-field">
            <label htmlFor="audit-action-filter">Action</label>
            <input
              id="audit-action-filter"
              list="audit-action-options"
              type="text"
              placeholder="e.g. TRANSFER_POSTED"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
            />
            <datalist id="audit-action-options">
              {KNOWN_ACTIONS.map((act) => (
                <option key={act} value={act} />
              ))}
            </datalist>
          </div>

          <div className="bv-field">
            <label htmlFor="audit-entity-filter">Entity Type</label>
            <input
              id="audit-entity-filter"
              list="audit-entity-options"
              type="text"
              placeholder="e.g. JournalTransaction"
              value={entityInput}
              onChange={(e) => setEntityInput(e.target.value)}
            />
            <datalist id="audit-entity-options">
              {KNOWN_ENTITIES.map((ent) => (
                <option key={ent} value={ent} />
              ))}
            </datalist>
          </div>

          <div className="bv-field bv-field--grow">
            <label htmlFor="audit-actor-filter">Actor User UUID</label>
            <input
              id="audit-actor-filter"
              type="text"
              placeholder="Optional actor user UUID..."
              value={actorIdInput}
              onChange={(e) => setActorIdInput(e.target.value)}
            />
          </div>

          <div className="bv-field">
            <label htmlFor="audit-from-date">From Date</label>
            <input
              id="audit-from-date"
              type="date"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
            />
          </div>

          <div className="bv-field">
            <label htmlFor="audit-to-date">To Date</label>
            <input
              id="audit-to-date"
              type="date"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
            />
          </div>

          <div className="bv-field">
            <label htmlFor="audit-page-size">Per Page</label>
            <select
              id="audit-page-size"
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
                setActionInput('');
                setEntityInput('');
                setActorIdInput('');
                setFromInput('');
                setToInput('');
                setFilterError(null);
                setAppliedFilters({});
                setPage(1);
              }}
            >
              Reset
            </button>
          </div>
        </form>

        {filterError ? (
          <div className="bv-alert bv-alert--error bv-mt-sm" role="alert">
            {filterError}
          </div>
        ) : null}
      </section>

      <ApiErrorAlert error={loadError} title="Unable to load audit events" />

      <section className="bv-card" aria-labelledby="audit-events-heading">
        <div className="bv-card-header">
          <h2 id="audit-events-heading" className="bv-card-title">
            Audit Trail ({total})
          </h2>
          <button
            type="button"
            className="bv-button bv-button--secondary"
            onClick={() => void loadAuditEvents()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="bv-skeleton-stack" aria-busy="true">
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
            <div className="bv-skeleton-line" />
          </div>
        ) : events.length === 0 ? (
          <div className="bv-empty-state">
            No audit events match the active filters.
          </div>
        ) : (
          <>
            <div className="bv-table-wrap">
              <table className="bv-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Target</th>
                    <th>Reason</th>
                    <th>State Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((evt) => {
                    const expanded = expandedId === evt.id;
                    return (
                      <Fragment key={evt.id}>
                        <tr>
                          <td>{formatDateTime(evt.occurredAt)}</td>
                          <td>
                            <code>{evt.action}</code>
                          </td>
                          <td>
                            <div className="bv-badges-inline">
                              <StatusBadge value={evt.actorType} />
                            </div>
                            <div className="bv-cell-secondary">
                              {evt.actorUserId ?? 'anonymous / system'}
                            </div>
                          </td>
                          <td>
                            <div className="bv-cell-primary">{evt.entityType}</div>
                            <div className="bv-cell-secondary">{evt.entityId}</div>
                          </td>
                          <td>{evt.reason ?? '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="bv-button bv-button--secondary"
                              aria-expanded={expanded}
                              onClick={() =>
                                setExpandedId((cur) => (cur === evt.id ? null : evt.id))
                              }
                            >
                              {expanded ? 'Hide' : 'Inspect'}
                            </button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="bv-audit-detail-row">
                            <td colSpan={6}>
                              <div className="bv-audit-detail">
                                <div>
                                  <strong>Request ID:</strong>{' '}
                                  <code>{evt.requestId}</code>
                                </div>
                                <div className="bv-audit-json-grid">
                                  <div>
                                    <strong>Before State</strong>
                                    <pre className="bv-pre">
                                      {evt.beforeState
                                        ? JSON.stringify(evt.beforeState, null, 2)
                                        : 'null'}
                                    </pre>
                                  </div>
                                  <div>
                                    <strong>After State</strong>
                                    <pre className="bv-pre">
                                      {evt.afterState
                                        ? JSON.stringify(evt.afterState, null, 2)
                                        : 'null'}
                                    </pre>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
