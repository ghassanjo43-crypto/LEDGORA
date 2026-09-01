/**
 * Where a company's supplier payments actually live.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 * A durable subscriber's payments are rows in PostgreSQL; this module holds a
 * CACHE of the last answer and decides nothing. Free Demo keeps its payments in
 * `usePaymentStore`, which is not a lesser path but the only correct one: there
 * is nothing on a server to read, and a demo workspace's records are the
 * originals.
 *
 * The verdict comes from `booksEngine`, the same latched decision the chart, the
 * journal, the invoices, the tax codes, the supplier directory and the bills use.
 *
 * ══ Why there is no local fallback ═══════════════════════════════════════════
 *
 * A failed load reports itself and shows nothing. It does NOT fall back to
 * `usePaymentStore`, whose payments belong to a demo seed — showing them would
 * claim a real subscriber's bills had been settled by money that never left a
 * bank, and the payables list would understate what is owed.
 *
 * Nothing here reaches `localStorage`. Clearing browser storage loses a cache
 * and not a payment.
 *
 * ══ What P4 does NOT bring ═══════════════════════════════════════════════════
 *
 * Unapplied cash, supplier advances, overpayments, bank fees, settlement
 * discounts, withholding, foreign-currency settlement, cheque clearing,
 * attachments and approval transitions have no server path. On durable books
 * they are REFUSED rather than written locally: a local write against a
 * server-held payment appears to save and is replaced by the next load without
 * a word, which is the failure mode this whole cutover exists to remove.
 */
import { create } from 'zustand';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';
import {
  paymentsApi,
  type ServerPayment,
  type ServerOutstandingBill,
  type ServerAgedPayables,
  type PaymentWriteInput,
  type PaymentAllocationInput,
} from '@/services/api/paymentsApi';

export type PaymentBackend = 'browser' | 'server';

/** Which store answers. One workspace cannot split its books from its payments. */
export function paymentBackend(): PaymentBackend {
  return booksEngine() === 'server' ? 'server' : 'browser';
}

export function paymentsAreServerAuthoritative(): boolean {
  return paymentBackend() === 'server';
}

export type PaymentDirectoryState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface DirectoryStore {
  state: PaymentDirectoryState;
  payments: ServerPayment[];
  error: string | null;
  search: string;
  /** What is still owed, as the server derived it — never computed here. */
  outstanding: ServerOutstandingBill[];
  aging: ServerAgedPayables | null;
}

export const useServerPayments = create<DirectoryStore>(() => ({
  state: 'idle',
  payments: [],
  error: null,
  search: '',
  outstanding: [],
  aging: null,
}));

/**
 * Empty the cache, synchronously.
 *
 * Called on a company change BEFORE anything is fetched. A bookkeeper spending
 * the loading interval looking at the previous company's payments is how
 * somebody pays the same supplier twice.
 */
export function clearPaymentCache(): void {
  useServerPayments.setState({
    state: 'idle', payments: [], error: null, search: '', outstanding: [], aging: null,
  });
}

/**
 * Load the payments and the outstanding schedule for the open company.
 *
 * A response is applied only if the books generation that issued it is still
 * current. The company can change at any await, and applying a late answer
 * would list one company's payments under another company's name.
 */
export async function loadPayments(options: { search?: string } = {}): Promise<void> {
  if (!paymentsAreServerAuthoritative()) return;

  const generation = booksGeneration();
  const search = options.search ?? '';
  useServerPayments.setState({ state: 'loading', error: null, search });

  try {
    const [payments, payables] = await Promise.all([
      paymentsApi.list({ search: search || undefined, limit: 200 }),
      paymentsApi.payables(),
    ]);
    if (!isCurrentGeneration(generation)) return;
    useServerPayments.setState({
      state: 'ready',
      payments,
      error: null,
      search,
      outstanding: payables.outstanding,
      aging: payables.aging,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useServerPayments.setState({
      state: 'unavailable',
      error: cause instanceof Error ? cause.message : 'Could not load payments.',
    });
  }
}

/**
 * The write path.
 *
 * Every one of these goes to the server and then re-reads, rather than patching
 * the cache with what was sent: the server allocates the number, bumps the
 * version, derives every bill balance from the allocations and may normalise a
 * value, and echoing the request would leave the screen disagreeing with the
 * books.
 */
export const paymentGateway = {
  create: async (
    input: PaymentWriteInput & { issuingEntityId: string; supplierId: string },
  ): Promise<ServerPayment> => {
    const created = await paymentsApi.create(input);
    await loadPayments({ search: useServerPayments.getState().search });
    return created;
  },

  update: async (
    id: string,
    expectedVersion: number,
    input: PaymentWriteInput & { supplierId?: string },
  ): Promise<ServerPayment> => {
    const updated = await paymentsApi.update(id, expectedVersion, input);
    await loadPayments({ search: useServerPayments.getState().search });
    return updated;
  },

  remove: async (id: string, expectedVersion: number): Promise<void> => {
    await paymentsApi.remove(id, expectedVersion);
    await loadPayments({ search: useServerPayments.getState().search });
  },

  /** Posting carries the allocations: a payment is not postable part-applied. */
  post: async (
    id: string,
    expectedVersion: number,
    allocations: PaymentAllocationInput[],
  ): Promise<ServerPayment> => {
    const posted = await paymentsApi.post(id, expectedVersion, allocations);
    await loadPayments({ search: useServerPayments.getState().search });
    return posted;
  },

  /** The complete replacement — the only correction short of a reversal. */
  reallocate: async (
    id: string,
    expectedVersion: number,
    allocations: PaymentAllocationInput[],
  ): Promise<ServerPayment> => {
    const moved = await paymentsApi.reallocate(id, expectedVersion, allocations);
    await loadPayments({ search: useServerPayments.getState().search });
    return moved;
  },

  reverse: async (id: string, expectedVersion: number, reason: string): Promise<ServerPayment> => {
    const reversed = await paymentsApi.reverse(id, expectedVersion, reason);
    await loadPayments({ search: useServerPayments.getState().search });
    return reversed;
  },
};

/** The server payment behind a row, for its version. */
export function serverPaymentById(id: string): ServerPayment | undefined {
  return useServerPayments.getState().payments.find((payment) => payment.id === id);
}

/** What a bill still owes, as the server derived it. Never recomputed here. */
export function outstandingForBill(billId: string): ServerOutstandingBill | undefined {
  return useServerPayments.getState().outstanding.find((row) => row.billId === billId);
}

/**
 * The bills one payment may settle: same supplier, same currency, still owing.
 *
 * A SUGGESTION for a screen, not a rule the server applies — the server locks
 * each bill and revalidates every allocation regardless of what was offered
 * here, because this list can be stale the moment it is rendered.
 */
export function eligibleBillsFor(supplierId: string, currency: string): ServerOutstandingBill[] {
  return useServerPayments.getState().outstanding.filter((row) => (
    row.supplierId === supplierId
    && row.currency.toUpperCase() === currency.toUpperCase()
  ));
}

/* ══ What the browser may no longer do on durable books ════════════════════ */

export const UNAPPLIED_UNSUPPORTED =
  'A payment must be allocated in full to posted bills. Unapplied cash, supplier advances and '
  + 'overpayments are not available: there is no controlled advances account and no supplier-refund '
  + 'workflow, so a leftover balance would be money with nowhere defined to sit. Allocate the whole '
  + 'amount, or record a smaller payment.';

export const UNALLOCATE_UNSUPPORTED =
  'A posted payment cannot simply be detached from a bill, because that would leave an unapplied '
  + 'balance the books have no account for. Either reallocate the full amount to other posted bills '
  + 'for the same supplier, or reverse the payment.';

export const BILL_REVERSAL_BLOCKED =
  'A bill that a posted payment settles cannot be reversed: it would debit accounts payable a '
  + 'second time against a single credit, understating what is owed. Reverse the payment first, or '
  + 'reallocate its full amount to other posted bills for the same supplier.';

export const ADJUSTMENTS_UNSUPPORTED =
  'Bank fees, settlement discounts, withholding tax, realised exchange differences and write-offs '
  + 'on a server-held payment are not available yet. Each needs its own controlled account, and '
  + 'posting the difference somewhere plausible would put a number in the ledger nobody chose.';

export const FOREIGN_CURRENCY_UNSUPPORTED =
  'Paying a supplier in a currency other than the functional one is not available yet: exchange '
  + 'rates and realised exchange differences are still kept in this browser, so the server cannot '
  + 'justify a converted amount.';

export const ATTACHMENTS_UNSUPPORTED =
  'Attachments on a server-held payment are not available yet: there is no durable storage for '
  + 'them, so a file kept in this browser would vanish the moment it was cleared.';

export const APPROVAL_UNSUPPORTED =
  'Submitting and approving a server-held payment is not available yet. There is no approval '
  + 'workflow on the server, and a status it can set but never honour would be worse than none.';
