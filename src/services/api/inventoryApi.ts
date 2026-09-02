/**
 * The browser's client for the server-held item, unit and warehouse registers.
 *
 * Money and quantity arrive as exact decimal STRINGS and stay strings all the
 * way through this module. Parsing them to `number` here would lose the third
 * place before any screen ever saw it, and a default price that quietly became
 * 12.49 would be copied onto invoice lines for as long as the item existed.
 *
 * There is no quantity endpoint, no balance and no valuation: I1 is master data.
 * Stock arrives with the movement ledger.
 */
import { api } from './client';

export type ItemType =
  | 'inventory' | 'non-inventory' | 'service' | 'raw-material' | 'component'
  | 'subassembly' | 'finished-good' | 'packaging' | 'consumable' | 'spare-part' | 'scrap';

export type MasterDataStatus = 'active' | 'inactive' | 'archived';

export interface ServerItem {
  id: string;
  itemCode: string;
  barcode: string | null;
  name: string;
  nameSecondary: string;
  description: string;
  itemType: ItemType;
  isInventoryTracked: boolean;
  isPurchasable: boolean;
  isSellable: boolean;
  trackingMode: 'none' | 'lot' | 'serial';
  valuationMethod: 'weighted-average' | 'standard' | 'fifo';
  baseUnitId: string;
  baseUnitCode: string;
  baseUnitDecimalPlaces: number;
  /** Exact decimal strings, or null. Defaults only — never a posted figure. */
  defaultSellingPrice: string | null;
  defaultPurchasePrice: string | null;
  standardCost: string | null;
  salesDescription: string;
  purchaseDescription: string;
  salesTaxCodeId: string | null;
  purchaseTaxCodeId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  salesAccountId: string | null;
  purchaseAccountId: string | null;
  inventoryAdjustmentAccountId: string | null;
  status: MasterDataStatus;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ItemWriteInput {
  itemCode: string;
  barcode?: string | null;
  name: string;
  nameSecondary?: string;
  description?: string;
  itemType: ItemType;
  isInventoryTracked?: boolean;
  isPurchasable?: boolean;
  isSellable?: boolean;
  trackingMode?: 'none' | 'lot' | 'serial';
  valuationMethod?: 'weighted-average' | 'standard' | 'fifo';
  baseUnitId: string;
  defaultSellingPrice?: string | null;
  defaultPurchasePrice?: string | null;
  standardCost?: string | null;
  salesDescription?: string;
  purchaseDescription?: string;
  salesTaxCodeId?: string | null;
  purchaseTaxCodeId?: string | null;
  inventoryAccountId?: string | null;
  cogsAccountId?: string | null;
  salesAccountId?: string | null;
  purchaseAccountId?: string | null;
  inventoryAdjustmentAccountId?: string | null;
}

export interface ServerWarehouse {
  id: string;
  code: string;
  name: string;
  description: string;
  warehouseType: string;
  location: string;
  status: MasterDataStatus;
  /** Derived from the company profile's pointer, never stored on the row. */
  isDefault: boolean;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WarehouseWriteInput {
  code: string;
  name: string;
  description?: string;
  warehouseType?: string;
  location?: string;
}

export interface ServerUnit {
  id: string;
  code: string;
  name: string;
  symbol: string;
  category: string;
  /** QUANTITY precision — independent of the company's currency precision. */
  decimalPlaces: number;
  status: MasterDataStatus;
  isSystem: boolean;
  version: number;
}

export interface ServerInventorySettings {
  defaultValuationMethod: string;
  defaultWarehouseId: string | null;
  defaultInventoryAccountId: string | null;
  defaultCogsAccountId: string | null;
  defaultSalesAccountId: string | null;
  defaultPurchaseAccountId: string | null;
  inventoryGainAccountId: string | null;
  inventoryLossAccountId: string | null;
  stockInTransitAccountId: string | null;
  /** Where a standalone receipt's offset lands. Required before receiving. */
  goodsReceivedNotInvoicedAccountId: string | null;
  /** 0 means "no profile saved yet", and is what a first save must send. */
  version: number;
}

export interface AuditEvent {
  id: string;
  action: string;
  resultingVersion: number | null;
  detail: Record<string, unknown>;
  actorName: string;
  occurredAt: string | null;
}

const query = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const itemsApi = {
  list: async (params: {
    status?: MasterDataStatus; itemType?: ItemType; tracked?: boolean;
    search?: string; limit?: number;
  } = {}): Promise<ServerItem[]> =>
    (await api.get<{ items: ServerItem[] }>(`/api/inventory/items${query(params)}`)).items,

  get: async (id: string): Promise<ServerItem> =>
    (await api.get<{ item: ServerItem }>(`/api/inventory/items/${id}`)).item,

  history: async (id: string): Promise<AuditEvent[]> =>
    (await api.get<{ events: AuditEvent[] }>(`/api/inventory/items/${id}/history`)).events,

  create: async (input: ItemWriteInput): Promise<ServerItem> =>
    (await api.post<{ item: ServerItem }>('/api/inventory/items', input)).item,

  update: async (id: string, expectedVersion: number, input: ItemWriteInput): Promise<ServerItem> =>
    (await api.patch<{ item: ServerItem }>(
      `/api/inventory/items/${id}`, { ...input, expectedVersion },
    )).item,

  /** Archive or bring back. There is no delete: documents name items. */
  setArchived: async (id: string, expectedVersion: number, archived: boolean): Promise<ServerItem> =>
    (await api.post<{ item: ServerItem }>(
      `/api/inventory/items/${id}/archive`, { expectedVersion, archived },
    )).item,
};

export const warehousesApi = {
  list: async (params: { status?: MasterDataStatus; search?: string; limit?: number } = {}):
  Promise<ServerWarehouse[]> =>
    (await api.get<{ warehouses: ServerWarehouse[] }>(
      `/api/inventory/warehouses${query(params)}`,
    )).warehouses,

  get: async (id: string): Promise<ServerWarehouse> =>
    (await api.get<{ warehouse: ServerWarehouse }>(`/api/inventory/warehouses/${id}`)).warehouse,

  history: async (id: string): Promise<AuditEvent[]> =>
    (await api.get<{ events: AuditEvent[] }>(`/api/inventory/warehouses/${id}/history`)).events,

  create: async (input: WarehouseWriteInput): Promise<ServerWarehouse> =>
    (await api.post<{ warehouse: ServerWarehouse }>('/api/inventory/warehouses', input)).warehouse,

  update: async (
    id: string, expectedVersion: number, input: WarehouseWriteInput,
  ): Promise<ServerWarehouse> =>
    (await api.patch<{ warehouse: ServerWarehouse }>(
      `/api/inventory/warehouses/${id}`, { ...input, expectedVersion },
    )).warehouse,

  setArchived: async (
    id: string, expectedVersion: number, archived: boolean,
  ): Promise<ServerWarehouse> =>
    (await api.post<{ warehouse: ServerWarehouse }>(
      `/api/inventory/warehouses/${id}/archive`, { expectedVersion, archived },
    )).warehouse,
};

export const unitsApi = {
  /**
   * The register, and the server's own statement that conversions do not exist.
   *
   * Returned in the payload rather than assumed by the client, so a screen that
   * later grows a conversion field has something explicit to contradict.
   */
  list: async (): Promise<{ units: ServerUnit[]; conversionsSupported: boolean; note: string }> => {
    const answer = await api.get<{
      units: ServerUnit[]; conversionsSupported: boolean; conversionNote: string;
    }>('/api/inventory/units');
    return {
      units: answer.units,
      conversionsSupported: answer.conversionsSupported,
      note: answer.conversionNote,
    };
  },
};

export const inventorySettingsApi = {
  get: async (): Promise<ServerInventorySettings> =>
    (await api.get<{ settings: ServerInventorySettings }>('/api/inventory/settings')).settings,

  update: async (
    expectedVersion: number,
    input: Partial<Omit<ServerInventorySettings, 'version'>>,
  ): Promise<ServerInventorySettings> =>
    (await api.patch<{ settings: ServerInventorySettings }>(
      '/api/inventory/settings', { ...input, expectedVersion },
    )).settings,
};

/* ══ I2 — the movement ledger ═══════════════════════════════════════════════
 *
 * Quantities are exact decimal STRINGS on the way in and out, exactly like
 * money. A quantity that passed through a JSON number would arrive at the
 * server already rounded, and the server would then post a journal against it.
 */

export type StockDocumentKind = 'receipt' | 'issue' | 'transfer' | 'adjustment';

export interface ServerMovement {
  id: string;
  lineNumber: number;
  movementType: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  baseUnitId: string;
  baseUnitCode: string;
  direction: 'in' | 'out';
  quantity: string;
  unitCost: string;
  totalCost: string;
  inventoryAccountId: string;
  offsetAccountId: string | null;
  movementDate: string;
  postingDate: string;
  status: string;
  reversalOfMovementId: string | null;
  reversedByMovementId: string | null;
}

export interface ServerStockDocument {
  id: string;
  documentNumber: string;
  kind: string;
  movementDate: string;
  postingDate: string;
  reference: string;
  memo: string;
  reason: string;
  status: string;
  journalEntryId: string | null;
  reversalOfDocumentId: string | null;
  reversedByDocumentId: string | null;
  reversalReason: string;
  version: number;
  createdAt: string | null;
  movements: ServerMovement[];
}

export interface StockLineInput {
  itemId: string;
  warehouseId?: string;
  quantity: string;
  unitCost?: string | null;
  expenseAccountId?: string | null;
  direction?: 'in' | 'out';
}

export interface StockDocumentInput {
  kind: StockDocumentKind;
  movementDate: string;
  postingDate?: string;
  reference?: string;
  memo?: string;
  reason?: string;
  /** Makes a retry safe. The caller mints it once per attempt at a document. */
  idempotencyKey: string;
  sourceWarehouseId?: string;
  destinationWarehouseId?: string;
  lines: StockLineInput[];
}

export interface StockOnHandRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  baseUnitCode: string;
  quantity: string;
  value: string;
}

export interface ValuationRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitCode: string;
  quantity: string;
  value: string;
  averageCost: string | null;
  inventoryAccountId: string;
}

export interface StockCardEntry {
  movementId: string;
  documentId: string;
  documentNumber: string;
  kind: string;
  movementType: string;
  warehouseId: string;
  warehouseCode: string;
  direction: 'in' | 'out';
  quantity: string;
  unitCost: string;
  totalCost: string;
  movementDate: string;
  postingDate: string;
  runningQuantity: string;
  runningValue: string;
}

export interface ReconciliationRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  subledgerValue: string;
  generalLedgerBalance: string;
  difference: string;
}

export const stockApi = {
  listDocuments: async (params: {
    kind?: StockDocumentKind; status?: string; search?: string; limit?: number;
  } = {}): Promise<ServerStockDocument[]> =>
    (await api.get<{ documents: ServerStockDocument[] }>(
      `/api/inventory/documents${query(params)}`,
    )).documents,

  getDocument: async (id: string): Promise<ServerStockDocument> =>
    (await api.get<{ document: ServerStockDocument }>(`/api/inventory/documents/${id}`)).document,

  /**
   * Post one stock document.
   *
   * `created` is false when the idempotency key had already posted — the retry
   * succeeded, and the caller holds one document rather than two.
   */
  post: async (
    input: StockDocumentInput,
  ): Promise<{ document: ServerStockDocument; created: boolean }> =>
    api.post<{ document: ServerStockDocument; created: boolean }>(
      '/api/inventory/documents', input,
    ),

  reverse: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerStockDocument> =>
    (await api.post<{ document: ServerStockDocument }>(
      `/api/inventory/documents/${id}/reverse`, { expectedVersion, reason },
    )).document,

  stockOnHand: async (params: {
    itemId?: string; warehouseId?: string; asOfDate?: string; includeEmpty?: boolean;
  } = {}): Promise<StockOnHandRow[]> =>
    (await api.get<{ rows: StockOnHandRow[] }>(
      `/api/inventory/stock-on-hand${query(params)}`,
    )).rows,

  valuation: async (params: { asOfDate?: string } = {}):
  Promise<{ rows: ValuationRow[]; totalValue: string }> =>
    api.get<{ rows: ValuationRow[]; totalValue: string }>(
      `/api/inventory/valuation${query(params)}`,
    ),

  stockCard: async (itemId: string, params: {
    warehouseId?: string; from?: string; to?: string;
  } = {}): Promise<StockCardEntry[]> =>
    (await api.get<{ entries: StockCardEntry[] }>(
      `/api/inventory/items/${itemId}/stock-card${query(params)}`,
    )).entries,

  reconciliation: async (params: { asOfDate?: string } = {}):
  Promise<{ asOfDate: string | null; rows: ReconciliationRow[]; balanced: boolean }> =>
    api.get<{ asOfDate: string | null; rows: ReconciliationRow[]; balanced: boolean }>(
      `/api/inventory/reconciliation${query(params)}`,
    ),
};
