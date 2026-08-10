// @vitest-environment happy-dom
/**
 * The pending-verification lockout.
 *
 * Reproduction being pinned: a subscriber registers, creates an organization,
 * selects a package, is invoiced and uploads payment proof. The subscription
 * becomes `pending_verification` and the customer is routed — permanently — to
 * `/subscription/status`, a page offering only "Sign out" and "Contact support".
 * They have paid and cannot enter Ledgora.
 *
 * The rule these tests enforce: A CHOSEN PACKAGE EARNS THE APPLICATION. Payment
 * verification is LEDGORA's work, never a reason to hold a customer outside
 * their books. Free Preview grants every feature and no durable storage, and
 * those two halves must never come apart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type {
  OnboardingSubscription,
  OnboardingSubscriptionStatus,
  Organization,
  RegisteredUser,
} from '@/types/onboarding';
import {
  ROUTES,
  freePreviewAllowed,
  isPathAllowed,
  resolvePostLoginRoute,
  type AccessContext,
} from '@/lib/accessControl';
import { FREE_PREVIEW_COPY, isFreePreviewEligible } from '@/lib/freePreview';
import { canOpenApplication, resolveAccountStatus } from '@/lib/sessionModel';
import { storageModeFor, syncWorkspaceStorageMode } from '@/lib/freeDemoSession';
import { canPersistFor } from '@/lib/persistencePolicy';
import { FULL_ACCESS_MODULE_IDS } from '@/lib/platformEntitlementOverride';
import { ALL_MODULE_IDS } from '@/config/modules';
import { VIEW_MODULE_REQUIREMENTS } from '@/config/navigation';
import { getEffectiveModuleIds } from '@/store/entitlementHooks';
import { isFreePreviewActive } from '@/store/freePreviewAccess';
import { readSessionState } from '@/store/sessionSnapshot';
import { isViewAllowed } from '@/components/access/AccessGate';
import { FreePreviewBanner } from '@/components/onboarding/FreePreviewBanner';
import { SubscriptionStatusPage } from '@/pages/onboarding/StatusPages';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useRouterStore } from '@/store/routerStore';
import { useJournalStore } from '@/store/journalStore';
import {
  clearMemoryWorkspace,
  getWorkspaceStorageMode,
  memoryWorkspaceKeys,
  setWorkspaceStorageMode,
} from '@/lib/workspaceStorage';

const ORG_ID = 'org_preview_1';

const user: RegisteredUser = {
  id: 'usr_preview_1',
  fullName: 'Sam Subscriber',
  email: 'sam@acme.test',
  mobile: '+971500000000',
  country: 'AE',
  passwordHash: 'not-a-real-hash',
  emailVerified: true,
  organizationId: ORG_ID,
  role: 'owner',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const organization: Organization = {
  id: ORG_ID,
  ownerUserId: user.id,
  legalName: 'Acme Trading LLC',
  tradingName: 'Acme',
  country: 'AE',
  registrationNumber: 'CN-1001',
  taxNumber: 'TRN-1001',
  industry: 'Trading',
  baseCurrency: 'AED',
  fiscalYearStart: '01-01',
  booksStartDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function subscriptionAt(status: OnboardingSubscriptionStatus): OnboardingSubscription {
  return {
    id: 'sub_preview_1',
    organizationId: ORG_ID,
    status,
    basePlanCode: 'core',
    addOnModuleCodes: [],
    extraUsers: 0,
    extraCompanies: 0,
    currency: 'USD',
    monthlyTotal: 49,
    invoiceId: 'inv_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A signed-in customer whose organization sits at the given lifecycle status. */
function seedCustomer(status: OnboardingSubscriptionStatus | null): void {
  useAuthStore.setState({ users: [user], currentUserId: user.id });
  useOrganizationStore.setState({
    organization,
    subscription: status ? subscriptionAt(status) : null,
    hydration: { status: 'ready', confirmedOrganizationId: ORG_ID, error: null },
  });
}

const ctxAt = (status: OnboardingSubscriptionStatus | null): AccessContext => ({
  user: { emailVerified: true },
  hasOrganization: true,
  subscriptionStatus: status,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setWorkspaceStorageMode('backend');
  clearMemoryWorkspace();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useOperatorViewStore.getState().exit();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.getState().resetToDefault();
  useAccountSessionStore.setState({ demoActive: false });
  useRouterStore.getState().navigate(ROUTES.subscriptionStatus, { replace: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useOperatorViewStore.getState().exit();
  useOrganizationStore.getState().resetToDefault();
  setWorkspaceStorageMode('backend');
  clearMemoryWorkspace();
});

/* ── 1–3, 5: every pending stage enters the application ───────────────────── */

describe('the three pending stages enter the application', () => {
  // `pending_payment` is the frontend's spelling of both `package_selected` and
  // `awaiting_payment`: a package is chosen and the invoice is unpaid.
  const PENDING: OnboardingSubscriptionStatus[] = ['pending_payment', 'pending_verification'];

  it.each(PENDING)('%s resolves to /app/dashboard in Free Preview', (status) => {
    expect(resolvePostLoginRoute(ctxAt(status))).toBe(ROUTES.appDashboard);
    expect(freePreviewAllowed(ctxAt(status))).toBe(true);
    expect(isPathAllowed(ctxAt(status), '/app/dashboard')).toBe(true);
  });

  it.each(PENDING)('%s resolves the account status to free-preview', (status) => {
    seedCustomer(status);
    expect(readSessionState().accountStatus).toBe('free-preview');
    expect(isFreePreviewActive()).toBe(true);
  });

  it('a pending-verification login lands on the dashboard, not the status page', () => {
    // The exact reported journey: proof uploaded, sign in again.
    expect(resolvePostLoginRoute(ctxAt('pending_verification'))).toBe(ROUTES.appDashboard);
  });

  it('the account status opens the accounting application at all', () => {
    expect(canOpenApplication('free-preview')).toBe(true);
    expect(isViewAllowed('free-preview', 'dashboard')).toBe(true);
  });
});

/* ── 4: proof upload is not a dead end ───────────────────────────────────── */

describe('after the payment-proof upload', () => {
  it('routes to the dashboard rather than the status page', () => {
    // The upload handler navigates to `appDashboard`; the routing rule agrees,
    // so a refresh immediately afterwards cannot bounce back either.
    seedCustomer('pending_verification');
    expect(resolvePostLoginRoute(ctxAt('pending_verification'))).toBe(ROUTES.appDashboard);
    expect(isPathAllowed(ctxAt('pending_verification'), ROUTES.appDashboard)).toBe(true);
  });

  it('does not redirect back to /subscription/status once there', () => {
    // The loop that built the cage: the status page was allowed, the app was
    // not, so every attempt to leave was reversed. Both are allowed now.
    const ctx = ctxAt('pending_verification');
    expect(isPathAllowed(ctx, ROUTES.subscriptionStatus)).toBe(true);
    expect(isPathAllowed(ctx, ROUTES.appDashboard)).toBe(true);
  });
});

/* ── 6–7: full entitlements ──────────────────────────────────────────────── */

describe('Free Preview entitlements', () => {
  it('receives every module id', () => {
    seedCustomer('pending_verification');
    const modules = getEffectiveModuleIds();
    expect(modules).toBe(FULL_ACCESS_MODULE_IDS);
    expect(modules).toHaveLength(ALL_MODULE_IDS.length);
  });

  it('can open every protected module route', () => {
    seedCustomer('pending_verification');
    const granted = new Set(getEffectiveModuleIds());
    const required = Object.values(VIEW_MODULE_REQUIREMENTS).flatMap((r) => [
      ...(r.requiredModule ? [r.requiredModule] : []),
      ...(r.requiredAllModules ?? []),
      ...(r.requiredAnyModules ?? []),
    ]);
    expect(required.length).toBeGreaterThan(0);
    for (const module of required) expect(granted.has(module)).toBe(true);
  });

  it('leaves the package awaiting activation untouched', () => {
    seedCustomer('pending_verification');
    const before = useEntitlementStore.getState().subscription;
    getEffectiveModuleIds();
    // Widening is a read-time overlay; the stored package is the one bought.
    expect(useEntitlementStore.getState().subscription).toEqual(before);
    expect(useOrganizationStore.getState().subscription?.basePlanCode).toBe('core');
  });

  it('reports the selected plan and the lifecycle status on the session', () => {
    seedCustomer('pending_verification');
    const session = readSessionState();
    expect(session.accountStatus).toBe('free-preview');
    expect(session.subscriptionStatus).toBe('pending_verification');
    expect(session.selectedPlanId).toBe(session.subscriptionPlanId);
    expect(session.canPersistData).toBe(false);
  });
});

/* ── 8–10: persistence protection ────────────────────────────────────────── */

describe('Free Preview persistence', () => {
  it('has canPersistData=false and memory-only storage', () => {
    expect(canPersistFor('free-preview')).toBe(false);
    expect(storageModeFor('free-preview')).toBe('memory');
    seedCustomer('pending_verification');
    expect(readSessionState().canPersistData).toBe(false);
  });

  it('writes no business data to browser persistence', () => {
    seedCustomer('pending_verification');
    syncWorkspaceStorageMode(readSessionState().accountStatus);
    expect(getWorkspaceStorageMode()).toBe('memory');

    useJournalStore.getState().resetToDefault();
    const before = Object.keys(localStorage);

    // A realistic preview action: post a journal entry.
    useJournalStore.setState({ entries: [{ id: 'je_preview' } as never] });

    // It lives in the volatile workspace …
    expect(memoryWorkspaceKeys().length).toBeGreaterThan(0);
    // … and nowhere durable. No NEW localStorage key, and nothing anywhere in
    // localStorage or sessionStorage mentioning the record.
    expect(Object.keys(localStorage)).toEqual(before);
    const durable = [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .map((k) => localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? '')
      .join('');
    expect(durable).not.toContain('je_preview');
  });

  it('disappears on refresh — the volatile workspace is not reloaded', () => {
    seedCustomer('pending_verification');
    syncWorkspaceStorageMode(readSessionState().accountStatus);
    useJournalStore.setState({ entries: [{ id: 'je_preview' } as never] });
    expect(memoryWorkspaceKeys().length).toBeGreaterThan(0);

    // A refresh is a new module instance: the in-memory map starts empty and
    // there is nothing durable to rehydrate from.
    clearMemoryWorkspace();
    expect(memoryWorkspaceKeys()).toEqual([]);
    expect(Object.keys(localStorage).join()).not.toContain('je_preview');
  });

  it('disappears on logout', async () => {
    seedCustomer('pending_verification');
    syncWorkspaceStorageMode(readSessionState().accountStatus);
    useJournalStore.setState({ entries: [{ id: 'je_preview' } as never] });

    const { clearLocalSession } = await import('@/services/sessionMirror');
    clearLocalSession();

    expect(memoryWorkspaceKeys()).toEqual([]);
    expect(useJournalStore.getState().entries.some((e) => e.id === 'je_preview')).toBe(false);
  });

  it('keeps the LIFECYCLE records durable — they are not business data', () => {
    seedCustomer('pending_verification');
    syncWorkspaceStorageMode(readSessionState().accountStatus);
    // The organization + subscription + invoice must survive: without them the
    // customer could never pay, and the preview would become permanent.
    expect(localStorage.getItem('ledgora-organization')).toBeTruthy();
    expect(localStorage.getItem('ledgora-organization')).toContain(ORG_ID);
  });
});

/* ── 13–14: activation switches to the real package ──────────────────────── */

describe('once the payment is approved', () => {
  it('the account becomes subscribed with durable storage', () => {
    seedCustomer('active');
    const session = readSessionState();
    expect(session.accountStatus).toBe('subscribed');
    expect(session.canPersistData).toBe(true);
    expect(storageModeFor('subscribed')).toBe('backend');
    expect(isFreePreviewActive()).toBe(false);
  });

  it('uses the selected package’s real entitlements, not the preview set', () => {
    seedCustomer('active');
    const ent = useEntitlementStore.getState();
    ent.replaceSubscription({
      ...ent.subscription,
      edition: 'core',
      status: 'active',
      enabledModules: [],
      disabledModules: [],
    });

    const modules = getEffectiveModuleIds();
    expect(modules).not.toBe(FULL_ACCESS_MODULE_IDS);
    expect(modules).toEqual(useEntitlementStore.getState().effectiveModuleIds);
    // A Core package has no manufacturing — the preview's breadth is gone.
    expect(modules).not.toContain('manufacturing_work_orders');
  });
});

/* ── 15–17: who does NOT get Free Preview ────────────────────────────────── */

describe('Free Preview is never granted to', () => {
  it('an anonymous visitor', () => {
    expect(isFreePreviewEligible({ authenticated: false, hasOrganization: true, subscriptionStatus: 'pending_verification' })).toBe(false);
    expect(freePreviewAllowed({ user: null, hasOrganization: true, subscriptionStatus: 'pending_verification' })).toBe(false);
    expect(resolveAccountStatus({
      user: null,
      organizationId: ORG_ID,
      onboardingStatus: 'pending_verification',
      entitlementStatus: 'active',
      subscriptionPlanId: null,
      demoActive: false,
    })).toBe('anonymous');
  });

  it('a customer who has selected no package — they stay in onboarding', () => {
    expect(freePreviewAllowed(ctxAt(null))).toBe(false);
    expect(resolvePostLoginRoute(ctxAt(null))).toBe(ROUTES.onboardingSubscription);
    expect(isPathAllowed(ctxAt(null), '/app/dashboard')).toBe(false);

    seedCustomer(null);
    expect(readSessionState().accountStatus).toBe('registered-no-plan');
    expect(isFreePreviewActive()).toBe(false);
  });

  it('a customer with an unconfirmed draft selection', () => {
    expect(freePreviewAllowed(ctxAt('draft'))).toBe(false);
    expect(resolvePostLoginRoute(ctxAt('draft'))).toBe(ROUTES.onboardingSubscription);
  });

  it('a suspended or archived account', () => {
    expect(freePreviewAllowed(ctxAt('suspended'))).toBe(false);
    expect(resolvePostLoginRoute(ctxAt('suspended'))).toBe(ROUTES.subscriptionSuspended);
    expect(
      isFreePreviewEligible({
        authenticated: true,
        hasOrganization: true,
        subscriptionStatus: 'pending_verification',
        accountClosed: true,
      }),
    ).toBe(false);
  });

  it('a customer with no organization', () => {
    expect(freePreviewAllowed({ user: { emailVerified: true }, hasOrganization: false, subscriptionStatus: 'pending_verification' })).toBe(false);
  });

  it('a platform operator outside the operator-view system', () => {
    const operator: AccessContext = {
      user: { emailVerified: true },
      hasOrganization: true,
      subscriptionStatus: 'pending_verification',
      platformRole: 'super-admin',
    };
    expect(freePreviewAllowed(operator)).toBe(false);
    // Operators keep their own landing surface and their own audited override.
    expect(resolvePostLoginRoute(operator)).toBe(ROUTES.adminConsole);
    expect(isPathAllowed(operator, '/app/dashboard')).toBe(false);
  });

  it('a Free Demo visitor, who has their own narrower mode', () => {
    expect(
      isFreePreviewEligible({
        authenticated: true,
        hasOrganization: true,
        subscriptionStatus: 'pending_verification',
        demoActive: true,
      }),
    ).toBe(false);
  });
});

/* ── 18: the status page is informational, not a trap ────────────────────── */

describe('/subscription/status', () => {
  it('remains reachable and offers a way into the application', () => {
    seedCustomer('pending_verification');
    render(<SubscriptionStatusPage />);

    // Still informational …
    expect(screen.getByText(/Awaiting verification/)).toBeTruthy();
    // … but no longer a dead end. This is the fix for "only Sign out and
    // Contact support".
    const enter = screen.getByRole('button', { name: FREE_PREVIEW_COPY.enterPreview });
    fireEvent.click(enter);
    expect(useRouterStore.getState().path).toBe(ROUTES.appDashboard);
  });

  it('offers the payment surface as the secondary action', () => {
    seedCustomer('pending_verification');
    render(<SubscriptionStatusPage />);

    fireEvent.click(screen.getByRole('button', { name: FREE_PREVIEW_COPY.paymentStatus }));
    expect(useRouterStore.getState().path).toBe(ROUTES.billingPayment);
  });

  it('does not offer Free Preview to a customer who has not selected a package', () => {
    seedCustomer(null);
    render(<SubscriptionStatusPage />);
    expect(screen.queryByRole('button', { name: FREE_PREVIEW_COPY.enterPreview })).toBeNull();
  });
});

/* ── The banner ──────────────────────────────────────────────────────────── */

describe('the Free Preview banner', () => {
  it('states that the work is temporary, and names the pending verification', async () => {
    seedCustomer('pending_verification');
    render(<FreePreviewBanner />);

    expect(await screen.findByTestId('free-preview-banner')).toBeTruthy();
    expect(screen.getByText(FREE_PREVIEW_COPY.banner)).toBeTruthy();
    expect(screen.getByText(FREE_PREVIEW_COPY.pendingVerification)).toBeTruthy();
  });

  it('keeps the payment funnel one click away while payment is due', async () => {
    seedCustomer('pending_payment');
    render(<FreePreviewBanner />);

    fireEvent.click(await screen.findByRole('button', { name: FREE_PREVIEW_COPY.paymentStatus }));
    expect(useRouterStore.getState().path).toBe(ROUTES.billingPayment);
  });

  it('is absent for an active subscriber', async () => {
    seedCustomer('active');
    render(<FreePreviewBanner />);
    await waitFor(() => expect(screen.queryByTestId('free-preview-banner')).toBeNull());
  });
});
