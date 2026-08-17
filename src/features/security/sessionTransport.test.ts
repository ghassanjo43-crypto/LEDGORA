// @vitest-environment happy-dom
/**
 * Session + CSRF transport at the store/service seam.
 *
 * These pin the browser-side half of the production fix: the CSRF token lives in
 * memory (delivered by the login/session response, never read from a cookie),
 * the verified session drives the mirror, and a logout tears both down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiAuthService } from '@/services/apiAuthService';
import { authApi } from '@/services/api/authApi';
import { getCsrfToken, setCsrfToken, clearCsrfToken } from '@/services/api/client';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { readAccessContext } from '@/lib/accessContext';
import { resolvePostLoginRoute, ROUTES } from '@/lib/accessControl';

const API = 'https://api.example.test';

const backendUser = (over: Record<string, unknown> = {}) =>
  ({
    id: 'user-1',
    email: 'person@example.test',
    fullName: 'A Person',
    status: 'active',
    emailVerified: true,
    mustChangePassword: false,
    platformRoles: [],
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as import('@/services/api/authApi').BackendUser;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route-based fetch stub. */
function mockRoutes(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const hit = Object.keys(routes).find((path) => url.includes(path));
    return hit ? routes[hit]!() : json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  clearCsrfToken();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.getState().clear();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.setState({ organization: null, subscription: null });
  useAccountSessionStore.setState({ demoActive: false });
  clearCsrfToken(); // clear() above may have logged out; ensure a clean token
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CSRF token lifecycle', () => {
  it('captures the token from the login response into memory', async () => {
    mockRoutes({
      '/api/auth/login': () => json({ user: backendUser(), mustChangePassword: false, csrfToken: 'csrf-from-login' }),
      '/api/organizations/current': () => json({ organization: null }),
      '/api/subscriptions/current': () => json({ subscription: null, invoice: null, bank: null }),
      '/api/auth/session': () => json({ authenticated: true, user: backendUser(), csrfToken: 'csrf-from-session' }),
    });

    await apiAuthService.signIn({ email: 'person@example.test', password: 'Correct-Horse-9x' });

    // The follow-up session refresh supersedes the login token; either way it is
    // in memory and was never read from document.cookie.
    expect(getCsrfToken()).toBe('csrf-from-session');
  });

  it('is sent as X-CSRF-Token on an unsafe request and never persisted', async () => {
    const fetchSpy = mockRoutes({ '/api/auth/logout': () => json({ ok: true }) });
    setCsrfToken('in-memory-token');

    await authApi.signOut();

    // Header carried the in-memory value…
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/auth/logout'));
    // signOut clears the token AFTER the request; assert it was sent, then gone.
    expect(call).toBeTruthy();
    expect(getCsrfToken()).toBe('');

    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain('in-memory-token');
  });

  it('drops the token when the session is reported unauthenticated', async () => {
    setCsrfToken('stale');
    mockRoutes({ '/api/auth/session': () => json({ authenticated: false, user: null, csrfToken: null }) });

    await authApi.getSession();

    expect(getCsrfToken()).toBe('');
  });

  /*
   * ── After an administrative password reset ────────────────────────────────
   * The page has been open since before the reset, so it still holds the CSRF
   * token of a session the server has since revoked. The user signs in with the
   * temporary password from that same page. Two things must hold: the stale
   * token must not prevent the attempt, and the token that replaces it must be
   * the one the NEW session issued — a request echoing the old token would be
   * refused by the CSRF hook the moment the new session is live.
   */
  it('replaces a stale token with the one the new login issued', async () => {
    setCsrfToken('token-of-the-revoked-session');
    const fetchSpy = mockRoutes({
      '/api/auth/login': () =>
        json({
          user: backendUser({ mustChangePassword: true }),
          mustChangePassword: true,
          csrfToken: 'token-of-the-new-session',
        }),
    });

    await authApi.signIn({ email: 'person@example.test', password: 'Temp-Issued-42-Zx' });

    expect(getCsrfToken()).toBe('token-of-the-new-session');
    expect(getCsrfToken()).not.toBe('token-of-the-revoked-session');

    // The attempt was made, not suppressed — and the browser's own cookie
    // handling, not this client, decides what cookie rides along.
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/auth/login'))!;
    expect((call[1] as RequestInit).credentials).toBe('include');
  });

  it('sends the NEW token on the next unsafe request, never the revoked one', async () => {
    setCsrfToken('token-of-the-revoked-session');
    const fetchSpy = mockRoutes({
      '/api/auth/login': () =>
        json({ user: backendUser(), mustChangePassword: true, csrfToken: 'token-of-the-new-session' }),
      '/api/auth/change-password': () => json({ ok: true, platformRoles: [] }),
    });

    await authApi.signIn({ email: 'person@example.test', password: 'Temp-Issued-42-Zx' });
    await authApi.changePassword({
      currentPassword: 'Temp-Issued-42-Zx',
      newPassword: 'Harbour-Lantern-44-Zx',
    });

    const change = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/auth/change-password'))!;
    const headers = (change[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('token-of-the-new-session');

    /*
     * Neither token reached storage. Scanned by VALUE rather than by asserting
     * storage is empty — signing in legitimately mirrors the user for routing,
     * so the claim worth making is that no CSRF token is among what it wrote.
     */
    const dump: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key) dump.push(key, store.getItem(key) ?? '');
      }
    }
    expect(dump.join(' ')).not.toContain('token-of-the-new-session');
    expect(dump.join(' ')).not.toContain('token-of-the-revoked-session');
  });
});

describe('login then verified session preserves the operator role', () => {
  it('surfaces super_admin and routes to the console', async () => {
    mockRoutes({
      '/api/auth/login': () =>
        json({ user: backendUser({ platformRoles: ['super_admin'] }), mustChangePassword: false, csrfToken: 't1' }),
      '/api/organizations/current': () => json({ organization: null }),
      '/api/auth/session': () =>
        json({ authenticated: true, user: backendUser({ platformRoles: ['super_admin'] }), csrfToken: 't2' }),
    });

    await apiAuthService.signIn({ email: 'person@example.test', password: 'Correct-Horse-9x' });

    expect(useBackendSessionStore.getState().platformRoles).toEqual(['super_admin']);
    expect(resolvePostLoginRoute(readAccessContext())).toBe(ROUTES.adminConsole);
  });
});

describe('logout clears session and CSRF state', () => {
  it('erases the mirror, the role and the token', async () => {
    mockRoutes({
      '/api/auth/login': () => json({ user: backendUser({ platformRoles: ['super_admin'] }), mustChangePassword: false, csrfToken: 't1' }),
      '/api/organizations/current': () => json({ organization: null }),
      '/api/auth/session': () => json({ authenticated: true, user: backendUser({ platformRoles: ['super_admin'] }), csrfToken: 't2' }),
      '/api/auth/logout': () => json({ ok: true }),
    });

    await apiAuthService.signIn({ email: 'person@example.test', password: 'Correct-Horse-9x' });
    expect(useAuthStore.getState().currentUserId).toBe('user-1');
    expect(getCsrfToken()).not.toBe('');

    await apiAuthService.signOut();

    expect(useAuthStore.getState().currentUserId).toBeNull();
    expect(useBackendSessionStore.getState().platformRoles).toEqual([]);
    expect(getCsrfToken()).toBe('');
  });
});

describe('backend session store reconciles the mirror', () => {
  it('clears a persisted mirror when the server reports authenticated:false', async () => {
    // A persisted mirror claims a signed-in user.
    useAuthStore.setState({
      users: [
        {
          id: 'user-1',
          fullName: 'A Person',
          email: 'person@example.test',
          mobile: '',
          country: '',
          passwordHash: '',
          emailVerified: true,
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      currentUserId: 'user-1',
    });
    mockRoutes({ '/api/auth/session': () => json({ authenticated: false, user: null, csrfToken: null }) });

    await useBackendSessionStore.getState().refresh();

    expect(useBackendSessionStore.getState().status).toBe('ready');
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it('leaves the mirror intact but grants no role when the backend is unreachable', async () => {
    useAuthStore.setState({
      users: [
        {
          id: 'user-1',
          fullName: 'A Person',
          email: 'person@example.test',
          mobile: '',
          country: '',
          passwordHash: '',
          emailVerified: true,
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      currentUserId: 'user-1',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await useBackendSessionStore.getState().refresh();

    expect(useBackendSessionStore.getState().status).toBe('unavailable');
    expect(useBackendSessionStore.getState().platformRoles).toEqual([]);
    // A transient blip does not force a logout…
    expect(useAuthStore.getState().currentUserId).toBe('user-1');
  });
});

describe('normal tenant routing is unchanged', () => {
  it('an active-subscription customer still lands on the app dashboard', () => {
    useAuthStore.setState({
      users: [
        {
          id: 'cust-1',
          fullName: 'Customer',
          email: 'customer@example.test',
          mobile: '',
          country: 'AE',
          passwordHash: '',
          emailVerified: true,
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      currentUserId: 'cust-1',
    });
    // Backend-confirmed organization: routing reads the confirmation, not a
    // bare local object, so the fixture has to state it.
    useOrganizationStore.setState({
      organization: { id: 'org-1', legalName: 'Acme' } as never,
      subscription: { status: 'active' } as never,
      hydration: { status: 'ready', confirmedOrganizationId: 'org-1', error: null },
    });
    // A verified session with no platform role — an ordinary tenant.
    useBackendSessionStore.setState({ status: 'ready', user: backendUser({ id: 'cust-1', platformRoles: [] }), platformRoles: [], error: null });

    expect(resolvePostLoginRoute(readAccessContext())).toBe(ROUTES.appDashboard);
  });

  it('a customer with no subscription still enters the onboarding funnel', () => {
    useAuthStore.setState({
      users: [
        {
          id: 'cust-2',
          fullName: 'Customer Two',
          email: 'two@example.test',
          mobile: '',
          country: 'AE',
          passwordHash: '',
          emailVerified: true,
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      currentUserId: 'cust-2',
    });
    useOrganizationStore.setState({
      organization: { id: 'org-2', legalName: 'Beta' } as never,
      subscription: null,
      hydration: { status: 'ready', confirmedOrganizationId: 'org-2', error: null },
    });
    useBackendSessionStore.setState({ status: 'ready', user: backendUser({ id: 'cust-2', platformRoles: [] }), platformRoles: [], error: null });

    expect(resolvePostLoginRoute(readAccessContext())).toBe(ROUTES.onboardingSubscription);
  });
});
