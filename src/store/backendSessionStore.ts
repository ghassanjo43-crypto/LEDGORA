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
import { mirrorVerifiedUser, mirrorOrganizationFromBackend, clearLocalSession } from '@/services/sessionMirror';

export type BackendSessionStatus = 'unknown' | 'loading' | 'ready' | 'unavailable';

interface BackendSessionState {
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
    set({ status: 'loading', error: null });
    try {
      const result = await authApi.getSession();

      if (result.authenticated && result.user) {
        // The server confirmed this identity. Reconcile the local mirror so a
        // cold reload (persisted stores, no in-memory state) still has a current
        // user and organization to route on.
        mirrorVerifiedUser(result.user);
        await mirrorOrganizationFromBackend();
        set({ status: 'ready', user: result.user, platformRoles: result.user.platformRoles ?? [], error: null });
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
