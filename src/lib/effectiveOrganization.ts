/**
 * The ONE answer to "which organization am I operating on?".
 *
 * ── The defect this exists to fix ────────────────────────────────────────────
 * A verified super_admin opened Acme Holdings Ltd. through the console. The
 * operator banner and the header read the VIEWED subscriber from
 * `operatorViewStore`, and said "Acme Holdings Ltd.". The Members page asked a
 * different question of a different store — `organizationStore.organization`,
 * i.e. the ADMINISTRATOR's own membership — got `null` (correctly: a platform
 * operator is deliberately tenantless, and `GET /api/organizations/current`
 * returns null for them), and concluded:
 *
 *   "Create your organization first to manage members."
 *
 * Both stores were right about their own question. The page was asking the wrong
 * one. An operator has no organization *of their own* and must never be told to
 * make one — so the question every consumer must ask is not "what is my
 * organization?" but "what organization is being operated on?".
 *
 * ── The three modes ──────────────────────────────────────────────────────────
 *   subscriber : the caller's backend-confirmed membership organization.
 *   operator   : the backend-confirmed VIEWED subscriber organization.
 *   none       : a platform operator outside subscriber view — there is no
 *                customer organization context, and the answer is the console,
 *                never onboarding.
 *
 * ── Trust boundary ───────────────────────────────────────────────────────────
 * Operator mode requires the same fail-closed override that widens entitlements
 * (`store/platformFullAccess` → `lib/platformEntitlementOverride`): a verified
 * super-admin role, explicit viewing mode, and a coherent organization context. A
 * tenant planting `ledgora-operator-view` in sessionStorage resolves to role
 * `'none'`, so they get `subscriber` mode and their own organization — exactly as
 * before. And the id this resolver hands out is never authorization on its own:
 * the backend re-authorizes every member call (see `routes/members.ts`).
 */
import type { PlatformEntitlementOverride } from './platformEntitlementOverride';
import type { OrganizationAvailability } from './currentOrganization';

export type EffectiveOrganizationMode = 'subscriber' | 'operator' | 'none';

/** How far resolution has got. `loading` is never "there is none" — see below. */
export type EffectiveOrganizationStatus = 'loading' | 'ready' | 'error';

export interface EffectiveOrganizationContext {
  mode: EffectiveOrganizationMode;
  status: EffectiveOrganizationStatus;
  /** The backend-confirmed organization being operated on, or null. */
  organizationId: string | null;
  organizationName: string | null;
  /**
   * True when the caller may mutate members in this context. In operator mode
   * this follows the override: `full_access` may manage, `subscriber_view` may
   * not (the operator is inspecting the customer experience, not editing it).
   */
  canMutate: boolean;
  error: string | null;
}

export interface EffectiveOrganizationInput {
  /** The resolved operator override — the trust decision, already made. */
  operatorOverride: PlatformEntitlementOverride;
  /** The caller holds a platform role at all (verified). */
  isPlatformOperator: boolean;
  /** Subscriber side: hydration of the caller's own organization. */
  subscriberAvailability: OrganizationAvailability;
  subscriberOrganizationId: string | null;
  subscriberOrganizationName: string | null;
  subscriberError: string | null;
  /** Operator side: backend confirmation of the VIEWED organization. */
  viewedStatus: EffectiveOrganizationStatus;
  viewedOrganizationId: string | null;
  viewedOrganizationName: string | null;
  viewedError: string | null;
  /**
   * The organization the operator SELECTED, straight from the viewing-mode record —
   * before any backend confirmation.
   *
   * Separate from `viewedOrganizationId`, which is the CONFIRMED id and is
   * therefore null while a lookup is pending or has failed. The distinction is
   * what lets this resolver say "operator mode, still loading" instead of falling
   * through to "no subscriber selected"; see the second branch below.
   */
  operatorSelectedOrganizationId?: string | null;
  /** The caller's role in their own organization, for subscriber-mode mutation. */
  subscriberCanManage: boolean;
}

/**
 * The single decision. Pure, so the page, the header, the stores and the guards
 * cannot reach different conclusions the way the banner and Members page did.
 */
export function resolveEffectiveOrganization(
  input: EffectiveOrganizationInput,
): EffectiveOrganizationContext {
  // ── Operator viewing a subscriber ───────────────────────────────────────
  if (input.operatorOverride !== 'none') {
    return {
      mode: 'operator',
      status: input.viewedStatus,
      organizationId: input.viewedStatus === 'ready' ? input.viewedOrganizationId : null,
      organizationName: input.viewedOrganizationName,
      // Exact-subscriber view is READ-ONLY for member management: the operator
      // asked to see what the customer sees, and the customer's own owner is who
      // may change it. Returning to administrator view re-enables mutation.
      canMutate: input.operatorOverride === 'full_access' && input.viewedStatus === 'ready',
      error: input.viewedError,
    };
  }

  /*
   * ── Operator viewing a subscriber whose lookup has not settled ───────────
   *
   * The override above requires the viewed organization to be CONFIRMED, which is
   * right for widening entitlements — access must never be granted over unknown
   * data. But "which organization am I operating on?" is a different question, and
   * answering it with `none` while the confirmation is in flight (or has failed)
   * sends the operator the "pick a subscriber" message when they have already
   * picked one.
   *
   * So: an operator who has selected a subscriber is in OPERATOR mode from that
   * moment, carrying the honest status of the lookup. No id is handed out and
   * nothing may be mutated until it is confirmed — the trust boundary is unchanged;
   * only the reported mode is now truthful.
   */
  if (
    input.isPlatformOperator &&
    input.operatorSelectedOrganizationId &&
    input.viewedStatus !== 'ready'
  ) {
    return {
      mode: 'operator',
      status: input.viewedStatus,
      organizationId: null,
      organizationName: input.viewedOrganizationName,
      canMutate: false,
      error: input.viewedError,
    };
  }

  // ── Operator NOT viewing anybody ────────────────────────────────────────
  // No customer organization context exists. Critically this is NOT "you have no
  // organization, go and create one" — it is "pick a subscriber, or go back to
  // the console".
  if (input.isPlatformOperator) {
    return {
      mode: 'none',
      status: 'ready',
      organizationId: null,
      organizationName: null,
      canMutate: false,
      error: null,
    };
  }

  // ── Ordinary subscriber ─────────────────────────────────────────────────
  const status: EffectiveOrganizationStatus =
    input.subscriberAvailability === 'loading'
      ? 'loading'
      : input.subscriberAvailability === 'error'
        ? 'error'
        : 'ready';
  return {
    mode: 'subscriber',
    status,
    organizationId: status === 'ready' ? input.subscriberOrganizationId : null,
    organizationName: input.subscriberOrganizationName,
    canMutate: status === 'ready' && !!input.subscriberOrganizationId && input.subscriberCanManage,
    error: input.subscriberError,
  };
}

/**
 * Does this context positively establish that no organization exists?
 *
 * Only true for a settled SUBSCRIBER with none — the single case where "create
 * your organization first" is honest. An operator (either mode) never reaches it,
 * and neither does a pending or failed lookup.
 */
export function isGenuinelyWithoutOrganization(ctx: EffectiveOrganizationContext): boolean {
  return ctx.mode === 'subscriber' && ctx.status === 'ready' && ctx.organizationId === null;
}
