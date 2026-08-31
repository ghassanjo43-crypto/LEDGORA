/**
 * Where a company's suppliers actually live.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 * A durable subscriber's suppliers are rows in PostgreSQL; this module holds a
 * CACHE of the last answer and decides nothing. Free Demo keeps its records in
 * `useEntityStore`, which is not a lesser path but the only correct one: there
 * is nothing on a server to read.
 *
 * The verdict comes from `booksEngine`, the same latched decision the chart of
 * accounts, the journal, the invoices and the customer directory use, so one
 * workspace cannot have its accounts on the server and its suppliers in a tab.
 *
 * ══ Why there is no local fallback ═══════════════════════════════════════════
 *
 * A failed load leaves the previous answer on screen and reports itself. It does
 * NOT fall back to `useEntityStore`, because that store holds demo seed data —
 * showing it would put invented suppliers in a real subscriber's picker, and a
 * bill raised against one would name a supplier that does not exist.
 *
 * Writes have no fallback either. If the server refuses, the write failed; it is
 * never quietly kept in the browser, because a local write appears to save and
 * the next hydration replaces it without a word.
 *
 * ══ Hydration REPLACES ══════════════════════════════════════════════════════
 *
 * Whatever the server returns IS the supplier directory. A merge would let a
 * local record with no server counterpart survive, which is exactly how a
 * browser-only supplier outlives the cutover and starts appearing on documents.
 *
 * ══ What is deliberately NOT cached ══════════════════════════════════════════
 *
 * Nothing here reaches `localStorage`. Clearing browser storage loses a cache
 * and not a supplier, which is the whole point of moving them.
 */
import { create } from 'zustand';
import {
  suppliersApi,
  type ServerSupplierParty,
  type SupplierWriteInput,
} from '@/services/api/suppliersApi';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';

export type SupplierDirectoryState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface DirectoryStore {
  state: SupplierDirectoryState;
  suppliers: ServerSupplierParty[];
  error: string | null;
  /** The search the cache currently answers, so a screen can tell. */
  search: string;
  /**
   * How many suppliers these books hold, ignoring the search.
   *
   * Read separately so an empty LIST can be explained: "no suppliers yet" and
   * "none match that search" are different sentences, and so is "you have
   * suppliers in this browser that were never imported".
   */
  total: number | null;
}

export const useSupplierDirectory = create<DirectoryStore>(() => ({
  state: 'idle',
  suppliers: [],
  error: null,
  search: '',
  total: null,
}));

/** True when the server owns this workspace's suppliers. */
export function suppliersAreServerAuthoritative(): boolean {
  return booksEngine() === 'server';
}

/**
 * Empty the cache, synchronously.
 *
 * Called on a company change BEFORE anything is fetched. A bookkeeper spending
 * the loading interval looking at the previous company's suppliers is how
 * somebody bills the wrong party, so the stale answer goes immediately rather
 * than when its replacement arrives.
 */
export function clearSupplierCache(): void {
  useSupplierDirectory.setState({
    state: 'idle', suppliers: [], error: null, search: '', total: null,
  });
}

/**
 * Load the directory for the open company.
 *
 * A response is applied only if the books generation that issued it is still
 * current. The company can change at any await, and applying a late answer
 * would list one company's suppliers under another company's name.
 */
export async function loadSuppliers(options: { search?: string } = {}): Promise<void> {
  if (!suppliersAreServerAuthoritative()) return;

  const generation = booksGeneration();
  const search = options.search ?? '';
  useSupplierDirectory.setState({ state: 'loading', error: null, search });

  try {
    const page = await suppliersApi.list({ search: search || undefined, limit: 200 });
    if (!isCurrentGeneration(generation)) return;

    /* The unfiltered count, so an empty search result and an empty directory
     * can be told apart on screen. A failure here is not fatal to the list. */
    let total: number | null = null;
    try {
      total = await suppliersApi.count();
    } catch {
      total = null;
    }
    if (!isCurrentGeneration(generation)) return;

    useSupplierDirectory.setState({
      state: 'ready', suppliers: page.parties, error: null, search, total,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useSupplierDirectory.setState({
      state: 'unavailable',
      error: cause instanceof Error ? cause.message : 'Could not load suppliers.',
    });
  }
}

/**
 * The write path.
 *
 * Every one of these goes to the server and then re-reads, rather than patching
 * the cache with what was sent: the server allocates the id, bumps the version
 * and may normalise a value, and echoing the request would leave the screen
 * disagreeing with the directory until the next reload.
 */
export const supplierGateway = {
  create: async (input: SupplierWriteInput): Promise<ServerSupplierParty> => {
    const created = await suppliersApi.create(input);
    await loadSuppliers({ search: useSupplierDirectory.getState().search });
    return created;
  },

  update: async (
    id: string,
    input: SupplierWriteInput & { expectedVersion: number },
  ): Promise<ServerSupplierParty> => {
    const updated = await suppliersApi.update(id, input);
    await loadSuppliers({ search: useSupplierDirectory.getState().search });
    return updated;
  },

  setArchived: async (
    id: string,
    input: { archived: boolean; expectedVersion: number; reason?: string },
  ): Promise<ServerSupplierParty> => {
    const changed = await suppliersApi.setArchived(id, input);
    await loadSuppliers({ search: useSupplierDirectory.getState().search });
    return changed;
  },

  grantSupplierRole: async (
    id: string,
    input: { expectedVersion: number; supplier?: Partial<ServerSupplierParty['supplier']> },
  ): Promise<ServerSupplierParty> => {
    const granted = await suppliersApi.grantSupplierRole(id, input as never);
    await loadSuppliers({ search: useSupplierDirectory.getState().search });
    return granted;
  },
};
