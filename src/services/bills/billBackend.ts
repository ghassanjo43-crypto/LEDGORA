/**
 * Where a company's bills actually live, and what the browser may still do.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 * A durable subscriber's bills are rows in PostgreSQL; this module holds a
 * CACHE of the last answer and decides nothing. Free Demo keeps its bills in
 * `useBillStore`, which is not a lesser path but the only correct one: there is
 * nothing on a server to read, and a demo workspace's records are the originals.
 *
 * The verdict comes from `booksEngine`, the same latched decision the chart, the
 * journal, the invoices, the tax codes and the supplier directory use.
 *
 * ══ Why there is no local fallback ═══════════════════════════════════════════
 *
 * A failed load reports itself and shows nothing. It does NOT fall back to
 * `useBillStore`, whose bills belong to a demo seed — showing them would put
 * invented liabilities in a real subscriber's payables list, and posting one
 * would credit a supplier the books do not have.
 *
 * Nothing here reaches `localStorage`. Clearing browser storage loses a cache
 * and not a bill.
 *
 * ══ What P2 does NOT bring, and what that means for the browser ══════════════
 *
 * Payments, supplier credits, attachments, amendments and approval transitions
 * have no server path. On durable books they are REFUSED rather than written
 * locally: a local write against a server-held bill appears to save and is
 * replaced by the next load without a word, which is the failure mode this
 * whole cutover exists to remove.
 */
import { create } from 'zustand';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';
import {
  billsApi,
  type ServerBill,
  type BillWriteInput,
} from '@/services/api/billsApi';

export type BillBackend = 'browser' | 'server';

/** Which store answers. One workspace cannot split its books from its bills. */
export function billBackend(): BillBackend {
  return booksEngine() === 'server' ? 'server' : 'browser';
}

export function billsAreServerAuthoritative(): boolean {
  return billBackend() === 'server';
}

export type BillDirectoryState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface DirectoryStore {
  state: BillDirectoryState;
  bills: ServerBill[];
  error: string | null;
  search: string;
}

export const useServerBills = create<DirectoryStore>(() => ({
  state: 'idle',
  bills: [],
  error: null,
  search: '',
}));

/**
 * Empty the cache, synchronously.
 *
 * Called on a company change BEFORE anything is fetched. A bookkeeper spending
 * the loading interval looking at the previous company's payables is how
 * somebody pays the wrong supplier.
 */
export function clearBillCache(): void {
  useServerBills.setState({ state: 'idle', bills: [], error: null, search: '' });
}

/**
 * Load the bills for the open company.
 *
 * A response is applied only if the books generation that issued it is still
 * current. The company can change at any await, and applying a late answer
 * would list one company's liabilities under another company's name.
 */
export async function loadBills(options: { search?: string } = {}): Promise<void> {
  if (!billsAreServerAuthoritative()) return;

  const generation = booksGeneration();
  const search = options.search ?? '';
  useServerBills.setState({ state: 'loading', error: null, search });

  try {
    const bills = await billsApi.list({ search: search || undefined, limit: 200 });
    if (!isCurrentGeneration(generation)) return;
    useServerBills.setState({ state: 'ready', bills, error: null, search });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useServerBills.setState({
      state: 'unavailable',
      error: cause instanceof Error ? cause.message : 'Could not load bills.',
    });
  }
}

/**
 * The write path.
 *
 * Every one of these goes to the server and then re-reads, rather than patching
 * the cache with what was sent: the server allocates the number, bumps the
 * version, computes the totals and may normalise a value, and echoing the
 * request would leave the screen disagreeing with the books.
 */
export const billGateway = {
  create: async (
    input: BillWriteInput & { issuingEntityId: string; supplierId: string },
  ): Promise<ServerBill> => {
    const created = await billsApi.create(input);
    await loadBills({ search: useServerBills.getState().search });
    return created;
  },

  update: async (
    id: string,
    expectedVersion: number,
    input: BillWriteInput & { supplierId?: string },
  ): Promise<ServerBill> => {
    const updated = await billsApi.update(id, expectedVersion, input);
    await loadBills({ search: useServerBills.getState().search });
    return updated;
  },

  remove: async (id: string, expectedVersion: number): Promise<void> => {
    await billsApi.remove(id, expectedVersion);
    await loadBills({ search: useServerBills.getState().search });
  },

  post: async (
    id: string,
    expectedVersion: number,
    options: { overrideDuplicate?: boolean } = {},
  ): Promise<ServerBill> => {
    const posted = await billsApi.post(id, expectedVersion, options);
    await loadBills({ search: useServerBills.getState().search });
    return posted;
  },

  reverse: async (id: string, expectedVersion: number, reason: string): Promise<ServerBill> => {
    const reversed = await billsApi.reverse(id, expectedVersion, reason);
    await loadBills({ search: useServerBills.getState().search });
    return reversed;
  },
};

/** The server bill behind a row, for its version. */
export function serverBillById(id: string): ServerBill | undefined {
  return useServerBills.getState().bills.find((bill) => bill.id === id);
}

/* ══ What the browser may no longer do on durable books ════════════════════ */

export const PAYMENTS_UNSUPPORTED =
  'Recording a payment against a server-held bill is not available yet. Supplier payments, '
  + 'allocations and settlement are a later Purchasing step; until then a bill records what is '
  + 'owed, and nothing here clears it.';

export const CREDITS_UNSUPPORTED =
  'Supplier credits against a server-held bill are not available yet. A credit reverses part of a '
  + 'posted purchase and needs its own accounting, which is a later Purchasing step.';

export const ATTACHMENTS_UNSUPPORTED =
  'Attachments on a server-held bill are not available yet: there is no durable storage for them, '
  + 'so a file kept in this browser would vanish the moment it was cleared.';

export const AMENDMENT_UNSUPPORTED =
  'Amending a server-held bill is not available yet. A posted bill is corrected by reversing it '
  + 'and recording a new one, which keeps both entries visible.';

export const APPROVAL_UNSUPPORTED =
  'Submitting and approving a server-held bill is not available yet. There is no approval workflow '
  + 'on the server, and a status it can set but never honour would be worse than none.';
