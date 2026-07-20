/**
 * LEDGORA backend API client.
 *
 * Authentication rides on an HttpOnly session cookie issued by the backend, so
 * every request sets `credentials: 'include'`. No session token is ever read
 * from or written to storage.
 *
 * CSRF: the server returns a double-submit token in the login/session response.
 * The client keeps it in MEMORY only (never localStorage, never a cookie read)
 * and echoes it in `X-CSRF-Token` on unsafe requests. It deliberately does NOT
 * read the CSRF cookie with `document.cookie`: in a cross-site deployment that
 * cookie belongs to the API host and is invisible to the frontend host, so any
 * such read returns nothing and breaks every write.
 *
 * `VITE_API_URL` is a public value (an origin), not a secret. Point it at the
 * frontend origin for a same-origin `/api` proxy, or at the API origin for a
 * cross-site deployment.
 */

export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * The CSRF token, held only for the lifetime of the page. A reload drops it;
 * `GET /api/auth/session` re-supplies it, so it is recovered before any unsafe
 * request the app makes after start-up.
 */
let csrfToken = '';

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = typeof token === 'string' ? token : '';
}

export function getCsrfToken(): string {
  return csrfToken;
}

export function clearCsrfToken(): void {
  csrfToken = '';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages from the backend's validation response, if any. */
  get fieldErrors(): Record<string, string> {
    const fields = (this.details as { fieldErrors?: Record<string, string> } | undefined)?.fieldErrors;
    return fields ?? {};
  }
}

/** Configured backend origin. Empty means "no backend configured". */
export function apiBaseUrl(): string {
  try {
    const value = (import.meta.env as Record<string, string | undefined>)?.VITE_API_URL ?? '';
    return value.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function isApiConfigured(): boolean {
  return apiBaseUrl().length > 0;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  /** Multipart payloads bypass JSON encoding. */
  formData?: FormData;
  signal?: AbortSignal;
}

/**
 * Perform an API call. Throws `ApiError` on any non-2xx response so callers
 * handle one error shape regardless of what went wrong.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const base = apiBaseUrl();
  if (!base) {
    throw new ApiError(0, 'api_not_configured', 'The LEDGORA API is not configured for this build.');
  }

  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (UNSAFE.has(method) && csrfToken) {
    headers[CSRF_HEADER] = csrfToken;
  }

  let payload: BodyInit | undefined;
  if (options.formData) {
    // Let the browser set the multipart boundary.
    payload = options.formData;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: payload,
      // Carries the HttpOnly session cookie cross-origin.
      credentials: 'include',
      signal: options.signal,
    });
  } catch (cause) {
    throw new ApiError(0, 'network_error', 'Could not reach the LEDGORA service. Check your connection and try again.', {
      cause: String(cause),
    });
  }

  // Refresh the in-memory CSRF token whenever the server supplies one. The
  // response body is the primary channel (see authApi); this header capture is
  // the belt-and-braces companion and needs `exposedHeaders` set in CORS.
  const headerToken = response.headers.get(CSRF_HEADER);
  if (headerToken) setCsrfToken(headerToken);

  if (response.status === 204) return undefined as T;

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
    const error = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'The request could not be completed.',
      error?.details,
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { method: 'GET', signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  upload: <T>(path: string, formData: FormData) => apiRequest<T>(path, { method: 'POST', formData }),
};
