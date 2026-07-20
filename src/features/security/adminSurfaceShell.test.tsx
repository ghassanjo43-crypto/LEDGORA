// @vitest-environment happy-dom
/**
 * End-to-end behaviour of the shell's access gate for platform operators.
 *
 * The unit tests in `platformOperatorRouting` pin the decision function; these
 * drive the real `AppShell` so the *timing* is covered too. The production
 * defect had two halves: the wrong verdict, and reaching a verdict before the
 * server had answered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { AppShell } from '@/components/shell/AppShell';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { ROUTES } from '@/lib/accessControl';

const API = 'https://api.example.test';

const adminUser = (over: Record<string, unknown> = {}) => ({
  id: 'admin-1',
  email: 'admin@ledgora.test',
  fullName: 'Platform Operator',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: ['super_admin'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const sessionResponse = (user: Record<string, unknown> | null) =>
  new Response(JSON.stringify({ authenticated: !!user, user }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function goto(path: string): void {
  window.history.replaceState({}, '', path);
  useRouterStore.getState().sync();
}

/** Sign a person in locally so the shell sees an authenticated session. */
function signInLocally(): void {
  useAuthStore.setState({
    users: [
      {
        id: 'admin-1',
        fullName: 'Platform Operator',
        email: 'admin@ledgora.test',
        mobile: '',
        country: '',
        passwordHash: '',
        emailVerified: true,
        role: 'owner',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    currentUserId: 'admin-1',
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.getState().clear();
  useBackendSessionStore.setState({ status: 'unknown' });
  useOrganizationStore.setState({ organization: null, subscription: null });
  signInLocally();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('operator refreshing /admin/console', () => {
  it('is not bounced to onboarding while the session is still loading', async () => {
    // The server is slow: hold the session response open.
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await pending;
      return sessionResponse(adminUser());
    });

    goto(ROUTES.adminConsole);
    render(<AppShell />);

    // While the verdict is outstanding the operator must stay put. Previously
    // the gate ran immediately, saw no subscription, and redirected.
    await act(async () => {
      await Promise.resolve();
    });
    expect(useRouterStore.getState().path).toBe(ROUTES.adminConsole);

    await act(async () => {
      release!();
      await pending;
    });

    // Once verified, they remain on the console.
    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('ready'));
    expect(useRouterStore.getState().path).toBe(ROUTES.adminConsole);
    expect(await screen.findByText(/platform administration/i)).toBeTruthy();
  });

  it('never lands on package selection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(adminUser()));

    goto(ROUTES.adminConsole);
    render(<AppShell />);

    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('ready'));
    await waitFor(() => expect(useRouterStore.getState().path).not.toBe(ROUTES.onboardingSubscription));
    expect(useRouterStore.getState().path).toBe(ROUTES.adminConsole);
  });
});

describe('regular customer at /admin/console', () => {
  it('is redirected away into the customer funnel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(adminUser({ platformRoles: [] })));

    goto(ROUTES.adminConsole);
    render(<AppShell />);

    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('ready'));
    // No organization and no subscription → the onboarding funnel.
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.onboardingOrganization));
  });
});

describe('bootstrap administrator with a temporary password', () => {
  it('is held on the password change page before the console', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sessionResponse(adminUser({ mustChangePassword: true })),
    );

    goto(ROUTES.adminConsole);
    render(<AppShell />);

    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('ready'));
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.changePassword));
    expect(await screen.findByText(/choose a new password/i)).toBeTruthy();
  });
});

describe('unreachable backend', () => {
  it('grants no administrator surface at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    goto(ROUTES.adminConsole);
    render(<AppShell />);

    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('unavailable'));
    // Fails closed: no role, so the console is not reachable.
    await waitFor(() => expect(useRouterStore.getState().path).not.toBe(ROUTES.adminConsole));
  });
});

describe('session verification returns authenticated:false', () => {
  it('clears the mirrored local user and returns to /login, never onboarding', async () => {
    // The persisted mirror says this browser is signed in (the production
    // symptom: login mirrored a user, but the follow-up session check fails).
    signInLocally();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(null));

    goto(ROUTES.adminConsole);
    render(<AppShell />);

    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('ready'));
    // The mirror is erased — a disowned user is not trusted.
    await waitFor(() => expect(useAuthStore.getState().currentUserId).toBeNull());
    // …and they land on /login, not the onboarding funnel.
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.login));
    expect(useRouterStore.getState().path).not.toBe(ROUTES.onboardingOrganization);
    expect(useRouterStore.getState().path).not.toBe(ROUTES.onboardingSubscription);
  });

  it('a missing cookie cannot create a customer onboarding session', async () => {
    // No local sign-in and the server reports no session: the browser must not
    // manufacture a half-authenticated customer that drifts into onboarding.
    useAuthStore.setState({ users: [], currentUserId: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(null));

    goto(ROUTES.onboardingOrganization);
    render(<AppShell />);

    await waitFor(() => expect(useBackendSessionStore.getState().status).toBe('ready'));
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.login));
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });
});
