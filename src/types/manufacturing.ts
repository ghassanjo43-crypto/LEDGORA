/**
 * Ledgora Manufacturing — master-data types (Phase 1).
 *
 * Governing rule: Inventory owns stock, Manufacturing owns the production
 * workflow, the General Journal owns accounting. Manufacturing never keeps a
 * competing stock balance, valuation engine or ledger — material flows go
 * through the shared Inventory services and all accounting posts through the
 * journal.
 *
 * Single-entity in Phase 1 (entityId is a fixed 'primary', matching Inventory).
 */

export type MfgStatus = 'active' | 'inactive' | 'archived';

export interface ManufacturingSettings {
  entityId: string;
  enabled: boolean;

  defaultRawMaterialWarehouseId?: string;
  defaultWipWarehouseId?: string;
  defaultFinishedGoodsWarehouseId?: string;
  defaultScrapWarehouseId?: string;

  defaultWipAccountId?: string;
  defaultLaborAbsorptionAccountId?: string;
  defaultMachineAbsorptionAccountId?: string;
  defaultOverheadAbsorptionAccountId?: string;
  defaultVarianceAccountId?: string;
  defaultScrapExpenseAccountId?: string;

  workOrderPrefix: string;
  materialIssuePrefix: string;
  materialReturnPrefix: string;
  productionReceiptPrefix: string;
  scrapPrefix: string;

  costingPolicy: 'standard' | 'actual';

  allowPartialCompletion: boolean;
  allowOverproduction: boolean;
  allowMaterialOverIssue: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface ManufacturingPlant {
  id: string;
  entityId: string;

  code: string;
  name: string;
  description?: string;
  address?: string;
  managerName?: string;

  defaultCostCenterId?: string;

  rawMaterialWarehouseId?: string;
  wipWarehouseId?: string;
  finishedGoodsWarehouseId?: string;
  scrapWarehouseId?: string;

  status: MfgStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionLine {
  id: string;
  entityId: string;
  plantId: string;

  code: string;
  name: string;
  description?: string;

  defaultCostCenterId?: string;

  dailyCapacity?: number;
  capacityUnitId?: string;

  status: MfgStatus;
  createdAt: string;
  updatedAt: string;
}

export type WorkCenterType = 'labor' | 'machine' | 'assembly' | 'inspection' | 'packaging' | 'mixed';

export interface WorkCenter {
  id: string;
  entityId: string;
  plantId: string;
  productionLineId?: string;

  code: string;
  name: string;
  description?: string;

  type: WorkCenterType;

  costCenterId: string;

  availableHoursPerDay: number;
  efficiencyPercent: number;

  setupRatePerHour: number;
  laborRatePerHour: number;
  machineRatePerHour: number;
  overheadRatePerHour: number;

  status: MfgStatus;
  createdAt: string;
  updatedAt: string;
}

/* ── Bills of Materials ───────────────────────────────────────────────────── */

export type BomStatus = 'draft' | 'approved' | 'inactive' | 'archived';

export interface BomComponent {
  id: string;
  bomId: string;

  sequence: number;
  itemId: string;

  quantity: number;
  unitId: string;
  quantityPerOutput: number;

  expectedScrapPercent?: number;
  issueWarehouseId?: string;

  isOptional: boolean;
  substituteItemIds?: string[];

  notes?: string;
}

export interface BillOfMaterials {
  id: string;
  entityId: string;

  code: string;
  name: string;
  productItemId: string;

  version: number;
  revisionLabel?: string;

  status: BomStatus;

  effectiveFrom: string;
  effectiveTo?: string;

  outputQuantity: number;
  outputUnitId: string;

  expectedYieldPercent: number;
  expectedScrapPercent?: number;

  components: BomComponent[];

  notes?: string;

  approvedAt?: string;
  approvedBy?: string;

  createdAt: string;
  updatedAt: string;
}

/* ── Routings ─────────────────────────────────────────────────────────────── */

export type RoutingStatus = 'draft' | 'approved' | 'inactive' | 'archived';

export interface RoutingOperation {
  id: string;
  routingId: string;

  operationNumber: number;
  name: string;
  description?: string;

  workCenterId: string;

  setupHours: number;
  runHoursPerUnit: number;
  queueHours?: number;

  requiresInspection: boolean;
  isOutsourced: boolean;

  notes?: string;
}

export interface ManufacturingRouting {
  id: string;
  entityId: string;

  code: string;
  name: string;
  productItemId: string;

  version: number;
  revisionLabel?: string;

  status: RoutingStatus;

  effectiveFrom: string;
  effectiveTo?: string;

  operations: RoutingOperation[];

  notes?: string;

  approvedAt?: string;
  approvedBy?: string;

  createdAt: string;
  updatedAt: string;
}
