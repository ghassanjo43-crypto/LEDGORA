/**
 * The company selector on outgoing requests.
 *
 * ══ Why this is worth its own test ═══════════════════════════════════════════
 *
 * The selector is a single header, set in one place, read on every request.
 * That design was chosen because the alternative — passing the company at each
 * call site — fails silently: a forgotten one does not break the build or throw
 * at runtime, it sends a request with no selector, which the server answers by
 * resolving the organization's only company. It works perfectly for every
 * single-company subscriber and mis-scopes the moment a customer adds a second.
 *
 * So the claims are narrow and specific: the header goes out on reads as well
 * as writes, it carries the BROWSER's reference rather than the server's uuid,
 * it follows the open company, and it is dropped at sign-out.
 *
 * These use a NON-GATED path deliberately. Accounting and invoice requests wait
 * for company adoption (`companyRegistration`), so driving them here would make
 * every assertion depend on a registration handshake that is not what this file
 * is about. The header on a genuine accounting request is asserted where the
 * handshake is modelled — see `companyRegistration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  apiRequest,
  setCompanyReference,
  getCompanyReference,
  setCsrfToken,
  COMPANY_REFERENCE_HEADER,
} from './client';

const fetchMock = vi.fn();

function jsonResponse(body: unknown = {}): Response {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The headers the client actually sent on the last call. */
const sentHeaders = (): Record<string, string> =>
  (fetchMock.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }).headers;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse());
  setCompanyReference(null);
  setCsrfToken('csrf-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setCompanyReference(null);
});

describe('the company selector header', () => {
  it('is omitted entirely when no company is open', async () => {
    await apiRequest('/api/organizations/current');
    expect(sentHeaders()[COMPANY_REFERENCE_HEADER]).toBeUndefined();
  });

  it('is sent on reads, not only on writes', async () => {
    setCompanyReference('co_lx8f2a');
    await apiRequest('/api/organizations/current');
    /*
     * A report scoped to the wrong company is as wrong as a journal posted into
     * it. Sending the selector only on unsafe methods would leave every GET
     * falling back to the server's omitted-selector rule.
     */
    expect(sentHeaders()[COMPANY_REFERENCE_HEADER]).toBe('co_lx8f2a');
  });

  it('is sent on writes alongside the CSRF token', async () => {
    setCompanyReference('co_lx8f2a');
    await apiRequest('/api/organizations/current', { method: 'POST', body: { a: 1 } });
    const headers = sentHeaders();
    expect(headers[COMPANY_REFERENCE_HEADER]).toBe('co_lx8f2a');
    expect(headers['X-CSRF-Token']).toBe('csrf-token');
  });

  it('follows the company that is open', async () => {
    setCompanyReference('co_first');
    await apiRequest('/api/organizations/current');
    expect(sentHeaders()[COMPANY_REFERENCE_HEADER]).toBe('co_first');

    setCompanyReference('co_second');
    await apiRequest('/api/organizations/current');
    expect(sentHeaders()[COMPANY_REFERENCE_HEADER]).toBe('co_second');
  });

  it('is dropped when the company is closed', async () => {
    setCompanyReference('co_first');
    setCompanyReference(null);
    await apiRequest('/api/organizations/current');
    expect(sentHeaders()[COMPANY_REFERENCE_HEADER]).toBeUndefined();
  });

  it('treats whitespace as no company rather than as a reference', async () => {
    setCompanyReference('   ');
    expect(getCompanyReference()).toBe('');
    await apiRequest('/api/organizations/current');
    expect(sentHeaders()[COMPANY_REFERENCE_HEADER]).toBeUndefined();
  });

  it('does not survive a reload', async () => {
    setCompanyReference('co_lx8f2a');
    expect(getCompanyReference()).toBe('co_lx8f2a');

    /*
     * A fresh module instance is what a page reload produces. It starts empty,
     * which is the property worth having: the selector is held in memory only,
     * like the CSRF token, and is re-derived from whichever company the app
     * actually opens. A persisted second copy could disagree with the company
     * on screen, and a request carrying a stale selector writes into the wrong
     * set of books.
     */
    vi.resetModules();
    const reloaded = await import('./client');
    expect(reloaded.getCompanyReference()).toBe('');
  });
});
