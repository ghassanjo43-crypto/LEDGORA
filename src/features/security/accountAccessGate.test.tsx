// @vitest-environment happy-dom
/**
 * The application-level AccessGate vs. platform-operator full access.
 *
 * The production defect these tests lock down: a backend-verified super_admin
 * in full-access operator viewing mode saw every module in the sidebar (the
 * entitlement override worked), yet every view — including the Dashboard —
 * rendered a refusal, because the AccessGate derived a subscriber account
 * status (`registered-no-plan`: an operator owns no subscription) and denied
 * the application independently. Worse, the refusal rendered
 * `ModuleUnavailablePage`, whose edition wording is wrong for an account-level
 * refusal.
 *
 * Contract:
 *  - full-access operator mode (verified role + viewing mode + matching
 *    organization + "view exactly as subscriber" OFF) opens every view;
 *  - exact-subscriber mode re-applies the subscriber's REAL account lifecycle;
 *  - ordinary subscribers and browser-planted roles change nothing;
 *  - account-level refusals render the account explanation, and
 *    `ModuleUnavailablePage` stays reserved for module entitlement failures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AccessGate, isViewAllowed } from '@/components/access/AccessGate';
import {
  AccountAccessRequiredPage,
  resolveAccountAccessExplanation,
} from '@/components/access/AccountAccessRequiredPage';
import { ModuleRoute } from '@/components/entitlements/ModuleRoute';
import { ROUTES } from '@/lib/accessControl';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import type { BackendUser } from '@/services/api/authApi';
import type {
  OnboardingSubscription,
  OnboardingSubscriptionStatus,
  Organization,
  RegisteredUser,
} from '@/types/onboarding';

const ORG_ID = 'org_sub_1';

/** A backend-verified super_admin session (the production trust path). */
const ADMIN: BackendUser = {
  id: 'usr_admin_1',
  email: 'admin@ledgora.com',
  fullName: 'Platform Admin',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: ['super_admin'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function verifyAdminWithBackend(): void {
  useBackendSessionStore.setState({ status: 'ready', user: ADMIN, platformRoles: ['super_admin'], error: null });
}

const subscriberUser: RegisteredUser = {
  id: 'usr_sub_1',
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

/**
 * Seed a signed-in subscriber whose organization sits at the given onboarding
 * status (`null` = registered, nothing selected yet).
 *
 * `null`, `draft` and `expired` resolve to a status the AccessGate refuses.
 * `pending_payment` / `pending_verification` resolve to `free-preview`, which it
 * admits — so tests about the OPERATOR override must seed a genuinely refused
 * status, or the override is not what is being measured.
 */
function seedSubscriber(status: OnboardingSubscriptionStatus | null): void {
  const organization: Organization = {
    id: ORG_ID,
    ownerUserId: subscriberUser.id,
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
  const subscription: OnboardingSubscription | null = status
    ? {
        id: 'sub_1',
        organizationId: ORG_ID,
        status,
        basePlanCode: 'core',
        addOnModuleCodes: [],
        extraUsers: 0,
        extraCompanies: 0,
        currency: 'USD',
        monthlyTotal: 49,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    : null;
  useAuthStore.setState({ users: [subscriberUser], currentUserId: subscriberUser.id });
  useOrganizationStore.setState({ organization, subscription });
}

/** Pin the workspace entitlements to a Core package (no manufacturing). */
function seedCoreEntitlements(): void {
  const ent = useEntitlementStore.getState();
  ent.replaceSubscription({
    ...ent.subscription,
    edition: 'core',
    status: 'active',
    enabledModules: [],
    disabledModules: [],
  });
}

function enterOperatorView(orgId: string): void {
  useOperatorViewStore.getState().enter({ organizationId: orgId, orgName: 'Acme Trading LLC' });
}

const CONTENT = 'protected-content';

function renderGate(view: 'dashboard' | 'manufacturing-work-orders' = 'dashboard') {
  return render(
    <AccessGate view={view} fallback={<AccountAccessRequiredPage />}>
      <div>{CONTENT}</div>
    </AccessGate>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useOperatorViewStore.getState().exit();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.setState({ organization: null, subscription: null });
  useAccountSessionStore.setState({ demoActive: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useOperatorViewStore.getState().exit();
});

/* ── Operator full access may open the application ───────────────────────── */

describe('operator full access through the AccessGate', () => {
  it('opens the Dashboard although the subscriber onboarding status is not active', () => {
    seedSubscriber('pending_payment');
    verifyAdminWithBackend();
    enterOperatorView(ORG_ID);

    // The account status genuinely refuses — only the override admits.
    expect(isViewAllowed('registered-no-plan', 'dashboard')).toBe(false);

    renderGate('dashboard');
    expect(screen.getByText(CONTENT)).toBeTruthy();
  });

  it('opens a protected module route the subscriber package does not include', () => {
    seedSubscriber('pending_payment');
    seedCoreEntitlements();
    verifyAdminWithBackend();
    enterOperatorView(ORG_ID);

    render(
      <AccessGate view="manufacturing-work-orders" fallback={<AccountAccessRequiredPage />}>
        <ModuleRoute module="manufacturing_work_orders" element={<div>{CONTENT}</div>} />
      </AccessGate>,
    );
    expect(screen.getByText(CONTENT)).toBeTruthy();
  });

  it('"view exactly as subscriber" re-applies the subscriber’s real restriction', () => {
    // A subscriber who has selected NOTHING — genuinely refused, so the only
    // thing that could open the gate is the override being (wrongly) applied.
    // `pending_payment` is deliberately not used here: that subscriber is in
    // Free Preview and may legitimately open the application on their own.
    seedSubscriber(null);
    verifyAdminWithBackend();
    enterOperatorView(ORG_ID);
    useOperatorViewStore.getState().setViewAsSubscriber(true);

    renderGate('dashboard');
    expect(screen.queryByText(CONTENT)).toBeNull();
    // The subscriber's real lifecycle state is what is explained.
    expect(screen.getByText('No active subscription')).toBeTruthy();
  });

  it('exact-subscriber mode shows a Free Preview subscriber exactly what they see', () => {
    // The other half of "exactly as subscriber": when the subscriber's real
    // state DOES open the app, the operator must see it open too.
    seedSubscriber('pending_verification');
    verifyAdminWithBackend();
    enterOperatorView(ORG_ID);
    useOperatorViewStore.getState().setViewAsSubscriber(true);

    renderGate('dashboard');
    expect(screen.getByText(CONTENT)).toBeTruthy();
  });
});

/* ── The gate stays shut for everyone else ───────────────────────────────── */

describe('AccessGate trust boundary', () => {
  it('keeps an ordinary registered-no-plan subscriber blocked', () => {
    seedSubscriber(null);

    renderGate('dashboard');
    expect(screen.queryByText(CONTENT)).toBeNull();
    expect(screen.getByText('No active subscription')).toBeTruthy();
  });

  it('a browser-planted platform role cannot open the gate in production', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    // No package selected, so the account itself grants nothing and the planted
    // role is the only thing that could possibly admit this render.
    seedSubscriber(null);
    // A tenant plants the role AND the operator-view payload in the browser.
    useSessionStore.setState({ platformRole: 'super-admin' });
    enterOperatorView(ORG_ID);

    renderGate('dashboard');
    expect(screen.queryByText(CONTENT)).toBeNull();
  });

  it('fails closed when the viewed organization does not match the loaded one', () => {
    seedSubscriber(null);
    verifyAdminWithBackend();
    enterOperatorView('org_other_tenant');

    renderGate('dashboard');
    expect(screen.queryByText(CONTENT)).toBeNull();
  });
});

/* ── Fallback accuracy ───────────────────────────────────────────────────── */

describe('refusal fallbacks', () => {
  it('module entitlement failures still render ModuleUnavailablePage', () => {
    seedSubscriber('active'); // account may open the application …
    seedCoreEntitlements(); // … but the Core package has no manufacturing.

    render(
      <AccessGate view="manufacturing-work-orders" fallback={<AccountAccessRequiredPage />}>
        <ModuleRoute module="manufacturing_work_orders" element={<div>{CONTENT}</div>} />
      </AccessGate>,
    );
    expect(screen.queryByText(CONTENT)).toBeNull();
    // The edition wording is CORRECT here — this is a package restriction.
    expect(screen.getByText(/is not available|Feature not available/)).toBeTruthy();
    expect(screen.getByText(/not included in your current/)).toBeTruthy();
  });

  it('account-level refusals never show edition wording', () => {
    // A refusal that survives the Free Preview rule: no package chosen at all.
    seedSubscriber(null);

    renderGate('dashboard');
    expect(screen.getByText('No active subscription')).toBeTruthy();
    expect(screen.queryByText(/edition/i)).toBeNull();
    expect(screen.queryByText(/not included/i)).toBeNull();
  });
});

/* ── The pure account-access explanation (every state) ───────────────────── */

describe('resolveAccountAccessExplanation', () => {
  const base = { accountStatus: 'registered-no-plan' as const, hasOrganization: true };

  it('distinguishes every account-level state and points at the resolving route', () => {
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: null }),
    ).toMatchObject({ reason: 'no-plan', route: ROUTES.onboardingSubscription });
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: 'draft' }),
    ).toMatchObject({ reason: 'no-plan', route: ROUTES.onboardingSubscription });
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: 'pending_payment' }),
    ).toMatchObject({ reason: 'pending-payment', route: ROUTES.billingPayment });
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: 'rejected' }),
    ).toMatchObject({ reason: 'pending-payment', route: ROUTES.billingPayment });
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: 'pending_verification' }),
    ).toMatchObject({ reason: 'pending-verification', route: ROUTES.subscriptionStatus });
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: 'expired' }),
    ).toMatchObject({ reason: 'expired', route: ROUTES.billingRenew });
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: 'suspended' }),
    ).toMatchObject({ reason: 'suspended', route: ROUTES.subscriptionSuspended });
    expect(
      resolveAccountAccessExplanation({
        accountStatus: 'suspended',
        onboardingStatus: null,
        hasOrganization: true,
      }),
    ).toMatchObject({ reason: 'suspended', route: ROUTES.subscriptionSuspended });
  });

  it('handles a missing organization, an anonymous visitor and the Free Demo', () => {
    expect(
      resolveAccountAccessExplanation({ ...base, onboardingStatus: null, hasOrganization: false }),
    ).toMatchObject({ reason: 'no-organization', route: ROUTES.onboardingOrganization });
    expect(
      resolveAccountAccessExplanation({
        accountStatus: 'anonymous',
        onboardingStatus: null,
        hasOrganization: false,
      }),
    ).toMatchObject({ reason: 'sign-in', route: ROUTES.login });
    expect(
      resolveAccountAccessExplanation({
        accountStatus: 'free-demo',
        onboardingStatus: null,
        hasOrganization: false,
      }),
    ).toMatchObject({ reason: 'demo-restricted', route: ROUTES.pricing });
  });
});
