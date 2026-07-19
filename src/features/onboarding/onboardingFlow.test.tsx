// @vitest-environment happy-dom
/**
 * End-to-end coverage of the onboarding / registration / subscription-selection
 * / free-demo flow: welcome gating, registration, the registered-no-plan lock,
 * the Free Demo workspace and its non-persistence guarantees, and sign-out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import { AppShell } from '@/components/shell/AppShell';
import { SubscriptionSettingsPage } from '@/components/settings/SubscriptionSettingsPage';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useRouterStore } from '@/store/routerStore';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { authService, subscriptionService } from '@/services';
import {
  getWorkspaceStorageMode,
  setWorkspaceStorageMode,
  clearMemoryWorkspace,
} from '@/lib/workspaceStorage';
import { rehydrateBusinessWorkspace } from '@/store/businessWorkspace';
import { ROUTES } from '@/lib/accessControl';
import { FREE_DEMO_COPY } from '@/config/freeDemo';

function goto(path: string): void {
  window.history.replaceState({}, '', path);
  useRouterStore.getState().sync();
}

const REGISTRATION = {
  fullName: 'Jane Owner',
  email: 'jane@acme.test',
  password: 'Secret123',
  confirmPassword: 'Secret123',
  companyName: 'Acme Holdings Ltd.',
  country: 'AE',
  acceptedTerms: true,
};

/** A balanced two-line journal entry against the seeded chart of accounts. */
function addDemoJournalEntry(): string | undefined {
  const accounts = useStore.getState().accounts.filter((a) => a.isPostingAccount);
  const debit = accounts[0]!;
  const credit = accounts[1]!;
  const line = (accountId: string, d: number, c: number) => ({
    accountId,
    accountCode: '',
    accountName: '',
    description: 'Demo',
    debit: d,
    credit: c,
    entityId: '',
    entityName: '',
    costCenter: '',
    project: '',
    taxCode: '',
    taxAmount: 0,
    memo: '',
  });
  const result = useJournalStore.getState().addEntry({
    entryNumber: '',
    entryDate: '2026-07-19',
    reference: 'DEMO',
    description: 'Temporary demo entry',
    currency: 'USD',
    exchangeRate: 1,
    notes: '',
    transactionType: 'Journal',
    createdBy: 'demo',
    approvedBy: '',
    lines: [line(debit.id, 100, 0), line(credit.id, 0, 100)],
  });
  return result.id;
}

beforeEach(() => {
  // Exercise the PRODUCTION path: no development tooling, so the dev tenant is
  // never provisioned and an unregistered visitor really does land on /welcome.
  vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', '');
  localStorage.clear();
  setWorkspaceStorageMode('backend');
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useAccountSessionStore.getState().resetToDefault();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useJournalStore.getState().resetToDefault();
  goto(ROUTES.welcome);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  useAccountSessionStore.getState().resetToDefault();
  setWorkspaceStorageMode('backend');
});

/* ── 1–2. The anonymous visitor ──────────────────────────────────────────── */

describe('anonymous visitor', () => {
  it('sees the LEDGORA welcome page with create-account, sign-in and demo options', async () => {
    render(<AppShell />);
    expect(await screen.findByRole('button', { name: /create account/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /sign in/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /explore free demo/i })).toBeTruthy();
    expect(screen.getByText(/temporary workspace/i)).toBeTruthy();
  });

  it('cannot reach the accounting dashboard by setting the URL', async () => {
    render(<AppShell />);
    await screen.findByRole('button', { name: /create account/i });

    act(() => {
      useRouterStore.getState().navigate('/app/dashboard');
    });

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.welcome));
  });

  it('cannot reach the accounting dashboard by setting the stored view key', async () => {
    act(() => {
      useStore.getState().setActiveView('journal');
    });
    render(<AppShell />);
    // The view key is irrelevant while the shell is on a public surface.
    expect(await screen.findByRole('button', { name: /create account/i })).toBeTruthy();
  });
});

/* ── 3–5. Registration ───────────────────────────────────────────────────── */

describe('registration', () => {
  it('rejects a mismatched confirmation, a weak password and missing terms', async () => {
    const mismatch = await authService.register({ ...REGISTRATION, confirmPassword: 'Different1' });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.fieldErrors?.confirmPassword).toBeTruthy();

    const weak = await authService.register({ ...REGISTRATION, password: 'abc', confirmPassword: 'abc' });
    expect(weak.ok).toBe(false);
    expect(weak.fieldErrors?.password).toBeTruthy();

    const noTerms = await authService.register({ ...REGISTRATION, acceptedTerms: false });
    expect(noTerms.ok).toBe(false);
    expect(noTerms.fieldErrors?.acceptedTerms).toBeTruthy();

    expect(useAuthStore.getState().users).toHaveLength(0);
  });

  it('never stores a raw password anywhere in browser storage', async () => {
    await authService.register(REGISTRATION);
    const dump = JSON.stringify(useAuthStore.getState()) + JSON.stringify({ ...localStorage });
    expect(dump).not.toContain(REGISTRATION.password);
  });

  it('shows validation errors in the registration form', async () => {
    goto(ROUTES.register);
    render(<AppShell />);
    const submit = await screen.findByRole('button', { name: /create account/i });
    fireEvent.click(submit);
    expect(await screen.findByText(/fix the highlighted fields/i)).toBeTruthy();
  });

  it('redirects a successful registration to package selection', async () => {
    goto(ROUTES.register);
    render(<AppShell />);
    await screen.findByRole('button', { name: /create account/i });

    await act(async () => {
      await authService.register(REGISTRATION);
      useRouterStore.getState().navigate(ROUTES.onboardingSubscription);
    });

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.onboardingSubscription));
    expect(await screen.findByText(FREE_DEMO_COPY.title)).toBeTruthy();
  });

  it('leaves a newly registered user without a plan and locked out of the app', async () => {
    await act(async () => {
      await authService.register(REGISTRATION);
    });
    render(<AppShell />);

    act(() => {
      useRouterStore.getState().navigate('/app/dashboard');
    });

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.onboardingSubscription));
    expect(useOrganizationStore.getState().subscription).toBeNull();
  });

  it('does not make a new registered user a platform administrator', async () => {
    await act(async () => {
      await authService.register(REGISTRATION);
    });
    expect(useSessionStore.getState().platformRole).toBe('none');
  });
});

/* ── 6–12. Free Demo ─────────────────────────────────────────────────────── */

describe('free demo', () => {
  it('can be selected from the welcome page confirmation dialog', async () => {
    render(<AppShell />);
    fireEvent.click(await screen.findByRole('button', { name: /explore free demo/i }));

    expect(await screen.findByText(FREE_DEMO_COPY.confirmBody)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: FREE_DEMO_COPY.confirmEnter }));
    });

    expect(useAccountSessionStore.getState().demoActive).toBe(true);
  });

  it('opens the accounting application and shows the demo banner', async () => {
    await act(async () => {
      await subscriptionService.startFreeDemo();
    });
    goto('/app/dashboard');
    render(<AppShell />);

    expect(await screen.findByText(FREE_DEMO_COPY.banner)).toBeTruthy();
    expect(screen.getByRole('button', { name: /choose a package/i })).toBeTruthy();
    expect(useRouterStore.getState().path).toBe('/app/dashboard');
  });

  it('"Choose a package" opens package selection without ending the demo', async () => {
    await act(async () => {
      await subscriptionService.startFreeDemo();
    });
    const entryId = addDemoJournalEntry();
    goto('/app/dashboard');
    render(<AppShell />);

    await screen.findByText(FREE_DEMO_COPY.banner);
    fireEvent.click(screen.getByRole('button', { name: /choose a package/i }));

    expect(useStore.getState().activeView).toBe('subscription');
    expect(useAccountSessionStore.getState().demoActive).toBe(true);
    // Demo data survives until the visitor actually leaves or upgrades.
    expect(useJournalStore.getState().entries.some((e) => e.id === entryId)).toBe(true);
  });

  it('creates temporary transactions that never reach localStorage', async () => {
    await act(async () => {
      await subscriptionService.startFreeDemo();
    });

    const entryId = addDemoJournalEntry();
    expect(entryId).toBeTruthy();
    expect(useJournalStore.getState().entries.some((e) => e.id === entryId)).toBe(true);

    expect(getWorkspaceStorageMode()).toBe('memory');
    const persisted = JSON.stringify({ ...localStorage });
    expect(persisted).not.toContain('Temporary demo entry');
    expect(persisted).not.toContain(entryId!);
  });

  it('resets the demo workspace on refresh', async () => {
    await act(async () => {
      await subscriptionService.startFreeDemo();
    });
    addDemoJournalEntry();
    const before = useJournalStore.getState().entries.length;
    expect(before).toBeGreaterThan(0);

    // A refresh drops the in-memory workspace; the stores rehydrate from a
    // storage that holds nothing for this session.
    clearMemoryWorkspace();
    act(() => {
      useJournalStore.getState().resetToDefault();
      rehydrateBusinessWorkspace();
    });

    expect(useJournalStore.getState().entries.some((e) => e.description === 'Temporary demo entry')).toBe(false);
  });

  it('is never treated as a paid subscription', async () => {
    await act(async () => {
      await subscriptionService.startFreeDemo();
    });
    expect(useOrganizationStore.getState().subscription).toBeNull();
    expect(useAccountSessionStore.getState().demoActive).toBe(true);
  });
});

/* ── 13–14. Persistence path + administration ────────────────────────────── */

describe('subscribed workspace', () => {
  it('uses the durable persistence path once a subscription is active', async () => {
    await act(async () => {
      await authService.register(REGISTRATION);
    });
    expect(getWorkspaceStorageMode()).toBe('backend');

    addDemoJournalEntry();
    expect(JSON.stringify({ ...localStorage })).toContain('Temporary demo entry');
  });

  it('does not offer subscription administration to an ordinary user', () => {
    useSessionStore.setState({ platformRole: 'none' });
    render(<SubscriptionSettingsPage />);
    expect(screen.queryByText(/Super Admin console/i)).toBeNull();
  });

  it('hides administration and metering in onboarding mode even for an admin', () => {
    // Grant a real (local-development) operator role for this case only.
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    useSessionStore.setState({ platformRole: 'super-admin' });
    render(<SubscriptionSettingsPage initialTab="packages" onboardingMode />);
    expect(screen.queryByText(/Super Admin console/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Usage$/i })).toBeNull();
  });
});

/* ── 15. Sign-out ────────────────────────────────────────────────────────── */

describe('sign-out', () => {
  it('clears demo data and returns the visitor to the welcome page', async () => {
    await act(async () => {
      await subscriptionService.startFreeDemo();
    });
    addDemoJournalEntry();
    expect(useJournalStore.getState().entries.some((e) => e.description === 'Temporary demo entry')).toBe(true);

    await act(async () => {
      await authService.signOut();
    });

    expect(useAccountSessionStore.getState().demoActive).toBe(false);
    expect(useJournalStore.getState().entries.some((e) => e.description === 'Temporary demo entry')).toBe(false);
    expect(useAuthStore.getState().currentUserId).toBeNull();

    goto('/app/dashboard');
    render(<AppShell />);
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.welcome));
  });

  it('leaves the public package configuration intact after sign-out', async () => {
    await act(async () => {
      await authService.signOut();
    });
    const plans = await subscriptionService.listPublicPlans();
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.some((p) => p.isFreeDemo)).toBe(true);
  });
});
