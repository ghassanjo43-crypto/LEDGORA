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
import { authApi, subscriptionApi } from './api/authApi';
import { ApiError } from './api/client';
import {
  mirrorVerifiedUser,
  mirrorOrganization,
  fetchBackendOrganization,
  clearLocalSession,
} from './sessionMirror';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { toAuthenticatedUser } from '@/lib/sessionModel';
import { restoreWorkspaceForSignIn } from '@/lib/freeDemoSession';
import { passwordProblem } from '@/lib/onboardingData';

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

const asText = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

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
      mirrorVerifiedUser(user, { country: input.country, mobile: input.mobile });

      // Registration issues a session cookie, so the organization can be created
      // straight away. A failure here is not fatal: the user is signed in and the
      // onboarding organization step will collect the details instead.
      try {
        await subscriptionApi.createOrganization({
          legalName: input.companyName?.trim() || `${input.fullName.trim()}'s organization`,
          country: input.country,
          tradingName: input.companyName?.trim() || undefined,
        });
        mirrorOrganization(await fetchBackendOrganization());
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
      mirrorVerifiedUser(user);
      mirrorOrganization(await fetchBackendOrganization());

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
    // Drops the mirrored user, the workspace and the in-memory CSRF token.
    useBackendSessionStore.getState().clear();
    // Any operator subscriber-view mode ends with the session.
    useOperatorViewStore.getState().exit();
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
      clearLocalSession();
      return null;
    }

    mirrorVerifiedUser(session.user);
    const organization = await fetchBackendOrganization();
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
