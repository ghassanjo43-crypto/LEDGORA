// @vitest-environment happy-dom
/**
 * A Ledgora platform operator is not a tenant subscriber.
 *
 * The production defect these tests lock down: a bootstrapped super_admin
 * authenticated successfully and the backend returned
 * `platformRoles: ["super_admin"]`, but the frontend routed on customer state
 * alone (email verified / has organization / subscription status) and sent the
 * operator to package selection and payment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isPathAllowed,
  operatorLandingRoute,
  requiredAdminCapability,
  resolvePostLoginRoute,
  ROUTES,
  type AccessContext,
} from '@/lib/accessControl';
import { readAccessContext, isSessionResolving } from '@/lib/accessContext';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';

const API = 'https://api.example.test';

/** A signed-in person with no tenant organization and nothing purchased. */
const bareCustomer = (over: Partial<AccessContext> = {}): AccessContext => ({
  user: { emailVerified: true },
  hasOrganization: false,
  subscriptionStatus: null,
  ...over,
});

const backendUser = (over: Record<string, unknown> = {}) => ({
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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.getState().clear();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.setState({ organization: null, subscription: null });
  useAccountSessionStore.setState({ demoActive: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('operator landing', () => {
  it('sends a super_admin with no organization and no subscription to the console', () => {
    const ctx = bareCustomer({ platformRole: 'super-admin' });
    expect(resolvePostLoginRoute(ctx)).toBe(ROUTES.adminConsole);
  });

  it('never routes a super_admin into the customer funnel', () => {
    // Every customer-state permutation must still land on administration.
    const customerRoutes = [
      ROUTES.onboardingSubscription,
      ROUTES.onboardingOrganization,
      ROUTES.billingPayment,
      ROUTES.subscriptionStatus,
      ROUTES.billingRenew,
      ROUTES.subscriptionSuspended,
    ];
    const permutations: AccessContext[] = [
      bareCustomer({ platformRole: 'super-admin' }),
      bareCustomer({ platformRole: 'super-admin', hasOrganization: true }),
      bareCustomer({ platformRole: 'super-admin', hasOrganization: true, subscriptionStatus: 'draft' }),
      bareCustomer({ platformRole: 'super-admin', subscriptionStatus: 'pending_payment' }),
      bareCustomer({ platformRole: 'super-admin', subscriptionStatus: 'rejected' }),
      bareCustomer({ platformRole: 'super-admin', subscriptionStatus: 'suspended' }),
      bareCustomer({ platformRole: 'super-admin', user: { emailVerified: false } }),
    ];
    for (const ctx of permutations) {
      expect(customerRoutes).not.toContain(resolvePostLoginRoute(ctx));
      expect(resolvePostLoginRoute(ctx)).toBe(ROUTES.adminConsole);
    }
  });

  it('sends a billing_admin to the payment review surface', () => {
    expect(operatorLandingRoute('billing-admin')).toBe(ROUTES.adminPayments);
    expect(resolvePostLoginRoute(bareCustomer({ platformRole: 'billing-admin' }))).toBe(ROUTES.adminPayments);
  });

  it('keeps a normal customer with no subscription in the onboarding funnel', () => {
    expect(resolvePostLoginRoute(bareCustomer({ platformRole: 'none' }))).toBe(ROUTES.onboardingOrganization);
    expect(
      resolvePostLoginRoute(bareCustomer({ platformRole: 'none', hasOrganization: true })),
    ).toBe(ROUTES.onboardingSubscription);
  });

  it('sends an unauthenticated visitor to the public surface', () => {
    expect(resolvePostLoginRoute({ user: null, hasOrganization: false, subscriptionStatus: null })).toBe(
      ROUTES.welcome,
    );
  });
});

describe('admin surface authorisation', () => {
  it('admits an operator with no organization and no subscription', () => {
    const ctx = bareCustomer({ platformRole: 'super-admin' });
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(true);
    expect(isPathAllowed(ctx, ROUTES.adminPayments)).toBe(true);
  });

  it('rejects a regular customer from every admin path', () => {
    const ctx = bareCustomer({ platformRole: 'none', hasOrganization: true, subscriptionStatus: 'active' });
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
    expect(isPathAllowed(ctx, ROUTES.adminPayments)).toBe(false);
  });

  it('holds a billing_admin to payment review only', () => {
    const ctx = bareCustomer({ platformRole: 'billing-admin' });
    expect(isPathAllowed(ctx, ROUTES.adminPayments)).toBe(true);
    // The full console requires cross-tenant administration.
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
  });

  it('requires the strongest capability for an unclassified admin path', () => {
    expect(requiredAdminCapability('/admin/something-new')).toBe('manage-any-organization');
    expect(isPathAllowed(bareCustomer({ platformRole: 'billing-admin' }), '/admin/something-new')).toBe(false);
  });

  it('never admits a demo visitor', () => {
    const ctx = bareCustomer({ platformRole: 'super-admin', demoActive: true });
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
  });
});

describe('forced password change', () => {
  it('sends a bootstrap administrator to change the temporary password first', () => {
    const ctx = bareCustomer({ platformRole: 'super-admin', mustChangePassword: true });
    expect(resolvePostLoginRoute(ctx)).toBe(ROUTES.changePassword);
  });

  it('withholds the console until the temporary password is exchanged', () => {
    const ctx = bareCustomer({ platformRole: 'super-admin', mustChangePassword: true });
    expect(isPathAllowed(ctx, ROUTES.changePassword)).toBe(true);
    // Everything else stays shut, so the operator cannot route around it.
    expect(isPathAllowed(ctx, ROUTES.appDashboard)).toBe(false);
    expect(isPathAllowed(ctx, ROUTES.profile)).toBe(false);
  });

  it('opens the console once the server stops demanding a change', () => {
    const ctx = bareCustomer({ platformRole: 'super-admin', mustChangePassword: false });
    expect(resolvePostLoginRoute(ctx)).toBe(ROUTES.adminConsole);
  });

  it('applies to customers too', () => {
    expect(resolvePostLoginRoute(bareCustomer({ platformRole: 'none', mustChangePassword: true }))).toBe(
      ROUTES.changePassword,
    );
  });
});

describe('trust boundary', () => {
  it('grants no platform role from modified browser storage in production', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    // A tenant edits localStorage and reloads.
    useSessionStore.setState({ platformRole: 'super-admin' });
    localStorage.setItem('ledgora-session', JSON.stringify({ state: { platformRole: 'super-admin' } }));

    const ctx = readAccessContext();
    expect(ctx.platformRole).toBe('none');
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
    expect(resolvePostLoginRoute({ ...ctx, user: { emailVerified: true } })).not.toBe(ROUTES.adminConsole);
  });

  it('grants no administrator access when the backend is unreachable', async () => {
    vi.stubEnv('VITE_API_URL', API);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await useBackendSessionStore.getState().refresh();

    expect(useBackendSessionStore.getState().status).toBe('unavailable');
    expect(useBackendSessionStore.getState().platformRoles).toEqual([]);
    const ctx = readAccessContext();
    expect(ctx.platformRole).toBe('none');
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
  });

  it('reads the role from the verified session, not from the local user record', async () => {
    vi.stubEnv('VITE_API_URL', API);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: backendUser() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await useBackendSessionStore.getState().refresh();

    // The local record claims nothing special; the server is what counts.
    expect(readAccessContext().platformRole).toBe('super-admin');
    expect(isPathAllowed(readAccessContext(), ROUTES.adminConsole)).toBe(true);
  });
});

describe('session resolution timing', () => {
  it('reports resolving while a configured backend has not answered', () => {
    vi.stubEnv('VITE_API_URL', API);
    useBackendSessionStore.setState({ status: 'unknown' });
    expect(isSessionResolving()).toBe(true);
    useBackendSessionStore.setState({ status: 'loading' });
    expect(isSessionResolving()).toBe(true);
  });

  it('never blocks the static build, which has no backend to wait for', () => {
    vi.stubEnv('VITE_API_URL', '');
    useBackendSessionStore.setState({ status: 'unknown' });
    expect(isSessionResolving()).toBe(false);
  });

  it('does not treat an unresolved session as "no role" (the refresh bounce)', async () => {
    vi.stubEnv('VITE_API_URL', API);
    useBackendSessionStore.setState({ status: 'loading' });

    // This is the /admin/console refresh case: mid-flight, the operator looks
    // exactly like a customer with no subscription. The shell must wait rather
    // than resolve a route now.
    expect(isSessionResolving()).toBe(true);
    expect(readAccessContext().platformRole).toBe('none');

    // Once the server answers, administration is available.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: backendUser() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await useBackendSessionStore.getState().refresh();

    expect(isSessionResolving()).toBe(false);
    expect(isPathAllowed(readAccessContext(), ROUTES.adminConsole)).toBe(true);
  });
});

describe('sign out', () => {
  it('drops the verified role and returns to the public surface', async () => {
    vi.stubEnv('VITE_API_URL', API);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: backendUser() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await useBackendSessionStore.getState().refresh();
    expect(readAccessContext().platformRole).toBe('super-admin');

    useBackendSessionStore.getState().clear();
    useAuthStore.setState({ currentUserId: null });

    const ctx = readAccessContext();
    expect(ctx.platformRole).toBe('none');
    expect(ctx.user).toBeNull();
    expect(resolvePostLoginRoute(ctx)).toBe(ROUTES.welcome);
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
  });
});
