/**
 * Free Preview — the ONE policy deciding whether a paying-but-not-yet-activated
 * customer may use Ledgora.
 *
 * ── The defect this exists to fix ────────────────────────────────────────────
 * A subscriber who had chosen a package, been invoiced and uploaded their
 * payment proof was routed to `/subscription/status` and held there. Three
 * separate rules cooperated to build the cage:
 *
 *   1. `resolvePostLoginRoute` sent `pending_verification` to the status page;
 *   2. `INACTIVE_ALLOWED_SURFACES` omitted `'app'`, so `isPathAllowed` refused
 *      `/app/*` to anyone whose subscription was not `active`;
 *   3. the shell reacted to that refusal by redirecting back to (1).
 *
 * The page offered only "Sign out" and "Contact support". A customer who had
 * paid could do nothing but leave.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * Choosing a package earns immediate, full-feature access. Payment verification
 * is LEDGORA's work, not a reason to lock the customer out of their books.
 * Preview access is deliberately BROADER than the package bought (every module,
 * for demonstration) and deliberately TEMPORARY: nothing entered survives the
 * session, because the subscription that would justify keeping it is unpaid.
 *
 * Two properties therefore always travel together and must never be separated:
 *
 *   full feature access   +   canPersistData: false
 *
 * ── Eligibility ──────────────────────────────────────────────────────────────
 * Fail-closed. Preview requires an authenticated customer, a backend-confirmed
 * organization and a selected package. It is never granted to an anonymous
 * visitor, a customer who has not chosen a package, a disabled/archived account,
 * or a platform operator (operators reach tenant workspaces through the
 * existing operator-view system, which has its own audited override).
 */
import type { OnboardingSubscriptionStatus } from '@/types/onboarding';

/**
 * The subscription statuses that grant Free Preview.
 *
 * These are the frontend lifecycle's spelling of the three funnel stages in the
 * business rule:
 *
 *   package_selected     ─┐
 *   awaiting_payment     ─┴→ `pending_payment`      (invoice issued, unpaid)
 *   pending_verification  →  `pending_verification` (proof uploaded, in review)
 *
 * `draft` is deliberately absent. A draft is an *unconfirmed* selection with no
 * invoice behind it — the customer is still mid-choice, so package selection is
 * where they belong (and `confirmSubscription` moves them on immediately). See
 * `store/organizationStore` for the transition.
 *
 * `rejected` is absent too: that customer has an actionable payment page to
 * return to and is not trapped. `expired` and `suspended` keep their existing
 * lifecycle restrictions — a preview is for a subscription being activated, not
 * one that has lapsed or been withdrawn.
 */
export const FREE_PREVIEW_STATUSES: readonly OnboardingSubscriptionStatus[] = [
  'pending_payment',
  'pending_verification',
];

export function isFreePreviewStatus(status: OnboardingSubscriptionStatus | null): boolean {
  return status !== null && FREE_PREVIEW_STATUSES.includes(status);
}

export interface FreePreviewInput {
  /** An authenticated customer exists. */
  authenticated: boolean;
  /** A backend-confirmed organization exists (see `lib/currentOrganization`). */
  hasOrganization: boolean;
  /** The organization's subscription lifecycle status. */
  subscriptionStatus: OnboardingSubscriptionStatus | null;
  /**
   * The caller holds a LEDGORA platform role. Operators are excluded: they have
   * no package to await and reach tenant data through operator view instead.
   */
  isPlatformOperator?: boolean;
  /** A Free Demo owns the application surface on its own terms. */
  demoActive?: boolean;
  /** The account is disabled, archived or otherwise administratively closed. */
  accountClosed?: boolean;
}

/**
 * The single predicate. Every consumer — the redirect resolver, the route
 * policy, the shell's render guard, the account status, the entitlement widening
 * and the banner — resolves preview access through this one function, so no two
 * of them can disagree the way the routing rules above did.
 */
export function isFreePreviewEligible(input: FreePreviewInput): boolean {
  if (!input.authenticated) return false;
  if (input.accountClosed) return false;
  // A demo is its own mode with its own (narrower) view allow-list; a platform
  // operator is not a subscriber. Neither becomes a preview customer.
  if (input.demoActive) return false;
  if (input.isPlatformOperator) return false;
  if (!input.hasOrganization) return false;
  return isFreePreviewStatus(input.subscriptionStatus);
}

/* ── Copy ─────────────────────────────────────────────────────────────────── */

export const FREE_PREVIEW_COPY = {
  banner:
    'Free Preview Mode — You can explore every Ledgora feature while your subscription is being activated. ' +
    'Your accounting work is temporary and will not be saved.',
  /** Shown when the user performs a save that the preview cannot make durable. */
  saveNotice:
    'This action is available for exploration, but it will not be saved until your subscription is activated.',
  pendingVerification: 'Subscription pending verification',
  paymentStatus: 'View payment status',
  enterPreview: 'Enter Free Preview',
} as const;
