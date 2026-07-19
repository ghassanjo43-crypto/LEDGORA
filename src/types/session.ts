/**
 * Account/session state model for the onboarding state machine.
 *
 * This is the *account-level* model that decides what a visitor may reach
 * (welcome → registration → subscription selection → application). It sits above
 * the organization/subscription lifecycle in `types/onboarding.ts` and above the
 * platform super-admin role in `store/sessionStore.ts`; neither is replaced.
 */

/** Where the visitor currently sits in the onboarding state machine. */
export type AccountStatus =
  | 'anonymous'
  | 'registered-no-plan'
  | 'free-demo'
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
