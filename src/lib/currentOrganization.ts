/**
 * The ONE answer to "does this user have an organization?".
 *
 * Before this module every consumer decided for itself. The onboarding stepper
 * inferred it from which page you were on, the subscription page read a local
 * store object, and the route guard read a third thing — so the console could
 * cheerfully show "Organization ✓" while the page beneath it refused to
 * continue because "Create your organization first."
 *
 * The answer here is derived from the BACKEND-CONFIRMED organization id, and it
 * has four states, not two. The distinction that matters most:
 *
 *   `loading` is not `absent`.
 *
 * "We have not asked the server yet" and "the server says there is none" are
 * different facts, and only the second one may ever block a user. Likewise a
 * failed request means we do not know — never that the organization is missing.
 *
 * With no backend configured (the static demo build) there is nothing to
 * confirm against, so the local store is the only truth available and is used
 * directly.
 */
import { useOrganizationStore, type OrganizationHydration } from '@/store/organizationStore';

export type OrganizationAvailability =
  /** Still asking the server. Show a spinner; block nothing, claim nothing. */
  | 'loading'
  /** The backend confirmed an organization. */
  | 'present'
  /** The backend confirmed there is NO organization. The only blocking state. */
  | 'absent'
  /** The lookup failed. We do not know — offer a retry, never an accusation. */
  | 'error';

/** Pure mapping, so both the hook and the imperative read cannot disagree. */
export function availabilityOf(hydration: OrganizationHydration): OrganizationAvailability {
  switch (hydration.status) {
    case 'idle':
    case 'loading':
      return 'loading';
    case 'error':
      return 'error';
    case 'ready':
      return hydration.confirmedOrganizationId ? 'present' : 'absent';
  }
}

/** Imperative read, for guards, services and event handlers. */
export function organizationAvailability(): OrganizationAvailability {
  return availabilityOf(useOrganizationStore.getState().hydration);
}

/**
 * The canonical predicate. True only when the backend has confirmed an
 * organization — never merely because a local object happens to exist.
 */
export function hasCurrentOrganization(): boolean {
  return organizationAvailability() === 'present';
}

/** The backend-confirmed organization id, or null. */
export function currentOrganizationId(): string | null {
  return useOrganizationStore.getState().hydration.confirmedOrganizationId;
}

/**
 * Resolve the organization id for an action that is about to call the API.
 *
 * If hydration has not settled — or settled on "none" without ever having
 * reached the server — this asks ONCE before giving up, so a page that mounted
 * mid-flight cannot reject a user who does in fact have an organization.
 */
export async function requireCurrentOrganizationId(): Promise<string | null> {
  const state = useOrganizationStore.getState();
  if (state.hydration.status === 'ready' && state.hydration.confirmedOrganizationId) {
    return state.hydration.confirmedOrganizationId;
  }
  const result = await state.hydrateFromBackend({ force: true });
  return result.organizationId;
}

/* ── Reactive hooks ───────────────────────────────────────────────────────── */

export function useOrganizationAvailability(): OrganizationAvailability {
  return useOrganizationStore((s) => availabilityOf(s.hydration));
}

export function useHasCurrentOrganization(): boolean {
  return useOrganizationAvailability() === 'present';
}

export function useCurrentOrganizationId(): string | null {
  return useOrganizationStore((s) => s.hydration.confirmedOrganizationId);
}

export function useOrganizationHydrationError(): string | null {
  return useOrganizationStore((s) => s.hydration.error);
}
