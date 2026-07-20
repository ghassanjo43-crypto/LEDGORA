/**
 * API-backed authentication adapter — the production path.
 *
 * Every credential decision happens on the LEDGORA backend. The browser holds
 * no password, no password hash and no token: the session is an HttpOnly cookie
 * the JavaScript here cannot read, and `GET /api/auth/session` is the only
 * source of truth for who is signed in.
 *
 * ── Why this file still writes to the local stores ────────────────────────────
 * The existing pages, the redirect state machine (`resolvePostLoginRoute`) and
 * the session read model (`lib/sessionModel`) all read `authStore` /
 * `organizationStore`. Rather than rewrite every one of those call sites, this
 * adapter MIRRORS the server's answer into them after each verified exchange.
 * The mirror is a cache for rendering and routing only:
 *
 *   • It is written only after the server has just confirmed the identity.
 *   • The mirrored user carries an EMPTY `passwordHash`, so the local
 *     `authStore.login()` credential path can never authenticate against it —
 *     a mirrored record cannot be used to sign in offline.
 *   • The platform role is deliberately NOT mirrored. It stays in
 *     `backendSessionStore`, re-confirmed by the server on every page load.
 */
import type { AuthResult, AuthService, AuthSession, RegistrationInput, SignInInput } from './types';
import type { BackendUser } from './api/authApi';
import { authApi, subscriptionApi } from './api/authApi';
import { ApiError } from './api/client';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { toAuthenticatedUser } from '@/lib/sessionModel';
import { clearWorkspaceForSignOut, restoreWorkspaceForSignIn } from '@/lib/freeDemoSession';
import { passwordProblem } from '@/lib/onboardingData';
import type { RegisteredUser } from '@/types/onboarding';

/** Turn any thrown value into the `AuthResult` shape the forms render. */
function toFailure(error: unknown, fallback: string): AuthResult {
  if (error instanceof ApiError) {
    const fieldErrors = error.fieldErrors;
    return {
      ok: false,
      error: error.message || fallback,
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }
  return { ok: false, error: fallback };
}

/**
 * Mirror a server-verified user into the local read model.
 *
 * Fields the backend does not model (mobile, country) are preserved from an
 * existing local record so a returning user does not lose them.
 */
function mirrorUser(user: BackendUser, extra: { country?: string; mobile?: string } = {}): RegisteredUser {
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

/** Read the organization the backend has for this user, if any. */
async function backendOrganization(): Promise<Record<string, unknown> | null> {
  try {
    const { organization } = await subscriptionApi.currentOrganization();
    return organization;
  } catch {
    // The funnel must still work when the organization endpoint is unreachable;
    // the user is simply routed to the organization step.
    return null;
  }
}

const asText = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/**
 * Ensure the local organization shell matches the backend. Only creates one
 * when the server says an organization exists and the browser has none.
 */
function mirrorOrganization(organization: Record<string, unknown> | null): void {
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

/** Validation belonging to the registration *form*, mirroring the backend rules. */
function validateRegistration(input: RegistrationInput): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const pw = passwordProblem(input.password);
  if (pw) fieldErrors.password = pw;
  if (!input.confirmPassword) fieldErrors.confirmPassword = 'Confirm your password.';
  else if (input.confirmPassword !== input.password) fieldErrors.confirmPassword = 'Passwords do not match.';
  return fieldErrors;
}

function authenticatedUser(): AuthResult['user'] {
  const org = useOrganizationStore.getState().organization;
  const state = useAuthStore.getState();
  const user = state.users.find((u) => u.id === state.currentUserId) ?? null;
  return toAuthenticatedUser(user, org?.legalName) ?? undefined;
}

export const apiAuthService: AuthService = {
  async register(input) {
    const formErrors = validateRegistration(input);
    if (Object.keys(formErrors).length > 0) {
      return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: formErrors };
    }

    try {
      const { user } = await authApi.register({
        email: input.email,
        password: input.password,
        fullName: input.fullName,
      });
      mirrorUser(user, { country: input.country, mobile: input.mobile });

      // Registration issues a session cookie, so the organization can be created
      // straight away. A failure here is not fatal: the user is signed in and the
      // onboarding organization step will collect the details instead.
      try {
        await subscriptionApi.createOrganization({
          legalName: input.companyName?.trim() || `${input.fullName.trim()}'s organization`,
          country: input.country,
          tradingName: input.companyName?.trim() || undefined,
        });
        mirrorOrganization(await backendOrganization());
      } catch {
        /* handled by the onboarding organization step */
      }

      await useBackendSessionStore.getState().refresh();
      return { ok: true, user: authenticatedUser() };
    } catch (error) {
      return toFailure(error, 'Could not create your account.');
    }
  },

  async signIn(input) {
    try {
      const { user } = await authApi.signIn({ email: input.email, password: input.password });
      mirrorUser(user);
      mirrorOrganization(await backendOrganization());

      // "Remember me" is a session *preference*; no credential is stored.
      useAccountSessionStore.getState().setRememberMe(!!input.rememberMe);
      useAccountSessionStore.getState().setDemoActive(false);
      restoreWorkspaceForSignIn();

      // Re-read the platform role from the server now the session exists.
      await useBackendSessionStore.getState().refresh();
      return { ok: true, user: authenticatedUser() };
    } catch (error) {
      return toFailure(error, 'Incorrect email or password.');
    }
  },

  async signOut() {
    try {
      await authApi.signOut();
    } catch {
      // The local session is dropped regardless: a user who asked to sign out
      // must never stay signed in because the network failed.
    }
    useBackendSessionStore.getState().clear();
    clearWorkspaceForSignOut();
    useAuthStore.getState().logout();
  },

  async getSession(): Promise<AuthSession | null> {
    let session;
    try {
      session = await authApi.getSession();
    } catch {
      // Fail closed: an unverifiable session is no session.
      return null;
    }
    if (!session.authenticated || !session.user) {
      useAuthStore.getState().logout();
      return null;
    }

    mirrorUser(session.user);
    const organization = await backendOrganization();
    mirrorOrganization(organization);

    const user = authenticatedUser();
    if (!user) return null;
    return {
      user,
      organizationId:
        asText(organization?.id) || useOrganizationStore.getState().organization?.id || null,
    };
  },

  async requestPasswordReset(email) {
    if (!email.trim()) return { ok: false, error: 'Enter the email address for your account.' };
    try {
      const result = await authApi.requestPasswordReset(email);
      return {
        ok: true,
        message: result.message ?? 'If an account exists for that address, reset instructions have been sent.',
      };
    } catch (error) {
      return toFailure(error, 'Could not start a password reset.');
    }
  },
};

export type { SignInInput };
