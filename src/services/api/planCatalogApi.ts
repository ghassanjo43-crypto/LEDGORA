/**
 * The platform package catalogue, over HTTP.
 *
 * ══ Why this file exists ═════════════════════════════════════════════════════
 *
 * Ledgora already had a complete server-side package catalogue —
 * `subscription_plans`, `GET /api/admin/plans`, `POST`/`PATCH`, archive and
 * restore, each gated on the `manage-plans` platform capability. The frontend
 * simply never called any of it: the Super Admin's "Packages & pricing" editor
 * and the subscriber's package cards both read and wrote a browser-local Zustand
 * store, so an administrator's edit reached localStorage and stopped there.
 *
 * This client is the missing half. It is deliberately thin — no shaping beyond
 * the row/record mapping — because the authority is the server, not this file.
 *
 * ══ The mapping, and why it is not a second definition ═══════════════════════
 *
 * The server speaks `monthlyPrice` / `modules`; the browser's `SubscriptionPlan`
 * speaks `priceMonthly` / `addOnModules`. Renaming a field is not a second
 * source of truth: every value below comes from the row the server returned, and
 * nothing is invented, defaulted from edition metadata, or merged with a seed.
 * The one exception is documented at `DESCRIPTION_FALLBACK`.
 */
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import type { SubscriptionPlan } from '@/types/billing';
import { api } from './client';

/** The canonical record as the server returns it. */
export interface ServerPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  edition: string;
  currency: string;
  monthlyPrice: number;
  annualPrice: number | null;
  userLimit: number;
  entityLimit: number;
  modules: string[];
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** The fields the server accepts on create/update. */
export interface PlanWriteInput {
  code: string;
  name: string;
  description?: string;
  edition: string;
  currency?: string;
  monthlyPrice: number;
  annualPrice?: number;
  userLimit: number;
  entityLimit: number;
  modules?: string[];
  isPublic?: boolean;
  sortOrder?: number;
}

/**
 * A plan with no stored description renders as an empty string, NOT as the
 * edition's marketing copy.
 *
 * That distinction is the whole point of this task: edition metadata describes
 * an entitlement tier, and using it to fill a commercial field would put a
 * second, invisible source of truth back into the catalogue. An administrator
 * who clears a description means it to be empty.
 */
const DESCRIPTION_FALLBACK = '';

/** Map a server row onto the browser's `SubscriptionPlan` shape. */
export function toSubscriptionPlan(row: ServerPlan): SubscriptionPlan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? DESCRIPTION_FALLBACK,
    edition: row.edition as LedgoraEdition,
    priceMonthly: row.monthlyPrice,
    currency: row.currency,
    userLimit: row.userLimit,
    entityLimit: row.entityLimit,
    /*
     * The server stores ONE entitlement list. The browser type splits add-ons
     * from removals because its local editor did; the server's list is the
     * effective set, so it maps to add-ons and removals stay empty. Nothing is
     * lost — `modules` is round-tripped verbatim on save.
     */
    addOnModules: (row.modules ?? []) as LedgoraModule[],
    removedModules: [],
    isActive: row.isActive,
    isPublic: row.isPublic,
    sortOrder: row.sortOrder,
    createdAt: '',
    updatedAt: '',
  } as SubscriptionPlan;
}

/** Map the browser's shape back to what the server accepts. */
export function toPlanWriteInput(plan: Partial<SubscriptionPlan>): Partial<PlanWriteInput> {
  const input: Partial<PlanWriteInput> = {};
  if (plan.code !== undefined) input.code = plan.code;
  if (plan.name !== undefined) input.name = plan.name;
  if (plan.description !== undefined) input.description = plan.description;
  if (plan.edition !== undefined) input.edition = plan.edition;
  if (plan.currency !== undefined) input.currency = plan.currency;
  if (plan.priceMonthly !== undefined) input.monthlyPrice = plan.priceMonthly;
  if (plan.userLimit !== undefined) input.userLimit = plan.userLimit;
  if (plan.entityLimit !== undefined) input.entityLimit = plan.entityLimit;
  if (plan.addOnModules !== undefined) input.modules = plan.addOnModules;
  if (plan.isPublic !== undefined) input.isPublic = plan.isPublic;
  if (plan.sortOrder !== undefined) input.sortOrder = plan.sortOrder;
  return input;
}

/**
 * The public catalogue row.
 *
 * Deliberately narrower than {@link ServerPlan}: `/api/plans/public` already
 * filters to published, active packages, so it does not report the flags it
 * filtered on. Anything this endpoint returns IS in the catalogue.
 */
export interface PublicServerPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  edition: string;
  currency: string;
  monthlyPrice: number;
  annualPrice: number | null;
  userLimit: number;
  entityLimit: number;
  modules: string[];
}

/** Map a public row, filling only the two flags the endpoint filtered on. */
export function publicToSubscriptionPlan(row: PublicServerPlan, index: number): SubscriptionPlan {
  return toSubscriptionPlan({
    ...row,
    // True by construction: the endpoint returns published, active plans only.
    isPublic: true,
    isActive: true,
    // The endpoint orders by sort_order; position preserves that ordering.
    sortOrder: index,
  });
}

export const planCatalogApi = {
  /**
   * The SUBSCRIBER catalogue.
   *
   * Unauthenticated and capability-free, which is the point: a subscriber holds
   * no platform capability, so reading the administration endpoint returns 403
   * for every customer in the product. That is exactly what happened — and the
   * 403 was being swallowed, leaving stale browser-local package names on
   * screen. See `useSubscriberPlanCatalog`.
   */
  listPublic(signal?: AbortSignal) {
    return api.get<{ plans: PublicServerPlan[] }>('/api/plans/public', signal);
  },

  /**
   * Every plan, including unpublished and archived ones.
   *
   * For the Super Admin editor: administration has to see what it manages, and
   * an unpublished package is exactly the thing an administrator needs to find
   * in order to publish it.
   */
  listAll(signal?: AbortSignal) {
    return api.get<{ plans: ServerPlan[] }>('/api/admin/plans', signal);
  },

  create(input: PlanWriteInput) {
    return api.post<{ id: string }>('/api/admin/plans', input);
  },

  update(id: string, patch: Partial<PlanWriteInput>) {
    return api.patch<{ ok: true }>(`/api/admin/plans/${encodeURIComponent(id)}`, patch);
  },

  archive(id: string) {
    return api.post<{ ok: true }>(`/api/admin/plans/${encodeURIComponent(id)}/archive`, {});
  },

  restore(id: string) {
    return api.post<{ ok: true }>(`/api/admin/plans/${encodeURIComponent(id)}/restore`, {});
  },
};
