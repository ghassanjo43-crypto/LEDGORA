/**
 * Manufacturing costing engine — pure functions.
 *
 * Standard cost = material + labor + machine + overhead + expected normal scrap.
 * Actual work-order cost and WIP are DERIVED from posted activity (never stored
 * as an authoritative total), which keeps the manufacturing subledger
 * reconcilable to the General Ledger WIP / absorption accounts.
 */
import type { BillOfMaterials, ManufacturingRouting, WorkCenter } from '@/types/manufacturing';
import type { ManufacturingCostBreakdown, ActualWorkOrderCost, ManufacturingVariance, WorkOrderWip } from '@/types/manufacturingCosting';
import type {
  ManufacturingMaterialIssue,
  ManufacturingMaterialReturn,
  ManufacturingProductionReceipt,
  ManufacturingScrap,
  WorkOrderMaterialRequirement,
  WorkOrderOperationSnapshot,
  WorkOrderOperationCostEntry,
} from '@/types/manufacturingDocuments';

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ── Standard cost ────────────────────────────────────────────────────────── */

export interface StandardCostInput {
  itemId: string;
  bom: BillOfMaterials;
  routing: ManufacturingRouting;
  outputQuantity: number;
  /** Unit cost of a component item (inventory average or item standard cost). */
  componentUnitCost: (itemId: string) => number;
  workCenterById: (id: string) => WorkCenter | undefined;
  asOf?: string;
}

export function calculateStandardManufacturingCost(input: StandardCostInput): ManufacturingCostBreakdown {
  const qty = input.outputQuantity;
  // Material: per-output component quantity × its unit cost × planned output.
  let materialPerOutput = 0;
  for (const c of input.bom.components) {
    if (c.isOptional) continue;
    materialPerOutput += c.quantityPerOutput * input.componentUnitCost(c.itemId);
  }
  const materialCost = r2(materialPerOutput * qty);

  // Conversion: setup (fixed) + run (per unit) at snapshotted work-center rates.
  let laborCost = 0;
  let machineCost = 0;
  let overheadCost = 0;
  for (const op of input.routing.operations) {
    const wc = input.workCenterById(op.workCenterId);
    if (!wc) continue;
    const runQty = op.runHoursPerUnit * qty;
    laborCost += op.setupHours * wc.setupRatePerHour + runQty * wc.laborRatePerHour;
    machineCost += runQty * wc.machineRatePerHour;
    overheadCost += runQty * wc.overheadRatePerHour;
  }
  laborCost = r2(laborCost);
  machineCost = r2(machineCost);
  overheadCost = r2(overheadCost);

  const scrapPct = input.bom.expectedScrapPercent ?? 0;
  const expectedScrapCost = r2((materialCost + laborCost + machineCost + overheadCost) * (scrapPct / 100));

  const totalCost = r2(materialCost + laborCost + machineCost + overheadCost + expectedScrapCost);
  return {
    itemId: input.itemId,
    outputQuantity: qty,
    materialCost,
    laborCost,
    machineCost,
    overheadCost,
    expectedScrapCost,
    totalCost,
    unitCost: qty > 0 ? r2(totalCost / qty) : 0,
    bomVersion: input.bom.version,
    routingVersion: input.routing.version,
    calculatedAt: input.asOf ?? new Date().toISOString(),
  };
}

/* ── Requirements + operation snapshots (built at release) ────────────────── */

export function buildMaterialRequirements(
  workOrderId: string,
  bom: BillOfMaterials,
  plannedQuantity: number,
  componentUnitCost: (itemId: string) => number,
  itemMeta: (itemId: string) => { code: string; name: string },
  defaultWarehouseId: string,
  idGen: () => string,
): WorkOrderMaterialRequirement[] {
  return bom.components
    .filter((c) => !c.isOptional)
    .map((c) => {
      const scrapPct = c.expectedScrapPercent ?? bom.expectedScrapPercent ?? 0;
      const required = r2(c.quantityPerOutput * plannedQuantity * (1 + scrapPct / 100));
      const meta = itemMeta(c.itemId);
      return {
        id: idGen(),
        workOrderId,
        itemId: c.itemId,
        requiredQuantity: required,
        issuedQuantity: 0,
        returnedQuantity: 0,
        unitId: c.unitId,
        warehouseId: c.issueWarehouseId || defaultWarehouseId,
        standardUnitCostSnapshot: componentUnitCost(c.itemId),
        bomComponentSnapshot: { itemCode: meta.code, itemName: meta.name, quantityPerOutput: c.quantityPerOutput, expectedScrapPercent: c.expectedScrapPercent },
      };
    });
}

export function buildOperationSnapshots(
  workOrderId: string,
  routing: ManufacturingRouting,
  plannedQuantity: number,
  workCenterById: (id: string) => WorkCenter | undefined,
  idGen: () => string,
): WorkOrderOperationSnapshot[] {
  return routing.operations
    .slice()
    .sort((a, b) => a.operationNumber - b.operationNumber)
    .map((op) => {
      const wc = workCenterById(op.workCenterId);
      return {
        id: idGen(),
        workOrderId,
        operationNumber: op.operationNumber,
        name: op.name,
        workCenterId: op.workCenterId,
        workCenterCode: wc?.code ?? '',
        workCenterName: wc?.name ?? '',
        plannedSetupHours: op.setupHours,
        plannedRunHours: r2(op.runHoursPerUnit * plannedQuantity),
        actualSetupHours: 0,
        actualRunHours: 0,
        laborRateSnapshot: wc?.laborRatePerHour ?? 0,
        machineRateSnapshot: wc?.machineRatePerHour ?? 0,
        overheadRateSnapshot: wc?.overheadRatePerHour ?? 0,
        status: 'not-started',
      };
    });
}

/* ── Posted-activity aggregation (WIP / actual cost / variance) ───────────── */

export interface WorkOrderActivity {
  issues: ManufacturingMaterialIssue[];
  returns: ManufacturingMaterialReturn[];
  receipts: ManufacturingProductionReceipt[];
  operationCosts: WorkOrderOperationCostEntry[];
  scraps: ManufacturingScrap[];
}

function posted<T extends { status: string; workOrderId: string }>(list: T[], workOrderId: string): T[] {
  return list.filter((d) => d.workOrderId === workOrderId && d.status === 'posted');
}

export function calculateWorkOrderWip(workOrderId: string, a: WorkOrderActivity, asOf?: string): WorkOrderWip {
  const materialsIssued = r2(posted(a.issues, workOrderId).reduce((s, d) => s + d.totalCost, 0));
  const materialsReturned = r2(posted(a.returns, workOrderId).reduce((s, d) => s + d.totalCost, 0));
  const laborAbsorbed = r2(posted(a.operationCosts, workOrderId).reduce((s, d) => s + d.laborCost, 0));
  const machineAbsorbed = r2(posted(a.operationCosts, workOrderId).reduce((s, d) => s + d.machineCost, 0));
  const overheadAbsorbed = r2(posted(a.operationCosts, workOrderId).reduce((s, d) => s + d.overheadCost, 0));
  const finishedGoodsReceived = r2(posted(a.receipts, workOrderId).reduce((s, d) => s + d.costSnapshot.totalCost, 0));
  // Every scrap posting credits WIP by its totalCost (recoverable value or the
  // abnormal cost), so subtracting it keeps subledger WIP equal to GL WIP.
  const recoverableScrap = r2(posted(a.scraps, workOrderId).reduce((s, d) => s + d.totalCost, 0));
  const remainingWip = r2(materialsIssued - materialsReturned + laborAbsorbed + machineAbsorbed + overheadAbsorbed - finishedGoodsReceived - recoverableScrap);
  return { workOrderId, materialsIssued, materialsReturned, laborAbsorbed, machineAbsorbed, overheadAbsorbed, finishedGoodsReceived, recoverableScrap, remainingWip, asOf: asOf ?? new Date().toISOString().slice(0, 10) };
}

export function calculateActualWorkOrderCost(workOrderId: string, a: WorkOrderActivity, asOf?: string): ActualWorkOrderCost {
  const materialCost = r2(posted(a.issues, workOrderId).reduce((s, d) => s + d.totalCost, 0) - posted(a.returns, workOrderId).reduce((s, d) => s + d.totalCost, 0));
  const laborCost = r2(posted(a.operationCosts, workOrderId).reduce((s, d) => s + d.laborCost, 0));
  const machineCost = r2(posted(a.operationCosts, workOrderId).reduce((s, d) => s + d.machineCost, 0));
  const overheadCost = r2(posted(a.operationCosts, workOrderId).reduce((s, d) => s + d.overheadCost, 0));
  const scrapCost = r2(posted(a.scraps, workOrderId).filter((d) => d.accountingPolicy === 'normal-to-product-cost').reduce((s, d) => s + d.totalCost, 0));
  const recoverable = r2(posted(a.scraps, workOrderId).reduce((s, d) => s + (d.recoverableValue ?? 0), 0));
  const completedQuantity = r2(posted(a.receipts, workOrderId).reduce((s, d) => s + d.completedQuantity, 0));
  const totalCost = r2(materialCost + laborCost + machineCost + overheadCost - recoverable);
  return {
    workOrderId,
    materialCost,
    laborCost,
    machineCost,
    overheadCost,
    scrapCost,
    otherCost: 0,
    totalCost,
    completedQuantity,
    costPerCompletedUnit: completedQuantity > 0 ? r2(totalCost / completedQuantity) : undefined,
    asOf: asOf ?? new Date().toISOString().slice(0, 10),
  };
}

export function calculateVariance(
  standardUnitCost: number,
  standardBreakdown: ManufacturingCostBreakdown,
  actual: ActualWorkOrderCost,
): ManufacturingVariance {
  const completed = actual.completedQuantity;
  const standardCostForOutput = r2(standardUnitCost * completed);
  const actualCostForOutput = actual.totalCost;
  const stdPerUnit = standardBreakdown.outputQuantity > 0 ? standardBreakdown : standardBreakdown;
  const factor = stdPerUnit.outputQuantity > 0 ? completed / stdPerUnit.outputQuantity : 0;
  return {
    workOrderId: actual.workOrderId,
    standardCostForOutput,
    actualCostForOutput,
    materialUsageVariance: r2(actual.materialCost - standardBreakdown.materialCost * factor),
    laborVariance: r2(actual.laborCost - standardBreakdown.laborCost * factor),
    machineVariance: r2(actual.machineCost - standardBreakdown.machineCost * factor),
    overheadVariance: r2(actual.overheadCost - standardBreakdown.overheadCost * factor),
    totalVariance: r2(actualCostForOutput - standardCostForOutput),
    calculatedAt: new Date().toISOString(),
  };
}
