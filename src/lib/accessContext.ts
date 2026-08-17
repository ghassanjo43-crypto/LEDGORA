/**
 * The single place the live `AccessContext` is assembled from the stores.
 *
 * Login, the forced password-change page and the shell's access gate must all
 * reach the same verdict about where a user belongs. When each built its own
 * context they drifted — the login page ignored the platform role entirely and
 * sent verified operators into the customer subscription funnel.
 *
 * ── Trust boundary ────────────────────────────────────────────────────────────
 * The platform role comes from `effectivePlatformRole`, which prefers the role
 * the BACKEND confirmed and falls back to a local simulation only on an approved
 * development machine. Nothing here reads a role from `authStore`, localStorage,
 * sessionStorage or a query parameter — a tenant controls all of those.
 */
import { type AccessContext, isPlatformOperator } from './accessControl';
import { effectivePlatformRole } from './platformAccess';
import { hasCurrentOrganization, organizationAvailability } from './currentOrganization';
import { getCurrentUser } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { isApiConfigured } from '@/services/api/client';

export function readAccessContext(): AccessContext {
  const user = getCurrentUser();
  const org = useOrganizationStore.getState();
  const backend = useBackendSessionStore.getState();

  const platformRole = effectivePlatformRole(useSessionStore.getState().platformRole, backend.platformRoles);

  return {
    user: user ? { emailVerified: user.emailVerified } : null,
    // The same backend-confirmed answer the stepper, the subscription page and
    // its confirm button use. Reading `org.organization` here independently is
    // what let the guard and the page disagree.
    hasOrganization: hasCurrentOrganization(),
    subscriptionStatus: org.subscription?.status ?? null,
    demoActive: useAccountSessionStore.getState().demoActive,
    platformRole,
    // Only the server may assert this.
    mustChangePassword: backend.user?.mustChangePassword ?? false,
    // Honoured ONLY for a genuine effective operator: a tenant setting the flag
    // in storage still resolves to `platformRole: 'none'`, so this stays false.
    operatorViewing: isPlatformOperator(platformRole) && useOperatorViewStore.getState().active,
  };
}

/**
 * True while a configured backend has not yet answered "who is this?".
 *
 * Callers must render nothing and redirect nowhere until this is false: an
 * administrator whose role has not arrived yet still looks exactly like a
 * customer with no subscription, and would be bounced into onboarding.
 */
export function isSessionResolving(): boolean {
  // With no backend configured there is nothing to wait for, and blocking would
  // stall the static demo build's first paint forever.
  if (!isApiConfigured()) return false;
  const status = useBackendSessionStore.getState().status;
  if (status === 'unknown' || status === 'loading') return true;

  // The organization lookup is part of "who is this?" for routing purposes: a
  // signed-in customer whose organization has not arrived yet is indistinguish-
  // able from one who has none, and would be bounced back to the organization
  // step they just completed. Only wait while a session actually exists.
  if (!useBackendSessionStore.getState().user) return false;
  // A verified platform operator has no tenant organization of their own. Its
  // organization hydration state belongs only to an explicitly viewed tenant
  // and must not hold the platform session in a resolving state.
  if (useBackendSessionStore.getState().platformRoles.length > 0) return false;
  return organizationAvailability() === 'loading';
}

/**
 * The backend positively confirmed there is NO session (`authenticated:false`),
 * as opposed to a visitor who simply never signed in. This is the "your session
 * ended / the cookie did not travel" case: the mirror has been cleared and the
 * user belongs on /login, not the public welcome page.
 */
export function isSessionVerifiedUnauthenticated(): boolean {
  if (!isApiConfigured()) return false;
  const { status, user } = useBackendSessionStore.getState();
  return status === 'ready' && user === null;
}
