/**
 * Service contracts for authentication, subscription selection and accounting
 * persistence.
 *
 * These interfaces are what a real Ledgora backend will implement. The
 * development adapters in this folder are the ONLY frontend-only
 * implementations, they are clearly isolated, and they are not — and must not be
 * presented as — production-grade authentication:
 *
 *   - There is no server, so there is no server-side credential verification,
 *     no session cookie, no rate limiting and no password-reset email.
 *   - Raw passwords are never stored anywhere. They are converted to a
 *     non-reversible mock hash inside the store and discarded; nothing writes a
 *     password to Zustand state, localStorage or sessionStorage.
 *   - No secret, API key or token belongs in this (public) frontend bundle.
 */
import type { AuthenticatedUser } from '@/types/session';

export interface RegistrationInput {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  companyName?: string;
  country: string;
  /** Optional; kept because the existing account model carries a contact number. */
  mobile?: string;
  acceptedTerms: boolean;
  /** Plan the visitor arrived with (`/register?plan=…`). */
  intendedPlanCode?: string;
}

export interface SignInInput {
  email: string;
  password: string;
  /** Session preference only — never a stored credential. */
  rememberMe?: boolean;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  user?: AuthenticatedUser;
}

export interface AuthSession {
  user: AuthenticatedUser;
  organizationId: string | null;
}

export interface AuthService {
  register(input: RegistrationInput): Promise<AuthResult>;
  signIn(input: SignInInput): Promise<AuthResult>;
  signOut(): Promise<void>;
  getSession(): Promise<AuthSession | null>;
  /** Password reset is a backend responsibility; the seam exists today. */
  requestPasswordReset(email: string): Promise<{ ok: boolean; error?: string; message?: string }>;
}

export interface PublicSubscriptionPlan {
  id: string;
  name: string;
  description: string;
  priceMonthly: number;
  currency: string;
  isFreeDemo?: boolean;
}

export interface SubscriptionResult {
  ok: boolean;
  error?: string;
  /** Invoice raised by the existing billing workflow, when applicable. */
  invoiceId?: string;
}

export interface SubscriptionService {
  listPublicPlans(): Promise<PublicSubscriptionPlan[]>;
  selectPlan(planId: string): Promise<SubscriptionResult>;
  startFreeDemo(): Promise<void>;
}

export interface AccountingPersistenceService {
  saveRecord(record: unknown): Promise<void>;
  loadWorkspace(organizationId: string): Promise<unknown>;
}
