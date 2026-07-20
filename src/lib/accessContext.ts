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
import type { AccessContext } from './accessControl';
import { effectivePlatformRole } from './platformAccess';
import { getCurrentUser } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { isApiConfigured } from '@/services/api/client';

export function readAccessContext(): AccessContext {
  const user = getCurrentUser();
  const org = useOrganizationStore.getState();
  const backend = useBackendSessionStore.getState();

  return {
    user: user ? { emailVerified: user.emailVerified } : null,
    hasOrganization: !!org.organization,
    subscriptionStatus: org.subscription?.status ?? null,
    demoActive: useAccountSessionStore.getState().demoActive,
    platformRole: effectivePlatformRole(useSessionStore.getState().platformRole, backend.platformRoles),
    // Only the server may assert this.
    mustChangePassword: backend.user?.mustChangePassword ?? false,
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
  return status === 'unknown' || status === 'loading';
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
