// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SuperAdminConsolePage } from './SuperAdminConsolePage';
import { NAV_GROUPS } from '@/config/navigation';
import { useSessionStore } from '@/store/sessionStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAuthStore } from '@/store/authStore';
import { useBillingStore } from '@/store/billingStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';

beforeEach(() => {
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useBillingStore.getState().ensureSeeded();
  useMeteringConfigStore.getState().resetToDefault();
  useOrganizationStore.getState().ensureBootstrapped(); // seeds a demo subscriber org
});
afterEach(() => cleanup());

describe('super-admin nav gating', () => {
  it('keeps the platform console out of the tenant application shell entirely', () => {
    // The console now lives on its own /admin/console surface, which does not
    // require a customer subscription. Leaving an entry in the subscriber
    // sidebar would put platform tooling behind the subscription-gated /app
    // surface — the production defect.
    const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.key === 'super-admin');
    expect(item).toBeUndefined();
  });
});

describe('super-admin console access', () => {
  it('blocks a subscriber (non-platform-admin) from the console', () => {
    useSessionStore.setState({ platformRole: 'none', userName: 'Subscriber' });
    render(<SuperAdminConsolePage />);
    expect(screen.getByText(/platform super-administrator only/i)).toBeTruthy();
  });

  it('shows the console with a subscribers list for the platform super-admin', () => {
    useSessionStore.setState({ platformRole: 'super-admin', userName: 'Platform Admin' });
    render(<SuperAdminConsolePage />);
    expect(screen.getByText(/acting as the Ledgora platform super-administrator/i)).toBeTruthy();
    // Subscribers tab is the default view and lists the demo subscriber organization.
    expect(screen.getByText(/Subscribers \(/i)).toBeTruthy();
    const orgName = useOrganizationStore.getState().organization!.legalName;
    expect(screen.getAllByText(orgName).length).toBeGreaterThan(0);
  });

  it('lists a newly-registered subscriber account in the roster', () => {
    // A visitor signs up (as happens through /register) — a separate account.
    useAuthStore.getState().register({ fullName: 'Lala Tester', email: 'lala@lala.com', mobile: '+971500000000', country: 'AE', password: 'Secret123', acceptedTerms: true });
    useSessionStore.setState({ platformRole: 'super-admin', userName: 'Platform Admin' });
    render(<SuperAdminConsolePage />);
    // Both the demo subscriber AND the new sign-up are listed.
    expect(screen.getByText(/lala@lala\.com/)).toBeTruthy();
    expect(screen.getByText(/Subscribers \(2\)/)).toBeTruthy();
  });
});
