/**
 * The member roster for the organization currently being operated on.
 *
 * Loads through whichever endpoint the context authorizes:
 *   operator   → `GET /api/admin/organizations/:id/members` (capability-guarded)
 *   subscriber → `GET /api/organizations/current/members`   (membership-derived)
 *
 * ── Organization switching ───────────────────────────────────────────────────
 * The hard requirement is that members from the PREVIOUS subscriber can never
 * appear under the newly selected one. Two mechanisms, because either alone
 * leaves a window:
 *
 *   1. `load` clears the roster synchronously the moment the requested
 *      organization changes, so nothing stale is on screen even for one frame;
 *   2. every request carries a generation number and an `AbortController`. A
 *      response whose generation is no longer current is DISCARDED — the
 *      administrator switching from Acme to Globex mid-flight cannot have Acme's
 *      slow response land in Globex's table.
 *
 * Nothing here is persisted. A roster is server state, and caching it across
 * sessions would be another way to show one tenant's people under another's name.
 */
import { create } from 'zustand';
import { memberApi, type MemberRecord } from '@/services/api/memberApi';
import { ApiError } from '@/services/api/client';

export type MemberDirectoryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface MemberDirectoryRequest {
  /** `null` in operator mode means "no organization selected". */
  organizationId: string | null;
  mode: 'subscriber' | 'operator';
}

interface MemberDirectoryState {
  status: MemberDirectoryStatus;
  /** The organization the CURRENT contents belong to. Never assume otherwise. */
  loadedOrganizationId: string | null;
  members: MemberRecord[];
  seatsUsed: number;
  seatLimit: number | null;
  error: string | null;

  load: (request: MemberDirectoryRequest) => Promise<void>;
  clear: () => void;
}

/** Bumped on every load; a response from an older generation is dropped. */
let generation = 0;
let inFlight: AbortController | null = null;

const EMPTY = {
  members: [] as MemberRecord[],
  seatsUsed: 0,
  seatLimit: null as number | null,
};

export const useMemberDirectoryStore = create<MemberDirectoryState>()((set, get) => ({
  status: 'idle',
  loadedOrganizationId: null,
  ...EMPTY,
  error: null,

  load: async ({ organizationId, mode }) => {
    // A switch invalidates everything already loaded, immediately.
    if (get().loadedOrganizationId !== organizationId) {
      set({ ...EMPTY, loadedOrganizationId: null, error: null });
    }

    if (mode === 'operator' && !organizationId) {
      set({ status: 'idle', ...EMPTY, loadedOrganizationId: null, error: null });
      return;
    }

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const mine = ++generation;
    const stale = (): boolean => mine !== generation;

    set({ status: 'loading', error: null });

    try {
      const result =
        mode === 'operator'
          ? await memberApi.listForOrganization(organizationId!, controller.signal)
          : await memberApi.listForCurrentOrganization(controller.signal);

      // Someone switched organization while this was in flight. Their request
      // owns the store now; this answer describes a tenant we are no longer
      // looking at and must be thrown away.
      if (stale()) return;

      set({
        status: 'ready',
        loadedOrganizationId: result.organizationId,
        members: result.members,
        seatsUsed: result.seatsUsed,
        seatLimit: result.seatLimit,
        error: null,
      });
    } catch (cause) {
      if (stale()) return;
      // An aborted request is not a failure — it was superseded.
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      set({
        status: 'error',
        // Keep the roster empty on failure: showing a previous tenant's members
        // beside another tenant's name is worse than showing none.
        ...EMPTY,
        loadedOrganizationId: null,
        error:
          cause instanceof ApiError
            ? cause.message
            : 'We could not load the members for this organization.',
      });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  clear: () => {
    // Invalidate any in-flight response as well, so a late arrival cannot
    // repopulate a roster the caller just cleared.
    generation += 1;
    inFlight?.abort();
    inFlight = null;
    set({ status: 'idle', loadedOrganizationId: null, ...EMPTY, error: null });
  },
}));
