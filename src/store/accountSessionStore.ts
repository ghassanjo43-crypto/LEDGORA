/**
 * Account-session store: the onboarding state machine's own state.
 *
 * It holds only *session* information (is a Free Demo running, how many demo
 * records have been created, whether "remember me" was chosen) — never business
 * data and never a password. Persisting the session is what lets a refresh land
 * on the correct onboarding screen; the demo *workspace* is separately wiped by
 * `lib/workspaceStorage`.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AccountSessionState {
  /** True while a Free Demo workspace is active. */
  demoActive: boolean;
  demoStartedAt: string | null;
  /** Records created in this demo session — drives restrained upgrade prompts. */
  demoRecordCount: number;
  /** Sign-in preference only. Never a credential. */
  rememberMe: boolean;

  setDemoActive: (active: boolean) => void;
  noteDemoRecords: (count: number) => void;
  setRememberMe: (rememberMe: boolean) => void;
  resetToDefault: () => void;
}

export const useAccountSessionStore = create<AccountSessionState>()(
  persist(
    (set) => ({
      demoActive: false,
      demoStartedAt: null,
      demoRecordCount: 0,
      rememberMe: false,

      setDemoActive: (active) =>
        set({
          demoActive: active,
          demoStartedAt: active ? new Date().toISOString() : null,
          demoRecordCount: 0,
        }),
      noteDemoRecords: (count) => set({ demoRecordCount: Math.max(0, count) }),
      setRememberMe: (rememberMe) => set({ rememberMe }),
      resetToDefault: () => set({ demoActive: false, demoStartedAt: null, demoRecordCount: 0 }),
    }),
    { name: 'ledgora-account-session', version: 1 },
  ),
);

export function isFreeDemoActive(): boolean {
  return useAccountSessionStore.getState().demoActive;
}
