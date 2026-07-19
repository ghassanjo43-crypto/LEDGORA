/**
 * Derives the onboarding `SessionState` from the stores that actually own the
 * facts: `authStore` (who is signed in), `organizationStore` (the subscription
 * lifecycle), `entitlementStore` (the runtime plan status) and
 * `accountSessionStore` (Free Demo).
 *
 * Nothing here writes state — it is the single read model the access gate, the
 * persistence policy and the UI all agree on.
 */
import type { AccountStatus, AuthenticatedUser, SessionState } from '@/types/session';
import type { SubscriptionStatus } from '@/types/subscription';
import type { OnboardingSubscriptionStatus } from '@/types/onboarding';
import type { RegisteredUser } from '@/types/onboarding';
import { resolvePersistencePolicy } from './persistencePolicy';

export interface SessionInputs {
  user: RegisteredUser | null;
  organizationId: string | null;
  organizationName?: string;
  /** Lifecycle status of the org's onboarding subscription (invoice → active). */
  onboardingStatus: OnboardingSubscriptionStatus | null;
  /** Runtime entitlement status (trial / active / past-due / …). */
  entitlementStatus: SubscriptionStatus;
  /** Plan identifier the org is on, when one has been selected. */
  subscriptionPlanId: string | null;
  demoActive: boolean;
}

export function resolveAccountStatus(input: SessionInputs): AccountStatus {
  if (input.demoActive) return 'free-demo';
  if (!input.user) return 'anonymous';

  // Only an activated onboarding subscription grants application access.
  if (input.onboardingStatus === 'active') {
    switch (input.entitlementStatus) {
      case 'trial':
        return 'trial';
      case 'past-due':
        return 'past-due';
      case 'suspended':
        return 'suspended';
      default:
        // active / cancelled / expired keep application access; the existing
        // entitlement banner + gates decide what may still be posted.
        return 'subscribed';
    }
  }
  if (input.onboardingStatus === 'suspended') return 'suspended';

  // Registered, but nothing purchased, paid for or activated yet.
  return 'registered-no-plan';
}

export function toAuthenticatedUser(
  user: RegisteredUser | null,
  organizationName?: string,
): AuthenticatedUser | null {
  if (!user) return null;
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    companyName: organizationName,
    country: user.country,
  };
}

export function resolveSessionState(input: SessionInputs): SessionState {
  const accountStatus = resolveAccountStatus(input);
  const policy = resolvePersistencePolicy({
    accountStatus,
    // A `past-due` entitlement is, by the existing billing lifecycle, still
    // inside its grace window (it becomes expired/suspended afterwards).
    inGracePeriod: true,
  });
  return {
    user: toAuthenticatedUser(input.user, input.organizationName),
    accountStatus,
    organizationId: input.organizationId,
    subscriptionPlanId: accountStatus === 'free-demo' ? null : input.subscriptionPlanId,
    canPersistData: policy.canPersistBusinessData,
    isAuthenticated: !!input.user,
  };
}

/** Account statuses that may open the accounting application at all. */
const APP_STATUSES: AccountStatus[] = ['free-demo', 'trial', 'subscribed', 'past-due', 'suspended'];

export function canOpenApplication(status: AccountStatus): boolean {
  return APP_STATUSES.includes(status);
}
