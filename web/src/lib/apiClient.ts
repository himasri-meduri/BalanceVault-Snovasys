import { API_BASE_URL } from './env';

export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    fieldErrors?: Record<string, string[]>;
    requestId?: string;
  };
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly fieldErrors?: Record<string, string[]>;
  public readonly requestId?: string;
  public readonly data?: unknown;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    requestId?: string;
    data?: unknown;
  }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.fieldErrors = params.fieldErrors;
    this.requestId = params.requestId;
    this.data = params.data;
  }
}

export interface ApiRequestOptions extends RequestInit {
  skipUnauthorizedCallback?: boolean;
}

let csrfTokenStore: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfTokenStore = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { skipUnauthorizedCallback = false, ...fetchOptions } = options;
  const method = (fetchOptions.method ?? 'GET').toUpperCase();
  const headers = new Headers(fetchOptions.headers);
  headers.set('Accept', 'application/json');

  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (method !== 'GET' && method !== 'HEAD' && csrfTokenStore) {
    headers.set('X-CSRF-Token', csrfTokenStore);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...fetchOptions,
    method,
    headers,
    credentials: 'include',
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !skipUnauthorizedCallback) {
      csrfTokenStore = null;
      unauthorizedHandler?.();
    }

    const errBody = (parsed as ApiErrorPayload | null)?.error;
    throw new ApiClientError({
      status: response.status,
      code: errBody?.code ?? 'HTTP_ERROR',
      message: errBody?.message ?? `Request failed with status ${response.status}`,
      fieldErrors: errBody?.fieldErrors,
      requestId: errBody?.requestId,
      data: parsed,
    });
  }

  return parsed as T;
}
