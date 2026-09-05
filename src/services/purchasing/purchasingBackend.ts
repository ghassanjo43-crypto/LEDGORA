/**
 * Where purchase orders, goods receipts and the GRNI schedule actually live.
 *
 * ══ On the server, or nowhere ════════════════════════════════════════════════
 *
 * There is deliberately no browser fallback in this file. A purchase order held
 * in this browser would be a commitment the business has no record of; a
 * receipt held here would look posted, would not be in the books, and would be
 * replaced by the next load — after somebody had already acted on the quantity.
 * So when the server cannot answer, every register here reads EMPTY and the
 * screen says so, rather than showing a figure that came from local storage.
 *
 * Clearing this browser's storage therefore changes nothing about a durable
 * order, receipt, quantity or GRNI balance. There is nothing here to clear.
 *
 * ══ Free Demo ═══════════════════════════════════════════════════════════════
 *
 * Free Demo has no purchase orders at all — the product has never had them in
 * the browser — so there is nothing disposable to preserve and nothing to
 * import. The screens say that plainly instead of offering a local imitation
 * whose numbers no ledger would ever honour.
 *
 * ══ Why writes re-read ═══════════════════════════════════════════════════════
 *
 * Every write goes to the server and then re-lists, rather than patching the
 * cache with what was sent. The server allocates the number, bumps the version,
 * derives the received and remaining quantities and decides the cost; echoing
 * the request would leave the screen disagreeing with the books on the very
 * next save.
 */
import { create } from 'zustand';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';
import {
  purchaseOrdersApi,
  goodsReceiptsApi,
  grniApi,
  type ServerPurchaseOrder,
  type ServerGoodsReceipt,
  type OpenOrderLine,
  type OrderWriteInput,
  type ReceiptWriteInput,
  type GrniSchedule,
  type PurchaseOrderStatus,
  matchingApi,
  type EligibleReceiptLine,
  type MatchHistoryRow,
  type GrniAging,
} from '@/services/api/purchasingApi';

export type RegisterState = 'idle' | 'loading' | 'ready' | 'unavailable';

/** Durable books, or nothing. Advanced purchasing has no browser engine. */
export function purchasingIsServerAuthoritative(): boolean {
  return booksEngine() === 'server';
}

export const PURCHASING_LOCAL_UNSUPPORTED =
  'Purchase orders and goods receipts are held on the server only. This workspace keeps its books '
  + 'in the browser, where there is no purchase-order document and no way to post the inventory a '
  + 'receipt recognises — so nothing here would reach a ledger. Record a stocked purchase on a '
  + 'supplier bill instead.';

export const MATCHING_NOTE =
  'A receipt is settled by posting a supplier bill against it, which clears the '
  + 'goods-received-not-invoiced accrual and recognises the payable and the recoverable input tax. '
  + 'Matching is exact: a bill invoiced at a different value from what the goods were received at '
  + 'is refused, because purchase-price variance has no defined destination under weighted-average '
  + 'costing in this product. Returns, debit notes and supplier credits are not implemented.';

interface PurchasingShape {
  orderState: RegisterState;
  orders: ServerPurchaseOrder[];
  orderError: string | null;

  openState: RegisterState;
  openLines: OpenOrderLine[];

  receiptState: RegisterState;
  receipts: ServerGoodsReceipt[];
  receiptError: string | null;
  /** The server's own word, never a screen's assumption. */
  matchingSupported: boolean;
  matchingNote: string;

  grniState: RegisterState;
  grni: GrniSchedule | null;
  grniError: string | null;

  eligibleState: RegisterState;
  eligible: EligibleReceiptLine[];
  eligibleError: string | null;
  /** The server's own rule, carried rather than restated by a screen. */
  exactValueRequired: boolean;
  varianceNote: string;

  matchState: RegisterState;
  matches: MatchHistoryRow[];

  agingState: RegisterState;
  aging: GrniAging | null;
}

export const usePurchasing = create<PurchasingShape>(() => ({
  orderState: 'idle',
  orders: [],
  orderError: null,
  openState: 'idle',
  openLines: [],
  receiptState: 'idle',
  receipts: [],
  receiptError: null,
  matchingSupported: false,
  matchingNote: MATCHING_NOTE,
  grniState: 'idle',
  grni: null,
  grniError: null,
  eligibleState: 'idle',
  eligible: [],
  eligibleError: null,
  exactValueRequired: true,
  varianceNote: MATCHING_NOTE,
  matchState: 'idle',
  matches: [],
  agingState: 'idle',
  aging: null,
}));

/**
 * Empty every register, synchronously.
 *
 * Called on a company change BEFORE anything is fetched. A buyer spending the
 * loading interval looking at the previous company's open orders is how
 * somebody receives goods against the wrong commitment.
 */
export function clearPurchasingCache(): void {
  usePurchasing.setState({
    orderState: 'idle', orders: [], orderError: null,
    openState: 'idle', openLines: [],
    receiptState: 'idle', receipts: [], receiptError: null,
    matchingSupported: false, matchingNote: MATCHING_NOTE,
    grniState: 'idle', grni: null, grniError: null,
    eligibleState: 'idle', eligible: [], eligibleError: null,
    exactValueRequired: true, varianceNote: MATCHING_NOTE,
    matchState: 'idle', matches: [],
    agingState: 'idle', aging: null,
  });
}

const message = (cause: unknown, fallback: string): string =>
  (cause instanceof Error ? cause.message : fallback);

export async function loadOrders(
  options: { status?: PurchaseOrderStatus; open?: boolean; search?: string } = {},
): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  /* The company can change at any await, and a late answer would list one
   * company's commitments under another company's name. */
  const generation = booksGeneration();
  usePurchasing.setState({ orderState: 'loading', orderError: null });
  try {
    const orders = await purchaseOrdersApi.list({ ...options, limit: 200 });
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ orderState: 'ready', orders, orderError: null });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    /* Empty, and SAID to be empty. Never a local list. */
    usePurchasing.setState({
      orderState: 'unavailable',
      orders: [],
      orderError: message(cause, 'Purchase orders could not be loaded.'),
    });
  }
}

export async function loadOpenLines(): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  const generation = booksGeneration();
  usePurchasing.setState({ openState: 'loading' });
  try {
    const openLines = await purchaseOrdersApi.openLines();
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ openState: 'ready', openLines });
  } catch {
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ openState: 'unavailable', openLines: [] });
  }
}

export async function loadReceipts(
  options: { orderId?: string; awaitingInvoice?: boolean } = {},
): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  const generation = booksGeneration();
  usePurchasing.setState({ receiptState: 'loading', receiptError: null });
  try {
    const answer = await goodsReceiptsApi.list({ ...options, limit: 200 });
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({
      receiptState: 'ready',
      receipts: answer.receipts,
      receiptError: null,
      matchingSupported: answer.matchingSupported,
      matchingNote: answer.note || MATCHING_NOTE,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({
      receiptState: 'unavailable',
      receipts: [],
      receiptError: message(cause, 'Goods receipts could not be loaded.'),
    });
  }
}

export async function loadGrni(options: { asOfDate?: string } = {}): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  const generation = booksGeneration();
  usePurchasing.setState({ grniState: 'loading', grniError: null });
  try {
    const grni = await grniApi.schedule(options);
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ grniState: 'ready', grni, grniError: null });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    /* Never a stale balance: an accrual figure is exactly what somebody acts on. */
    usePurchasing.setState({
      grniState: 'unavailable',
      grni: null,
      grniError: message(cause, 'The received-not-invoiced schedule could not be loaded.'),
    });
  }
}

export async function loadEligibleReceiptLines(
  options: { supplierId?: string; orderId?: string } = {},
): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  const generation = booksGeneration();
  usePurchasing.setState({ eligibleState: 'loading', eligibleError: null });
  try {
    const answer = await matchingApi.eligible(options);
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({
      eligibleState: 'ready',
      eligible: answer.lines,
      eligibleError: null,
      /* The rule comes from the server, so a screen cannot drift from it. */
      exactValueRequired: answer.exactValueRequired,
      varianceNote: answer.varianceNote || MATCHING_NOTE,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    /*
     * Empty, never stale. A capacity figure is exactly what somebody acts on,
     * and offering one another bill has already taken is how a receipt gets
     * cleared twice.
     */
    usePurchasing.setState({
      eligibleState: 'unavailable',
      eligible: [],
      eligibleError: message(cause, 'Eligible goods receipts could not be loaded.'),
    });
  }
}

export async function loadMatchHistory(
  options: { supplierId?: string; billId?: string; receiptId?: string } = {},
): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  const generation = booksGeneration();
  usePurchasing.setState({ matchState: 'loading' });
  try {
    const matches = await matchingApi.history(options);
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ matchState: 'ready', matches });
  } catch {
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ matchState: 'unavailable', matches: [] });
  }
}

export async function loadGrniAging(options: { asOfDate?: string } = {}): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  const generation = booksGeneration();
  usePurchasing.setState({ agingState: 'loading' });
  try {
    const aging = await grniApi.aging(options);
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ agingState: 'ready', aging });
  } catch {
    if (!isCurrentGeneration(generation)) return;
    usePurchasing.setState({ agingState: 'unavailable', aging: null });
  }
}

/**
 * Every write, followed by a re-read of what it touched.
 *
 * Receiving refreshes the orders too, because the order's derived status and
 * remaining quantity changed in the same transaction — and a screen still
 * showing the old remaining quantity is how somebody tries to receive twice.
 */
export const purchasingGateway = {
  createOrder: async (input: OrderWriteInput): Promise<ServerPurchaseOrder> => {
    const order = await purchaseOrdersApi.create(input);
    await Promise.all([loadOrders(), loadOpenLines()]);
    return order;
  },

  updateOrder: async (
    id: string, expectedVersion: number, input: OrderWriteInput,
  ): Promise<ServerPurchaseOrder> => {
    const order = await purchaseOrdersApi.update(id, expectedVersion, input);
    await Promise.all([loadOrders(), loadOpenLines()]);
    return order;
  },

  approveOrder: async (id: string, expectedVersion: number): Promise<ServerPurchaseOrder> => {
    const order = await purchaseOrdersApi.approve(id, expectedVersion);
    await Promise.all([loadOrders(), loadOpenLines()]);
    return order;
  },

  issueOrder: async (id: string, expectedVersion: number): Promise<ServerPurchaseOrder> => {
    const order = await purchaseOrdersApi.issue(id, expectedVersion);
    await Promise.all([loadOrders(), loadOpenLines()]);
    return order;
  },

  closeOrder: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerPurchaseOrder> => {
    const order = await purchaseOrdersApi.close(id, expectedVersion, reason);
    await Promise.all([loadOrders(), loadOpenLines()]);
    return order;
  },

  cancelOrder: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerPurchaseOrder> => {
    const order = await purchaseOrdersApi.cancel(id, expectedVersion, reason);
    await Promise.all([loadOrders(), loadOpenLines()]);
    return order;
  },

  postReceipt: async (
    input: ReceiptWriteInput,
  ): Promise<{ receipt: ServerGoodsReceipt; created: boolean }> => {
    const answer = await goodsReceiptsApi.post(input);
    await Promise.all([loadReceipts(), loadOrders(), loadOpenLines(), loadGrni()]);
    return answer;
  },

  reverseReceipt: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerGoodsReceipt> => {
    const receipt = await goodsReceiptsApi.reverse(id, expectedVersion, reason);
    await Promise.all([loadReceipts(), loadOrders(), loadOpenLines(), loadGrni()]);
    return receipt;
  },

  orderHistory: (id: string) => purchaseOrdersApi.history(id),
  receiptHistory: (id: string) => goodsReceiptsApi.history(id),
};

/**
 * Refreshing everything a posted or reversed supplier bill touched.
 *
 * A matched bill clears an accrual, so the eligible list, the receipts, the
 * GRNI schedule and its ageing all change at once. Calling this from the bill
 * screens keeps a stale capacity figure off the matching screen — which is the
 * figure somebody would otherwise try to bill a second time.
 */
export async function refreshAfterBillChange(): Promise<void> {
  if (!purchasingIsServerAuthoritative()) return;
  await Promise.all([
    loadEligibleReceiptLines(),
    loadMatchHistory(),
    loadReceipts(),
    loadGrni(),
    loadGrniAging(),
  ]);
}

/**
 * A fresh idempotency key for one attempt at one delivery.
 *
 * Minted where the user presses the button, not inside the gateway: a retry of
 * the SAME attempt must carry the SAME key, and a gateway that generated one
 * per call would make every retry a second delivery — which is the failure the
 * key exists to prevent.
 */
export function newReceiptKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `gr-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
