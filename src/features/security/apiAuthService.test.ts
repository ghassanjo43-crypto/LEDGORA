// @vitest-environment happy-dom
/**
 * The API-backed authentication adapter.
 *
 * The point of these tests is that the SERVER decides. The adapter may cache the
 * answer locally so the existing pages can route, but that cache must never
 * become a way to authenticate, and an unverifiable session must never be
 * treated as a signed-in one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';

const API = 'https://api.example.test';

const backendUser = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'ada@example.test',
  fullName: 'Ada Lovelace',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: [],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route-based fetch stub: maps a URL fragment to its response. */
function mockRoutes(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const hit = Object.keys(routes).find((path) => url.includes(path));
    if (!hit) return json({ error: { code: 'not_found', message: 'No route.' } }, 404);
    return routes[hit]!();
  });
}

async function loadAdapter() {
  const { apiAuthService } = await import('@/services/apiAuthService');
  return apiAuthService;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.setState({ organization: null, subscription: null });
  useBackendSessionStore.getState().clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sign in', () => {
  it('authenticates against the backend and mirrors the identity for routing', async () => {
    const fetchSpy = mockRoutes({
      '/api/auth/login': () => json({ user: backendUser(), mustChangePassword: false }),
      '/api/organizations/current': () => json({ organization: null }),
      '/api/auth/session': () => json({ authenticated: true, user: backendUser() }),
    });

    const result = await (await loadAdapter()).signIn({ email: 'ada@example.test', password: 'Correct-Horse-9x' });

    expect(result.ok).toBe(true);
    expect(result.user?.email).toBe('ada@example.test');
    // LoginPage routes off the local store, so the mirror must be present.
    expect(useAuthStore.getState().currentUserId).toBe('user-1');
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/auth/login'))).toBe(true);
  });

  it('mirrors no credential, so the local password path cannot authenticate', async () => {
    mockRoutes({
      '/api/auth/login': () => json({ user: backendUser(), mustChangePassword: false }),
      '/api/organizations/current': () => json({ organization: null }),
      '/api/auth/session': () => json({ authenticated: true, user: backendUser() }),
    });

    await (await loadAdapter()).signIn({ email: 'ada@example.test', password: 'Correct-Horse-9x' });

    const mirrored = useAuthStore.getState().users.find((u) => u.id === 'user-1')!;
    expect(mirrored.passwordHash).toBe('');

    // The offline credential check must reject the real password outright.
    useAuthStore.setState({ currentUserId: null });
    expect(useAuthStore.getState().login('ada@example.test', 'Correct-Horse-9x').ok).toBe(false);
    expect(useAuthStore.getState().currentUserId).toBeNull();

    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain('Correct-Horse-9x');
  });

  it('reports the backend rejection and signs nobody in', async () => {
    mockRoutes({
      '/api/auth/login': () =>
        json({ error: { code: 'invalid_credentials', message: 'Incorrect email or password.' } }, 401),
    });

    const result = await (await loadAdapter()).signIn({ email: 'ada@example.test', password: 'wrong-password-1' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Incorrect email or password.');
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it('does not fall back to local authentication when the backend is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await (await loadAdapter()).signIn({ email: 'ada@example.test', password: 'Correct-Horse-9x' });

    expect(result.ok).toBe(false);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });
});

describe('registration', () => {
  it('surfaces field errors from the backend', async () => {
    mockRoutes({
      '/api/auth/register': () =>
        json(
          {
            error: {
              code: 'validation_error',
              message: 'Please fix the highlighted fields.',
              details: { fieldErrors: { email: 'That email is already registered.' } },
            },
          },
          409,
        ),
    });

    const result = await (await loadAdapter()).register({
      fullName: 'Ada Lovelace',
      email: 'ada@example.test',
      password: 'Correct-Horse-9x',
      confirmPassword: 'Correct-Horse-9x',
      country: 'GB',
      acceptedTerms: true,
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.email).toBe('That email is already registered.');
  });

  it('rejects a mismatched confirmation without calling the backend', async () => {
    const fetchSpy = mockRoutes({ '/api/auth/register': () => json({ user: backendUser() }, 201) });

    const result = await (await loadAdapter()).register({
      fullName: 'Ada Lovelace',
      email: 'ada@example.test',
      password: 'Correct-Horse-9x',
      confirmPassword: 'Different-Horse-9x',
      country: 'GB',
      acceptedTerms: true,
    });

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.confirmPassword).toBe('Passwords do not match.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('session and sign out', () => {
  it('fails closed when the session cannot be verified', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    expect(await (await loadAdapter()).getSession()).toBeNull();
  });

  it('treats an unauthenticated response as signed out', async () => {
    useAuthStore.setState({ currentUserId: 'stale-user' });
    mockRoutes({ '/api/auth/session': () => json({ authenticated: false, user: null }) });

    expect(await (await loadAdapter()).getSession()).toBeNull();
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it('signs out locally even when the backend call fails', async () => {
    useAuthStore.setState({
      users: [
        {
          id: 'user-1',
          fullName: 'Ada Lovelace',
          email: 'ada@example.test',
          mobile: '',
          country: 'GB',
          passwordHash: '',
          emailVerified: true,
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      currentUserId: 'user-1',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await (await loadAdapter()).signOut();

    expect(useAuthStore.getState().currentUserId).toBeNull();
    expect(useBackendSessionStore.getState().platformRoles).toEqual([]);
  });
});

describe('adapter selection', () => {
  it('uses the API adapter when a backend origin is configured', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', API);
    const [{ authService }, { apiAuthService }] = await Promise.all([
      import('@/services'),
      import('@/services/apiAuthService'),
    ]);
    expect(authService).toBe(apiAuthService);
  });

  it('keeps the browser-only adapter when no backend is configured', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', '');
    const [{ authService }, { devAuthService }] = await Promise.all([
      import('@/services'),
      import('@/services/devAuthService'),
    ]);
    expect(authService).toBe(devAuthService);
  });
});
