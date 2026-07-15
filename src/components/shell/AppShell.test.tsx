// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { AppShell } from './AppShell';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';

function goto(path: string): void {
  window.history.replaceState({}, '', path);
  useRouterStore.getState().sync();
}

beforeEach(() => {
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
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

afterEach(() => cleanup());

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
