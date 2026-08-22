// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { AppShell } from './AppShell';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { ROUTES } from '@/lib/accessControl';

const API = 'http://localhost:5173';

const backendUser = {
  id: 'user-1',
  email: 'jane@acme.test',
  fullName: 'Jane Owner',
  status: 'active' as const,
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: [],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function goto(path: string): void {
  window.history.replaceState({}, '', path);
  useRouterStore.getState().sync();
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', '');
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useAccountSessionStore.getState().resetToDefault();
  useBackendSessionStore.setState({ status: 'unavailable', user: null, platformRoles: [], error: null });
  // A registered-but-unverified user disables the dev bootstrap (users exist)
  // and leaves the org unset, so we can exercise the gate deterministically.
  useAuthStore.getState().register({
    fullName: 'Jane Owner',
    email: 'jane@acme.test',
    mobile: '+971500000000',
    country: 'AE',
    password: 'Secret123',
    acceptedTerms: true,
  });
  goto('/pricing');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('AppShell surface gate', () => {
  it('renders the public pricing page', async () => {
    render(<AppShell />);
    expect(await screen.findByText(/Choose your Ledgora plan/i)).toBeTruthy();
  });

  it('blocks the app for a signed-in unverified user and redirects to email verification', async () => {
    render(<AppShell />);
    await screen.findByText(/Choose your Ledgora plan/i);

    act(() => {
      useRouterStore.getState().navigate('/app/dashboard');
    });

    // The gate must bounce an unverified user away from the app to /verify-email.
    await waitFor(() => expect(useRouterStore.getState().path).toBe('/verify-email'));
    expect(await screen.findByText(/Verify your email/i)).toBeTruthy();
  });
});

describe('server-authoritative startup routing', () => {
  function authenticated(overrides: { organization?: boolean; subscription?: 'active' | null } = {}): void {
    const user = useAuthStore.getState().users[0]!;
    useAuthStore.setState({
      users: [{ ...user, id: backendUser.id, emailVerified: true }],
      currentUserId: backendUser.id,
    });
    const hasOrganization = overrides.organization ?? true;
    const organizationId = hasOrganization ? 'org-server-1' : null;
    useOrganizationStore.setState({
      organization: hasOrganization
        ? ({ id: organizationId, legalName: 'Acme Ltd.', ownerUserId: backendUser.id } as never)
        : null,
      subscription: overrides.subscription === null
        ? null
        : ({ id: 'sub-1', organizationId, status: 'active' } as never),
      hydration: { status: 'ready', confirmedOrganizationId: organizationId, error: null },
    });
    useBackendSessionStore.setState({ status: 'ready', user: backendUser, platformRoles: [], error: null });
  }

  beforeEach(() => vi.stubEnv('VITE_API_URL', API));

  it('opens the dashboard for an existing organization with an active subscription', async () => {
    authenticated();
    goto(ROUTES.onboardingOrganization);

    render(<AppShell />);

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.appDashboard));
    expect(screen.queryByText(/Set up your organization/i)).toBeNull();
  });

  it('does not let stale onboarding URL state override the server organization', async () => {
    authenticated();
    localStorage.setItem('ledgora-stale-needs-onboarding', 'true');
    goto(ROUTES.onboardingOrganization);

    render(<AppShell />);

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.appDashboard));
  });

  it('keeps genuine organization-less users in organization setup', async () => {
    authenticated({ organization: false, subscription: null });
    goto(ROUTES.onboardingOrganization);

    render(<AppShell />);

    expect(await screen.findByText(/Set up your organization/i)).toBeTruthy();
  });

  it('shows a blank loading surface instead of onboarding before session hydration', () => {
    goto(ROUTES.onboardingOrganization);
    useBackendSessionStore.setState({ status: 'loading', user: null, platformRoles: [], error: null });

    render(<AppShell />);

    expect(screen.queryByText(/Set up your organization/i)).toBeNull();
    expect(screen.queryByText(/could not restore your session/i)).toBeNull();
  });

  it('shows an explicit bootstrap error instead of treating failure as no organization', async () => {
    goto(ROUTES.onboardingOrganization);
    useBackendSessionStore.setState({
      status: 'unavailable',
      user: null,
      platformRoles: [],
      error: 'Could not reach the LEDGORA service.',
    });

    render(<AppShell />);

    expect(await screen.findByText(/could not restore your session/i)).toBeTruthy();
    expect(screen.queryByText(/Set up your organization/i)).toBeNull();
  });

  it('allows a valid demo directly into the application without organization setup', async () => {
    useAccountSessionStore.getState().setDemoActive(true);
    useBackendSessionStore.setState({ status: 'ready', user: null, platformRoles: [], error: null });
    goto(ROUTES.onboardingOrganization);

    render(<AppShell />);

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.appDashboard));
    expect(screen.queryByText(/Set up your organization/i)).toBeNull();
  });

  it('still sends an organization without a subscription to package selection', async () => {
    authenticated({ subscription: null });
    goto(ROUTES.appDashboard);

    render(<AppShell />);

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.onboardingSubscription));
    expect(screen.queryByText(/Set up your organization/i)).toBeNull();
  });
});
