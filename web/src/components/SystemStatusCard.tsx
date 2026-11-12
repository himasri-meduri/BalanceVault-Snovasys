import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiClientError } from '../lib/apiClient';
import { StatusBadge } from './StatusBadge';

interface HealthPayload {
  status: string;
  service: string;
  timestamp: string;
  requestId: string;
}

interface ReadyPayload {
  status: 'ready' | 'degraded';
  checks: {
    database: 'ok' | 'unavailable';
    redis: 'ok' | 'unavailable';
  };
  timestamp: string;
  requestId: string;
}

export function SystemStatusCard() {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [ready, setReady] = useState<ReadyPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const healthData = await apiRequest<HealthPayload>('/health');
      setHealth(healthData);

      try {
        const readyData = await apiRequest<ReadyPayload>('/ready');
        setReady(readyData);
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 503) {
          const payload = err.data as Partial<ReadyPayload> | null;
          setReady({
            status: 'degraded',
            checks: {
              database: payload?.checks?.database ?? 'unavailable',
              redis: payload?.checks?.redis ?? 'unavailable',
            },
            timestamp: payload?.timestamp ?? new Date().toISOString(),
            requestId: payload?.requestId ?? err.requestId ?? 'n/a',
          });
        } else {
          throw err;
        }
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to reach BalanceVault API',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return (
    <section className="bv-card" aria-labelledby="system-status-heading">
      <div className="bv-card-header">
        <div>
          <h2 id="system-status-heading" className="bv-card-title">
            Platform Health &amp; Readiness
          </h2>
          <p className="bv-card-subtitle">
            Live verification of API liveness, PostgreSQL, and Redis rate-limit store.
          </p>
        </div>
        <button
          type="button"
          className="bv-button bv-button--secondary"
          onClick={() => void fetchStatus()}
          disabled={loading}
        >
          {loading ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <div className="bv-skeleton-stack" aria-busy="true" aria-label="Loading status">
          <div className="bv-skeleton-line" />
          <div className="bv-skeleton-line" />
          <div className="bv-skeleton-line" />
        </div>
      ) : errorMessage ? (
        <div className="bv-alert bv-alert--error" role="alert">
          <strong>API unreachable:</strong> {errorMessage}
        </div>
      ) : (
        <dl className="bv-kv-grid">
          <div className="bv-kv-item">
            <dt>API Liveness</dt>
            <dd>
              <StatusBadge value={health?.status ?? 'unavailable'} />
            </dd>
          </div>
          <div className="bv-kv-item">
            <dt>Overall Readiness</dt>
            <dd>
              <StatusBadge value={ready?.status ?? 'unavailable'} />
            </dd>
          </div>
          <div className="bv-kv-item">
            <dt>PostgreSQL</dt>
            <dd>
              <StatusBadge value={ready?.checks.database ?? 'unavailable'} />
            </dd>
          </div>
          <div className="bv-kv-item">
            <dt>Redis</dt>
            <dd>
              <StatusBadge value={ready?.checks.redis ?? 'unavailable'} />
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
