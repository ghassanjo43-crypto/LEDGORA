/**
 * Live readers for Free Preview.
 *
 * These are deliberately THIN. The policy lives in `lib/freePreview` and is
 * applied in exactly two places:
 *
 *   · `lib/sessionModel.resolveAccountStatus` → the `'free-preview'` account
 *     status, which is what this module reports;
 *   · `lib/accessControl.freePreviewAllowed`  → the routing adapter, which is
 *     pure and so takes its inputs from an `AccessContext` instead of the stores.
 *
 * This module re-derives NOTHING. An earlier draft assembled the policy's inputs
 * itself and read the organization from a different signal than the account
 * status does, which is precisely how the previous "Create your organization
 * first." contradiction was built. One question, one answer: entitlements, the
 * banner, the notices and the status page all read the account status below.
 *
 * Preview grants a BROADER module set than the package bought, and never writes
 * to the subscription: `entitlementStore` keeps holding the package awaiting
 * activation, so approving the payment applies the real entitlements with
 * nothing to unwind.
 */
import { useAccountStatus } from '@/hooks/useSession';
import { readSessionState } from './sessionSnapshot';

/** Imperative read, for guards, services and store actions. */
export function isFreePreviewActive(): boolean {
  return readSessionState().accountStatus === 'free-preview';
}

/** Reactive read, for components. */
export function useIsFreePreview(): boolean {
  return useAccountStatus() === 'free-preview';
}
