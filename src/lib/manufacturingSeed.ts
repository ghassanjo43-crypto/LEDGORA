/**
 * Manufacturing edition seed (data builders). Seeded ONLY for Manufacturing
 * organizations; the store orchestrates opening stock + the posted issue /
 * receipt / scrap so the seeded work order has real, reconcilable activity.
 *
 * Numbers encode the specification's acceptance scenario:
 *   Steel 2×20 + Bolt 4×1 + Paint 1×5 = 49 material/unit
 *   Conversion (labor 8 + machine 4 + overhead 3) = 15/unit
 *   Standard unit cost = 64 ; planned 10 units = 640.
 */
import type { InventoryItem, Warehouse } from '@/types/inventory';
import type {
  BillOfMaterials,
  ManufacturingPlant,
  ManufacturingRouting,
  ManufacturingSettings,
  ProductionLine,
  WorkCenter,
} from '@/types/manufacturing';

export const MFG_ENTITY = 'primary';
const now = '2026-01-01T00:00:00.000Z';

/* Inventory master the manufacturing seed needs (added to the inventory store). */
export function makeMfgWarehouses(): Warehouse[] {
  const w = (id: string, code: string, name: string, type: Warehouse['type']): Warehouse => ({ id, entityId: MFG_ENTITY, code, name, type, status: 'active', createdAt: now, updatedAt: now });
  return [
    w('mfg_rm_wh', 'RM-WH', 'Raw material warehouse', 'raw-material'),
    w('mfg_wip_wh', 'WIP-WH', 'Work in progress', 'wip'),
    w('mfg_fg_wh', 'FG-WH', 'Finished goods', 'finished-goods'),
    w('mfg_scrap_wh', 'SCRAP-WH', 'Scrap store', 'scrap'),
  ];
}

export function makeMfgItems(): InventoryItem[] {
  const base = { entityId: MFG_ENTITY, baseUnitId: 'uom_ea', isInventoryTracked: true, isPurchasable: true, isSellable: false, isManufacturable: false, trackingMode: 'none' as const, valuationMethod: 'weighted-average' as const, status: 'active' as const, createdAt: now, updatedAt: now };
  return [
    { ...base, id: 'mfg_steel', code: 'RM-STEEL', name: 'Steel sheet', itemType: 'raw-material', baseUnitId: 'uom_kg', standardCost: 20 },
    { ...base, id: 'mfg_bolt', code: 'RM-BOLT', name: 'Bolt', itemType: 'raw-material', standardCost: 1 },
    { ...base, id: 'mfg_paint', code: 'RM-PAINT', name: 'Paint', itemType: 'consumable', baseUnitId: 'uom_l', standardCost: 5 },
    { ...base, id: 'mfg_cabinet', code: 'FG-CABINET', name: 'Steel cabinet', itemType: 'finished-good', isPurchasable: false, isSellable: true, isManufacturable: true, preferredBomId: 'mfg_bom_cabinet', preferredRoutingId: 'mfg_rtg_cabinet', defaultPlantId: 'mfg_plant_01' },
  ];
}

/** Opening stock so the seeded work order can issue material. */
export function makeMfgOpeningStock(): Array<{ id: string; itemId: string; warehouseId: string; quantity: number; unitId: string; unitCost: number }> {
  return [
    { id: 'ob_steel', itemId: 'mfg_steel', warehouseId: 'mfg_rm_wh', quantity: 1000, unitId: 'uom_kg', unitCost: 20 },
    { id: 'ob_bolt', itemId: 'mfg_bolt', warehouseId: 'mfg_rm_wh', quantity: 2000, unitId: 'uom_ea', unitCost: 1 },
    { id: 'ob_paint', itemId: 'mfg_paint', warehouseId: 'mfg_rm_wh', quantity: 500, unitId: 'uom_l', unitCost: 5 },
  ];
}

export function makeMfgSettings(): ManufacturingSettings {
  return {
    entityId: MFG_ENTITY,
    enabled: true,
    defaultRawMaterialWarehouseId: 'mfg_rm_wh',
    defaultWipWarehouseId: 'mfg_wip_wh',
    defaultFinishedGoodsWarehouseId: 'mfg_fg_wh',
    defaultScrapWarehouseId: 'mfg_scrap_wh',
    workOrderPrefix: 'WO',
    materialIssuePrefix: 'MI',
    materialReturnPrefix: 'MR',
    productionReceiptPrefix: 'PR',
    scrapPrefix: 'SC',
    costingPolicy: 'standard',
    allowPartialCompletion: true,
    allowOverproduction: false,
    allowMaterialOverIssue: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeMfgMasterData(costCenterId: string): {
  plant: ManufacturingPlant;
  lines: ProductionLine[];
  workCenters: WorkCenter[];
  bom: BillOfMaterials;
  routing: ManufacturingRouting;
} {
  const plant: ManufacturingPlant = {
    id: 'mfg_plant_01', entityId: MFG_ENTITY, code: 'PLANT-01', name: 'Main plant',
    defaultCostCenterId: costCenterId, rawMaterialWarehouseId: 'mfg_rm_wh', wipWarehouseId: 'mfg_wip_wh',
    finishedGoodsWarehouseId: 'mfg_fg_wh', scrapWarehouseId: 'mfg_scrap_wh', status: 'active', createdAt: now, updatedAt: now,
  };
  const lines: ProductionLine[] = [
    { id: 'mfg_line_01', entityId: MFG_ENTITY, plantId: plant.id, code: 'LINE-01', name: 'Assembly line 1', defaultCostCenterId: costCenterId, status: 'active', createdAt: now, updatedAt: now },
  ];
  const wc = (id: string, code: string, name: string, type: WorkCenter['type'], labor: number, machine: number, overhead: number): WorkCenter => ({
    id, entityId: MFG_ENTITY, plantId: plant.id, productionLineId: 'mfg_line_01', code, name, type,
    costCenterId, availableHoursPerDay: 8, efficiencyPercent: 100, setupRatePerHour: 0,
    laborRatePerHour: labor, machineRatePerHour: machine, overheadRatePerHour: overhead, status: 'active', createdAt: now, updatedAt: now,
  });
  const workCenters: WorkCenter[] = [
    wc('mfg_wc_cut', 'CUT-01', 'Cutting', 'machine', 3, 4, 1),
    wc('mfg_wc_asm', 'ASM-01', 'Assembly', 'assembly', 4, 0, 1),
    wc('mfg_wc_pack', 'PACK-01', 'Packaging', 'packaging', 1, 0, 1),
  ];
  const bom: BillOfMaterials = {
    id: 'mfg_bom_cabinet', entityId: MFG_ENTITY, code: 'BOM-CABINET', name: 'Steel cabinet BOM', productItemId: 'mfg_cabinet',
    version: 1, status: 'approved', effectiveFrom: '2026-01-01', outputQuantity: 1, outputUnitId: 'uom_ea',
    expectedYieldPercent: 100, components: [
      { id: 'bc_steel', bomId: 'mfg_bom_cabinet', sequence: 1, itemId: 'mfg_steel', quantity: 2, unitId: 'uom_kg', quantityPerOutput: 2, isOptional: false, issueWarehouseId: 'mfg_rm_wh' },
      { id: 'bc_bolt', bomId: 'mfg_bom_cabinet', sequence: 2, itemId: 'mfg_bolt', quantity: 4, unitId: 'uom_ea', quantityPerOutput: 4, isOptional: false, issueWarehouseId: 'mfg_rm_wh' },
      { id: 'bc_paint', bomId: 'mfg_bom_cabinet', sequence: 3, itemId: 'mfg_paint', quantity: 1, unitId: 'uom_l', quantityPerOutput: 1, isOptional: false, issueWarehouseId: 'mfg_rm_wh' },
    ],
    approvedAt: now, approvedBy: 'Seed', createdAt: now, updatedAt: now,
  };
  const routing: ManufacturingRouting = {
    id: 'mfg_rtg_cabinet', entityId: MFG_ENTITY, code: 'RTG-CABINET', name: 'Steel cabinet routing', productItemId: 'mfg_cabinet',
    version: 1, status: 'approved', effectiveFrom: '2026-01-01', operations: [
      { id: 'op_cut', routingId: 'mfg_rtg_cabinet', operationNumber: 10, name: 'Cut', workCenterId: 'mfg_wc_cut', setupHours: 0, runHoursPerUnit: 1, requiresInspection: false, isOutsourced: false },
      { id: 'op_asm', routingId: 'mfg_rtg_cabinet', operationNumber: 20, name: 'Assemble', workCenterId: 'mfg_wc_asm', setupHours: 0, runHoursPerUnit: 1, requiresInspection: false, isOutsourced: false },
      { id: 'op_pack', routingId: 'mfg_rtg_cabinet', operationNumber: 30, name: 'Pack', workCenterId: 'mfg_wc_pack', setupHours: 0, runHoursPerUnit: 1, requiresInspection: false, isOutsourced: false },
    ],
    approvedAt: now, approvedBy: 'Seed', createdAt: now, updatedAt: now,
  };
  return { plant, lines, workCenters, bom, routing };
}
