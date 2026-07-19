/**
 * DEVELOPMENT authentication adapter — NOT production authentication.
 *
 * Ledgora has no authentication backend yet. This adapter keeps the funnel
 * working in the static build by delegating to the browser-only `authStore`:
 *
 *   ⚠ Everything here runs in the visitor's browser. It provides NO real
 *     security: there is no server-side credential check, no HTTP-only session
 *     cookie, no rate limiting, no email delivery. Do not describe it as secure
 *     production authentication.
 *
 * What it does guarantee:
 *   • The raw password is used only to compute a non-reversible mock hash and is
 *     then discarded — it is never placed in Zustand state, localStorage,
 *     sessionStorage, a URL or a log line.
 *   • No secret/API key lives in this bundle.
 *
 * ── BACKEND SEAM ──────────────────────────────────────────────────────────────
 * Replace this file with `apiAuthService.ts` implementing the same `AuthService`
 * contract. Each method below marks the exact call to make:
 *   register()              → POST /api/auth/register
 *   signIn()                → POST /api/auth/login       (sets an HTTP-only cookie)
 *   signOut()               → POST /api/auth/logout
 *   getSession()            → GET  /api/auth/session
 *   requestPasswordReset()  → POST /api/auth/password-reset
 * Then swap the export in `services/index.ts`; no page needs to change.
 */
import type { AuthResult, AuthService, AuthSession, RegistrationInput, SignInInput } from './types';
import { useAuthStore, getCurrentUser } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { toAuthenticatedUser } from '@/lib/sessionModel';
import { clearWorkspaceForSignOut, restoreWorkspaceForSignIn } from '@/lib/freeDemoSession';
import { passwordProblem } from '@/lib/onboardingData';

function currentAuthenticatedUser(): AuthResult['user'] {
  const org = useOrganizationStore.getState().organization;
  return toAuthenticatedUser(getCurrentUser(), org?.legalName) ?? undefined;
}

/** Validation that belongs to the registration *form*, not the account store. */
function validateRegistration(input: RegistrationInput): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const pw = passwordProblem(input.password);
  if (pw) fieldErrors.password = pw;
  if (!input.confirmPassword) fieldErrors.confirmPassword = 'Confirm your password.';
  else if (input.confirmPassword !== input.password) fieldErrors.confirmPassword = 'Passwords do not match.';
  return fieldErrors;
}

export const devAuthService: AuthService = {
  async register(input) {
    const formErrors = validateRegistration(input);
    if (Object.keys(formErrors).length > 0) {
      return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: formErrors };
    }

    // BACKEND SEAM: POST /api/auth/register { fullName, email, password, … }
    const result = useAuthStore.getState().register({
      fullName: input.fullName,
      email: input.email,
      mobile: input.mobile ?? '',
      country: input.country,
      password: input.password,
      acceptedTerms: input.acceptedTerms,
      intendedPlanCode: input.intendedPlanCode,
    });
    if (!result.ok) return { ok: false, error: result.error, fieldErrors: result.fieldErrors };

    // BACKEND SEAM: a production backend emails a verification link and the
    // account stays unverified until it is clicked. The development adapter
    // confirms immediately so the registration → package-selection funnel is
    // usable and testable in the static build.
    if (result.verificationToken) useAuthStore.getState().verifyEmail(result.verificationToken);

    // A newly registered user is `registered-no-plan`: an organization shell is
    // created from the signup details so package selection can raise an invoice,
    // but no subscription exists and the accounting application stays locked.
    ensureOrganizationShell(input);

    return { ok: true, user: currentAuthenticatedUser() };
  },

  async signIn(input) {
    // BACKEND SEAM: POST /api/auth/login — the server verifies the credential.
    const result = useAuthStore.getState().login(input.email, input.password);
    if (!result.ok) return { ok: false, error: result.error };
    // "Remember me" is a session *preference*; no credential is stored.
    useAccountSessionStore.getState().setRememberMe(!!input.rememberMe);
    useAccountSessionStore.getState().setDemoActive(false);
    restoreWorkspaceForSignIn();
    return { ok: true, user: currentAuthenticatedUser() };
  },

  async signOut() {
    // BACKEND SEAM: POST /api/auth/logout — invalidates the server session.
    // Local cleanup: drop the authenticated session and every temporary record.
    // Durable records belonging to other accounts are never touched, because the
    // reset runs after the workspace has been switched to memory-only.
    clearWorkspaceForSignOut();
    useAuthStore.getState().logout();
  },

  async getSession(): Promise<AuthSession | null> {
    // BACKEND SEAM: GET /api/auth/session
    const user = currentAuthenticatedUser();
    if (!user) return null;
    return { user, organizationId: useOrganizationStore.getState().organization?.id ?? null };
  },

  async requestPasswordReset(email) {
    // BACKEND SEAM: POST /api/auth/password-reset — sends the reset email.
    // Deliberately not implemented in the browser: a frontend cannot send mail
    // or mint a trustworthy reset token.
    if (!email.trim()) return { ok: false, error: 'Enter the email address for your account.' };
    return {
      ok: true,
      message:
        'Password reset is handled by the Ledgora account service. Contact support to reset your password for now.',
    };
  },
};

/**
 * Create the organization shell the subscription step needs. Uses the signup
 * company name/country; the full organization form remains available for the
 * remaining commercial details.
 */
function ensureOrganizationShell(input: RegistrationInput): void {
  const org = useOrganizationStore.getState();
  if (org.organization) return;
  const year = new Date().getFullYear();
  org.createOrganization({
    legalName: input.companyName?.trim() || `${input.fullName.trim()}'s organization`,
    tradingName: input.companyName?.trim() ?? '',
    country: input.country,
    registrationNumber: '',
    taxNumber: '',
    industry: 'general',
    baseCurrency: 'USD',
    fiscalYearStart: '01-01',
    booksStartDate: `${year}-01-01`,
  });
}

export type { SignInInput };
