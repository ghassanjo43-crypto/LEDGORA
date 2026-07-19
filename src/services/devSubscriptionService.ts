/**
 * DEVELOPMENT subscription adapter.
 *
 * It does NOT duplicate the package system: `listPublicPlans` and `selectPlan`
 * delegate to the existing billing store, so package definitions, invoice
 * issuing, bank-remittance payment and administrator verification stay exactly
 * as they are. A package is never silently marked active — activation remains
 * the existing verification workflow's decision.
 *
 * ── BACKEND SEAM ──────────────────────────────────────────────────────────────
 *   listPublicPlans() → GET  /api/plans
 *   selectPlan()      → POST /api/subscriptions { planId }  (returns the invoice)
 *   startFreeDemo()   → no server call: the demo never leaves the browser.
 */
import type { PublicSubscriptionPlan, SubscriptionService } from './types';
import { useBillingStore, publicPlans } from '@/store/billingStore';
import { FREE_DEMO_COPY, FREE_DEMO_PLAN_ID } from '@/config/freeDemo';
import { startFreeDemoWorkspace } from '@/lib/freeDemoSession';

export const devSubscriptionService: SubscriptionService = {
  async listPublicPlans(): Promise<PublicSubscriptionPlan[]> {
    // BACKEND SEAM: GET /api/plans
    useBillingStore.getState().ensureSeeded();
    const plans = publicPlans(useBillingStore.getState().plans).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      priceMonthly: p.priceMonthly,
      currency: p.currency,
    }));
    return [
      ...plans,
      {
        id: FREE_DEMO_PLAN_ID,
        name: FREE_DEMO_COPY.title,
        description: FREE_DEMO_COPY.description,
        priceMonthly: 0,
        currency: 'USD',
        isFreeDemo: true,
      },
    ];
  },

  async selectPlan(planId) {
    if (planId === FREE_DEMO_PLAN_ID) {
      await this.startFreeDemo();
      return { ok: true };
    }
    // BACKEND SEAM: POST /api/subscriptions — here, the existing billing store
    // raises the subscription invoice and the existing payment/verification
    // workflow takes over.
    const result = useBillingStore.getState().requestSubscription(planId);
    return { ok: result.ok, error: result.error, invoiceId: result.id };
  },

  async startFreeDemo() {
    // No payment, no account requirement, no server call — a memory-only
    // workspace that disappears with the session.
    startFreeDemoWorkspace();
  },
};
