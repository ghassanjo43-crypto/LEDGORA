/**
 * Reconcile the local read model with a SERVER-VERIFIED session.
 *
 * The pages, the redirect state machine and the persistence policy all read the
 * local `authStore` / `organizationStore`. Those stores are persisted, so on a
 * cold reload they describe whoever was last signed in — a claim the server has
 * not re-confirmed. This module is the single place that makes the local mirror
 * agree with `GET /api/auth/session`:
 *
 *   · `mirrorVerifiedUser` adopts a user the server just confirmed;
 *   · `clearLocalSession` erases the mirror the moment the server says
 *     `authenticated:false`, so a stale persisted user can never be trusted;
 *   · `mirrorOrganizationFromBackend` keeps the tenant's organization shell in
 *     step for routing.
 *
 * ── Trust boundary ────────────────────────────────────────────────────────────
 * The mirrored user carries an EMPTY `passwordHash`, so the browser-only
 * `authStore.login()` credential path can never authenticate against it. No
 * platform role is written here — that lives only in the verified backend
 * session (see `backendSessionStore`).
 */
import type { BackendUser } from './api/authApi';
import { subscriptionApi } from './api/authApi';
import { clearCsrfToken, setCompanyReference } from './api/client';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useBillingStore } from '@/store/billingStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { publicToSubscriptionPlan } from './api/planCatalogApi';
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import type { SubscriptionStatus } from '@/types/subscription';
import { clearWorkspaceForSignOut } from '@/lib/freeDemoSession';
import type { RegisteredUser } from '@/types/onboarding';

const asText = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/**
 * Mirror a server-verified user into the local read model and make it current.
 * Details the backend does not model (mobile, country) are preserved from any
 * existing local record so a returning user does not lose them.
 */
export function mirrorVerifiedUser(user: BackendUser, extra: { country?: string; mobile?: string } = {}): RegisteredUser {
  const existing = useAuthStore.getState().users.find((u) => u.id === user.id);
  const mirrored: RegisteredUser = {
    ...existing,
    id: user.id,
    fullName: user.fullName,
    email: user.email.toLowerCase(),
    mobile: extra.mobile ?? existing?.mobile ?? '',
    country: extra.country ?? existing?.country ?? '',
    // Never a credential: the server holds the only password hash there is.
    passwordHash: '',
    emailVerified: user.emailVerified,
    role: existing?.role ?? 'owner',
    status: existing?.status ?? 'active',
    createdAt: existing?.createdAt ?? user.createdAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
  };
  useAuthStore.getState().adoptVerifiedSession(mirrored);
  return mirrored;
}

/**
 * Erase the local mirror. Called when the server reports no session, so the app
 * never routes a user the server has disowned into the application or the
 * onboarding funnel. The CSRF token is dropped too — it is meaningless with no
 * session behind it.
 */
export function clearLocalSession(): void {
  clearWorkspaceForSignOut();
  useAuthStore.getState().logout();
  clearCsrfToken();
  // So does the open company. A selector left behind would point the next
  // person signing in on this browser at the previous user's set of books —
  // harmless against the server, which resolves it only inside whatever
  // organization THEY belong to, but it would silently scope their first
  // requests to nothing and look like missing data.
  setCompanyReference(null);
  // The organization confirmation belonged to the session that just ended. Left
  // behind, the next visitor would inherit a "confirmed" verdict for an
  // organization that is not theirs.
  useOrganizationStore.setState({
    hydration: { status: 'idle', confirmedOrganizationId: null, error: null },
  });
}

/** Read the organization the backend has for this user, tolerating failure. */
export async function fetchBackendOrganization(): Promise<Record<string, unknown> | null> {
  try {
    const { organization } = await subscriptionApi.currentOrganization();
    return organization;
  } catch {
    // The funnel must still work when the organization endpoint is unreachable;
    // the user is simply routed to the organization step.
    return null;
  }
}

/**
 * Adopt the organization the backend returned, keeping the SERVER's id.
 *
 * This used to funnel the backend's organization through the local
 * `createOrganization` mutator, which was wrong in three ways and produced the
 * "Create your organization first." blocker on a working account:
 *
 *  1. That mutator refuses when `emailVerified` is false — and it is false for
 *     every self-registered backend account, because `POST /api/auth/verify-email`
 *     is still a 501 seam. The refusal was returned as a value and discarded, so
 *     the store stayed EMPTY while the backend held a perfectly good
 *     organization.
 *  2. It minted a fresh local id, so even on success the browser and the server
 *     disagreed about which organization this was.
 *  3. It bailed out whenever a local organization already existed, so a stale
 *     one was never corrected.
 *
 * Adoption has none of those properties: it is not gated on local user state,
 * it keeps the backend id, and it always reconciles.
 */
export function mirrorOrganization(organization: Record<string, unknown> | null): void {
  const store = useOrganizationStore.getState();
  if (organization && asText(organization.id)) {
    store.adoptBackendOrganization(organization);
    return;
  }
  // Nothing came back. That is only a confirmed absence when the caller reached
  // the server; `fetchBackendOrganization` swallows failures, so this path must
  // not clear anything or claim anything — `hydrateFromBackend` owns that.
}

/** Convenience: fetch and mirror the organization in one call. */
export async function mirrorOrganizationFromBackend(): Promise<Record<string, unknown> | null> {
  // Go through the store's hydration so the confirmation STATE is recorded, not
  // just the organization itself. Without it every consumer is back to
  // guessing whether "no organization" means "none" or "not asked yet".
  await useOrganizationStore.getState().hydrateFromBackend({ force: true });
  const organization = useOrganizationStore.getState().organization;
  return organization ? { ...organization } : null;
}

/** Hydrate every subscriber access decision from the same server row used by purchase conflict checks. */
export async function mirrorSubscriptionFromBackend(): Promise<void> {
  useBillingStore.setState({ subscriptionHydration: 'loading' });
  try {
    const { subscription } = await subscriptionApi.current();
    if (!subscription) {
      useBillingStore.setState({ activePlanId: undefined, subscriptionHydration: 'inactive', serverPaymentStatus: null });
      useOrganizationStore.setState({ subscription: null });
      return;
    }
    const status = subscription.status === 'past_due' ? 'past-due' : subscription.status as SubscriptionStatus;
    const active = status === 'active' || status === 'past-due';
    if (subscription.planId) {
      const plan = publicToSubscriptionPlan({
        id: subscription.planId, code: subscription.planCode ?? '', name: subscription.planName ?? '',
        description: subscription.planDescription, edition: subscription.edition ?? 'core',
        currency: subscription.currency ?? 'USD', monthlyPrice: subscription.monthlyPrice ?? 0,
        annualPrice: subscription.annualPrice, userLimit: subscription.userLimit,
        entityLimit: subscription.entityLimit, modules: subscription.modules,
      }, 0);
      useBillingStore.setState((state) => ({
        plans: [...state.plans.filter((item) => item.id !== plan.id), plan],
        activePlanId: active ? plan.id : undefined,
        seeded: true,
        subscriptionHydration: active ? 'active' : 'inactive',
        serverPaymentStatus: subscription.paymentStatus,
      }));
    } else {
      useBillingStore.setState({ activePlanId: undefined, subscriptionHydration: 'inactive', serverPaymentStatus: subscription.paymentStatus });
    }
    useOrganizationStore.setState({ subscription: {
      id: subscription.id, organizationId: subscription.organizationId,
      status: subscription.status as never, basePlanCode: subscription.planCode ?? '', addOnModuleCodes: [],
      extraUsers: 0, extraCompanies: 0, currency: subscription.currency ?? 'USD',
      monthlyTotal: subscription.monthlyPrice ?? 0, startsAt: subscription.startsAt ?? undefined,
      expiresAt: subscription.expiresAt ?? undefined, paymentReference: subscription.paymentReference ?? undefined,
      createdAt: subscription.startsAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
    }});
    useEntitlementStore.getState().replaceSubscription({
      id: subscription.id, organizationId: subscription.organizationId,
      edition: (subscription.edition ?? 'core') as LedgoraEdition, status,
      enabledModules: subscription.modules as LedgoraModule[], disabledModules: [],
      userLimit: subscription.userLimit, entityLimit: subscription.entityLimit,
      startsAt: subscription.startsAt ?? new Date().toISOString(), expiresAt: subscription.expiresAt ?? undefined,
      activationMethod: 'admin', createdAt: subscription.startsAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(), activatedAt: active ? (subscription.startsAt ?? undefined) : undefined,
    });
    if (active) useAccountSessionStore.setState({ demoActive: false });
  } catch (error) {
    useBillingStore.setState({ subscriptionHydration: 'error' });
    throw error;
  }
}
