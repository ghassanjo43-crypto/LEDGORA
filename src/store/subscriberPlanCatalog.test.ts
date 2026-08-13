// @vitest-environment happy-dom
/**
 * The subscriber catalogue reads the PUBLIC server endpoint, and never falls
 * back to browser-local packages.
 *
 * ══ The defect ═══════════════════════════════════════════════════════════════
 *
 * The subscriber's package cards were wired to the ADMIN sync, which reads
 * `/api/admin/plans`. That endpoint demands the `view-admin` platform
 * capability, which no subscriber holds — so for every customer in the product
 * the request returned 403, the failure was caught, and the seeded browser-local
 * names stayed on screen. An administrator could rename a package as often as
 * they liked and the catalogue would still read "Ledgora Core".
 *
 * The two properties below are what stop that recurring: the subscriber reads
 * the capability-free public endpoint, and a failed read shows a failure rather
 * than stale data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBillingStore } from '@/store/billingStore';
import { useSubscriberPlanCatalog, loadCanonicalPlans } from '@/store/planCatalogSync';
import { publicToSubscriptionPlan, type PublicServerPlan } from '@/services/api/planCatalogApi';

/** A package as the platform currently defines it — renamed away from the seed. */
const RENAMED: PublicServerPlan = {
  id: 'srv_core', code: 'core', name: 'Ledgora Essential',
  description: 'The administrator’s copy.', edition: 'core', currency: 'JOD',
  monthlyPrice: 35, annualPrice: null, userLimit: 5, entityLimit: 2, modules: ['accounting'],
};

/** Point the app at a backend and answer `path` with `respond`. */
function withApi(respond: (path: string) => Promise<Response> | Response): void {
  vi.stubEnv('VITE_API_URL', 'http://localhost:4000');
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(respond(url));
  }));
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  useBillingStore.getState().resetToDefault();
  useBillingStore.getState().ensureSeeded();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ══ The endpoint it must use ══════════════════════════════════════════════ */

describe('which endpoint the subscriber reads', () => {
  it('asks the PUBLIC catalogue, never the administration one', async () => {
    const asked: string[] = [];
    withApi((url) => {
      asked.push(url);
      return json({ plans: [RENAMED] });
    });

    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(asked.some((u) => u.includes('/api/plans/public'))).toBe(true);
    // The admin endpoint would 403 for a subscriber — asking it at all was the bug.
    expect(asked.some((u) => u.includes('/api/admin/plans'))).toBe(false);
  });

  it('renders the server name, not the seeded one', async () => {
    withApi(() => json({ plans: [RENAMED] }));

    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const plans = useBillingStore.getState().plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]!.name).toBe('Ledgora Essential');
    expect(plans[0]!.name).not.toBe('Ledgora Core');
  });

  it('carries every commercial field through from the server', async () => {
    withApi(() => json({ plans: [RENAMED] }));
    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const plan = useBillingStore.getState().plans[0]!;
    expect(plan.priceMonthly).toBe(35);
    expect(plan.currency).toBe('JOD');
    expect(plan.userLimit).toBe(5);
    expect(plan.entityLimit).toBe(2);
    expect(plan.description).toBe('The administrator’s copy.');
    // Identity is preserved so invoices and subscriptions keep resolving.
    expect(plan.id).toBe('srv_core');
    expect(plan.code).toBe('core');
  });
});

/* ══ No silent fallback ════════════════════════════════════════════════════ */

describe('when the catalogue cannot be read', () => {
  it('reports an error and shows NO packages, rather than stale local ones', async () => {
    /*
     * The heart of the defect. Previously a 403 was swallowed and the browser's
     * seeded packages stayed on screen — a customer would have been choosing
     * against prices the platform no longer offers.
     */
    const seededNames = useBillingStore.getState().plans.map((p) => p.name);
    expect(seededNames).toContain('Ledgora Core');

    withApi(() => json({ error: { code: 'forbidden', message: 'no' } }, 403));

    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.error).toBeTruthy();
    // Cleared, not kept.
    expect(useBillingStore.getState().plans).toEqual([]);
  });

  it('does the same for a network failure', async () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:4000');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(useBillingStore.getState().plans).toEqual([]);
  });

  it('recovers when the platform answers again', async () => {
    let fail = true;
    withApi(() => (fail ? json({}, 500) : json({ plans: [RENAMED] })));

    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('error'));

    fail = false;
    await result.current.reload();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(useBillingStore.getState().plans[0]!.name).toBe('Ledgora Essential');
  });
});

/* ══ Persisted browser data cannot win ═════════════════════════════════════ */

describe('legacy browser data', () => {
  it('is replaced wholesale by the server response', async () => {
    // A browser holding the old catalogue, as an upgrading user would have.
    useBillingStore.setState({
      plans: [{ ...publicToSubscriptionPlan(RENAMED, 0), id: 'stale', name: 'Ledgora Core', priceMonthly: 29 }],
    });

    withApi(() => json({ plans: [RENAMED] }));
    const { result } = renderHook(() => useSubscriberPlanCatalog());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const plans = useBillingStore.getState().plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]!.name).toBe('Ledgora Essential');
    expect(plans.some((p) => p.id === 'stale')).toBe(false);
  });

  it('is no longer written to localStorage at all', () => {
    /*
     * `plans` was removed from the persisted slice, so a browser cannot become
     * an authority on Ledgora's commercial packages again. Everything else in
     * the billing store is still persisted.
     */
    useBillingStore.setState({ plans: [publicToSubscriptionPlan(RENAMED, 0)] });
    const raw = window.localStorage.getItem('ledgora-billing');
    if (raw) {
      const stored = JSON.parse(raw) as { state?: Record<string, unknown> };
      expect(stored.state).not.toHaveProperty('plans');
      // …and the tenant's own billing workflow data is still there.
      expect(stored.state).toHaveProperty('invoices');
      expect(stored.state).toHaveProperty('auditTrail');
    }
  });
});

/* ══ The admin loader is unchanged and still sees everything ═══════════════ */

describe('the administration loader', () => {
  it('reads the admin endpoint, which returns unpublished packages too', async () => {
    const asked: string[] = [];
    withApi((url) => {
      asked.push(url);
      return json({
        plans: [
          { ...RENAMED, isPublic: false, isActive: true, sortOrder: 0 },
          { ...RENAMED, id: 'srv_2', code: 'projects', name: 'Ledgora Projects', isPublic: true, isActive: true, sortOrder: 1 },
        ],
      });
    });

    await loadCanonicalPlans();

    expect(asked.some((u) => u.includes('/api/admin/plans'))).toBe(true);
    const plans = useBillingStore.getState().plans;
    expect(plans).toHaveLength(2);
    // Administration sees the unpublished one — that is how it gets published.
    expect(plans.find((p) => p.id === 'srv_core')!.isPublic).toBe(false);
  });
});
