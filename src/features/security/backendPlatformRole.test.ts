// @vitest-environment happy-dom
/**
 * Phase 3 frontend integration: administrator access is decided by the backend
 * session, not by anything the browser holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  effectivePlatformRole,
  hasPlatformCapability,
  platformRoleFromBackend,
} from '@/lib/platformAccess';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { ApiError, isApiConfigured } from '@/services/api/client';

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.getState().clear();
});
afterEach(() => vi.unstubAllEnvs());

describe('backend role mapping', () => {
  it('translates backend role names and takes the strongest', () => {
    expect(platformRoleFromBackend(['super_admin'])).toBe('super-admin');
    expect(platformRoleFromBackend(['billing_admin'])).toBe('billing-admin');
    expect(platformRoleFromBackend(['support'])).toBe('support');
    expect(platformRoleFromBackend(['support', 'super_admin'])).toBe('super-admin');
    expect(platformRoleFromBackend([])).toBe('none');
  });

  it('ignores role names the frontend does not recognise', () => {
    expect(platformRoleFromBackend(['root', 'administrator', 'admin'])).toBe('none');
  });
});

describe('effective role resolution', () => {
  it('honours a backend-verified role even in a production build', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    // Development tooling is off, yet the server says this person is an admin.
    expect(effectivePlatformRole('none', ['super_admin'])).toBe('super-admin');
    expect(hasPlatformCapability('none', 'verify-payments', ['billing_admin'])).toBe(true);
  });

  it('still ignores a browser-held role in production with no backend session', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    useSessionStore.setState({ platformRole: 'super-admin' });
    expect(effectivePlatformRole('super-admin', [])).toBe('none');
    expect(hasPlatformCapability('super-admin', 'verify-payments', [])).toBe(false);
  });

  it('grants nothing for a backend session that carries no platform role', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    // An ordinary signed-in customer.
    expect(effectivePlatformRole('super-admin', [])).toBe('none');
    expect(hasPlatformCapability('none', 'manage-any-organization', [])).toBe(false);
  });

  it('fails closed on an unrecognised capability name', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    // A capability the backend knows about but the frontend does not.
    expect(hasPlatformCapability('super-admin', 'view-admin' as never, ['super_admin'])).toBe(false);
  });

  it('falls back to a simulated role only on an approved local dev server', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    expect(effectivePlatformRole('super-admin', [])).toBe('super-admin');

    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', '');
    expect(effectivePlatformRole('super-admin', [])).toBe('none');
  });
});

describe('backend session store', () => {
  it('is not persisted, so storage cannot manufacture a role', async () => {
    useBackendSessionStore.setState({ platformRoles: ['super_admin'], status: 'ready' });
    // Nothing was written to localStorage…
    expect(JSON.stringify({ ...localStorage })).not.toContain('super_admin');
    // …and the store exposes no persist API to rehydrate from one.
    expect((useBackendSessionStore as unknown as { persist?: unknown }).persist).toBeUndefined();
  });

  it('fails closed when the backend cannot be reached', async () => {
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:1/api');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      await useBackendSessionStore.getState().refresh();
      const state = useBackendSessionStore.getState();
      expect(state.status).toBe('unavailable');
      expect(state.platformRoles).toEqual([]);
      expect(effectivePlatformRole('none', state.platformRoles)).toBe('none');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports unavailable rather than erroring when no API is configured', async () => {
    vi.stubEnv('VITE_API_URL', '');
    await useBackendSessionStore.getState().refresh();
    expect(useBackendSessionStore.getState().status).toBe('unavailable');
    expect(isApiConfigured()).toBe(false);
  });

  it('caches the roles the server returned', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ authenticated: true, user: { id: 'u1', email: 'a@b.c', platformRoles: ['billing_admin'] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      await useBackendSessionStore.getState().refresh();
      expect(useBackendSessionStore.getState().platformRoles).toEqual(['billing_admin']);
      expect(effectivePlatformRole('none', useBackendSessionStore.getState().platformRoles)).toBe('billing-admin');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('api client', () => {
  it('sends credentials and the in-memory CSRF header on unsafe methods', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    try {
      const { api, setCsrfToken } = await import('@/services/api/client');
      // The token is held in memory, never read from document.cookie (which
      // cannot see an API-host cookie cross-site).
      setCsrfToken('token-abc');
      await api.post('/api/auth/logout');
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.credentials).toBe('include');
      expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('token-abc');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('never reads the CSRF token from document.cookie', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    document.cookie = 'ledgora_csrf=cookie-value-should-be-ignored';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    try {
      const { api, clearCsrfToken } = await import('@/services/api/client');
      clearCsrfToken();
      await api.post('/api/auth/logout');
      const [, init] = fetchSpy.mock.calls[0]!;
      // With no in-memory token the header is absent, even though a cookie exists.
      expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('surfaces a typed error with field messages', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'validation_error', message: 'Fix fields.', details: { fieldErrors: { email: 'Bad email.' } } } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    try {
      const { api } = await import('@/services/api/client');
      await expect(api.post('/api/auth/register', {})).rejects.toBeInstanceOf(ApiError);
      await api.post('/api/auth/register', {}).catch((error: ApiError) => {
        expect(error.status).toBe(400);
        expect(error.fieldErrors.email).toBe('Bad email.');
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('never places a session token in browser storage', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'u1', platformRoles: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const { authApi } = await import('@/services/api/authApi');
      await authApi.signIn({ email: 'a@b.c', password: 'Correct-Horse-9x' });
      const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      expect(dump).not.toContain('Correct-Horse-9x');
      expect(dump).not.toContain('ledgora_session');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
