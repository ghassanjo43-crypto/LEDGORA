/**
 * Account/session state model for the onboarding state machine.
 *
 * This is the *account-level* model that decides what a visitor may reach
 * (welcome → registration → subscription selection → application). It sits above
 * the organization/subscription lifecycle in `types/onboarding.ts` and above the
 * platform super-admin role in `store/sessionStore.ts`; neither is replaced.
 */
import type { OnboardingSubscriptionStatus } from './onboarding';

/**
 * Where the visitor currently sits in the onboarding state machine.
 *
 * `free-preview` is its OWN status on purpose. A customer whose package is
 * chosen but whose payment is still being verified has full feature access and
 * no durable storage — a combination none of the others describes. Reusing
 * `subscribed` would let preview work be written to the books; reusing `trial`
 * would grant durable storage; reusing `free-demo` would apply the demo's
 * narrow view allow-list; and `registered-no-plan` is what locked these
 * customers out in the first place. See `lib/freePreview`.
 */
export type AccountStatus =
  | 'anonymous'
  | 'registered-no-plan'
  | 'free-demo'
  | 'free-preview'
  | 'trial'
  | 'subscribed'
  | 'past-due'
  | 'suspended';

/** The signed-in person. Never contains a password or password hash. */
export interface AuthenticatedUser {
  id: string;
  fullName: string;
  email: string;
  companyName?: string;
  country?: string;
}

export interface SessionState {
  user: AuthenticatedUser | null;
  accountStatus: AccountStatus;
  organizationId: string | null;
  subscriptionPlanId: string | null;
  /**
   * The package the customer chose, which in Free Preview is the package
   * *awaiting activation* rather than one in force. Same value as
   * `subscriptionPlanId`, under the name the lifecycle rule uses.
   */
  selectedPlanId: string | null;
  /** The organization subscription's lifecycle status, exposed verbatim. */
  subscriptionStatus: OnboardingSubscriptionStatus | null;
  /** True when business records may be written to durable storage. */
  canPersistData: boolean;
  isAuthenticated: boolean;
}

/**
 * Where business records go for the current account status.
 *
 * `'backend'` is the durable path. Ledgora is frontend-only today, so the
 * durable path is currently served by the browser-storage development adapter
 * (see `lib/workspaceStorage.ts`); it is the single place a real backend
 * persistence service is swapped in.
 */
export interface PersistencePolicy {
  canPersistBusinessData: boolean;
  storageMode: 'memory' | 'backend';
}
