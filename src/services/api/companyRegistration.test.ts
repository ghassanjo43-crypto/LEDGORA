/**
 * @vitest-environment happy-dom
 *
 * A DOM environment, deliberately: `getWorkspaceStorageMode` reads
 * `window.localStorage`, and the Free Demo exclusion is exactly what these tests
 * have to be able to observe. Under the default node environment there is no
 * `window`, the mode silently reads as `backend`, and the demo assertion would
 * pass for the wrong reason.
 */
/**
 * The browser lifecycle, end to end: sign in → mint → adopt → read the books.
 *
 * ══ Why this file had to exist ═══════════════════════════════════════════════
 *
 * The server suite proves exhaustively that the books REFUSE the wrong company:
 * cross-tenant, cross-company, a forged uuid, an omitted selector. Not one test
 * asked whether a real client can SUCCEED. Every one of them either builds an
 * actor directly or registers the reference inside the test first, so the step
 * a browser actually has to perform — mint `co_…`, get it adopted, then read —
 * was never exercised. It was missing, and a suite built entirely around
 * refusal could not see that.
 *
 * So these tests walk the sequence in order, and the first of them fails
 * against the code as it was.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  apiRequest,
  setCompanyReference,
  setCsrfToken,
  COMPANY_REFERENCE_HEADER,
} from './client';
import {
  ensureCompanyRegistered,
  resetCompanyRegistration,
  registrationState,
  requiresCompanyRegistration,
} from './companyRegistration';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { setWorkspaceStorageMode } from '@/lib/workspaceStorage';

const fetchMock = vi.fn();

/** Every request the client made, in order. */
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  method: (init as { method?: string }).method ?? 'GET',
  headers: (init as { headers: Record<string, string> }).headers,
}));

const ok = (body: unknown = {}) => ({
  status: 200, ok: true,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
} as unknown as Response);

const failure = (status: number, code: string, message: string) => ({
  status, ok: false,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { code, message } }),
} as unknown as Response);

/** The browser's own id, exactly as `companyStore.ensureInitialized` mints it. */
const BROWSER_REFERENCE = 'co_lx8f2a_9d4kz1';

/** A signed-in subscriber with a hydrated organization — the normal case. */
function signedInSubscriber(): void {
  setWorkspaceStorageMode('backend');
  useBackendSessionStore.setState({
    status: 'ready',
    user: { id: 'u1', email: 'owner@acme.test', fullName: 'Acme Owner', platformRoles: [] } as never,
    platformRoles: [],
    error: null,
  });
  useOrganizationStore.setState({ organization: { legalName: 'Acme Trading LLC' } as never });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
  resetCompanyRegistration();
  setCompanyReference(null);
  setCsrfToken('csrf-token');
  signedInSubscriber();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCompanyRegistration();
  setCompanyReference(null);
  setWorkspaceStorageMode('backend');
});

/* ══ Which requests are gated ══════════════════════════════════════════════ */

describe('the gate', () => {
  it('covers the books, and nothing a bootstrap needs', () => {
    expect(requiresCompanyRegistration('/api/accounting/accounts')).toBe(true);
    expect(requiresCompanyRegistration('/api/accounting/opening-balances/current')).toBe(true);
    expect(requiresCompanyRegistration('/api/invoices')).toBe(true);

    /* These must travel before adoption, or adoption can never happen. */
    expect(requiresCompanyRegistration('/api/auth/session')).toBe(false);
    expect(requiresCompanyRegistration('/api/organizations/current')).toBe(false);
    expect(requiresCompanyRegistration('/api/organizations/current/companies')).toBe(false);
  });
});

/* ══ The principal success path ════════════════════════════════════════════ */

describe('sign in, mint, adopt, read', () => {
  it('registers the browser reference and only then reads the books', async () => {
    setCompanyReference(BROWSER_REFERENCE);

    await apiRequest('/api/accounting/accounts');

    const sent = calls();
    expect(sent).toHaveLength(2);

    /* Adoption first, carrying the browser's own reference and the legal name. */
    expect(sent[0]!.url).toContain('/api/organizations/current/companies');
    expect(sent[0]!.method).toBe('POST');

    /* Then the books, with the header the server now recognises. */
    expect(sent[1]!.url).toContain('/api/accounting/accounts');
    expect(sent[1]!.headers[COMPANY_REFERENCE_HEADER]).toBe(BROWSER_REFERENCE);
    expect(registrationState().status).toBe('registered');
  });

  it('reads opening balances the same way', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    await apiRequest('/api/accounting/opening-balances/current');

    const sent = calls();
    expect(sent[0]!.url).toContain('/companies');
    expect(sent[1]!.url).toContain('/opening-balances/current');
    expect(sent[1]!.headers[COMPANY_REFERENCE_HEADER]).toBe(BROWSER_REFERENCE);
  });

  it('sends the browser reference, never a substitute', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    await apiRequest('/api/accounting/accounts');

    /*
     * The fix must not work by quietly selecting a different company. The
     * header on the books request is the reference the browser minted, and the
     * registration body asked for that same one.
     */
    const registration = fetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(registration.body).clientReference).toBe(BROWSER_REFERENCE);
    expect(calls()[1]!.headers[COMPANY_REFERENCE_HEADER]).toBe(BROWSER_REFERENCE);
  });
});

/* ══ Repetition, reload and concurrency ════════════════════════════════════ */

describe('registering more than once', () => {
  it('adopts once, however many requests follow', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    await apiRequest('/api/accounting/accounts');
    await apiRequest('/api/accounting/journals');
    await apiRequest('/api/invoices');

    const registrations = calls().filter((c) => c.url.includes('/companies'));
    expect(registrations).toHaveLength(1);
  });

  it('coalesces concurrent first requests into ONE registration', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    await Promise.all([
      apiRequest('/api/accounting/accounts'),
      apiRequest('/api/accounting/journals'),
      apiRequest('/api/invoices'),
      apiRequest('/api/accounting/periods'),
    ]);

    /*
     * Four requests in flight together, one adoption. The server would tolerate
     * four — `registerCompany` is idempotent under an advisory lock — but a
     * client that fires them is a client that will fire forty.
     */
    expect(calls().filter((c) => c.url.includes('/companies'))).toHaveLength(1);
  });

  it('registers again after a reload, and the server replays it', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    await apiRequest('/api/accounting/accounts');

    /* A reload: module state is gone, the persisted reference is not. */
    resetCompanyRegistration();
    await apiRequest('/api/accounting/accounts');

    expect(calls().filter((c) => c.url.includes('/companies'))).toHaveLength(2);
    expect(registrationState().status).toBe('registered');
  });

  it('re-registers when the open company changes', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    await apiRequest('/api/accounting/accounts');

    setCompanyReference('co_second_books');
    await apiRequest('/api/accounting/accounts');

    const registrations = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/companies'))
      .map(([, init]) => JSON.parse((init as { body: string }).body).clientReference);
    expect(registrations).toEqual([BROWSER_REFERENCE, 'co_second_books']);
  });
});

/* ══ Failure ═══════════════════════════════════════════════════════════════ */

describe('when registration cannot succeed', () => {
  it('does NOT send the accounting request while offline, and stays retryable', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(apiRequest('/api/accounting/accounts')).rejects.toMatchObject({
      code: 'company_registration_pending',
    });

    /*
     * The load-bearing assertion. An unadopted header answers 404, which reads
     * as "you have no accounts" — so the request must not go out at all.
     */
    expect(calls().some((c) => c.url.includes('/accounting'))).toBe(false);
    expect(registrationState().status).toBe('unavailable');

    /* Retryable: the next attempt tries again rather than inheriting the failure. */
    fetchMock.mockResolvedValue(ok());
    await apiRequest('/api/accounting/accounts');
    expect(registrationState().status).toBe('registered');
    expect(calls().some((c) => c.url.includes('/accounting'))).toBe(true);
  });

  it('surfaces a permanent refusal as itself', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    fetchMock.mockResolvedValueOnce(failure(
      409, 'conflict', 'These books are already registered as "Acme Holdings LLC".',
    ));

    await expect(apiRequest('/api/accounting/accounts')).rejects.toMatchObject({
      code: 'company_registration_refused',
      message: 'These books are already registered as "Acme Holdings LLC".',
    });

    /* Reported, not retried behind a spinner, and the books stay unread. */
    expect(registrationState().status).toBe('refused');
    expect(calls().some((c) => c.url.includes('/accounting'))).toBe(false);
  });

  it('waits rather than registering a company with no name', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    useOrganizationStore.setState({ organization: null as never });

    await expect(apiRequest('/api/accounting/accounts')).rejects.toMatchObject({
      code: 'company_registration_pending',
    });
    /* Nothing was sent — not the books, and not a company called nothing. */
    expect(calls()).toHaveLength(0);
  });
});

/* ══ Who must never register ═══════════════════════════════════════════════ */

describe('Free Demo and friends', () => {
  it('never registers a memory-only workspace', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    /* Free Demo, Free Preview and anonymous all run memory-only. */
    setWorkspaceStorageMode('memory');

    await ensureCompanyRegistered();

    expect(calls()).toHaveLength(0);
    expect(registrationState().status).toBe('idle');
  });

  it('never registers for a platform operator', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    useBackendSessionStore.setState({ platformRoles: ['super_admin'] as never });

    await ensureCompanyRegistered();
    expect(calls()).toHaveLength(0);
  });

  it('never registers before the session is confirmed', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    useBackendSessionStore.setState({ status: 'loading', user: null, platformRoles: [] });

    await ensureCompanyRegistered();
    expect(calls()).toHaveLength(0);
  });

  it('refuses to send the books for a demo workspace that HAS a reference', async () => {
    setCompanyReference(BROWSER_REFERENCE);
    setWorkspaceStorageMode('memory');

    /*
     * The tightened case. A memory-only workspace never registers, so its
     * reference is unadopted — and an unadopted header answers 404, which reads
     * as "you have no accounts". Refused plainly instead, and nothing is sent.
     */
    await expect(apiRequest('/api/accounting/accounts')).rejects.toMatchObject({
      code: 'company_registration_pending',
    });
    expect(calls()).toHaveLength(0);
  });

  it('does not gate a request when no company is open', async () => {
    setCompanyReference(null);
    await apiRequest('/api/accounting/accounts');

    /*
     * No reference, no header — the server resolves the organization's sole
     * company itself. Blocking here would break a subscriber whose store has
     * not initialised yet.
     */
    const sent = calls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers[COMPANY_REFERENCE_HEADER]).toBeUndefined();
  });
});
