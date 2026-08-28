/**
 * The verified backend session.
 *
 * This store is a CACHE of what `GET /api/auth/session` returned — never a
 * source of authority. It is deliberately NOT persisted: a platform role must
 * be re-confirmed by the server on every page load, so editing browser storage
 * can never manufacture one.
 *
 * When a backend session confirms a platform role, that role governs production
 * administration. With no backend configured (the current static build), the
 * store stays empty and the existing local-development rules apply unchanged.
 */
import { create } from 'zustand';
import type { BackendPlatformRole, BackendUser } from '@/services/api/authApi';
import { authApi } from '@/services/api/authApi';
import { isApiConfigured, clearCsrfToken } from '@/services/api/client';
import { mirrorVerifiedUser, mirrorOrganizationFromBackend, mirrorSubscriptionFromBackend, clearLocalSession } from '@/services/sessionMirror';

export type BackendSessionStatus = 'unknown' | 'loading' | 'ready' | 'unavailable';

interface BackendSessionState {
  /**
   * `unknown` → never asked; `loading` → asking for the FIRST time; `ready` /
   * `unavailable` → the server has answered. Guards that must not paint before
   * the verdict is in test for the first two — see the note in `refresh` on why
   * a later re-check deliberately does not return to `loading`.
   */
  status: BackendSessionStatus;
  user: BackendUser | null;
  platformRoles: BackendPlatformRole[];
  error: string | null;

  /** Re-read the session from the server. Safe to call repeatedly. */
  refresh: () => Promise<void>;
  /** Drop the cached session (sign-out). */
  clear: () => void;
}

export const useBackendSessionStore = create<BackendSessionState>()((set) => ({
  status: 'unknown',
  user: null,
  platformRoles: [],
  error: null,

  refresh: async () => {
    if (!isApiConfigured()) {
      // No backend in this build — not an error, just nothing to verify against.
      set({ status: 'unavailable', user: null, platformRoles: [], error: null });
      return;
    }
    /*
     * Announce `loading` only for the FIRST resolution.
     *
     * Every guard that waits for a session verdict (the shell, the platform
     * console) renders nothing while the status is `unknown` or `loading`. If a
     * routine re-check regressed the status, each one would blank and REMOUNT
     * its whole subtree, destroying the component state of whatever was on
     * screen — which is how the change-password form's success confirmation
     * disappeared the instant it re-read the session to clear
     * `mustChangePassword`. Re-checking a session we already have an answer for
     * is background work, and the last known verdict stays up while it runs.
     */
    set((state) => (state.status === 'unknown' ? { status: 'loading', error: null } : { error: null }));
    try {
      const result = await authApi.getSession();

      if (result.authenticated && result.user) {
        // The server confirmed this identity. Reconcile the local mirror so a
        // cold reload (persisted stores, no in-memory state) still has a current
        // user and organization to route on.
        mirrorVerifiedUser(result.user);
        // Platform operators have no subscriber onboarding lifecycle of their
        // own. Tenant bootstrap is therefore both unnecessary and harmful for
        // them: a billing read must never be able to discard a verified admin
        // role or CSRF token. An operator explicitly entering a tenant uses the
        // separate viewed-organization flow.
        if ((result.user.platformRoles ?? []).length === 0) {
          await mirrorOrganizationFromBackend();
          await mirrorSubscriptionFromBackend();
        }
        set({ status: 'ready', user: result.user, platformRoles: result.user.platformRoles ?? [], error: null });

        /*
         * Adopt the open company now that there is a confirmed session and a
         * hydrated organization to name it by — the two things registration
         * needs. Deliberately AFTER `set(...)`: `ensureCompanyRegistered` reads
         * this store to decide whether the caller is a subscriber, so it has to
         * see `ready`.
         *
         * Not awaited, and its failure is not this function's failure. Session
         * verification must not hinge on company registration; a subscriber
         * whose adoption is still in flight simply waits at the gate in front of
         * the first accounting request, which is where the delay belongs and
         * where it can be explained.
         */
        void import('@/services/api/companyRegistration')
          .then((m) => m.ensureCompanyRegistered())
          .catch(() => undefined);
        return;
      }

      // authenticated:false — the cookie did not travel or the session is gone.
      // NEVER keep trusting the persisted mirror: erase it, so the app cannot
      // route a disowned user into the application or the onboarding funnel.
      clearLocalSession();
      set({ status: 'ready', user: null, platformRoles: [], error: null });
    } catch (error) {
      // Fail CLOSED: an unreachable backend grants no platform role. The mirror
      // is left intact (a transient blip must not force a logout), but with no
      // verified role the shell keeps every protected surface shut.
      clearCsrfToken();
      set({
        status: 'unavailable',
        user: null,
        platformRoles: [],
        error: error instanceof Error ? error.message : 'Could not verify your session.',
      });
    }
  },

  clear: () => {
    clearLocalSession();
    set({ status: 'ready', user: null, platformRoles: [], error: null });
  },
}));

/** Imperative read for non-component call sites (guards, services). */
export function getBackendPlatformRoles(): BackendPlatformRole[] {
  return useBackendSessionStore.getState().platformRoles;
}

export function getBackendUser(): BackendUser | null {
  return useBackendSessionStore.getState().user;
}
