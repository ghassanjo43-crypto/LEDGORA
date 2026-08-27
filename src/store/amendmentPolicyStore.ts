/**
 * The amendment policy the SUBSCRIBER sets: which roles, and which individual
 * people, may amend posted documents.
 *
 * ── Why this is a store and not a constant ───────────────────────────────────
 * The requirement is that the subscriber controls who may amend, and that
 * holding a subscription is not itself authorisation. A hard-coded role ladder
 * would give the subscriber no control at all; the server's answer to the same
 * problem is a role template in code plus overrides in a table, and this is
 * that table for books that are still browser-resident.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────────
 * Not a second permission system. The keys are the server catalogue's keys and
 * the precedence is the server's precedence — both live in
 * `lib/amendmentPermissions`, which this store only supplies data to.
 *
 * ── Who may change it ────────────────────────────────────────────────────────
 * Owner and Organization Admin only, checked HERE rather than in the screen
 * that draws the switches. A user who has been granted `invoices:amend` cannot
 * grant it to anyone else, and cannot grant themselves another document type.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { OrganizationRole } from '@/types/roles';
import {
  AMENDMENT_PERMISSION_KEYS,
  canAdministerAmendmentPolicy,
  type AmendmentPermissionKey,
  type AmendmentPolicy,
  type OverrideEffect,
  type RoleAmendmentGrant,
  type UserAmendmentOverride,
} from '@/lib/amendmentPermissions';
import { readAmendmentContext } from '@/lib/amendmentContext';

export interface PolicyActionResult {
  ok: boolean;
  error?: string;
}

interface AmendmentPolicyState extends AmendmentPolicy {
  /** The whole policy, for the resolver. */
  policy: () => AmendmentPolicy;

  /** Grant or revoke a permission for everyone holding `role`. */
  setRoleGrant: (role: OrganizationRole, key: AmendmentPermissionKey, granted: boolean) => PolicyActionResult;
  /** Set, or clear (`null`), one person's explicit decision. */
  setUserOverride: (userId: string, key: AmendmentPermissionKey, effect: OverrideEffect | null) => PolicyActionResult;
  /** Drop every override for a person — used when a membership is removed. */
  clearUser: (userId: string) => PolicyActionResult;

  resetToDefault: () => void;
}

function isKnownKey(key: string): key is AmendmentPermissionKey {
  return (AMENDMENT_PERMISSION_KEYS as string[]).includes(key);
}

/**
 * The anti-mass-assignment check, mirroring the server's `isKnownPermission`.
 * An invented key must never become a stored grant that nothing enforces today
 * and a future resolver might.
 */
function guard(key: string): PolicyActionResult {
  const context = readAmendmentContext();
  if (!canAdministerAmendmentPolicy(context.role)) {
    return {
      ok: false,
      error: `Your role (${context.role}) cannot change who may amend posted documents. Only the organization owner or an Organization Admin can.`,
    };
  }
  if (!isKnownKey(key)) return { ok: false, error: `"${key}" is not an amendment permission.` };
  return { ok: true };
}

export const useAmendmentPolicyStore = create<AmendmentPolicyState>()(
  persist(
    (set, get) => ({
      roleGrants: [],
      userOverrides: [],

      policy: () => ({ roleGrants: get().roleGrants, userOverrides: get().userOverrides }),

      setRoleGrant: (role, key, granted) => {
        const denied = guard(key);
        if (!denied.ok) return denied;
        const without = get().roleGrants.filter((g) => !(g.role === role && g.key === key));
        const next: RoleAmendmentGrant[] = granted ? [...without, { role, key }] : without;
        set({ roleGrants: next });
        return { ok: true };
      },

      setUserOverride: (userId, key, effect) => {
        const denied = guard(key);
        if (!denied.ok) return denied;
        if (!userId) return { ok: false, error: 'Select a user.' };
        const without = get().userOverrides.filter((o) => !(o.userId === userId && o.key === key));
        const next: UserAmendmentOverride[] = effect ? [...without, { userId, key, effect }] : without;
        set({ userOverrides: next });
        return { ok: true };
      },

      clearUser: (userId) => {
        const context = readAmendmentContext();
        if (!canAdministerAmendmentPolicy(context.role)) {
          return { ok: false, error: `Your role (${context.role}) cannot change who may amend posted documents.` };
        }
        set({ userOverrides: get().userOverrides.filter((o) => o.userId !== userId) });
        return { ok: true };
      },

      resetToDefault: () => set({ roleGrants: [], userOverrides: [] }),
    }),
    {
      name: 'ledgora-amendment-policy',
      storage: businessJSONStorage,
      version: 1,
      partialize: (s) => ({ roleGrants: s.roleGrants, userOverrides: s.userOverrides }),
    },
  ),
);

/** The policy as the resolver wants it. Call-time read, cycle-safe. */
export function currentAmendmentPolicy(): AmendmentPolicy {
  const state = useAmendmentPolicyStore.getState();
  return { roleGrants: state.roleGrants, userOverrides: state.userOverrides };
}
