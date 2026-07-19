/**
 * Platform-operator session.
 *
 * This store holds the LEDGORA *platform* role — who may verify payments, edit
 * packages or change metering configuration across tenants. It is NOT the
 * subscriber's organization membership; that lives on `RegisteredUser.role` in
 * `authStore` and is a separate dimension (see `types/roles`).
 *
 * ⚠ The stored value is NEVER an authorization decision on its own. Reads go
 * through `getPlatformRole()`, which returns `'none'` unless
 * `platformAdminToolsAllowed()` holds — i.e. a local development server with an
 * explicit `.env.local` opt-in. In a production build the stored value is
 * ignored entirely, so editing `localStorage` grants nothing.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PlatformRole } from '@/types/roles';
import { effectivePlatformRole, platformAdminToolsAllowed } from '@/lib/platformAccess';

export interface SessionState {
  userName: string;
  /**
   * The role a developer has simulated locally. Meaningless in production —
   * always resolve it through `getPlatformRole()` / `useEffectivePlatformRole()`.
   */
  platformRole: PlatformRole;
  setPlatformRole: (role: PlatformRole) => void;
  setUserName: (name: string) => void;
  resetToDefault: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      userName: 'Finance Manager',
      // No visitor, customer, demo user or subscriber is ever an operator.
      platformRole: 'none',
      setPlatformRole: (platformRole) =>
        // Refuse to record a privileged role outside local development, so a
        // production build cannot even be coaxed into persisting one.
        set({ platformRole: platformAdminToolsAllowed() ? platformRole : 'none' }),
      setUserName: (userName) => set({ userName }),
      resetToDefault: () => set({ platformRole: 'none' }),
    }),
    {
      name: 'ledgora-session',
      version: 2,
      /**
       * v1 stored `role: 'admin' | 'member'` and DEFAULTED TO 'admin', so every
       * existing browser holds an administrator value. That value is discarded:
       * migration always lands on `'none'`, and a developer re-enables their
       * local role deliberately. This is what stops an already-deployed browser
       * from keeping administrator access after this release.
       */
      migrate: () => ({ platformRole: 'none' as PlatformRole }),
      /**
       * Defence in depth: even a hand-edited storage payload is normalised on
       * rehydration, so a production build can never come up privileged.
       */
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.platformRole = effectivePlatformRole(state.platformRole ?? 'none');
      },
    },
  ),
);

/** The role as *stored* (simulated locally). Not an authorization answer. */
export function getStoredPlatformRole(): PlatformRole {
  return useSessionStore.getState().platformRole;
}

/**
 * The role that actually applies. Always `'none'` in a production build.
 * Use this — never `useSessionStore.getState().platformRole` — for decisions.
 */
export function getPlatformRole(): PlatformRole {
  return effectivePlatformRole(useSessionStore.getState().platformRole);
}

export function getCurrentUserName(): string {
  return useSessionStore.getState().userName;
}
