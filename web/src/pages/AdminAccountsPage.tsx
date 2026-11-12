import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { PaginationControls } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { TransactionDetailPanel } from '../components/TransactionDetailPanel';
import { accountsApi, adminApi, transactionsApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { formatMinorInr, parseRupeesInputToMinor } from '../lib/money';
import type {
  AccountItem,
  AccountLedgerItem,
  AccountStatus,
  AdminUserItem,
  EntryDirection,
  JournalTransactionType,
  TransactionDetailItem,
} from '../lib/types';
import { isValidUuid } from '../lib/validation';

export function AdminAccountsPage() {
  // Directory filters
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | AccountStatus>('ALL');
  const [includeSystem, setIncludeSystem] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Eligible customer list for account creation dropdown
  const [customers, setCustomers] = useState<AdminUserItem[]>([]);
  const [selectedOwnerMode, setSelectedOwnerMode] = useState<string>('');
  const [manualOwnerUuid, setManualOwnerUuid] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [initialStatus, setInitialStatus] = useState<'ACTIVE' | 'PENDING'>('ACTIVE');
  const [initialCreditInr, setInitialCreditInr] = useState('0');
  const [createReason, setCreateReason] = useState('');
  const [createValidationError, setCreateValidationError] = useState<string | null>(
    null,
  );
  const [createError, setCreateError] = useState<unknown>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Selected account inspector & lifecycle controls
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [lifecycleReason, setLifecycleReason] = useState('');
  const [pendingDestructiveAction, setPendingDestructiveAction] = useState<
    'FREEZE' | 'CLOSE' | null
  >(null);
  const [lifecycleValidationError, setLifecycleValidationError] = useState<string | null>(
    null,
  );
  const [lifecycleError, setLifecycleError] = useState<unknown>(null);
  const [lifecycleSuccess, setLifecycleSuccess] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  // Ledger & Transaction inspector for selected account
  const [ledgerItems, setLedgerItems] = useState<AccountLedgerItem[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerDirection, setLedgerDirection] = useState<'ALL' | EntryDirection>('ALL');
  const [ledgerType, setLedgerType] = useState<'ALL' | JournalTransactionType>('ALL');
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<unknown>(null);

  const [selectedTxn, setSelectedTxn] = useState<TransactionDetailItem | null>(null);
  const [txnLoading, setTxnLoading] = useState(false);
  const [txnError, setTxnError] = useState<unknown>(null);
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<unknown>(null);
  const [reverseSuccess, setReverseSuccess] = useState<string | null>(null);

  const selectedAccount =
    accounts.find((acc) => acc.id === selectedAccountId) ?? accounts[0] ?? null;

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await accountsApi.list({
        page,
        pageSize,
        search: appliedSearch || undefined,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        includeSystem,
      });
      setAccounts(res.items);
      setTotal(res.total);
      setSelectedAccountId((prev) => {
        if (prev && res.items.some((item) => item.id === prev)) {
          return prev;
        }
        return res.items[0]?.id ?? '';
      });
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, appliedSearch, statusFilter, includeSystem]);

  const loadCustomers = useCallback(async () => {
    try {
      const res = await adminApi.listUsers({
        role: 'CUSTOMER',
        page: 1,
        pageSize: 50,
      });
      setCustomers(res.items);
      setSelectedOwnerMode((prev) => {
        if (prev) return prev;
        const firstApproved = res.items.find(
          (u) => u.onboardingStatus === 'APPROVED' && u.status === 'ACTIVE',
        );
        return firstApproved?.id ?? res.items[0]?.id ?? '__manual__';
      });
    } catch {
      // Directory error handled by accounts list / form submit if unreachable
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  const loadSelectedLedger = useCallback(async () => {
    if (!selectedAccount?.id) {
      setLedgerItems([]);
      setLedgerTotal(0);
      return;
    }

    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const res = await accountsApi.getLedger(selectedAccount.id, {
        page: ledgerPage,
        pageSize: 15,
        direction: ledgerDirection === 'ALL' ? undefined : ledgerDirection,
        type: ledgerType === 'ALL' ? undefined : ledgerType,
      });
      setLedgerItems(res.items);
      setLedgerTotal(res.total);
    } catch (err) {
      setLedgerError(err);
    } finally {
      setLedgerLoading(false);
    }
  }, [selectedAccount?.id, ledgerPage, ledgerDirection, ledgerType]);

  useEffect(() => {
    void loadSelectedLedger();
  }, [loadSelectedLedger]);

  const handleFilterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(searchInput.trim());
  };

  const handleCreateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateValidationError(null);
    setCreateError(null);
    setCreateSuccess(null);

    const targetUserId =
      selectedOwnerMode === '__manual__' ? manualOwnerUuid.trim() : selectedOwnerMode;

    if (!isValidUuid(targetUserId)) {
      setCreateValidationError('Select a valid customer or enter a valid user UUID.');
      return;
    }

    const trimmedName = newAccountName.trim();
    if (trimmedName.length < 3 || trimmedName.length > 80) {
      setCreateValidationError('Account name must be between 3 and 80 characters.');
      return;
    }

    const creditMinor =
      initialStatus === 'PENDING'
        ? '0'
        : parseRupeesInputToMinor(initialCreditInr, { allowZero: true });
    if (!creditMinor) {
      setCreateValidationError(
        'Initial synthetic credit must be 0 or a positive INR amount up to ₹1,00,00,000.00.',
      );
      return;
    }

    const trimmedReason = createReason.trim();
    if (trimmedReason.length < 5 || trimmedReason.length > 500) {
      setCreateValidationError('Audit reason must be between 5 and 500 characters.');
      return;
    }

    setCreating(true);
    try {
      const res = await adminApi.createAccount({
        ownerUserId: targetUserId,
        accountName: trimmedName,
        initialStatus,
        initialCreditMinor: creditMinor,
        reason: trimmedReason,
      });

      setCreateSuccess(
        `Created ${res.account.accountName} (${res.account.publicReference}) in status ${res.account.status} with balance ${formatMinorInr(res.account.balanceMinor)}.`,
      );
      setNewAccountName('');
      setInitialCreditInr('0');
      setCreateReason('');
      setSelectedAccountId(res.account.id);
      if (res.openingTransaction) {
        setSelectedTxn(res.openingTransaction);
      }

      await loadAccounts();
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  };

  const runLifecycleAction = async (
    action: 'ACTIVATE' | 'FREEZE' | 'UNFREEZE' | 'CLOSE',
  ) => {
    if (!selectedAccount) return;
    setLifecycleValidationError(null);
    setLifecycleError(null);
    setLifecycleSuccess(null);

    const minLen = action === 'FREEZE' || action === 'CLOSE' ? 10 : 5;
    const trimmed = lifecycleReason.trim();
    if (trimmed.length < minLen || trimmed.length > 500) {
      setLifecycleValidationError(
        `Audit reason for ${action.toLowerCase()} must be ${minLen} to 500 characters.`,
      );
      return;
    }

    if (
      (action === 'FREEZE' || action === 'CLOSE') &&
      pendingDestructiveAction !== action
    ) {
      setPendingDestructiveAction(action);
      return;
    }

    setTransitioning(true);
    try {
      const res =
        action === 'ACTIVATE'
          ? await adminApi.activateAccount(selectedAccount.id, trimmed)
          : action === 'FREEZE'
            ? await adminApi.freezeAccount(selectedAccount.id, trimmed)
            : action === 'UNFREEZE'
              ? await adminApi.unfreezeAccount(selectedAccount.id, trimmed)
              : await adminApi.closeAccount(selectedAccount.id, trimmed);

      setLifecycleSuccess(
        `Updated ${res.account.publicReference} status to ${res.account.status}.`,
      );
      setLifecycleReason('');
      setPendingDestructiveAction(null);
      await loadAccounts();
    } catch (err) {
      setLifecycleError(err);
    } finally {
      setTransitioning(false);
    }
  };

  const inspectTransaction = async (transactionId: string) => {
    setTxnLoading(true);
    setTxnError(null);
    setReverseError(null);
    setReverseSuccess(null);
    try {
      const res = await transactionsApi.getById(transactionId);
      setSelectedTxn(res.transaction);
    } catch (err) {
      setTxnError(err);
    } finally {
      setTxnLoading(false);
    }
  };

  const handleReverseTransaction = async (transactionId: string, reason: string) => {
    setReversing(true);
    setReverseError(null);
    setReverseSuccess(null);
    try {
      const res = await adminApi.reverseTransaction(transactionId, reason);
      setReverseSuccess(
        `Posted compensating reversal ${res.reversalTransaction.publicReference}; original transaction is now REVERSED.`,
      );
      const updatedOriginal = await transactionsApi.getById(transactionId);
      setSelectedTxn(updatedOriginal.transaction);
      await Promise.all([loadAccounts(), loadSelectedLedger()]);
    } catch (err) {
      setReverseError(err);
    } finally {
      setReversing(false);
    }
  };

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <div className="bv-hero-row">
          <div>
            <h1>Account Provisioning &amp; Ledger Governance</h1>
            <p>
              Open synthetic customer INR vaults, transition account lifecycle states (
              <code>PENDING → ACTIVE → FROZEN → CLOSED</code>), inspect balanced
              double-entry lines, and issue compensating reversals.
            </p>
          </div>
          <button
            type="button"
            className="bv-button bv-button--secondary"
            onClick={() => void Promise.all([loadAccounts(), loadSelectedLedger()])}
            disabled={loading || ledgerLoading}
          >
            Refresh
          </button>
        </div>
      </section>

      <section className="bv-card" aria-labelledby="provision-account-heading">
        <div className="bv-card-header">
          <div>
            <h2 id="provision-account-heading" className="bv-card-title">
              Provision Customer Synthetic Account
            </h2>
            <p className="bv-card-subtitle">
              Requires an <code>ACTIVE</code> customer with <code>APPROVED</code>{' '}
              onboarding. Positive opening credits are funded symmetrically from{' '}
              <code>BV-SYS-TREASURY-01</code>.
            </p>
          </div>
          <span className="bv-badge bv-badge--info">DOUBLE-ENTRY ISSUANCE</span>
        </div>

        {createSuccess ? (
          <div className="bv-alert bv-alert--success bv-mb-md" role="status">
            {createSuccess}
          </div>
        ) : null}

        <ApiErrorAlert error={createError} title="Account provisioning failed" />

        {createValidationError ? (
          <div className="bv-alert bv-alert--error bv-mb-md" role="alert">
            {createValidationError}
          </div>
        ) : null}

        <form
          className="bv-form"
          onSubmit={(e) => void handleCreateAccount(e)}
          noValidate
        >
          <div className="bv-form-grid">
            <div className="bv-field">
              <label htmlFor="create-owner-select">Customer Owner</label>
              <select
                id="create-owner-select"
                value={selectedOwnerMode}
                onChange={(e) => setSelectedOwnerMode(e.target.value)}
                disabled={creating}
              >
                {customers.map((cust) => (
                  <option key={cust.id} value={cust.id}>
                    {cust.fullName} — {cust.email} ({cust.onboardingStatus ?? 'NONE'})
                  </option>
                ))}
                <option value="__manual__">Enter Customer UUID manually...</option>
              </select>
            </div>

            {selectedOwnerMode === '__manual__' ? (
              <div className="bv-field">
                <label htmlFor="create-owner-uuid">Customer User UUID</label>
                <input
                  id="create-owner-uuid"
                  type="text"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={manualOwnerUuid}
                  onChange={(e) => setManualOwnerUuid(e.target.value)}
                  disabled={creating}
                />
              </div>
            ) : null}

            <div className="bv-field">
              <label htmlFor="create-account-name">Account Label</label>
              <input
                id="create-account-name"
                type="text"
                placeholder="e.g. Primary Synthetic Reserve"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                disabled={creating}
              />
            </div>

            <div className="bv-field">
              <label htmlFor="create-initial-status">Initial Status</label>
              <select
                id="create-initial-status"
                value={initialStatus}
                onChange={(e) => {
                  const next = e.target.value as 'ACTIVE' | 'PENDING';
                  setInitialStatus(next);
                  if (next === 'PENDING') {
                    setInitialCreditInr('0');
                  }
                }}
                disabled={creating}
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="PENDING">PENDING</option>
              </select>
            </div>

            <div className="bv-field">
              <label htmlFor="create-initial-credit">
                Opening Synthetic Allocation (INR)
              </label>
              <input
                id="create-initial-credit"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={initialCreditInr}
                onChange={(e) => setInitialCreditInr(e.target.value)}
                disabled={creating || initialStatus === 'PENDING'}
              />
            </div>
          </div>

          <div className="bv-field">
            <label htmlFor="create-account-reason">
              Provisioning Audit Reason (required, 5–500 chars)
            </label>
            <input
              id="create-account-reason"
              type="text"
              placeholder="Document synthetic allocation approval and audit reference..."
              value={createReason}
              onChange={(e) => setCreateReason(e.target.value)}
              disabled={creating}
            />
          </div>

          <div className="bv-actions-row">
            <button
              type="submit"
              className="bv-button bv-button--primary"
              disabled={creating}
            >
              {creating ? 'Provisioning...' : 'Create Synthetic Account'}
            </button>
          </div>
        </form>
      </section>

      <section className="bv-card" aria-label="Account directory filters">
        <form className="bv-filter-bar" onSubmit={(e) => handleFilterSubmit(e)}>
          <div className="bv-field bv-field--grow">
            <label htmlFor="admin-accounts-search">
              Search Reference, Label, or Owner
            </label>
            <input
              id="admin-accounts-search"
              type="text"
              placeholder="e.g. BV-..., Primary Reserve, or customer email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          <div className="bv-field">
            <label htmlFor="admin-accounts-status">Status</label>
            <select
              id="admin-accounts-status"
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value as 'ALL' | AccountStatus);
              }}
            >
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="PENDING">PENDING</option>
              <option value="FROZEN">FROZEN</option>
              <option value="CLOSED">CLOSED</option>
            </select>
          </div>

          <label className="bv-checkbox-field">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => {
                setPage(1);
                setIncludeSystem(e.target.checked);
              }}
            />
            <span>Include System Issuance Reserve</span>
          </label>

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
                setStatusFilter('ALL');
                setIncludeSystem(false);
                setPage(1);
              }}
            >
              Reset
            </button>
          </div>
        </form>
      </section>

      <ApiErrorAlert error={loadError} title="Unable to load accounts directory" />

      <div className="bv-split-layout">
        <section className="bv-card" aria-labelledby="admin-accounts-table-heading">
          <div className="bv-card-header">
            <h2 id="admin-accounts-table-heading" className="bv-card-title">
              Accounts Directory ({total})
            </h2>
            <select
              aria-label="Accounts per page"
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
          </div>

          {loading ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="bv-empty-state">No accounts match the active filters.</div>
          ) : (
            <>
              <div className="bv-table-wrap">
                <table className="bv-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Owner / Kind</th>
                      <th>Status</th>
                      <th className="bv-text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((acc) => {
                      const isSelected = selectedAccount?.id === acc.id;
                      return (
                        <tr
                          key={acc.id}
                          className={
                            isSelected ? 'bv-row-selected' : 'bv-row-clickable'
                          }
                        >
                          <td>
                            <button
                              type="button"
                              className="bv-table-select-btn"
                              onClick={() => {
                                setSelectedAccountId(acc.id);
                                setLedgerPage(1);
                                setLifecycleError(null);
                                setLifecycleSuccess(null);
                                setLifecycleValidationError(null);
                                setPendingDestructiveAction(null);
                              }}
                            >
                              <span className="bv-cell-primary">{acc.accountName}</span>
                              <code className="bv-cell-secondary">
                                {acc.publicReference}
                              </code>
                            </button>
                          </td>
                          <td>
                            {acc.owner ? (
                              <>
                                <div className="bv-cell-primary">
                                  {acc.owner.fullName}
                                </div>
                                <div className="bv-cell-secondary">{acc.owner.email}</div>
                              </>
                            ) : (
                              <StatusBadge value={acc.kind} />
                            )}
                          </td>
                          <td>
                            <StatusBadge value={acc.status} />
                          </td>
                          <td className="bv-text-right bv-amount-mono">
                            {formatMinorInr(acc.balanceMinor)}
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

        <section className="bv-card" aria-labelledby="account-inspector-heading">
          <h2 id="account-inspector-heading" className="bv-card-title">
            Selected Account Lifecycle
          </h2>

          {!selectedAccount ? (
            <p className="bv-muted bv-mt-sm">
              Select an account from the directory to inspect details and manage
              lifecycle state.
            </p>
          ) : (
            <div className="bv-stack-md bv-mt-sm">
              <dl className="bv-kv-grid">
                <div className="bv-kv-item">
                  <dt>Public Reference</dt>
                  <dd>
                    <code>{selectedAccount.publicReference}</code>
                  </dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Status &amp; Version</dt>
                  <dd className="bv-badges-inline">
                    <StatusBadge value={selectedAccount.status} />
                    <span>v{selectedAccount.version}</span>
                  </dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Synthetic Balance</dt>
                  <dd className="bv-amount-mono">
                    <strong>{formatMinorInr(selectedAccount.balanceMinor)}</strong>
                  </dd>
                </div>
                <div className="bv-kv-item">
                  <dt>Owner</dt>
                  <dd>
                    {selectedAccount.owner
                      ? `${selectedAccount.owner.fullName} (${selectedAccount.owner.email})`
                      : 'SYSTEM ISSUANCE TREASURY'}
                  </dd>
                </div>
                <div className="bv-kv-item bv-kv-span-2">
                  <dt>Status Reason</dt>
                  <dd>{selectedAccount.statusReason ?? '—'}</dd>
                </div>
              </dl>

              {lifecycleSuccess ? (
                <div className="bv-alert bv-alert--success" role="status">
                  {lifecycleSuccess}
                </div>
              ) : null}

              <ApiErrorAlert error={lifecycleError} title="Lifecycle update failed" />

              {lifecycleValidationError ? (
                <div className="bv-alert bv-alert--error" role="alert">
                  {lifecycleValidationError}
                </div>
              ) : null}

              {selectedAccount.kind !== 'CUSTOMER' ? (
                <div className="bv-alert bv-alert--info" role="status">
                  <code>{selectedAccount.publicReference}</code> is the protected
                  double-entry system issuance reserve. Its status cannot be modified.
                </div>
              ) : selectedAccount.status === 'CLOSED' ? (
                <div className="bv-alert bv-alert--info" role="status">
                  This account is permanently <code>CLOSED</code> (balance ₹0.00).
                </div>
              ) : (
                <div className="bv-review-actions bv-stack-sm">
                  <div className="bv-field">
                    <label htmlFor="account-lifecycle-reason">
                      Lifecycle Audit Reason (min 5 chars; min 10 chars for Freeze /
                      Close)
                    </label>
                    <input
                      id="account-lifecycle-reason"
                      type="text"
                      placeholder="Explain operational or compliance reason..."
                      value={lifecycleReason}
                      onChange={(e) => {
                        setLifecycleReason(e.target.value);
                        setPendingDestructiveAction(null);
                      }}
                      disabled={transitioning}
                    />
                  </div>

                  <div className="bv-actions-row">
                    {selectedAccount.status === 'PENDING' ? (
                      <button
                        type="button"
                        className="bv-button bv-button--primary"
                        onClick={() => void runLifecycleAction('ACTIVATE')}
                        disabled={transitioning}
                      >
                        Activate Account
                      </button>
                    ) : null}

                    {selectedAccount.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="bv-button bv-button--danger"
                        onClick={() => void runLifecycleAction('FREEZE')}
                        disabled={transitioning}
                      >
                        Freeze Account
                      </button>
                    ) : null}

                    {selectedAccount.status === 'FROZEN' ? (
                      <button
                        type="button"
                        className="bv-button bv-button--primary"
                        onClick={() => void runLifecycleAction('UNFREEZE')}
                        disabled={transitioning}
                      >
                        Unfreeze Account
                      </button>
                    ) : null}

                    {selectedAccount.status === 'ACTIVE' ||
                    selectedAccount.status === 'FROZEN' ? (
                      <button
                        type="button"
                        className="bv-button bv-button--secondary"
                        onClick={() => void runLifecycleAction('CLOSE')}
                        disabled={
                          transitioning || selectedAccount.balanceMinor !== '0'
                        }
                        title={
                          selectedAccount.balanceMinor !== '0'
                            ? 'Account balance must be ₹0.00 before closing'
                            : 'Close zero-balance vault'
                        }
                      >
                        Close Account
                      </button>
                    ) : null}
                  </div>

                  {selectedAccount.balanceMinor !== '0' &&
                  (selectedAccount.status === 'ACTIVE' ||
                    selectedAccount.status === 'FROZEN') ? (
                    <p className="bv-muted">
                      Closing requires a zero balance (<code>₹0.00</code>). Current
                      balance: {formatMinorInr(selectedAccount.balanceMinor)}.
                    </p>
                  ) : null}

                  {pendingDestructiveAction ? (
                    <div className="bv-alert bv-alert--warning" role="alert">
                      <p className="bv-mb-sm">
                        Confirm <strong>{pendingDestructiveAction}</strong> on{' '}
                        <code>{selectedAccount.publicReference}</code>?
                      </p>
                      <div className="bv-actions-row">
                        <button
                          type="button"
                          className="bv-button bv-button--danger"
                          onClick={() =>
                            void runLifecycleAction(pendingDestructiveAction)
                          }
                          disabled={transitioning}
                        >
                          Confirm {pendingDestructiveAction}
                        </button>
                        <button
                          type="button"
                          className="bv-button bv-button--secondary"
                          onClick={() => setPendingDestructiveAction(null)}
                          disabled={transitioning}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {selectedAccount ? (
        <section className="bv-card" aria-labelledby="admin-ledger-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="admin-ledger-heading" className="bv-card-title">
                Ledger Entries — {selectedAccount.accountName} (
                <code>{selectedAccount.publicReference}</code>)
              </h2>
              <p className="bv-card-subtitle">
                Posted journal entries: {ledgerTotal}. Inspect any entry to post a
                compensating reversal.
              </p>
            </div>

            <div className="bv-filter-bar">
              <div className="bv-field">
                <label htmlFor="admin-ledger-direction">Direction</label>
                <select
                  id="admin-ledger-direction"
                  value={ledgerDirection}
                  onChange={(e) => {
                    setLedgerPage(1);
                    setLedgerDirection(e.target.value as 'ALL' | EntryDirection);
                  }}
                >
                  <option value="ALL">All</option>
                  <option value="CREDIT">CREDIT</option>
                  <option value="DEBIT">DEBIT</option>
                </select>
              </div>
              <div className="bv-field">
                <label htmlFor="admin-ledger-type">Type</label>
                <select
                  id="admin-ledger-type"
                  value={ledgerType}
                  onChange={(e) => {
                    setLedgerPage(1);
                    setLedgerType(e.target.value as 'ALL' | JournalTransactionType);
                  }}
                >
                  <option value="ALL">All</option>
                  <option value="DEMO_TRANSFER">DEMO_TRANSFER</option>
                  <option value="ADJUSTMENT">ADJUSTMENT</option>
                  <option value="REVERSAL">REVERSAL</option>
                </select>
              </div>
            </div>
          </div>

          <ApiErrorAlert error={ledgerError} title="Unable to load account ledger" />

          {reverseSuccess ? (
            <div className="bv-alert bv-alert--success bv-mb-md" role="status">
              {reverseSuccess}
            </div>
          ) : null}

          {ledgerLoading ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : ledgerItems.length === 0 ? (
            <div className="bv-empty-state">No journal entries found for this vault.</div>
          ) : (
            <>
              <div className="bv-table-wrap">
                <table className="bv-table">
                  <thead>
                    <tr>
                      <th>Posted</th>
                      <th>Txn Ref</th>
                      <th>Type &amp; Status</th>
                      <th>Description</th>
                      <th>Direction</th>
                      <th className="bv-text-right">Amount</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerItems.map((entry) => (
                      <tr
                        key={entry.id}
                        className={
                          selectedTxn?.id === entry.transactionId ? 'bv-row-selected' : ''
                        }
                      >
                        <td>{formatDateTime(entry.createdAt)}</td>
                        <td>
                          <code>{entry.transactionPublicReference}</code>
                        </td>
                        <td>
                          <div className="bv-badges-inline">
                            <StatusBadge value={entry.transactionType} />
                            <StatusBadge value={entry.transactionStatus} />
                          </div>
                        </td>
                        <td>
                          <div className="bv-cell-primary">{entry.description}</div>
                          {entry.counterpartyReference ? (
                            <div className="bv-cell-secondary">
                              Counterparty: <code>{entry.counterpartyReference}</code>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <StatusBadge value={entry.direction} />
                        </td>
                        <td className="bv-text-right bv-amount-mono">
                          <span
                            className={
                              entry.direction === 'CREDIT'
                                ? 'bv-amount-credit'
                                : 'bv-amount-debit'
                            }
                          >
                            {entry.direction === 'CREDIT' ? '+' : '-'}
                            {formatMinorInr(entry.amountMinor)}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="bv-button bv-button--secondary"
                            onClick={() => void inspectTransaction(entry.transactionId)}
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <PaginationControls
                page={ledgerPage}
                pageSize={15}
                total={ledgerTotal}
                disabled={ledgerLoading}
                onPageChange={setLedgerPage}
              />
            </>
          )}
        </section>
      ) : null}

      <TransactionDetailPanel
        transaction={selectedTxn}
        loading={txnLoading}
        error={txnError}
        onClose={() => setSelectedTxn(null)}
        canReverse
        onReverse={handleReverseTransaction}
        reversing={reversing}
        reverseError={reverseError}
        onSelectRelatedTransaction={(id) => void inspectTransaction(id)}
      />
    </div>
  );
}
