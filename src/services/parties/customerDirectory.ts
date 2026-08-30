/**
 * Where a company's customers actually live.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 * A durable subscriber's customers are rows in PostgreSQL; this module holds a
 * CACHE of the last answer and decides nothing. Free Demo keeps its records in
 * `useEntityStore`, which is not a lesser path but the only correct one: there
 * is nothing on a server to read.
 *
 * The verdict comes from `booksEngine`, the same latched decision the chart of
 * accounts and the journal use, so one workspace cannot have its accounts on
 * the server and its customers in the browser.
 *
 * ══ Why there is no local fallback ═══════════════════════════════════════════
 *
 * A failed load leaves the previous answer on screen and reports itself. It does
 * NOT fall back to `useEntityStore`, because that store holds a different
 * company's demo seed data — showing it would put invented customers in a real
 * subscriber's picker, and the first invoice raised against one would name a
 * customer that does not exist.
 *
 * Writes have no fallback either. If the server refuses, the write failed; it is
 * never quietly kept in the browser, because a local write appears to save and
 * the next hydration replaces it without a word.
 *
 * ══ Hydration REPLACES ══════════════════════════════════════════════════════
 *
 * Whatever the server returns IS the customer directory. A merge would let a
 * local record with no server counterpart survive, which is exactly how a
 * browser-only customer outlives the cutover and starts appearing on documents.
 *
 * Supplier-role parties are untouched by any of this. They are not migrated yet,
 * they are read from `useEntityStore` by the purchasing screens exactly as
 * before, and this module never writes to that store.
 */
import { create } from 'zustand';
import { customersApi, type ServerBusinessParty, type CustomerWriteInput } from '@/services/api/customersApi';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksScope';

export type CustomerDirectoryState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface DirectoryStore {
  state: CustomerDirectoryState;
  customers: ServerBusinessParty[];
  error: string | null;
  /** The search the cache currently answers, so a screen can tell. */
  search: string;
}

/**
 * The cache, deliberately NOT persisted.
 *
 * Nothing here reaches `localStorage`. A durable subscriber's customers are
 * re-read from the server on load, so clearing browser storage loses a cache
 * and not a customer — which is the whole point of moving them.
 */
export const useCustomerDirectory = create<DirectoryStore>(() => ({
  state: 'idle',
  customers: [],
  error: null,
  search: '',
}));

/** True when the server owns this workspace's customers. */
export function customersAreServerAuthoritative(): boolean {
  return booksEngine() === 'server';
}

/**
 * Empty the cache, synchronously.
 *
 * Called on a company change BEFORE anything is fetched. A bookkeeper spending
 * the loading interval looking at the previous company's customers is how
 * somebody invoices the wrong party, so the stale answer goes immediately
 * rather than when its replacement arrives.
 */
export function clearCustomerCache(): void {
  useCustomerDirectory.setState({ state: 'idle', customers: [], error: null, search: '' });
}

/**
 * Load the directory for the open company.
 *
 * A response is applied only if the books generation that issued it is still
 * current. The company can change at any await, and applying a late answer
 * would list one company's customers under another company's name.
 */
export async function loadCustomers(options: { search?: string } = {}): Promise<void> {
  if (!customersAreServerAuthoritative()) return;

  const generation = booksGeneration();
  const search = options.search ?? '';
  useCustomerDirectory.setState({ state: 'loading', error: null, search });

  try {
    const page = await customersApi.list({ search: search || undefined, limit: 200 });
    if (!isCurrentGeneration(generation)) return;
    useCustomerDirectory.setState({ state: 'ready', customers: page.parties, error: null, search });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useCustomerDirectory.setState({
      state: 'unavailable',
      error: cause instanceof Error ? cause.message : 'Could not load customers.',
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
export const customerGateway = {
  create: async (input: CustomerWriteInput): Promise<ServerBusinessParty> => {
    const created = await customersApi.create(input);
    await loadCustomers({ search: useCustomerDirectory.getState().search });
    return created;
  },

  update: async (
    id: string,
    input: CustomerWriteInput & { expectedVersion: number },
  ): Promise<ServerBusinessParty> => {
    const updated = await customersApi.update(id, input);
    await loadCustomers({ search: useCustomerDirectory.getState().search });
    return updated;
  },

  setArchived: async (
    id: string,
    input: { archived: boolean; expectedVersion: number; reason?: string },
  ): Promise<ServerBusinessParty> => {
    const changed = await customersApi.setArchived(id, input);
    await loadCustomers({ search: useCustomerDirectory.getState().search });
    return changed;
  },
};
