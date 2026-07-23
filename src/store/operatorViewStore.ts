/**
 * Operator "subscriber view" mode.
 *
 * A LEDGORA platform operator (super-admin) can step OUT of the administration
 * console and look at the product the way a subscriber does — without ceasing to
 * be an operator. This store records that explicit mode and, optionally, which
 * subscriber organization is being viewed.
 *
 * ── Why a separate store, and NOT a role change ───────────────────────────────
 * The operator keeps their verified `super_admin` platform role at all times.
 * Viewing mode is a distinct, orthogonal flag. Nothing here ever writes to
 * `sessionStore.platformRole` or `backendSessionStore.platformRoles`: downgrading
 * the role to "leave" administration was the original defect (a no-op under a
 * backend-verified session, and a privilege mutation we must not perform).
 *
 * ── Trust boundary ────────────────────────────────────────────────────────────
 * This flag grants NOTHING on its own. It only relaxes routing when the reader
 * has *already* resolved an effective operator role (see `readAccessContext`),
 * so a tenant hand-setting this value in storage gains no tenant access: their
 * effective role stays `'none'` and the flag is ignored.
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 * Session-scoped (`sessionStorage`), deliberately not `localStorage`: the mode
 * survives a refresh so the surface is predictable, but it does not outlive the
 * browser session, and it is re-validated against the verified role on every
 * read.
 */
import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';

export interface OperatorViewTarget {
  /** The organization being viewed, when one is available (null for a generic peek). */
  organizationId?: string | null;
  /** The subscriber owner whose workspace is being viewed. */
  ownerUserId?: string | null;
  /** Display label for the banner. */
  ownerName?: string | null;
  /** Organization display name for the banner. */
  orgName?: string | null;
}

export interface OperatorViewState extends Required<OperatorViewTarget> {
  /** True while the operator is explicitly viewing the subscriber application. */
  active: boolean;
  /**
   * "View exactly as subscriber": temporarily apply the subscriber's REAL
   * package so the operator can verify the customer experience. Default is
   * false — operator mode is full-access administrator mode. This flag grants
   * nothing (it only narrows); the widening decision itself lives in
   * `lib/platformEntitlementOverride` and requires the verified role.
   */
  viewAsSubscriber: boolean;
  /** Enter subscriber-view mode for an (optional) organization context. */
  enter: (target?: OperatorViewTarget) => void;
  /** Toggle the temporary exact-subscriber-package view. */
  setViewAsSubscriber: (viewAsSubscriber: boolean) => void;
  /** Leave subscriber-view mode and clear the selected subscriber context. */
  exit: () => void;
}

/** A no-op storage so importing this module in a non-DOM test env is safe. */
const memory = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

const backing: StateStorage =
  typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : memoryStorage;

const CLEARED = {
  active: false as boolean,
  viewAsSubscriber: false as boolean,
  organizationId: null,
  ownerUserId: null,
  ownerName: null,
  orgName: null,
};

export const useOperatorViewStore = create<OperatorViewState>()(
  persist(
    (set) => ({
      ...CLEARED,
      enter: (target = {}) =>
        set({
          active: true,
          // Default operator mode is full-access administrator mode; the
          // exact-subscriber view is an explicit, per-entry choice.
          viewAsSubscriber: false,
          organizationId: target.organizationId ?? null,
          ownerUserId: target.ownerUserId ?? null,
          ownerName: target.ownerName ?? null,
          orgName: target.orgName ?? null,
        }),
      setViewAsSubscriber: (viewAsSubscriber) => set({ viewAsSubscriber }),
      exit: () => set({ ...CLEARED }),
    }),
    {
      name: 'ledgora-operator-view',
      storage: createJSONStorage(() => backing),
      // Only the mode + context is persisted; the actions are recreated.
      partialize: (s) => ({
        active: s.active,
        viewAsSubscriber: s.viewAsSubscriber,
        organizationId: s.organizationId,
        ownerUserId: s.ownerUserId,
        ownerName: s.ownerName,
        orgName: s.orgName,
      }),
    },
  ),
);

/** Non-reactive read for policy code (routing, access context). */
export function isOperatorViewingRaw(): boolean {
  return useOperatorViewStore.getState().active;
}
