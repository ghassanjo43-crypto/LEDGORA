// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorSubscriptionFromBackend } from '@/services/sessionMirror';
import { useBillingStore } from '@/store/billingStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { resolveAccountStatus } from '@/lib/sessionModel';

const response = (subscription: Record<string, unknown> | null) =>
  new Response(JSON.stringify({ subscription, invoice: null, bank: null }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

const core = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1', organizationId: 'org-1', status: 'active', billingCycle: 'monthly',
  planId: 'plan-core', planCode: 'core', planName: 'Core', planDescription: 'Core package',
  edition: 'core', currency: 'USD', monthlyPrice: 29, annualPrice: 290,
  userLimit: 3, entityLimit: 1, modules: ['core_accounting', 'sales'],
  paymentStatus: 'paid',
  paymentReference: null, startsAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('server-authoritative subscription bootstrap', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    useBillingStore.getState().resetToDefault();
    useBillingStore.setState({ subscriptionHydration: 'idle', activePlanId: undefined });
    useEntitlementStore.getState().resetToDefault();
    useOrganizationStore.setState({ subscription: null });
    useAccountSessionStore.setState({ demoActive: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('hydrates the assigned canonical package and outranks stale demo state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(core()));
    await mirrorSubscriptionFromBackend();
    const billing = useBillingStore.getState();
    expect(billing.subscriptionHydration).toBe('active');
    expect(billing.activePlanId).toBe('plan-core');
    expect(billing.serverPaymentStatus).toBe('paid');
    expect(billing.plans.find((p) => p.id === 'plan-core')).toMatchObject({ name: 'Core', userLimit: 3, addOnModules: ['core_accounting', 'sales'] });
    expect(useEntitlementStore.getState().subscription).toMatchObject({ edition: 'core', status: 'active', userLimit: 3 });
    expect(useAccountSessionStore.getState().demoActive).toBe(false);
    expect(resolveAccountStatus({ user: {} as never, organizationId: 'org-1', onboardingStatus: 'active', entitlementStatus: 'active', subscriptionPlanId: 'plan-core', demoActive: false })).toBe('subscribed');
  });

  it('keeps an organization without an active subscription gated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(null));
    await mirrorSubscriptionFromBackend();
    expect(useBillingStore.getState().subscriptionHydration).toBe('inactive');
    expect(useBillingStore.getState().activePlanId).toBeUndefined();
    expect(resolveAccountStatus({ user: {} as never, organizationId: 'org-1', onboardingStatus: null, entitlementStatus: 'expired', subscriptionPlanId: null, demoActive: false })).toBe('registered-no-plan');
  });

  it('hydrates a different assigned package and treats inactive as gated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(core({ planId: 'plan-projects', planCode: 'projects', planName: 'Projects', edition: 'projects' })))
      .mockResolvedValueOnce(response(core({ status: 'expired' })));
    await mirrorSubscriptionFromBackend();
    expect(useBillingStore.getState().plans.find((p) => p.id === 'plan-projects')?.name).toBe('Projects');
    await mirrorSubscriptionFromBackend();
    expect(useBillingStore.getState().subscriptionHydration).toBe('inactive');
    expect(useBillingStore.getState().activePlanId).toBeUndefined();
  });
});
