/**
 * One canonical package catalogue, for both the Super Admin editor and the
 * subscriber's package cards.
 *
 * ══ The defect this closes ═══════════════════════════════════════════════════
 *
 * Ledgora had THREE package sources at once:
 *
 *   1. `subscription_plans` on the server, with a complete admin API
 *      (`GET/POST/PATCH /api/admin/plans`, archive, restore) already gated on
 *      the `manage-plans` capability — and called by nothing in the browser.
 *   2. The browser-local `billingStore.plans`, persisted to localStorage, which
 *      the Super Admin editor wrote to and the subscriber's package cards read.
 *   3. `EDITION_INFO`, static edition metadata, which the Subscription page used
 *      for the package's headline name and description.
 *
 * So an administrator's edit reached localStorage and stopped there: it never
 * became platform data, never crossed a browser, and never reached the
 * onboarding catalogue — which reads the SERVER through `/api/plans/public`.
 *
 * ══ What this module does ════════════════════════════════════════════════════
 *
 * Makes the server canonical and keeps the existing components working:
 *
 *   read   `GET /api/admin/plans` → mapped → `billingStore.plans`
 *   write  editor → server → re-read → `billingStore.plans`
 *
 * Both screens keep rendering from `billingStore.plans`, so they cannot show
 * different values — but that array is now a PROJECTION of the server record
 * rather than an independently edited copy. An edit made in one browser is on
 * the server, so every other session sees it on its next read.
 *
 * ══ The offline build ════════════════════════════════════════════════════════
 *
 * With no account service configured (the static demo), there is no server to be
 * canonical and the local seed remains the catalogue. `planCatalogSource()`
 * reports which of the two is in force, so the console can say so plainly rather
 * than implying an edit is platform-wide when it is not.
 *
 * ══ What is NOT touched ══════════════════════════════════════════════════════
 *
 * Only `plans`. Invoices, payment proofs, the audit trail, billing settings and
 * `activePlanId` are left exactly as they are — a catalogue refresh must never
 * disturb a subscriber's billing history.
 */
import { useCallback, useEffect, useState } from 'react';
import { isApiConfigured } from '@/services/api/client';
import {
  planCatalogApi,
  publicToSubscriptionPlan,
  toPlanWriteInput,
  toSubscriptionPlan,
  type PlanWriteInput,
} from '@/services/api/planCatalogApi';
import type { SubscriptionPlan } from '@/types/billing';
import { useBillingStore } from './billingStore';

export type PlanCatalogSource = 'server' | 'local';

/** Which catalogue is authoritative right now. */
export function planCatalogSource(): PlanCatalogSource {
  return isApiConfigured() ? 'server' : 'local';
}

export interface PlanCatalogSyncState {
  source: PlanCatalogSource;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Re-read the canonical catalogue. */
  reload: () => Promise<void>;
}

/**
 * Replace the rendered catalogue with the server's, leaving everything else in
 * the billing store untouched.
 *
 * `seeded` is set so `ensureSeeded` — which reseeds only when there are no plans
 * — cannot later overwrite server data with the local seed. That is the
 * "seeds are initial values only" rule, enforced rather than assumed.
 */
function adoptServerPlans(plans: SubscriptionPlan[]): void {
  useBillingStore.setState({ plans, seeded: true });
}

/**
 * Load the canonical catalogue into the store.
 *
 * Imperative so non-React callers (a save path, a test) can await it.
 */
export async function loadCanonicalPlans(signal?: AbortSignal): Promise<void> {
  if (!isApiConfigured()) return;
  const { plans } = await planCatalogApi.listAll(signal);
  adoptServerPlans(plans.map(toSubscriptionPlan));
}

/**
 * Keep the rendered catalogue in step with the server for as long as the
 * component is mounted.
 *
 * A failure leaves whatever is already in the store on screen rather than
 * blanking the catalogue, and reports the error — an operator who cannot reach
 * the platform service needs to know that, not to see an empty list that looks
 * like "no packages exist".
 */
export function usePlanCatalogSync(): PlanCatalogSyncState {
  const source = planCatalogSource();
  const [status, setStatus] = useState<PlanCatalogSyncState['status']>(
    source === 'server' ? 'loading' : 'ready',
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!isApiConfigured()) {
      setStatus('ready');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      await loadCanonicalPlans(signal);
      setStatus('ready');
    } catch (cause) {
      setStatus('error');
      setError(cause instanceof Error ? cause.message : 'Could not read the package catalogue.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  return { source, status, error, reload: () => reload() };
}

/* ── The SUBSCRIBER catalogue ─────────────────────────────────────────────── */

/**
 * The packages a subscriber may choose from, read from the PUBLIC endpoint.
 *
 * ══ Why this is not `usePlanCatalogSync` ═════════════════════════════════════
 *
 * That hook reads `/api/admin/plans`, which demands the `view-admin` platform
 * capability. No subscriber holds one — so for every customer in the product the
 * request returned 403, the failure was caught, and the stale browser-local
 * plans stayed on screen. The catalogue therefore kept showing the seeded names
 * ("Ledgora Core", …) however many times an administrator renamed the package.
 *
 * `/api/plans/public` is unauthenticated and already filters to published,
 * active packages ordered by `sort_order`, which is exactly the subscriber's
 * question.
 *
 * ══ No silent fallback ═══════════════════════════════════════════════════════
 *
 * A failed load CLEARS the catalogue rather than leaving whatever the browser
 * had. Showing stale package names is how the defect looked in the first place,
 * and a wrong price on a purchase screen is worse than an honest error: the
 * customer would be choosing against figures the platform no longer offers.
 */
export function useSubscriberPlanCatalog(): PlanCatalogSyncState {
  const source = planCatalogSource();
  const [status, setStatus] = useState<PlanCatalogSyncState['status']>(
    source === 'server' ? 'loading' : 'ready',
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!isApiConfigured()) {
      setStatus('ready');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const { plans } = await planCatalogApi.listPublic(signal);
      adoptServerPlans(plans.map(publicToSubscriptionPlan));
      setStatus('ready');
    } catch (cause) {
      if (signal?.aborted) return;
      /*
       * Clear, do not keep. The rendered catalogue must never be a mixture of
       * "what the server says" and "what this browser remembered".
       */
      adoptServerPlans([]);
      setStatus('error');
      setError(cause instanceof Error ? cause.message : 'Could not read the package catalogue.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  return { source, status, error, reload: () => reload() };
}

/* ── Administration: write to the server, then re-read it ─────────────────── */

export interface PlanMutationResult {
  ok: boolean;
  error?: string;
}

async function throughServer(run: () => Promise<unknown>): Promise<PlanMutationResult> {
  try {
    await run();
    // Re-read rather than patching the local copy: the server may normalise
    // values, and the catalogue on screen must be what was actually stored.
    await loadCanonicalPlans();
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'The change was not saved.' };
  }
}

/**
 * Save an edit to the canonical record.
 *
 * When there is no account service the local store remains the catalogue and the
 * existing browser-local action is used — the static demo has nowhere else to
 * put it. `planCatalogSource()` is what tells the operator which happened.
 */
export async function savePlanEdit(
  id: string,
  patch: Partial<SubscriptionPlan>,
): Promise<PlanMutationResult> {
  if (!isApiConfigured()) return useBillingStore.getState().updatePlan(id, patch);
  return throughServer(() => planCatalogApi.update(id, toPlanWriteInput(patch)));
}

export async function createPlanRecord(
  input: Omit<SubscriptionPlan, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<PlanMutationResult> {
  if (!isApiConfigured()) return useBillingStore.getState().createPlan(input);
  return throughServer(() =>
    planCatalogApi.create(toPlanWriteInput(input) as PlanWriteInput),
  );
}

export async function archivePlanRecord(id: string): Promise<PlanMutationResult> {
  if (!isApiConfigured()) return useBillingStore.getState().archivePlan(id);
  return throughServer(() => planCatalogApi.archive(id));
}

export async function restorePlanRecord(id: string): Promise<PlanMutationResult> {
  if (!isApiConfigured()) return useBillingStore.getState().restorePlan(id);
  return throughServer(() => planCatalogApi.restore(id));
}
