import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { PaginationControls } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { TransactionDetailPanel } from '../components/TransactionDetailPanel';
import {
  accountsApi,
  onboardingApi,
  transactionsApi,
  transfersApi,
} from '../lib/api';
import { formatDateTime, sumAccountBalancesMinor } from '../lib/format';
import { formatMinorInr, parseRupeesInputToMinor } from '../lib/money';
import type {
  AccountItem,
  AccountLedgerItem,
  CustomerOnboardingApplication,
  EntryDirection,
  JournalTransactionType,
  TransactionDetailItem,
} from '../lib/types';
import { validateTransferForm } from '../lib/validation';

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `bv-web-${crypto.randomUUID()}`;
  }
  return `bv-web-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export function AccountsPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [onboarding, setOnboarding] =
    useState<CustomerOnboardingApplication | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<unknown>(null);

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  // Ledger state for selected account
  const [ledgerItems, setLedgerItems] = useState<AccountLedgerItem[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState(20);
  const [directionFilter, setDirectionFilter] = useState<'ALL' | EntryDirection>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | JournalTransactionType>('ALL');
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<unknown>(null);

  // Transaction detail drawer
  const [selectedTxn, setSelectedTxn] = useState<TransactionDetailItem | null>(null);
  const [txnLoading, setTxnLoading] = useState(false);
  const [txnError, setTxnError] = useState<unknown>(null);

  // Simulated transfer form state with sticky per-attempt idempotency key
  const [sourceAccountId, setSourceAccountId] = useState<string>('');
  const [destRef, setDestRef] = useState('');
  const [amountRupees, setAmountRupees] = useState('');
  const [description, setDescription] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    generateIdempotencyKey(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmTransferOpen, setConfirmTransferOpen] = useState(false);
  const [submittingTransfer, setSubmittingTransfer] = useState(false);
  const [transferError, setTransferError] = useState<unknown>(null);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);

  const activeAccounts = accounts.filter(
    (acc) => acc.kind === 'CUSTOMER' && acc.status === 'ACTIVE',
  );
  const selectedAccount =
    accounts.find((acc) => acc.id === selectedAccountId) ?? accounts[0] ?? null;
  const effectiveOnboardingStatus = onboarding?.status ?? user?.onboardingStatus;

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const [accountsRes, onboardingRes] = await Promise.all([
        accountsApi.list({ page: 1, pageSize: 50 }),
        onboardingApi.getOwn().catch(() => null),
      ]);
      setAccounts(accountsRes.items);
      if (onboardingRes) {
        setOnboarding(onboardingRes.application);
      }

      setSelectedAccountId((prev) => {
        if (prev && accountsRes.items.some((acc) => acc.id === prev)) {
          return prev;
        }
        return accountsRes.items[0]?.id ?? '';
      });

      const firstActive = accountsRes.items.find(
        (acc) => acc.kind === 'CUSTOMER' && acc.status === 'ACTIVE',
      );
      setSourceAccountId((prev) => {
        if (
          prev &&
          accountsRes.items.some((acc) => acc.id === prev && acc.status === 'ACTIVE')
        ) {
          return prev;
        }
        return firstActive?.id ?? '';
      });
    } catch (err) {
      setAccountsError(err);
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const loadLedger = useCallback(async () => {
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
        pageSize: ledgerPageSize,
        direction: directionFilter === 'ALL' ? undefined : directionFilter,
        type: typeFilter === 'ALL' ? undefined : typeFilter,
      });
      setLedgerItems(res.items);
      setLedgerTotal(res.total);
    } catch (err) {
      setLedgerError(err);
    } finally {
      setLedgerLoading(false);
    }
  }, [selectedAccount?.id, ledgerPage, ledgerPageSize, directionFilter, typeFilter]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const inspectTransaction = async (transactionId: string) => {
    setTxnLoading(true);
    setTxnError(null);
    try {
      const res = await transactionsApi.getById(transactionId);
      setSelectedTxn(res.transaction);
    } catch (err) {
      setTxnError(err);
    } finally {
      setTxnLoading(false);
    }
  };

  const updateFormField = (setter: (value: string) => void, value: string) => {
    setter(value);
    setConfirmTransferOpen(false);
    setTransferError(null);
    setTransferSuccess(null);
    setIdempotencyKey(generateIdempotencyKey());
  };

  const handleReviewTransfer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTransferError(null);
    setTransferSuccess(null);

    const { errors } = validateTransferForm({
      sourceAccountId,
      destinationAccountReference: destRef,
      amountRupees,
      description,
    });

    const sourceAcc = accounts.find((acc) => acc.id === sourceAccountId);
    if (
      sourceAcc &&
      destRef.trim().toUpperCase() === sourceAcc.publicReference.toUpperCase()
    ) {
      errors.destinationAccountReference =
        'Source and destination accounts must be different.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setConfirmTransferOpen(true);
  };

  const handleConfirmTransfer = async () => {
    const minor = parseRupeesInputToMinor(amountRupees, { allowZero: false });
    if (!minor) {
      return;
    }

    setSubmittingTransfer(true);
    setTransferError(null);
    setTransferSuccess(null);
    try {
      const normalizedDest = destRef.trim().toUpperCase();
      const res = await transfersApi.create(
        {
          sourceAccountId,
          destinationAccountReference: normalizedDest,
          amountMinor: minor,
          description: description.trim(),
        },
        idempotencyKey,
      );

      setConfirmTransferOpen(false);
      setSelectedAccountId(res.sourceAccount.id);
      setSelectedTxn(res.transaction);
      setTransferSuccess(
        res.idempotentReplay
          ? `Idempotent replay (${res.transaction.publicReference}): original transfer returned without duplicate debit.`
          : `Transfer ${res.transaction.publicReference} posted for ${formatMinorInr(minor)} to ${normalizedDest}.`,
      );

      setDestRef('');
      setAmountRupees('');
      setDescription('');
      setFieldErrors({});
      setIdempotencyKey(generateIdempotencyKey());

      await Promise.all([loadAccounts(), loadLedger()]);
    } catch (err) {
      // Keep confirmation open + preserve the exact Idempotency-Key so retries remain safe
      setTransferError(err);
    } finally {
      setSubmittingTransfer(false);
    }
  };

  const totalBalanceMinor = sumAccountBalancesMinor(accounts);
  const parsedAmountPreviewMinor = parseRupeesInputToMinor(amountRupees, {
    allowZero: false,
  });

  return (
    <div className="bv-stack-lg">
      <section className="bv-hero">
        <div className="bv-hero-row">
          <div>
            <h1>Accounts &amp; Ledger History</h1>
            <p>
              Owned synthetic INR vaults, immutable double-entry journal lines, and
              idempotent simulated internal transfers. Zero real funds or payment rails.
            </p>
          </div>
          <button
            type="button"
            className="bv-button bv-button--secondary"
            onClick={() => void Promise.all([loadAccounts(), loadLedger()])}
            disabled={accountsLoading || ledgerLoading}
          >
            Refresh
          </button>
        </div>
      </section>

      <ApiErrorAlert error={accountsError} title="Unable to load synthetic accounts" />

      <div className="bv-kpi-grid" aria-label="Account summary metrics">
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Total Synthetic Balance</div>
          <div className="bv-kpi-value bv-amount-mono">
            {accountsLoading ? '—' : formatMinorInr(totalBalanceMinor)}
          </div>
          <span className="bv-muted">Simulated INR demonstration balance only</span>
        </div>
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Owned Synthetic Vaults</div>
          <div className="bv-kpi-value">{accountsLoading ? '—' : accounts.length}</div>
          <span className="bv-muted">
            Active for transfers: {accountsLoading ? '—' : activeAccounts.length}
          </span>
        </div>
        <div className="bv-card bv-kpi-card">
          <div className="bv-kpi-label">Onboarding Eligibility</div>
          <div className="bv-mt-xs">
            {effectiveOnboardingStatus ? (
              <StatusBadge value={effectiveOnboardingStatus} />
            ) : (
              '—'
            )}
          </div>
          <Link to="/onboarding" className="bv-text-link bv-mt-xs">
            View Onboarding Application
          </Link>
        </div>
      </div>

      {!accountsLoading && accounts.length === 0 ? (
        <section className="bv-card" aria-labelledby="no-accounts-heading">
          <h2 id="no-accounts-heading" className="bv-card-title">
            No Synthetic Accounts Provisioned Yet
          </h2>
          {effectiveOnboardingStatus !== 'APPROVED' ? (
            <div className="bv-stack-sm bv-mt-sm">
              <p className="bv-muted">
                Your customer onboarding status is currently{' '}
                <strong>{effectiveOnboardingStatus ?? 'PENDING'}</strong>. Only customers
                with <code>APPROVED</code> onboarding can be provisioned synthetic ledger
                accounts by an administrator.
              </p>
              <div className="bv-actions-row">
                <Link to="/onboarding" className="bv-button bv-button--primary">
                  Manage Onboarding Profile
                </Link>
              </div>
            </div>
          ) : (
            <p className="bv-muted bv-mt-sm">
              Your onboarding application is <strong>APPROVED</strong>. Ask an
              administrator to open and activate an initial synthetic INR vault for your
              account under Admin Accounts.
            </p>
          )}
        </section>
      ) : null}

      {accounts.length > 0 ? (
        <div className="bv-split-layout">
          <section className="bv-card" aria-labelledby="owned-vaults-heading">
            <div className="bv-card-header">
              <div>
                <h2 id="owned-vaults-heading" className="bv-card-title">
                  Your Synthetic Vaults
                </h2>
                <p className="bv-card-subtitle">
                  Select a vault to inspect its paginated double-entry ledger.
                </p>
              </div>
            </div>

            <div className="bv-table-wrap">
              <table className="bv-table">
                <thead>
                  <tr>
                    <th>Vault</th>
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
                            }}
                          >
                            <span className="bv-cell-primary">{acc.accountName}</span>
                            <code className="bv-cell-secondary">
                              {acc.publicReference}
                            </code>
                          </button>
                          {acc.statusReason ? (
                            <div className="bv-cell-secondary">{acc.statusReason}</div>
                          ) : null}
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
          </section>

          <section className="bv-card" aria-labelledby="transfer-form-heading">
            <div className="bv-card-header">
              <div>
                <h2 id="transfer-form-heading" className="bv-card-title">
                  Simulated Internal Transfer
                </h2>
                <p className="bv-card-subtitle">
                  Double-entry synthetic INR transfer between active BalanceVault
                  accounts (protected by sticky <code>Idempotency-Key</code>).
                </p>
              </div>
              <span className="bv-badge bv-badge--info">SYNTHETIC INR</span>
            </div>

            {transferSuccess ? (
              <div className="bv-alert bv-alert--success bv-mb-md" role="status">
                {transferSuccess}
              </div>
            ) : null}

            <ApiErrorAlert error={transferError} title="Transfer failed" />

            {activeAccounts.length === 0 ? (
              <div className="bv-alert bv-alert--warning" role="status">
                Transfers require at least one <code>ACTIVE</code> synthetic vault. Your
                current vaults are <code>PENDING</code>, <code>FROZEN</code>, or{' '}
                <code>CLOSED</code>.
              </div>
            ) : (
              <form
                className="bv-form"
                onSubmit={(e) => handleReviewTransfer(e)}
                noValidate
              >
                <div className="bv-field">
                  <label htmlFor="transfer-source-account">Source Vault</label>
                  <select
                    id="transfer-source-account"
                    value={sourceAccountId}
                    onChange={(e) =>
                      updateFormField(setSourceAccountId, e.target.value)
                    }
                    disabled={submittingTransfer}
                  >
                    {activeAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.accountName} ({acc.publicReference}) —{' '}
                        {formatMinorInr(acc.balanceMinor)}
                      </option>
                    ))}
                  </select>
                  {fieldErrors.sourceAccountId ? (
                    <p className="bv-field-error">{fieldErrors.sourceAccountId}</p>
                  ) : null}
                </div>

                <div className="bv-form-grid">
                  <div className="bv-field">
                    <label htmlFor="transfer-dest-ref">
                      Destination Account Reference
                    </label>
                    <input
                      id="transfer-dest-ref"
                      type="text"
                      placeholder="BV-..."
                      value={destRef}
                      onChange={(e) => updateFormField(setDestRef, e.target.value)}
                      disabled={submittingTransfer}
                    />
                    {fieldErrors.destinationAccountReference ? (
                      <p className="bv-field-error">
                        {fieldErrors.destinationAccountReference}
                      </p>
                    ) : null}
                  </div>

                  <div className="bv-field">
                    <label htmlFor="transfer-amount-inr">
                      Amount (INR, max ₹1,00,00,000.00)
                    </label>
                    <input
                      id="transfer-amount-inr"
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 250.00"
                      value={amountRupees}
                      onChange={(e) => updateFormField(setAmountRupees, e.target.value)}
                      disabled={submittingTransfer}
                    />
                    {fieldErrors.amountRupees ? (
                      <p className="bv-field-error">{fieldErrors.amountRupees}</p>
                    ) : null}
                  </div>
                </div>

                <div className="bv-field">
                  <label htmlFor="transfer-description">Description</label>
                  <input
                    id="transfer-description"
                    type="text"
                    placeholder="Reason for internal synthetic transfer (3–140 chars)"
                    value={description}
                    onChange={(e) => updateFormField(setDescription, e.target.value)}
                    disabled={submittingTransfer}
                  />
                  {fieldErrors.description ? (
                    <p className="bv-field-error">{fieldErrors.description}</p>
                  ) : null}
                </div>

                <div className="bv-note-box">
                  Attempt <code>Idempotency-Key</code>: <code>{idempotencyKey}</code>
                </div>

                {!confirmTransferOpen ? (
                  <div className="bv-actions-row">
                    <button
                      type="submit"
                      className="bv-button bv-button--primary"
                      disabled={submittingTransfer}
                    >
                      Review Transfer
                    </button>
                  </div>
                ) : (
                  <div className="bv-review-box" role="region" aria-label="Transfer review confirmation">
                    <h3>Confirm Simulated Transfer</h3>
                    <p className="bv-muted">
                      Sending{' '}
                      <strong>
                        {parsedAmountPreviewMinor
                          ? formatMinorInr(parsedAmountPreviewMinor)
                          : amountRupees}
                      </strong>{' '}
                      to <code>{destRef.trim().toUpperCase()}</code> using sticky
                      idempotency key <code>{idempotencyKey}</code>.
                    </p>
                    <div className="bv-actions-row">
                      <button
                        type="button"
                        className="bv-button bv-button--primary"
                        onClick={() => void handleConfirmTransfer()}
                        disabled={submittingTransfer}
                      >
                        {submittingTransfer
                          ? 'Posting Transfer...'
                          : transferError
                            ? 'Retry Transfer'
                            : 'Confirm & Send Transfer'}
                      </button>
                      <button
                        type="button"
                        className="bv-button bv-button--secondary"
                        onClick={() => setConfirmTransferOpen(false)}
                        disabled={submittingTransfer}
                      >
                        Edit Details
                      </button>
                    </div>
                  </div>
                )}
              </form>
            )}
          </section>
        </div>
      ) : null}

      {selectedAccount ? (
        <section className="bv-card" aria-labelledby="selected-ledger-heading">
          <div className="bv-card-header">
            <div>
              <h2 id="selected-ledger-heading" className="bv-card-title">
                Ledger History — {selectedAccount.accountName} (
                <code>{selectedAccount.publicReference}</code>)
              </h2>
              <p className="bv-card-subtitle">
                Current balance:{' '}
                <strong className="bv-amount-mono">
                  {formatMinorInr(selectedAccount.balanceMinor)}
                </strong>{' '}
                · Total posted lines: {ledgerTotal}
              </p>
            </div>

            <div className="bv-filter-bar">
              <div className="bv-field">
                <label htmlFor="ledger-direction-filter">Direction</label>
                <select
                  id="ledger-direction-filter"
                  value={directionFilter}
                  onChange={(e) => {
                    setLedgerPage(1);
                    setDirectionFilter(e.target.value as 'ALL' | EntryDirection);
                  }}
                >
                  <option value="ALL">All directions</option>
                  <option value="CREDIT">CREDIT (+)</option>
                  <option value="DEBIT">DEBIT (-)</option>
                </select>
              </div>

              <div className="bv-field">
                <label htmlFor="ledger-type-filter">Type</label>
                <select
                  id="ledger-type-filter"
                  value={typeFilter}
                  onChange={(e) => {
                    setLedgerPage(1);
                    setTypeFilter(e.target.value as 'ALL' | JournalTransactionType);
                  }}
                >
                  <option value="ALL">All types</option>
                  <option value="DEMO_TRANSFER">DEMO_TRANSFER</option>
                  <option value="ADJUSTMENT">ADJUSTMENT</option>
                  <option value="REVERSAL">REVERSAL</option>
                </select>
              </div>

              <div className="bv-field">
                <label htmlFor="ledger-page-size">Per Page</label>
                <select
                  id="ledger-page-size"
                  value={ledgerPageSize}
                  onChange={(e) => {
                    setLedgerPage(1);
                    setLedgerPageSize(Number(e.target.value));
                  }}
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </div>
            </div>
          </div>

          <ApiErrorAlert error={ledgerError} title="Unable to load account ledger" />

          {ledgerLoading ? (
            <div className="bv-skeleton-stack" aria-busy="true">
              <div className="bv-skeleton-line" />
              <div className="bv-skeleton-line" />
            </div>
          ) : ledgerItems.length === 0 ? (
            <div className="bv-empty-state">
              No journal entries match the selected filters for this vault.
            </div>
          ) : (
            <>
              <div className="bv-table-wrap">
                <table className="bv-table">
                  <thead>
                    <tr>
                      <th>Posted At</th>
                      <th>Transaction Ref</th>
                      <th>Type &amp; Status</th>
                      <th>Description &amp; Counterparty</th>
                      <th>Direction</th>
                      <th className="bv-text-right">Amount</th>
                      <th>Detail</th>
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
                pageSize={ledgerPageSize}
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
        onSelectRelatedTransaction={(id) => void inspectTransaction(id)}
      />
    </div>
  );
}
