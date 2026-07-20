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
import { clearCsrfToken } from './api/client';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
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
 * Ensure the local organization shell matches the backend. Only creates one
 * when the server says an organization exists and the browser has none.
 */
export function mirrorOrganization(organization: Record<string, unknown> | null): void {
  if (!organization) return;
  const store = useOrganizationStore.getState();
  if (store.organization) return;
  const year = new Date().getFullYear();
  store.createOrganization({
    legalName: asText(organization.legalName, 'Your organization'),
    tradingName: asText(organization.tradingName),
    country: asText(organization.country),
    registrationNumber: asText(organization.registrationNumber),
    taxNumber: asText(organization.taxNumber),
    industry: asText(organization.industry, 'general'),
    baseCurrency: asText(organization.baseCurrency, 'USD'),
    fiscalYearStart: asText(organization.fiscalYearStart, '01-01'),
    booksStartDate: asText(organization.booksStartDate, `${year}-01-01`),
  });
}

/** Convenience: fetch and mirror the organization in one call. */
export async function mirrorOrganizationFromBackend(): Promise<Record<string, unknown> | null> {
  const organization = await fetchBackendOrganization();
  mirrorOrganization(organization);
  return organization;
}
