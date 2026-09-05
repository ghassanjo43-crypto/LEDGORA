/**
 * The browser's client for server-held purchase orders, goods receipts and the
 * received-not-invoiced schedule.
 *
 * Money and quantity arrive as exact decimal STRINGS and stay strings all the
 * way through. Parsing them to `number` here would lose the third place before
 * any screen saw it, and a receipt value that quietly became 12.49 would be the
 * figure a bookkeeper reconciled against.
 *
 * There is no local posting path behind any of this and no browser fallback: a
 * purchase order, a receipt, a quantity or a GRNI balance kept in this browser
 * would be a figure the books have never seen, and the moment somebody acted on
 * it the mistake would already be in the ledger.
 */
import { api } from './client';

export type PurchaseOrderStatus =
  | 'draft' | 'approved' | 'issued' | 'partially_received' | 'received' | 'closed' | 'cancelled';

export type GoodsReceiptStatus = 'posted' | 'reversed';

export interface ServerOrderLine {
  id: string;
  lineNumber: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  description: string;
  /** Exact decimal strings throughout. */
  orderedQuantity: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string;
  discountAmount: string;
  lineSubtotal: string;
  lineNet: string;
  taxCodeId: string | null;
  /** Commercial expectation only. Never a statutory tax figure. */
  estimatedTaxRate: string;
  estimatedTaxCategory: string | null;
  estimatedTaxMethod: string | null;
  estimatedTaxAmount: string;
  /** What a receipt of the whole line costs, net of recoverable input tax. */
  netAmount: string;
  grossAmount: string;
  /** Derived by the server from posted receipts. Never stored, never sent. */
  receivedQuantity: string;
  remainingQuantity: string;
  receivedValue: string;
}

export interface ServerPurchaseOrder {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  orderDate: string;
  expectedDate: string | null;
  status: PurchaseOrderStatus;
  currency: string;
  supplierReference: string;
  memo: string;
  subtotal: string;
  discountTotal: string;
  estimatedTaxTotal: string;
  total: string;
  approvedAt: string | null;
  issuedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  closureReason: string;
  version: number;
  createdAt: string | null;
  lines: ServerOrderLine[];
}

export interface OrderLineInput {
  itemId: string;
  warehouseId: string;
  description?: string;
  quantity: string;
  unitPrice: string;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: string | null;
  taxCodeId?: string | null;
}

export interface OrderWriteInput {
  supplierId: string;
  orderDate: string;
  expectedDate?: string | null;
  supplierReference?: string;
  memo?: string;
  lines: OrderLineInput[];
}

export interface OpenOrderLine {
  orderId: string;
  orderNumber: string;
  orderDate: string;
  expectedDate: string | null;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierName: string;
  orderLineId: string;
  lineNumber: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  orderedQuantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
  netAmount: string;
  receivedValue: string;
  remainingValue: string;
}

export interface ServerReceiptLine {
  id: string;
  lineNumber: number;
  orderLineId: string;
  orderLineNumber: number | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  receivedQuantity: string;
  unitCost: string;
  totalCost: string;
  movementId: string | null;
}

export interface ServerGoodsReceipt {
  id: string;
  receiptNumber: string;
  orderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  receiptDate: string;
  postingDate: string;
  deliveryNoteReference: string;
  memo: string;
  status: GoodsReceiptStatus;
  totalValue: string;
  inventoryDocumentId: string | null;
  inventoryDocumentNumber: string | null;
  journalEntryId: string | null;
  reversalDocumentId: string | null;
  reversalReason: string;
  reversedAt: string | null;
  /** Always false: nothing in this product can match a receipt to an invoice. */
  matched: false;
  version: number;
  createdAt: string | null;
  lines: ServerReceiptLine[];
}

export interface ReceiptWriteInput {
  orderId: string;
  receiptDate: string;
  postingDate?: string;
  deliveryNoteReference?: string;
  memo?: string;
  /** Belongs to the ATTEMPT: a retry must carry the same key. */
  idempotencyKey: string;
  /** An order line and a quantity. Nothing else is accepted by the server. */
  lines: Array<{ orderLineId: string; quantity: string }>;
}

export interface GrniRow {
  documentId: string;
  documentNumber: string;
  documentKind: string;
  postingDate: string;
  receiptId: string | null;
  receiptNumber: string | null;
  orderId: string | null;
  orderNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  quantity: string;
  value: string;
  matched: false;
}

export interface GrniSchedule {
  asOfDate: string | null;
  rows: GrniRow[];
  total: string;
  generalLedgerBalance: string;
  difference: string;
  balanced: boolean;
  matchingImplemented: false;
}

export interface PurchasingAuditEvent {
  id: string;
  action: string;
  detail: unknown;
  previousVersion: number | null;
  resultingVersion: number | null;
  actorUserId: string | null;
  actorName: string;
  at: string | null;
}

const query = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const purchaseOrdersApi = {
  list: async (params: {
    status?: PurchaseOrderStatus; supplierId?: string; open?: boolean;
    search?: string; limit?: number;
  } = {}): Promise<ServerPurchaseOrder[]> =>
    (await api.get<{ orders: ServerPurchaseOrder[] }>(
      `/api/purchasing/orders${query(params)}`,
    )).orders,

  get: async (id: string): Promise<ServerPurchaseOrder> =>
    (await api.get<{ order: ServerPurchaseOrder }>(`/api/purchasing/orders/${id}`)).order,

  history: async (id: string): Promise<PurchasingAuditEvent[]> =>
    (await api.get<{ events: PurchasingAuditEvent[] }>(
      `/api/purchasing/orders/${id}/history`,
    )).events,

  /** Every order line with something still to come. Derived, never stored. */
  openLines: async (params: {
    supplierId?: string; itemId?: string; warehouseId?: string;
  } = {}): Promise<OpenOrderLine[]> =>
    (await api.get<{ lines: OpenOrderLine[] }>(
      `/api/purchasing/orders/open-lines${query(params)}`,
    )).lines,

  create: async (input: OrderWriteInput): Promise<ServerPurchaseOrder> =>
    (await api.post<{ order: ServerPurchaseOrder }>('/api/purchasing/orders', input)).order,

  update: async (
    id: string, expectedVersion: number, input: OrderWriteInput,
  ): Promise<ServerPurchaseOrder> =>
    (await api.patch<{ order: ServerPurchaseOrder }>(
      `/api/purchasing/orders/${id}`, { ...input, expectedVersion },
    )).order,

  approve: async (id: string, expectedVersion: number): Promise<ServerPurchaseOrder> =>
    (await api.post<{ order: ServerPurchaseOrder }>(
      `/api/purchasing/orders/${id}/approve`, { expectedVersion },
    )).order,

  issue: async (id: string, expectedVersion: number): Promise<ServerPurchaseOrder> =>
    (await api.post<{ order: ServerPurchaseOrder }>(
      `/api/purchasing/orders/${id}/issue`, { expectedVersion },
    )).order,

  close: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerPurchaseOrder> =>
    (await api.post<{ order: ServerPurchaseOrder }>(
      `/api/purchasing/orders/${id}/close`, { expectedVersion, reason },
    )).order,

  cancel: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerPurchaseOrder> =>
    (await api.post<{ order: ServerPurchaseOrder }>(
      `/api/purchasing/orders/${id}/cancel`, { expectedVersion, reason },
    )).order,
};

export const goodsReceiptsApi = {
  list: async (params: {
    orderId?: string; supplierId?: string; status?: GoodsReceiptStatus;
    awaitingInvoice?: boolean; limit?: number;
  } = {}): Promise<{ receipts: ServerGoodsReceipt[]; matchingSupported: boolean; note: string }> => {
    const answer = await api.get<{
      receipts: ServerGoodsReceipt[]; matchingSupported: boolean; matchingNote: string;
    }>(`/api/purchasing/receipts${query(params)}`);
    return {
      receipts: answer.receipts,
      /* The server's own word on matching, rather than an assumption a screen
       * made. A client that inferred "settled" from an absent field would show
       * somebody a state the books cannot reach. */
      matchingSupported: answer.matchingSupported,
      note: answer.matchingNote,
    };
  },

  get: async (id: string): Promise<ServerGoodsReceipt> =>
    (await api.get<{ receipt: ServerGoodsReceipt }>(`/api/purchasing/receipts/${id}`)).receipt,

  history: async (id: string): Promise<PurchasingAuditEvent[]> =>
    (await api.get<{ events: PurchasingAuditEvent[] }>(
      `/api/purchasing/receipts/${id}/history`,
    )).events,

  post: async (
    input: ReceiptWriteInput,
  ): Promise<{ receipt: ServerGoodsReceipt; created: boolean }> =>
    api.post<{ receipt: ServerGoodsReceipt; created: boolean }>('/api/purchasing/receipts', input),

  reverse: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerGoodsReceipt> =>
    (await api.post<{ receipt: ServerGoodsReceipt }>(
      `/api/purchasing/receipts/${id}/reverse`, { expectedVersion, reason },
    )).receipt,
};

export const grniApi = {
  schedule: async (params: {
    asOfDate?: string; supplierId?: string; itemId?: string;
  } = {}): Promise<GrniSchedule> =>
    api.get<GrniSchedule>(`/api/purchasing/grni${query(params)}`),
};
