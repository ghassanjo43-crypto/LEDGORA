// @vitest-environment happy-dom
/**
 * SubscribersPanel — the operator "View" action and workspace entry.
 *
 * Verifies that View opens the correct subscriber (keyed by id, no cross-tenant
 * leakage), that registered-only accounts are shown honestly, and that opening a
 * subscriber workspace is allowed only for the retained active tenant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { SubscribersPanel } from './SubscribersPanel';
import { useSessionStore } from '@/store/sessionStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAuthStore } from '@/store/authStore';
import { useBillingStore } from '@/store/billingStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';

/** Seed one retained active tenant (via bootstrap) plus a registered-only user. */
function seed(): { ownerId: string; ownerName: string; ownerEmail: string; orgId: string; orgName: string; lalaId: string } {
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useBillingStore.getState().ensureSeeded();
  useMeteringConfigStore.getState().resetToDefault();
  useOperatorViewStore.getState().exit();
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'Demo Owner' });
  useOrganizationStore.getState().ensureBootstrapped(); // active tenant + owner + active sub

  const org = useOrganizationStore.getState().organization!;
  const owner = useAuthStore.getState().users.find((u) => u.id === org.ownerUserId)!;

  // A separate visitor signs up — never onboarded (no organization).
  const lala = useAuthStore.getState().register({
    fullName: 'Lala Tester',
    email: 'lala@lala.com',
    mobile: '+971500000000',
    country: 'AE',
    password: 'Secret123',
    acceptedTerms: true,
  });

  return {
    ownerId: owner.id,
    ownerName: owner.fullName,
    ownerEmail: owner.email,
    orgId: org.id,
    orgName: org.legalName,
    lalaId: lala.id!,
  };
}

beforeEach(() => {
  useRouterStore.getState().navigate('/', { replace: true });
});

afterEach(() => {
  cleanup();
  useOperatorViewStore.getState().exit();
});

describe('View action', () => {
  it('opens the details of the exact subscriber whose row was clicked', () => {
    const { ownerId, ownerName, ownerEmail } = seed();
    render(<SubscribersPanel />);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`View ${ownerName}`, 'i') }));

    const detail = screen.getByTestId('subscriber-detail');
    expect(detail.getAttribute('data-subscriber-id')).toBe(ownerId);
    // The owner's email appears in the drawer (Account row, and — as a member —
    // the members table): at least one occurrence confirms the right subscriber.
    expect(within(detail).getAllByText(ownerEmail).length).toBeGreaterThan(0);
  });

  it('passes the correct id for each distinct row', () => {
    const { lalaId } = seed();
    render(<SubscribersPanel />);

    fireEvent.click(screen.getByRole('button', { name: /View Lala Tester/i }));
    expect(screen.getByTestId('subscriber-detail').getAttribute('data-subscriber-id')).toBe(lalaId);
  });

  it('renders a registered-only subscriber as "Not onboarded yet"', () => {
    seed();
    render(<SubscribersPanel />);

    fireEvent.click(screen.getByRole('button', { name: /View Lala Tester/i }));
    const detail = screen.getByTestId('subscriber-detail');
    expect(within(detail).getByText(/Not onboarded yet/i)).toBeTruthy();
    // Sign-up data is still present.
    expect(within(detail).getByText('lala@lala.com')).toBeTruthy();
  });

  it('never shows another tenant\'s subscription data on a registered-only account', () => {
    const { orgName } = seed();
    render(<SubscribersPanel />);

    fireEvent.click(screen.getByRole('button', { name: /View Lala Tester/i }));
    const detail = screen.getByTestId('subscriber-detail');
    // The active tenant's plan/MRR/org must not bleed into a different subscriber.
    expect(within(detail).queryByText('MRR')).toBeNull();
    expect(within(detail).queryByText(orgName)).toBeNull();
  });

  it('exposes View as a real, keyboard-operable button with an accessible name', () => {
    seed();
    render(<SubscribersPanel />);
    const btn = screen.getByRole('button', { name: /View Lala Tester/i });
    // A native <button> is inherently activable by keyboard (Enter/Space).
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn); // the event Enter/Space dispatches on a native button
    expect(screen.getByTestId('subscriber-detail')).toBeTruthy();
  });
});

describe('Open subscriber workspace', () => {
  it('is disabled for a not-onboarded subscriber, with an explanation', () => {
    seed();
    render(<SubscribersPanel />);

    fireEvent.click(screen.getByRole('button', { name: /View Lala Tester/i }));
    const wsBtn = screen.getByRole('button', { name: /Open subscriber workspace/i });
    expect(wsBtn.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/has not completed organization onboarding/i)).toBeTruthy();
  });

  it('enters operator viewing mode and navigates to the dashboard for the active tenant', () => {
    const { ownerId, ownerName, orgId } = seed();
    render(<SubscribersPanel />);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`View ${ownerName}`, 'i') }));
    const wsBtn = screen.getByRole('button', { name: /Open subscriber workspace/i });
    expect(wsBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(wsBtn);

    const view = useOperatorViewStore.getState();
    expect(view.active).toBe(true);
    expect(view.organizationId).toBe(orgId);
    expect(view.ownerUserId).toBe(ownerId);
    expect(useRouterStore.getState().path).toBe(ROUTES.appDashboard);
  });
});
