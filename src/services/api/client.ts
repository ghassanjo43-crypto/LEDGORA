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
 * Which of the organization's companies this client currently has open.
 *
 * A SELECTOR, never a credential. The server derives the organization from the
 * session and resolves this reference only within it, so the value cannot widen
 * access — the worst a tampered header achieves is a 404 for books that are not
 * the caller's. It is deliberately the browser's own `co_...` reference and not
 * the server's company UUID: sending an internal key that appears in every
 * accounting foreign key would make it behave like a token that never expires.
 *
 * Held in memory alongside the CSRF token, for the same reason. It is derived
 * from whichever company the app has open, so persisting a second copy would
 * create a value that can disagree with the one on screen — and a request
 * carrying a stale selector writes into the wrong set of books.
 */
export const COMPANY_REFERENCE_HEADER = 'X-Ledgora-Company-Reference';

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

let companyReference = '';

/**
 * Point subsequent requests at a company. Pass null when no company is open —
 * the header is then omitted entirely, and the server applies its own rule:
 * resolve when the organization has exactly one company, refuse otherwise.
 */
export function setCompanyReference(reference: string | null | undefined): void {
  companyReference = typeof reference === 'string' ? reference.trim() : '';
}

export function getCompanyReference(): string {
  return companyReference;
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

/**
 * Resolve the configured API origin.
 *
 * Older local setups pin this to Vite's preferred `:5173` origin so `/api` is
 * same-origin and travels through the dev proxy. Vite legitimately moves to a
 * free port when 5173 is occupied; continuing to call the old port then talks
 * to a different/stale dev server and loses the session bootstrap. In
 * development only, carry that legacy same-origin setting to the origin that
 * actually served this page. Explicit API ports (for example `:3000`) and all
 * deployed origins remain untouched.
 */
export function resolveApiBaseUrl(
  configured: string | undefined,
  runtimeOrigin: string | undefined,
  development: boolean,
): string {
  const value = (configured ?? '').replace(/\/$/, '');
  if (!value || !development || !runtimeOrigin) return value;

  try {
    const configuredUrl = new URL(value);
    const runtimeUrl = new URL(runtimeOrigin);
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    const legacyViteOrigin = localHosts.has(configuredUrl.hostname) && configuredUrl.port === '5173';
    const servedLocally = localHosts.has(runtimeUrl.hostname);
    if (legacyViteOrigin && servedLocally && configuredUrl.origin !== runtimeUrl.origin) {
      return runtimeUrl.origin;
    }
  } catch {
    // Preserve existing handling for relative/custom values.
  }
  return value;
}

/** Configured backend origin. Empty means "no backend configured". */
export function apiBaseUrl(): string {
  try {
    const env = import.meta.env as Record<string, string | boolean | undefined>;
    const runtimeOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
    return resolveApiBaseUrl(env?.VITE_API_URL as string | undefined, runtimeOrigin, env?.DEV === true);
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
  /*
   * On reads as well as writes: a report scoped to the wrong company is as
   * wrong as a journal posted into it, and sending the selector only on unsafe
   * methods would make GETs silently fall back to the server's omitted-selector
   * rule.
   */
  if (companyReference) {
    headers[COMPANY_REFERENCE_HEADER] = companyReference;
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
  del: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => apiRequest<T>(path, { method: 'POST', formData }),
};
