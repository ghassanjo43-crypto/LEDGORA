/**
 * Manufacturing costing types — standard cost, effective-dated cost versions,
 * derived actual work-order cost and variance. All amounts are in entity base
 * currency; nothing here stores an authoritative mutable total (actual cost and
 * WIP are always derived from posted activity).
 */

export interface ManufacturingCostBreakdown {
  itemId: string;
  outputQuantity: number;

  materialCost: number;
  laborCost: number;
  machineCost: number;
  overheadCost: number;
  expectedScrapCost: number;

  totalCost: number;
  unitCost: number;

  bomVersion: number;
  routingVersion: number;

  calculatedAt: string;
}

export interface StandardCostVersion {
  id: string;
  entityId: string;
  itemId: string;

  effectiveFrom: string;
  effectiveTo?: string;

  breakdown: ManufacturingCostBreakdown;

  status: 'draft' | 'active' | 'superseded';

  createdAt: string;
  createdBy?: string;
}

export interface ActualWorkOrderCost {
  workOrderId: string;

  materialCost: number;
  laborCost: number;
  machineCost: number;
  overheadCost: number;
  scrapCost: number;
  otherCost: number;

  totalCost: number;

  completedQuantity: number;
  costPerCompletedUnit?: number;

  asOf: string;
}

export interface ManufacturingVariance {
  workOrderId: string;

  standardCostForOutput: number;
  actualCostForOutput: number;

  materialUsageVariance?: number;
  materialPriceVariance?: number;
  laborVariance?: number;
  machineVariance?: number;
  overheadVariance?: number;
  scrapVariance?: number;

  totalVariance: number;

  calculatedAt: string;
}

/** Derived work-in-progress balance for one work order (never stored). */
export interface WorkOrderWip {
  workOrderId: string;
  materialsIssued: number;
  materialsReturned: number;
  laborAbsorbed: number;
  machineAbsorbed: number;
  overheadAbsorbed: number;
  finishedGoodsReceived: number;
  recoverableScrap: number;
  remainingWip: number;
  asOf: string;
}
