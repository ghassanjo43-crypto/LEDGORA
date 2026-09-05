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

export const MATCHING_UNSUPPORTED =
  'Matching a receipt to a supplier invoice is not available yet. Every posted receipt is awaiting '
  + 'one, and the goods-received-not-invoiced balance is what the business has taken in and not yet '
  + 'been invoiced for.';

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
  matchingNote: MATCHING_UNSUPPORTED,
  grniState: 'idle',
  grni: null,
  grniError: null,
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
    matchingSupported: false, matchingNote: MATCHING_UNSUPPORTED,
    grniState: 'idle', grni: null, grniError: null,
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
      matchingNote: answer.note || MATCHING_UNSUPPORTED,
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
