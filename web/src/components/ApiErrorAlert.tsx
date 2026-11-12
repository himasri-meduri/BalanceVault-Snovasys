import { ApiClientError } from '../lib/apiClient';

interface ApiErrorAlertProps {
  error: unknown;
  title?: string;
}

export function ApiErrorAlert({ error, title = 'Request failed' }: ApiErrorAlertProps) {
  if (!error) {
    return null;
  }

  if (error instanceof ApiClientError) {
    return (
      <div className="bv-alert bv-alert--error" role="alert">
        <div>
          <strong>{title}:</strong> {error.message}
        </div>
        <div className="bv-alert-meta">
          <span>Code: {error.code}</span>
          {error.requestId ? <span>Request ID: {error.requestId}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="bv-alert bv-alert--error" role="alert">
      <strong>{title}:</strong>{' '}
      {error instanceof Error ? error.message : 'An unexpected error occurred.'}
    </div>
  );
}
