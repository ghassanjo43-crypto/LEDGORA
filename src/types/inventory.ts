/**
 * Ledgora Inventory — core domain types.
 *
 * Inventory is a reusable module (trading, retail, wholesale, projects,
 * construction, manufacturing). The governing principle:
 *
 *   Stock quantity comes from posted movements.
 *   Stock value comes from the valuation engine.
 *   Accounting value comes from journal entries.
 *   The subledger must reconcile to the General Ledger.
 *
 * Quantity-on-hand and value are DERIVED from the immutable stock-movement
 * ledger — never stored as an authoritative mutable field.
 */

export type InventoryItemType =
  | 'inventory'
  | 'non-inventory'
  | 'service'
  | 'raw-material'
  | 'component'
  | 'subassembly'
  | 'finished-good'
  | 'packaging'
  | 'consumable'
  | 'spare-part'
  | 'scrap';

export type ItemStatus = 'active' | 'inactive' | 'archived';
export type ItemTrackingMode = 'none' | 'lot' | 'serial';
export type InventoryValuationMethod = 'weighted-average' | 'standard' | 'fifo';

/** Item-level account mappings (all optional; resolved to COA at posting). */
export interface ItemAccountMappings {
  inventoryAccountId?: string;
  inventoryAdjustmentAccountId?: string;
  costOfGoodsSoldAccountId?: string;
  salesAccountId?: string;
  purchaseAccountId?: string;
  purchaseReturnAccountId?: string;
  salesReturnAccountId?: string;
  inventoryWriteOffAccountId?: string;
  inventoryGainAccountId?: string;
}

export interface InventoryItem extends ItemAccountMappings {
  id: string;
  entityId: string;

  code: string;
  name: string;
  description?: string;

  itemType: InventoryItemType;
  categoryId?: string;

  baseUnitId: string;
  purchaseUnitId?: string;
  salesUnitId?: string;

  isInventoryTracked: boolean;
  isPurchasable: boolean;
  isSellable: boolean;
  isManufacturable: boolean;

  trackingMode: ItemTrackingMode;
  valuationMethod: InventoryValuationMethod;

  defaultTaxCodeId?: string;
  defaultSupplierId?: string;
  defaultWarehouseId?: string;
  defaultCostCenterId?: string;

  standardCost?: number;
  reorderLevel?: number;
  reorderQuantity?: number;
  safetyStock?: number;
  leadTimeDays?: number;

  /* Manufacturing (optional; only used when Manufacturing is enabled). */
  preferredBomId?: string;
  preferredRoutingId?: string;
  defaultPlantId?: string;
  defaultProductionLineId?: string;
  defaultBatchSize?: number;
  minimumBatchSize?: number;
  maximumBatchSize?: number;

  allowNegativeStock?: boolean;

  status: ItemStatus;

  createdAt: string;
  updatedAt: string;
}

export interface ItemCategory {
  id: string;
  entityId: string;

  code: string;
  name: string;
  parentId?: string;
  description?: string;

  defaultInventoryAccountId?: string;
  defaultCogsAccountId?: string;
  defaultSalesAccountId?: string;
  defaultPurchaseAccountId?: string;

  status: 'active' | 'inactive';
}

export type UnitCategory =
  | 'quantity'
  | 'weight'
  | 'volume'
  | 'length'
  | 'area'
  | 'time'
  | 'custom';

export interface UnitOfMeasure {
  id: string;
  entityId: string;

  code: string;
  name: string;
  symbol: string;

  category: UnitCategory;
  decimalPlaces: number;
  status: 'active' | 'inactive';
}

export type WarehouseType =
  | 'main'
  | 'raw-material'
  | 'wip'
  | 'finished-goods'
  | 'returns'
  | 'quarantine'
  | 'scrap'
  | 'site'
  | 'transit'
  | 'virtual';

export interface Warehouse {
  id: string;
  entityId: string;

  code: string;
  name: string;
  description?: string;

  type: WarehouseType;

  location?: string;
  costCenterId?: string;
  projectId?: string;

  /** Optional per-warehouse override of the entity negative-stock policy. */
  allowNegativeStock?: boolean;

  status: 'active' | 'inactive' | 'archived';

  createdAt: string;
  updatedAt: string;
}

/* ── Immutable stock-movement ledger ──────────────────────────────────────── */

export type StockMovementType =
  | 'opening-balance'
  | 'purchase-receipt'
  | 'purchase-return'
  | 'sales-delivery'
  | 'sales-return'
  | 'warehouse-transfer-out'
  | 'warehouse-transfer-in'
  | 'stock-adjustment-in'
  | 'stock-adjustment-out'
  | 'stock-count-in'
  | 'stock-count-out'
  | 'manufacturing-material-issue'
  | 'manufacturing-material-return'
  | 'manufacturing-production-receipt'
  | 'manufacturing-scrap'
  | 'project-material-issue'
  | 'project-material-return'
  | 'landed-cost-adjustment';

export type StockSourceDocumentType =
  | 'opening-balance'
  | 'goods-receipt'
  | 'goods-issue'
  | 'transfer'
  | 'adjustment'
  | 'stock-count'
  | 'bill'
  | 'supplier-credit'
  | 'invoice'
  | 'credit-note'
  | 'manufacturing'
  | 'project';

export interface StockMovement {
  id: string;
  entityId: string;

  movementNumber: string;
  movementType: StockMovementType;

  movementDate: string;
  postingDate: string;

  itemId: string;
  warehouseId: string;
  locationId?: string;

  direction: 'in' | 'out';

  quantity: number;
  baseUnitId: string;

  unitCostBase: number;
  totalCostBase: number;

  documentCurrency?: string;
  documentUnitCost?: number;
  exchangeRate?: number;

  lotId?: string;
  serialNumbers?: string[];

  projectId?: string;
  costCenterId?: string;

  /* Construction extension points (unused in Phase 1). */
  wbsId?: string;
  costCodeId?: string;
  siteRequisitionId?: string;
  siteReceiptId?: string;

  /* Manufacturing extension points (unused in Phase 1). */
  manufacturingWorkOrderId?: string;
  manufacturingOperationId?: string;
  manufacturingBatchId?: string;

  sourceDocumentType: StockSourceDocumentType;
  sourceDocumentId: string;
  sourceLineId?: string;

  journalEntryId?: string;
  journalLineIds?: string[];

  itemSnapshot: {
    code: string;
    name: string;
    itemType: InventoryItemType;
    baseUnitCode: string;
  };
  warehouseSnapshot: {
    code: string;
    name: string;
  };
  accountSnapshot: {
    inventoryAccountId?: string;
    cogsAccountId?: string;
    adjustmentAccountId?: string;
  };

  status: 'posted' | 'reversed';

  reversalOfMovementId?: string;
  reversedByMovementId?: string;

  createdAt: string;
  createdBy?: string;
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

export type StockAdjustmentReason =
  | 'damage'
  | 'loss'
  | 'found'
  | 'expiry'
  | 'write-off'
  | 'data-correction'
  | 'quality-rejection'
  | 'other';

export type NegativeStockPolicy = 'block' | 'warn' | 'allow';

export interface InventorySettings {
  entityId: string;
  enabled: boolean;

  defaultValuationMethod: 'weighted-average' | 'standard';
  negativeStockPolicy: NegativeStockPolicy;

  salesRecognitionMode: 'on-invoice' | 'on-delivery';
  purchaseRecognitionMode: 'on-bill' | 'on-goods-receipt';

  useGrni: boolean;

  defaultWarehouseId?: string;

  inventoryGainAccountId?: string;
  inventoryLossAccountId?: string;
  goodsReceivedNotInvoicedAccountId?: string;
  purchasePriceVarianceAccountId?: string;
  stockInTransitAccountId?: string;
}

/* ── Derived balances (never stored as source of truth) ───────────────────── */

export interface InventoryBalance {
  entityId: string;
  itemId: string;
  warehouseId?: string;

  quantityOnHand: number;
  reservedQuantity: number;
  availableQuantity: number;

  averageUnitCost: number;
  inventoryValue: number;

  asOfDate: string;
}
