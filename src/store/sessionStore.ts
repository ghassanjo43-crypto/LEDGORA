/**
 * Minimal session/role store. Real authentication does not exist yet; this
 * provides a single place to model the current user's role so permission checks
 * (e.g. who may verify payments or edit packages) are real and testable. The
 * development default is an administrator.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type UserRole = 'admin' | 'member';

export interface SessionState {
  userName: string;
  role: UserRole;
  setRole: (role: UserRole) => void;
  setUserName: (name: string) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      userName: 'Finance Manager',
      role: 'admin',
      setRole: (role) => set({ role }),
      setUserName: (userName) => set({ userName }),
    }),
    { name: 'ledgora-session', version: 1 },
  ),
);

export function getCurrentRole(): UserRole {
  return useSessionStore.getState().role;
}

export function getCurrentUserName(): string {
  return useSessionStore.getState().userName;
}
