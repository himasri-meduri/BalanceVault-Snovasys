import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime } from '../lib/format';
import { formatMinorInr } from '../lib/money';
import type { TransactionDetailItem } from '../lib/types';
import { ApiErrorAlert } from './ApiErrorAlert';
import { StatusBadge } from './StatusBadge';

interface TransactionDetailPanelProps {
  transaction: TransactionDetailItem | null;
  loading?: boolean;
  error?: unknown;
  onClose?: () => void;
  canReverse?: boolean;
  onReverse?: (transactionId: string, reason: string) => Promise<void>;
  reversing?: boolean;
  reverseError?: unknown;
  onSelectRelatedTransaction?: (transactionId: string) => void;
}

export function TransactionDetailPanel({
  transaction,
  loading = false,
  error = null,
  onClose,
  canReverse = false,
  onReverse,
  reversing = false,
  reverseError = null,
  onSelectRelatedTransaction,
}: TransactionDetailPanelProps) {
  const [reverseReason, setReverseReason] = useState('');
  const [confirmReverse, setConfirmReverse] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setReverseReason('');
    setConfirmReverse(false);
    setValidationError(null);
  }, [transaction?.id]);

  if (!loading && !error && !transaction) {
    return null;
  }

  const eligibleForReversal =
    Boolean(canReverse) &&
    Boolean(onReverse) &&
    transaction !== null &&
    transaction.type !== 'REVERSAL' &&
    transaction.status === 'POSTED' &&
    transaction.reversedByTransactionId === null;

  const handlePrepareReversal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(null);
    const trimmed = reverseReason.trim();
    if (trimmed.length < 10 || trimmed.length > 500) {
      setValidationError('Reversal reason must be between 10 and 500 characters.');
      return;
    }
    setConfirmReverse(true);
  };

  const handleConfirmReversal = async () => {
    if (!transaction || !onReverse) {
      return;
    }
    setValidationError(null);
    await onReverse(transaction.id, reverseReason.trim());
    setConfirmReverse(false);
    setReverseReason('');
  };

  return (
    <section
      className="bv-card bv-txn-drawer"
      aria-labelledby="transaction-detail-heading"
    >
      <div className="bv-card-header">
        <div>
          <h2 id="transaction-detail-heading" className="bv-card-title">
            Journal Transaction Detail
          </h2>
          <p className="bv-card-subtitle">
            Immutable double-entry ledger lines verified on PostgreSQL.
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            className="bv-button bv-button--secondary"
            onClick={onClose}
          >
            Close Detail
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="bv-skeleton-stack" aria-busy="true">
          <div className="bv-skeleton-line" />
          <div className="bv-skeleton-line" />
          <div className="bv-skeleton-line" />
        </div>
      ) : null}

      <ApiErrorAlert error={error} title="Unable to load transaction detail" />

      {!loading && transaction ? (
        <div className="bv-stack-md">
          <dl className="bv-kv-grid">
            <div className="bv-kv-item">
              <dt>Transaction Reference</dt>
              <dd>
                <code>{transaction.publicReference}</code>
              </dd>
            </div>
            <div className="bv-kv-item">
              <dt>Type &amp; Effective Status</dt>
              <dd className="bv-badges-inline">
                <StatusBadge value={transaction.type} />
                <StatusBadge value={transaction.status} />
              </dd>
            </div>
            <div className="bv-kv-item">
              <dt>Posted At</dt>
              <dd>{formatDateTime(transaction.createdAt)}</dd>
            </div>
            <div className="bv-kv-item">
              <dt>Currency</dt>
              <dd>{transaction.currency} (Synthetic)</dd>
            </div>
            <div className="bv-kv-item bv-kv-span-2">
              <dt>Description</dt>
              <dd>{transaction.description}</dd>
            </div>
          </dl>

          {transaction.reversalOfTransactionId ? (
            <div className="bv-alert bv-alert--info">
              <div className="bv-alert-row">
                <span>
                  This compensating entry reverses original transaction{' '}
                  <code>
                    {transaction.reversalOfPublicReference ??
                      transaction.reversalOfTransactionId}
                  </code>
                  .
                </span>
                {onSelectRelatedTransaction ? (
                  <button
                    type="button"
                    className="bv-button bv-button--secondary"
                    onClick={() =>
                      onSelectRelatedTransaction(transaction.reversalOfTransactionId!)
                    }
                  >
                    Inspect Original
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {transaction.reversedByTransactionId ? (
            <div className="bv-alert bv-alert--warning">
              <div className="bv-alert-row">
                <span>
                  Reversed by compensating transaction{' '}
                  <code>
                    {transaction.reversedByPublicReference ??
                      transaction.reversedByTransactionId}
                  </code>
                  . Original journal rows remain immutable.
                </span>
                {onSelectRelatedTransaction ? (
                  <button
                    type="button"
                    className="bv-button bv-button--secondary"
                    onClick={() =>
                      onSelectRelatedTransaction(transaction.reversedByTransactionId!)
                    }
                  >
                    Inspect Reversal
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="bv-table-wrap">
            <table className="bv-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Account Reference</th>
                  <th>Kind</th>
                  <th>Vault Label</th>
                  <th className="bv-text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transaction.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <StatusBadge value={entry.direction} />
                    </td>
                    <td>
                      <code>{entry.accountPublicReference}</code>
                    </td>
                    <td>
                      <StatusBadge value={entry.accountKind} />
                    </td>
                    <td>
                      {entry.accountName ? (
                        entry.accountName
                      ) : (
                        <span className="bv-muted">Counterparty details redacted</span>
                      )}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {eligibleForReversal ? (
            <div className="bv-review-box bv-review-box--danger">
              <h3>Issue Compensating Reversal</h3>
              <p className="bv-muted">
                Appends opposite-direction entries in a new <code>REVERSAL</code> journal
                transaction without mutating original entries. Fails with{' '}
                <code>422</code> if the credited account has insufficient balance or{' '}
                <code>409</code> if any participating account is <code>CLOSED</code>.
              </p>

              <ApiErrorAlert error={reverseError} title="Reversal failed" />

              {validationError ? (
                <div className="bv-alert bv-alert--error" role="alert">
                  {validationError}
                </div>
              ) : null}

              <form
                className="bv-form"
                onSubmit={(e) => handlePrepareReversal(e)}
                noValidate
              >
                <div className="bv-field">
                  <label htmlFor="reversal-reason-input">
                    Compensating Reversal Reason (required, 10–500 chars)
                  </label>
                  <textarea
                    id="reversal-reason-input"
                    rows={2}
                    placeholder="Document compliance or operational justification for this reversal..."
                    value={reverseReason}
                    onChange={(e) => {
                      setReverseReason(e.target.value);
                      setConfirmReverse(false);
                    }}
                    disabled={reversing}
                  />
                </div>

                {!confirmReverse ? (
                  <div className="bv-actions-row">
                    <button
                      type="submit"
                      className="bv-button bv-button--danger"
                      disabled={reversing}
                    >
                      Review Reversal
                    </button>
                  </div>
                ) : (
                  <div className="bv-alert bv-alert--warning" role="alert">
                    <p className="bv-mb-sm">
                      Confirm posting a compensating <code>REVERSAL</code> for{' '}
                      <code>{transaction.publicReference}</code>? This cannot be reversed
                      again.
                    </p>
                    <div className="bv-actions-row">
                      <button
                        type="button"
                        className="bv-button bv-button--danger"
                        onClick={() => void handleConfirmReversal()}
                        disabled={reversing}
                      >
                        {reversing ? 'Posting Reversal...' : 'Confirm Reversal'}
                      </button>
                      <button
                        type="button"
                        className="bv-button bv-button--secondary"
                        onClick={() => setConfirmReverse(false)}
                        disabled={reversing}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </form>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
