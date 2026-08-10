/**
 * Roster state for the Super Admin console.
 *
 * ── The problem both stores exist to solve ───────────────────────────────────
 * An operator changes a filter — most consequentially, switches which subscriber
 * they are looking at — and a slow response from the PREVIOUS request arrives
 * afterwards. Rendered naively, one tenant's people appear under another tenant's
 * name. That is a data-leak-shaped bug, not a cosmetic one.
 *
 * Two mechanisms, because either alone leaves a window:
 *
 *  1. `requestKey` — the contents are stamped with the exact query that produced
 *     them. A component compares the key it is asking for against the key that is
 *     loaded and renders nothing until they match, so nothing stale is on screen
 *     even for a single frame.
 *  2. a generation counter plus an `AbortController` — a response from a
 *     superseded request is DISCARDED rather than stored, so a late arrival
 *     cannot repopulate a view the operator has already moved on from.
 *
 * ── Nothing here is persisted ───────────────────────────────────────────────
 * A roster is server state. Caching it across sessions would be another way to
 * show one tenant's data under another's name, and it would outlive the
 * capability that authorised reading it. Both stores are in-memory only.
 *
 * ── Nothing here holds a credential ─────────────────────────────────────────
 * One-time secrets (a temporary password, an invitation token) are never put in
 * a store. They travel from the API response straight to the dialog that shows
 * them once and are then gone. See `CredentialResultDialog`.
 */
import { create } from 'zustand';
import {
  adminMemberApi,
  adminSubscriberApi,
  type AdminMemberDetail,
  type AdminMemberListResponse,
  type AdminMemberQuery,
  type AdminMemberRow,
  type AdminSubscriberListResponse,
  type AdminSubscriberQuery,
  type AdminSubscriberRow,
} from '@/services/api/adminConsoleApi';
import { ApiError } from '@/services/api/client';

export type RosterStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A stable identity for a query. Keys are sorted so `{a,b}` and `{b,a}` are the
 * same request — otherwise a re-render with reordered properties would look like
 * a new query and refetch forever.
 */
export function requestKeyOf(query: Record<string, unknown>): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/** Bumped per store on every load; a response from an older generation is dropped. */
interface Guard {
  generation: number;
  inFlight: AbortController | null;
}

function beginLoad(guard: Guard): { controller: AbortController; isStale: () => boolean } {
  guard.inFlight?.abort();
  const controller = new AbortController();
  guard.inFlight = controller;
  const mine = (guard.generation += 1);
  return { controller, isStale: () => mine !== guard.generation };
}

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

const wasAborted = (cause: unknown): boolean =>
  cause instanceof DOMException && cause.name === 'AbortError';

/* ══ Members ══════════════════════════════════════════════════════════════ */

interface AdminMemberState {
  status: RosterStatus;
  /** The query the CURRENT contents belong to. Never assume otherwise. */
  loadedKey: string | null;
  members: AdminMemberRow[];
  pagination: AdminMemberListResponse['pagination'];
  facets: AdminMemberListResponse['facets'];
  error: string | null;

  /** The open drawer's subject, and the detail that belongs to THAT subject. */
  selectedUserId: string | null;
  detail: AdminMemberDetail | null;
  detailUserId: string | null;
  detailStatus: RosterStatus;
  detailError: string | null;

  load: (query: AdminMemberQuery) => Promise<void>;
  select: (userId: string | null) => Promise<void>;
  reloadDetail: () => Promise<void>;
  clear: () => void;
}

const EMPTY_MEMBERS = {
  members: [] as AdminMemberRow[],
  pagination: { limit: 25, offset: 0, count: 0, total: 0 },
  facets: { accountStatus: {}, organizationRole: {} } as AdminMemberListResponse['facets'],
};

const listGuard: Guard = { generation: 0, inFlight: null };
const detailGuard: Guard = { generation: 0, inFlight: null };

export const useAdminMemberStore = create<AdminMemberState>()((set, get) => ({
  status: 'idle',
  loadedKey: null,
  ...EMPTY_MEMBERS,
  error: null,
  selectedUserId: null,
  detail: null,
  detailUserId: null,
  detailStatus: 'idle',
  detailError: null,

  load: async (query) => {
    const key = requestKeyOf(query as Record<string, unknown>);
    // A different query invalidates everything already loaded, immediately.
    if (get().loadedKey !== key) {
      set({ ...EMPTY_MEMBERS, loadedKey: null, error: null });
    }

    const { controller, isStale } = beginLoad(listGuard);
    set({ status: 'loading', error: null });

    try {
      const result = await adminMemberApi.list(query, controller.signal);
      // Someone changed the filter while this was in flight. Their request owns
      // the store now; this answer describes a query we are no longer showing.
      if (isStale()) return;
      set({
        status: 'ready',
        loadedKey: key,
        members: result.members,
        pagination: result.pagination,
        facets: result.facets,
        error: null,
      });
    } catch (cause) {
      if (isStale() || wasAborted(cause)) return;
      set({
        status: 'error',
        // Keep the roster empty on failure: showing a previous query's people
        // beside the new filter is worse than showing none.
        ...EMPTY_MEMBERS,
        loadedKey: null,
        error: messageFor(cause, 'We could not load the member directory.'),
      });
    } finally {
      if (listGuard.inFlight === controller) listGuard.inFlight = null;
    }
  },

  select: async (userId) => {
    if (!userId) {
      detailGuard.generation += 1;
      detailGuard.inFlight?.abort();
      detailGuard.inFlight = null;
      set({ selectedUserId: null, detail: null, detailUserId: null, detailStatus: 'idle', detailError: null });
      return;
    }

    // Drop the previous member's detail before the new request, so the drawer
    // cannot show Alice's audit trail under Bob's name while loading.
    set({
      selectedUserId: userId,
      detail: null,
      detailUserId: null,
      detailStatus: 'loading',
      detailError: null,
    });

    const { controller, isStale } = beginLoad(detailGuard);
    try {
      const result = await adminMemberApi.get(userId, controller.signal);
      if (isStale()) return;
      // Stamped with the subject it describes; the drawer checks it before rendering.
      set({ detail: result.member, detailUserId: userId, detailStatus: 'ready', detailError: null });
    } catch (cause) {
      if (isStale() || wasAborted(cause)) return;
      set({
        detail: null,
        detailUserId: null,
        detailStatus: 'error',
        detailError: messageFor(cause, 'We could not load this member.'),
      });
    } finally {
      if (detailGuard.inFlight === controller) detailGuard.inFlight = null;
    }
  },

  reloadDetail: async () => {
    const userId = get().selectedUserId;
    if (userId) await get().select(userId);
  },

  clear: () => {
    listGuard.generation += 1;
    listGuard.inFlight?.abort();
    listGuard.inFlight = null;
    detailGuard.generation += 1;
    detailGuard.inFlight?.abort();
    detailGuard.inFlight = null;
    set({
      status: 'idle',
      loadedKey: null,
      ...EMPTY_MEMBERS,
      error: null,
      selectedUserId: null,
      detail: null,
      detailUserId: null,
      detailStatus: 'idle',
      detailError: null,
    });
  },
}));

/* ══ Subscribers ══════════════════════════════════════════════════════════ */

interface AdminSubscriberState {
  status: RosterStatus;
  loadedKey: string | null;
  subscribers: AdminSubscriberRow[];
  pagination: AdminSubscriberListResponse['pagination'];
  statusCounts: Record<string, number>;
  error: string | null;

  load: (query: AdminSubscriberQuery) => Promise<void>;
  clear: () => void;
}

const EMPTY_SUBSCRIBERS = {
  subscribers: [] as AdminSubscriberRow[],
  pagination: { limit: 25, offset: 0, count: 0, total: 0 },
  statusCounts: {} as Record<string, number>,
};

const subscriberGuard: Guard = { generation: 0, inFlight: null };

export const useAdminSubscriberStore = create<AdminSubscriberState>()((set, get) => ({
  status: 'idle',
  loadedKey: null,
  ...EMPTY_SUBSCRIBERS,
  error: null,

  load: async (query) => {
    const key = requestKeyOf(query as Record<string, unknown>);
    if (get().loadedKey !== key) {
      set({ ...EMPTY_SUBSCRIBERS, loadedKey: null, error: null });
    }

    const { controller, isStale } = beginLoad(subscriberGuard);
    set({ status: 'loading', error: null });

    try {
      const result = await adminSubscriberApi.list(query, controller.signal);
      if (isStale()) return;
      set({
        status: 'ready',
        loadedKey: key,
        subscribers: result.subscribers,
        pagination: result.pagination,
        statusCounts: result.statusCounts,
        error: null,
      });
    } catch (cause) {
      if (isStale() || wasAborted(cause)) return;
      set({
        status: 'error',
        ...EMPTY_SUBSCRIBERS,
        loadedKey: null,
        error: messageFor(cause, 'We could not load the subscriber list.'),
      });
    } finally {
      if (subscriberGuard.inFlight === controller) subscriberGuard.inFlight = null;
    }
  },

  clear: () => {
    subscriberGuard.generation += 1;
    subscriberGuard.inFlight?.abort();
    subscriberGuard.inFlight = null;
    set({ status: 'idle', loadedKey: null, ...EMPTY_SUBSCRIBERS, error: null });
  },
}));
