/**
 * Manufacturing document types — work orders and the posting documents
 * (material issue/return, production receipt, operation cost, scrap). Posted
 * documents are immutable; corrections are linked reversals. Every posting is
 * atomic across the manufacturing document, the Inventory stock movement, the
 * journal entry, work-order quantities and an audit event.
 */
import type { ManufacturingCostBreakdown } from './manufacturingCosting';

export type WorkOrderStatus =
  | 'draft'
  | 'planned'
  | 'released'
  | 'in-progress'
  | 'partially-completed'
  | 'completed'
  | 'closed'
  | 'on-hold'
  | 'cancelled';

export interface WorkOrderMaterialRequirement {
  id: string;
  workOrderId: string;

  itemId: string;

  requiredQuantity: number;
  issuedQuantity: number;
  returnedQuantity: number;

  unitId: string;
  warehouseId: string;

  standardUnitCostSnapshot: number;

  bomComponentSnapshot: {
    itemCode: string;
    itemName: string;
    quantityPerOutput: number;
    expectedScrapPercent?: number;
  };
}

export type OperationSnapshotStatus = 'not-started' | 'in-progress' | 'completed' | 'skipped';

export interface WorkOrderOperationSnapshot {
  id: string;
  workOrderId: string;

  operationNumber: number;
  name: string;

  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;

  plannedSetupHours: number;
  plannedRunHours: number;

  actualSetupHours: number;
  actualRunHours: number;

  laborRateSnapshot: number;
  machineRateSnapshot: number;
  overheadRateSnapshot: number;

  status: OperationSnapshotStatus;
}

export interface ManufacturingWorkOrder {
  id: string;
  entityId: string;

  workOrderNumber: string;

  plantId: string;
  productionLineId?: string;

  productItemId: string;

  bomId: string;
  bomVersion: number;

  routingId: string;
  routingVersion: number;

  plannedQuantity: number;
  completedQuantity: number;
  scrappedQuantity: number;

  unitId: string;

  plannedStartDate: string;
  plannedEndDate: string;

  actualStartDate?: string;
  actualEndDate?: string;

  rawMaterialWarehouseId: string;
  wipWarehouseId: string;
  finishedGoodsWarehouseId: string;
  scrapWarehouseId?: string;

  costCenterId: string;
  projectId?: string;

  status: WorkOrderStatus;

  materialRequirements: WorkOrderMaterialRequirement[];
  operationSnapshots: WorkOrderOperationSnapshot[];

  standardCostSnapshot: ManufacturingCostBreakdown;

  notes?: string;

  createdAt: string;
  updatedAt: string;

  releasedAt?: string;
  releasedBy?: string;

  closedAt?: string;
  closedBy?: string;

  /** Frozen closeout summary (set at close). */
  closeoutSnapshot?: WorkOrderCloseout;
}

export type MfgDocStatus = 'draft' | 'posted' | 'reversed';

export interface ManufacturingMaterialIssueLine {
  id: string;
  itemId: string;
  requirementId?: string;
  quantity: number;
  unitId: string;
  sourceWarehouseId: string;
  stockMovementId?: string;
  unitCostSnapshot?: number;
  totalCostSnapshot?: number;
  costCenterId: string;
  projectId?: string;
}

interface PostedDoc {
  status: MfgDocStatus;
  journalEntryId?: string;
  inventoryDocumentId?: string;
  reversalOfId?: string;
  reversedById?: string;
  postedAt?: string;
  postedBy?: string;
}

export interface ManufacturingMaterialIssue extends PostedDoc {
  id: string;
  entityId: string;
  issueNumber: string;
  workOrderId: string;
  issueDate: string;
  postingDate: string;
  lines: ManufacturingMaterialIssueLine[];
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManufacturingMaterialReturnLine {
  id: string;
  itemId: string;
  requirementId?: string;
  quantity: number;
  unitId: string;
  warehouseId: string;
  unitCostSnapshot: number;
  totalCostSnapshot: number;
  costCenterId: string;
}

export interface ManufacturingMaterialReturn extends PostedDoc {
  id: string;
  entityId: string;
  returnNumber: string;
  workOrderId: string;
  returnDate: string;
  postingDate: string;
  lines: ManufacturingMaterialReturnLine[];
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManufacturingProductionReceipt extends PostedDoc {
  id: string;
  entityId: string;
  receiptNumber: string;
  workOrderId: string;
  receiptDate: string;
  postingDate: string;
  finishedGoodsWarehouseId: string;
  wipWarehouseId: string;
  completedQuantity: number;
  unitId: string;
  costSnapshot: {
    costingPolicy: 'standard' | 'actual';
    unitCost: number;
    totalCost: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WorkOrderOperationCostEntry extends PostedDoc {
  id: string;
  entityId: string;
  workOrderId: string;
  operationSnapshotId: string;
  postingDate: string;
  setupHours: number;
  runHours: number;
  laborCost: number;
  machineCost: number;
  overheadCost: number;
  totalCost: number;
  costCenterId: string;
  createdAt: string;
}

export type ScrapReason = 'normal-process-loss' | 'damage' | 'quality-failure' | 'machine-failure' | 'operator-error' | 'other';
export type ScrapPolicy = 'normal-to-product-cost' | 'abnormal-to-expense';

export interface ManufacturingScrap extends PostedDoc {
  id: string;
  entityId: string;
  scrapNumber: string;
  workOrderId: string;
  scrapDate: string;
  postingDate: string;
  itemId: string;
  quantity: number;
  unitId: string;
  reason: ScrapReason;
  accountingPolicy: ScrapPolicy;
  /** Recoverable value (recognized as scrap inventory) — else abnormal expense. */
  recoverableValue?: number;
  scrapWarehouseId?: string;
  costCenterId: string;
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkOrderCloseout {
  workOrderId: string;
  plannedOutput: number;
  completedOutput: number;
  scrap: number;
  requiredMaterial: number;
  issuedMaterial: number;
  returnedMaterial: number;
  materialVariance: number;
  standardCost: number;
  actualCost: number;
  totalVariance: number;
  remainingWip: number;
  closedAt: string;
}

export type MfgAuditEvent =
  | 'settings-updated'
  | 'plant-saved' | 'line-saved' | 'work-center-saved'
  | 'bom-saved' | 'bom-approved' | 'bom-versioned'
  | 'routing-saved' | 'routing-approved' | 'routing-versioned'
  | 'standard-cost-versioned'
  | 'work-order-created' | 'work-order-transitioned' | 'work-order-released' | 'work-order-closed' | 'work-order-cancelled'
  | 'material-issue-posted' | 'material-issue-reversed'
  | 'material-return-posted' | 'material-return-reversed'
  | 'production-receipt-posted' | 'production-receipt-reversed'
  | 'operation-cost-posted' | 'operation-cost-reversed'
  | 'scrap-posted' | 'scrap-reversed';

export interface MfgAuditEntry {
  id: string;
  entityId: string;
  event: MfgAuditEvent;
  at: string;
  actor: string;
  detail: string;
  workOrderId?: string;
  documentId?: string;
}
