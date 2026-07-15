/**
 * Inventory document types — the source documents that generate stock movements
 * and journal entries. Each posted document links to its movements and journal
 * entry; posted documents are immutable and corrected via reversal.
 */
import type { StockAdjustmentReason } from './inventory';

export type InventoryDocumentStatus = 'draft' | 'posted' | 'reversed';

/** Fields shared by every posted inventory document. */
interface PostedLinks {
  journalEntryId?: string;
  movementIds: string[];
  reversalOfId?: string;
  reversedById?: string;
  postedAt?: string;
  postedBy?: string;
}

export interface GoodsReceiptLine {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  unitCost: number;
  projectId?: string;
  costCenterId?: string;
  description?: string;
  lotId?: string;
  serialNumbers?: string[];
}

export interface GoodsReceipt extends PostedLinks {
  id: string;
  entityId: string;
  number: string;
  status: InventoryDocumentStatus;

  supplierId?: string;
  receiptDate: string;
  warehouseId: string;
  supplierDeliveryRef?: string;

  currency: string;
  exchangeRate: number;

  lines: GoodsReceiptLine[];
  notes?: string;

  createdAt: string;
  updatedAt: string;
}

export type GoodsIssueReason =
  | 'internal-consumption'
  | 'project-issue'
  | 'site-use'
  | 'sample'
  | 'damage'
  | 'maintenance'
  | 'other';

export interface GoodsIssueLine {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  /** Expense / WIP / project-cost account to debit (resolved if omitted). */
  expenseAccountId?: string;
  projectId?: string;
  costCenterId?: string;
  description?: string;
}

export interface GoodsIssue extends PostedLinks {
  id: string;
  entityId: string;
  number: string;
  status: InventoryDocumentStatus;

  issueDate: string;
  warehouseId: string;
  reason: GoodsIssueReason;

  projectId?: string;
  costCenterId?: string;

  lines: GoodsIssueLine[];
  notes?: string;

  createdAt: string;
  updatedAt: string;
}

export interface TransferLine {
  id: string;
  itemId: string;
  quantity: number;
  unitId: string;
  description?: string;
}

export interface WarehouseTransfer extends PostedLinks {
  id: string;
  entityId: string;
  number: string;
  status: InventoryDocumentStatus;

  transferDate: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;

  lines: TransferLine[];
  notes?: string;

  createdAt: string;
  updatedAt: string;
}

export interface AdjustmentLine {
  id: string;
  itemId: string;
  warehouseId: string;
  /** Signed quantity: positive = increase, negative = decrease. */
  quantity: number;
  unitId: string;
  /** Unit cost for increases; decreases use current average cost. */
  unitCost?: number;
  costCenterId?: string;
  description?: string;
}

export interface StockAdjustment extends PostedLinks {
  id: string;
  entityId: string;
  number: string;
  status: InventoryDocumentStatus;

  adjustmentDate: string;
  warehouseId: string;
  reason: StockAdjustmentReason;
  notes: string;

  lines: AdjustmentLine[];

  createdAt: string;
  updatedAt: string;
}

export type StockCountStatus =
  | 'draft'
  | 'counting'
  | 'reviewed'
  | 'posted'
  | 'reversed';

export interface StockCountLine {
  id: string;
  itemId: string;
  /** Frozen system quantity captured when counting begins. */
  systemQuantity: number;
  /** Average unit cost frozen at freeze time (for variance valuation). */
  frozenUnitCost: number;
  countedQuantity?: number;
  reason?: string;
}

export interface StockCount extends PostedLinks {
  id: string;
  entityId: string;
  number: string;
  status: StockCountStatus;

  warehouseId: string;
  freezeAt?: string;
  reviewedBy?: string;

  lines: StockCountLine[];
  notes?: string;

  createdAt: string;
  updatedAt: string;
}

export interface OpeningBalanceLine {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  unitCost: number;
  lotId?: string;
}

export interface OpeningBalanceDocument extends PostedLinks {
  id: string;
  entityId: string;
  number: string;
  status: InventoryDocumentStatus;

  openingDate: string;
  lines: OpeningBalanceLine[];
  notes?: string;

  createdAt: string;
  updatedAt: string;
}

/* ── Audit ────────────────────────────────────────────────────────────────── */

export type InventoryAuditEvent =
  | 'item-created'
  | 'item-updated'
  | 'item-archived'
  | 'warehouse-created'
  | 'warehouse-updated'
  | 'warehouse-archived'
  | 'category-saved'
  | 'unit-saved'
  | 'settings-updated'
  | 'opening-balance-posted'
  | 'receipt-posted'
  | 'receipt-reversed'
  | 'issue-posted'
  | 'issue-reversed'
  | 'transfer-posted'
  | 'transfer-reversed'
  | 'adjustment-posted'
  | 'adjustment-reversed'
  | 'count-started'
  | 'count-reviewed'
  | 'count-posted'
  | 'count-reversed'
  | 'bill-receipt-posted'
  | 'invoice-issue-posted'
  | 'customer-return-posted'
  | 'supplier-return-posted'
  | 'negative-stock-override'
  | 'valuation-method-change-blocked';

export interface InventoryAuditEntry {
  id: string;
  entityId: string;
  event: InventoryAuditEvent;
  at: string;
  actor: string;
  detail: string;
  documentId?: string;
  movementId?: string;
}
