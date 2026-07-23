/**
 * Ledgora Manufacturing store (persist key `ledgora-manufacturing`).
 *
 * Owns the production workflow — plants, lines, work centers, BOMs, routings,
 * work orders and the posting documents — but NEVER stock or accounting. Every
 * material flow goes through the shared Inventory service
 * (`inventoryStore.recordLinkedMovements`) and every accounting value posts
 * through the General Journal (`journalStore.insertPostedEntry`). WIP and actual
 * cost are always DERIVED from posted activity.
 *
 * Posting is atomic: the journal is inserted first; if the linked inventory
 * movement fails, the journal is reversed and nothing partial remains.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type {
  BillOfMaterials,
  ManufacturingPlant,
  ManufacturingRouting,
  ManufacturingSettings,
  ProductionLine,
  WorkCenter,
} from '@/types/manufacturing';
import type {
  ManufacturingMaterialIssue,
  ManufacturingMaterialReturn,
  ManufacturingProductionReceipt,
  ManufacturingScrap,
  ManufacturingWorkOrder,
  MfgAuditEntry,
  MfgAuditEvent,
  ScrapPolicy,
  ScrapReason,
  WorkOrderOperationCostEntry,
  WorkOrderStatus,
} from '@/types/manufacturingDocuments';
import type { StandardCostVersion } from '@/types/manufacturingCosting';
import { useStore } from './useStore';
import { useJournalStore } from './journalStore';
import { useInventoryStore } from './inventoryStore';
import { useEntitlementStore } from './entitlementStore';
import { useCostCenterStore } from './costCenterStore';
import { getCurrentUserName } from './sessionStore';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import {
  buildMaterialRequirements,
  buildOperationSnapshots,
  calculateActualWorkOrderCost,
  calculateStandardManufacturingCost,
  calculateWorkOrderWip,
  calculateVariance,
  type WorkOrderActivity,
} from '@/lib/manufacturingCosting';
import { canTransition, acceptsProductionActivity, completionStatus } from '@/lib/workOrderLifecycle';
import { validateBom, hasCircularReference, nextBomVersion, makeNewBomVersion, canEditBom } from '@/lib/bomVersioning';
import { validateRouting, makeNewRoutingVersion, canEditRouting } from '@/lib/routingVersioning';
import { validatePlant, validateProductionLine, validateWorkCenter } from '@/lib/manufacturingValidation';
import { nextMfgNumber } from '@/lib/manufacturingNumbering';
import { MFG_ENTITY, makeMfgItems, makeMfgMasterData, makeMfgOpeningStock, makeMfgSettings, makeMfgWarehouses } from '@/lib/manufacturingSeed';
import { generateId, nowIso } from '@/lib/utils';

export interface MfgResult {
  ok: boolean;
  error?: string;
  id?: string;
  journalEntryId?: string;
  movementIds?: string[];
}

interface MfgState {
  settings: ManufacturingSettings;
  plants: ManufacturingPlant[];
  lines: ProductionLine[];
  workCenters: WorkCenter[];
  boms: BillOfMaterials[];
  routings: ManufacturingRouting[];
  workOrders: ManufacturingWorkOrder[];
  standardCostVersions: StandardCostVersion[];
  materialIssues: ManufacturingMaterialIssue[];
  materialReturns: ManufacturingMaterialReturn[];
  productionReceipts: ManufacturingProductionReceipt[];
  operationCosts: WorkOrderOperationCostEntry[];
  scraps: ManufacturingScrap[];
  auditTrail: MfgAuditEntry[];
  seeded: boolean;

  ensureSeeded: () => void;

  updateSettings: (patch: Partial<ManufacturingSettings>) => MfgResult;
  savePlant: (plant: ManufacturingPlant) => MfgResult;
  saveLine: (line: ProductionLine) => MfgResult;
  saveWorkCenter: (wc: WorkCenter) => MfgResult;
  deletePlant: (id: string) => MfgResult;

  saveBom: (bom: BillOfMaterials) => MfgResult;
  approveBom: (id: string) => MfgResult;
  reviseBom: (id: string) => MfgResult;

  saveRouting: (routing: ManufacturingRouting) => MfgResult;
  approveRouting: (id: string) => MfgResult;
  reviseRouting: (id: string) => MfgResult;

  createStandardCostVersion: (itemId: string, bomId: string, routingId: string, outputQuantity: number) => MfgResult;

  createWorkOrder: (input: CreateWorkOrderInput) => MfgResult;
  transitionWorkOrder: (id: string, to: WorkOrderStatus) => MfgResult;
  releaseWorkOrder: (id: string) => MfgResult;
  cancelWorkOrder: (id: string) => MfgResult;
  closeWorkOrder: (id: string) => MfgResult;

  postMaterialIssue: (input: IssueInput) => MfgResult;
  postMaterialReturn: (input: ReturnInput) => MfgResult;
  postProductionReceipt: (input: ReceiptInput) => MfgResult;
  postOperationCost: (input: OperationCostInput) => MfgResult;
  postScrap: (input: ScrapInput) => MfgResult;

  reverseMaterialIssue: (id: string) => MfgResult;
  reverseProductionReceipt: (id: string) => MfgResult;

  getActivity: (workOrderId: string) => WorkOrderActivity;
  resetToDefault: () => void;
}

export interface CreateWorkOrderInput {
  productItemId: string;
  bomId: string;
  routingId: string;
  plannedQuantity: number;
  plantId: string;
  productionLineId?: string;
  costCenterId: string;
  projectId?: string;
  plannedStartDate: string;
  plannedEndDate: string;
  unitId?: string;
}
export interface IssueInput { workOrderId: string; date: string; lines: Array<{ itemId: string; requirementId?: string; quantity: number; warehouseId?: string; costCenterId?: string }>; }
export interface ReturnInput { workOrderId: string; date: string; lines: Array<{ itemId: string; requirementId?: string; quantity: number; warehouseId?: string }>; }
export interface ReceiptInput { workOrderId: string; date: string; completedQuantity: number; }
export interface OperationCostInput { workOrderId: string; operationSnapshotId: string; date: string; setupHours?: number; runHours?: number; laborCost?: number; machineCost?: number; overheadCost?: number; }
export interface ScrapInput { workOrderId: string; date: string; itemId: string; quantity: number; reason: ScrapReason; accountingPolicy: ScrapPolicy; recoverableValue?: number; scrapWarehouseId?: string; costCenterId?: string; unitCost?: number; }

function audit(event: MfgAuditEvent, detail: string, extra?: { workOrderId?: string; documentId?: string }): MfgAuditEntry {
  return { id: generateId('mau'), entityId: MFG_ENTITY, event, at: nowIso(), actor: getCurrentUserName(), detail, ...extra };
}

function blank(): Pick<MfgState, 'settings' | 'plants' | 'lines' | 'workCenters' | 'boms' | 'routings' | 'workOrders' | 'standardCostVersions' | 'materialIssues' | 'materialReturns' | 'productionReceipts' | 'operationCosts' | 'scraps' | 'auditTrail' | 'seeded'> {
  return { settings: makeMfgSettings(), plants: [], lines: [], workCenters: [], boms: [], routings: [], workOrders: [], standardCostVersions: [], materialIssues: [], materialReturns: [], productionReceipts: [], operationCosts: [], scraps: [], auditTrail: [], seeded: false };
}

function r2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export const useManufacturingStore = create<MfgState>()(
  persist(
    (set, get) => {
      const accountByCode = (code: string): string | undefined => useStore.getState().accounts.find((a) => a.code === code && a.isPostingAccount)?.id;

      /** Resolve the GL accounts manufacturing postings need (settings → COA). */
      function mfgAccounts() {
        const s = get().settings;
        return {
          wip: s.defaultWipAccountId ?? accountByCode('1212'),
          labor: s.defaultLaborAbsorptionAccountId ?? accountByCode('5200'),
          machine: s.defaultMachineAbsorptionAccountId ?? accountByCode('5700'),
          overhead: s.defaultOverheadAbsorptionAccountId ?? accountByCode('5700'),
          scrapExpense: s.defaultScrapExpenseAccountId ?? accountByCode('5600'),
          variance: s.defaultVarianceAccountId ?? accountByCode('5600'),
        };
      }
      /** An inventory item's inventory (asset) account. */
      function itemInventoryAccount(itemId: string): string | undefined {
        const inv = useInventoryStore.getState();
        const item = inv.items.find((i) => i.id === itemId);
        if (!item) return undefined;
        const raw = item.itemType === 'raw-material' || item.itemType === 'component' || item.itemType === 'consumable' || item.itemType === 'packaging' || item.itemType === 'spare-part';
        return accountByCode(raw ? '1211' : item.itemType === 'subassembly' ? '1212' : '1213');
      }
      /** Company-wide weighted-average cost of an inventory item. */
      function avgCost(itemId: string): number {
        return getInventoryBalance(useInventoryStore.getState().movements, { entityId: MFG_ENTITY, itemId }).averageUnitCost;
      }
      function componentUnitCost(itemId: string): number {
        const avg = avgCost(itemId);
        if (avg > 0) return avg;
        return useInventoryStore.getState().items.find((i) => i.id === itemId)?.standardCost ?? 0;
      }
      function itemMeta(itemId: string): { code: string; name: string } {
        const item = useInventoryStore.getState().items.find((i) => i.id === itemId);
        return { code: item?.code ?? '', name: item?.name ?? '' };
      }
      function workCenterById(id: string): WorkCenter | undefined {
        return get().workCenters.find((w) => w.id === id);
      }
      function wo(id: string): ManufacturingWorkOrder | undefined { return get().workOrders.find((w) => w.id === id); }
      function updateWo(id: string, patch: Partial<ManufacturingWorkOrder>): void {
        set((s) => ({ workOrders: s.workOrders.map((w) => (w.id === id ? { ...w, ...patch, updatedAt: nowIso() } : w)) }));
      }
      function hasPostedMovements(workOrderId: string): boolean {
        return get().materialIssues.some((d) => d.workOrderId === workOrderId && d.status === 'posted') ||
          get().productionReceipts.some((d) => d.workOrderId === workOrderId && d.status === 'posted') ||
          get().scraps.some((d) => d.workOrderId === workOrderId && d.status === 'posted');
      }

      /** Post a balanced journal; returns its id or an error. */
      function postJournal(input: { date: string; reference: string; description: string; lines: Array<{ accountId?: string; debit: number; credit: number; description?: string; costCenter?: string; project?: string }> }): { ok: boolean; id?: string; error?: string } {
        if (input.lines.some((l) => !l.accountId)) return { ok: false, error: 'A required posting account could not be resolved.' };
        const res = useJournalStore.getState().insertPostedEntry({
          entryDate: input.date, reference: input.reference, description: input.description, currency: useStore.getState().settings.baseCurrency ?? 'USD', exchangeRate: 1, transactionType: 'Manufacturing',
          lines: input.lines.map((l) => ({ accountId: l.accountId!, debit: l.debit, credit: l.credit, description: l.description, costCenter: l.costCenter, project: l.project })),
        });
        return { ok: res.ok, id: res.id, error: res.error };
      }

      function getActivity(workOrderId: string): WorkOrderActivity {
        const s = get();
        return {
          issues: s.materialIssues.filter((d) => d.workOrderId === workOrderId),
          returns: s.materialReturns.filter((d) => d.workOrderId === workOrderId),
          receipts: s.productionReceipts.filter((d) => d.workOrderId === workOrderId),
          operationCosts: s.operationCosts.filter((d) => d.workOrderId === workOrderId),
          scraps: s.scraps.filter((d) => d.workOrderId === workOrderId),
        };
      }

      return {
        ...blank(),

        /* ── Seed ─────────────────────────────────────────────────────────── */
        ensureSeeded: () => {
          if (get().seeded) return;
          if (!useEntitlementStore.getState().effectiveModuleIds.includes('manufacturing_core')) return;
          const inv = useInventoryStore.getState();
          inv.ensureSeeded();
          // Add manufacturing warehouses + items (idempotent by code).
          for (const w of makeMfgWarehouses()) if (!useInventoryStore.getState().warehouses.some((x) => x.code === w.code)) useInventoryStore.getState().saveWarehouse(w);
          for (const it of makeMfgItems()) if (!useInventoryStore.getState().items.some((x) => x.code === it.code)) useInventoryStore.getState().saveItem(it);
          // Opening raw-material stock so the work order can issue material.
          useInventoryStore.getState().postOpeningBalance({ date: '2026-01-01', reference: 'MFG-OPEN', lines: makeMfgOpeningStock() });

          const costCenterId = useCostCenterStore.getState().costCenters[0]?.id ?? '';
          const md = makeMfgMasterData(costCenterId);
          set({ settings: makeMfgSettings(), plants: [md.plant], lines: md.lines, workCenters: md.workCenters, boms: [md.bom], routings: [md.routing], seeded: true });

          // Standard cost version for the cabinet.
          get().createStandardCostVersion('mfg_cabinet', 'mfg_bom_cabinet', 'mfg_rtg_cabinet', 1);

          // Planned + released work orders (10 units).
          const planned = get().createWorkOrder({ productItemId: 'mfg_cabinet', bomId: 'mfg_bom_cabinet', routingId: 'mfg_rtg_cabinet', plannedQuantity: 10, plantId: 'mfg_plant_01', productionLineId: 'mfg_line_01', costCenterId, plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-05' });
          if (planned.ok && planned.id) get().transitionWorkOrder(planned.id, 'planned');

          const released = get().createWorkOrder({ productItemId: 'mfg_cabinet', bomId: 'mfg_bom_cabinet', routingId: 'mfg_rtg_cabinet', plannedQuantity: 10, plantId: 'mfg_plant_01', productionLineId: 'mfg_line_01', costCenterId, plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-05' });
          if (released.ok && released.id) {
            get().transitionWorkOrder(released.id, 'planned');
            get().releaseWorkOrder(released.id);
            // Full material issue (490), conversion (150), partial receipt (5 units), one scrap.
            const w = wo(released.id)!;
            get().postMaterialIssue({ workOrderId: released.id, date: '2026-02-01', lines: w.materialRequirements.map((r) => ({ itemId: r.itemId, requirementId: r.id, quantity: r.requiredQuantity, warehouseId: r.warehouseId })) });
            for (const op of w.operationSnapshots) get().postOperationCost({ workOrderId: released.id, operationSnapshotId: op.id, date: '2026-02-02', runHours: op.plannedRunHours });
            get().postProductionReceipt({ workOrderId: released.id, date: '2026-02-04', completedQuantity: 5 });
            get().postScrap({ workOrderId: released.id, date: '2026-02-04', itemId: 'mfg_steel', quantity: 2, reason: 'normal-process-loss', accountingPolicy: 'abnormal-to-expense', costCenterId });
          }
        },

        /* ── Master data ──────────────────────────────────────────────────── */
        updateSettings: (patch) => { set((s) => ({ settings: { ...s.settings, ...patch, updatedAt: nowIso() }, auditTrail: [...s.auditTrail, audit('settings-updated', 'Manufacturing settings updated.')] })); return { ok: true }; },

        savePlant: (plant) => {
          const v = validatePlant(plant, get().plants); if (!v.ok) return v;
          const rec = { ...plant, entityId: MFG_ENTITY, updatedAt: nowIso(), createdAt: get().plants.find((p) => p.id === plant.id)?.createdAt ?? nowIso() };
          set((s) => ({ plants: s.plants.some((p) => p.id === plant.id) ? s.plants.map((p) => (p.id === plant.id ? rec : p)) : [...s.plants, rec], auditTrail: [...s.auditTrail, audit('plant-saved', `Plant "${rec.code}" saved.`)] }));
          return { ok: true, id: rec.id };
        },
        saveLine: (line) => {
          const v = validateProductionLine(line, get().lines); if (!v.ok) return v;
          const rec = { ...line, entityId: MFG_ENTITY, updatedAt: nowIso(), createdAt: get().lines.find((l) => l.id === line.id)?.createdAt ?? nowIso() };
          set((s) => ({ lines: s.lines.some((l) => l.id === line.id) ? s.lines.map((l) => (l.id === line.id ? rec : l)) : [...s.lines, rec], auditTrail: [...s.auditTrail, audit('line-saved', `Line "${rec.code}" saved.`)] }));
          return { ok: true, id: rec.id };
        },
        saveWorkCenter: (wc) => {
          const v = validateWorkCenter(wc, get().workCenters); if (!v.ok) return v;
          const rec = { ...wc, entityId: MFG_ENTITY, updatedAt: nowIso(), createdAt: get().workCenters.find((w) => w.id === wc.id)?.createdAt ?? nowIso() };
          set((s) => ({ workCenters: s.workCenters.some((w) => w.id === wc.id) ? s.workCenters.map((w) => (w.id === wc.id ? rec : w)) : [...s.workCenters, rec], auditTrail: [...s.auditTrail, audit('work-center-saved', `Work center "${rec.code}" saved.`)] }));
          return { ok: true, id: rec.id };
        },
        deletePlant: (id) => {
          if (get().workOrders.some((w) => w.plantId === id) || get().workCenters.some((w) => w.plantId === id)) return { ok: false, error: 'This plant is referenced by work centers or work orders and cannot be deleted. Archive it instead.' };
          set((s) => ({ plants: s.plants.filter((p) => p.id !== id) }));
          return { ok: true };
        },

        /* ── BOM ──────────────────────────────────────────────────────────── */
        saveBom: (bom) => {
          const existing = get().boms.find((b) => b.id === bom.id);
          if (existing && !canEditBom(existing)) return { ok: false, error: 'Approved BOMs are immutable. Create a new version to make changes.' };
          const v = validateBom(bom); if (!v.ok) return v;
          const bomsByProduct = new Map(get().boms.filter((b) => b.status === 'approved').map((b) => [b.productItemId, b]));
          if (hasCircularReference(bom.productItemId, bom.components, bomsByProduct)) return { ok: false, error: 'This BOM creates a circular reference.' };
          const version = existing?.version ?? nextBomVersion(get().boms, bom.productItemId);
          const rec: BillOfMaterials = { ...bom, entityId: MFG_ENTITY, version, updatedAt: nowIso(), createdAt: existing?.createdAt ?? nowIso() };
          set((s) => ({ boms: existing ? s.boms.map((b) => (b.id === bom.id ? rec : b)) : [...s.boms, rec], auditTrail: [...s.auditTrail, audit('bom-saved', `BOM "${rec.code}" v${rec.version} saved.`)] }));
          return { ok: true, id: rec.id };
        },
        approveBom: (id) => {
          const bom = get().boms.find((b) => b.id === id);
          if (!bom) return { ok: false, error: 'BOM not found.' };
          if (bom.status !== 'draft') return { ok: false, error: 'Only a draft BOM can be approved.' };
          const v = validateBom(bom); if (!v.ok) return v;
          set((s) => ({ boms: s.boms.map((b) => (b.id === id ? { ...b, status: 'approved', approvedAt: nowIso(), approvedBy: getCurrentUserName(), updatedAt: nowIso() } : b)), auditTrail: [...s.auditTrail, audit('bom-approved', `BOM "${bom.code}" v${bom.version} approved.`)] }));
          return { ok: true, id };
        },
        reviseBom: (id) => {
          const bom = get().boms.find((b) => b.id === id);
          if (!bom) return { ok: false, error: 'BOM not found.' };
          const draft = makeNewBomVersion(bom, get().boms, nowIso());
          set((s) => ({ boms: [...s.boms, draft], auditTrail: [...s.auditTrail, audit('bom-versioned', `BOM "${bom.code}" revised to v${draft.version}.`)] }));
          return { ok: true, id: draft.id };
        },

        /* ── Routing ──────────────────────────────────────────────────────── */
        saveRouting: (routing) => {
          const existing = get().routings.find((r) => r.id === routing.id);
          if (existing && !canEditRouting(existing)) return { ok: false, error: 'Approved routings are immutable. Create a new version to make changes.' };
          const v = validateRouting(routing); if (!v.ok) return v;
          const rec: ManufacturingRouting = { ...routing, entityId: MFG_ENTITY, updatedAt: nowIso(), createdAt: existing?.createdAt ?? nowIso() };
          set((s) => ({ routings: existing ? s.routings.map((r) => (r.id === routing.id ? rec : r)) : [...s.routings, rec], auditTrail: [...s.auditTrail, audit('routing-saved', `Routing "${rec.code}" v${rec.version} saved.`)] }));
          return { ok: true, id: rec.id };
        },
        approveRouting: (id) => {
          const r = get().routings.find((x) => x.id === id);
          if (!r) return { ok: false, error: 'Routing not found.' };
          if (r.status !== 'draft') return { ok: false, error: 'Only a draft routing can be approved.' };
          const v = validateRouting(r); if (!v.ok) return v;
          set((s) => ({ routings: s.routings.map((x) => (x.id === id ? { ...x, status: 'approved', approvedAt: nowIso(), approvedBy: getCurrentUserName(), updatedAt: nowIso() } : x)), auditTrail: [...s.auditTrail, audit('routing-approved', `Routing "${r.code}" v${r.version} approved.`)] }));
          return { ok: true, id };
        },
        reviseRouting: (id) => {
          const r = get().routings.find((x) => x.id === id);
          if (!r) return { ok: false, error: 'Routing not found.' };
          const draft = makeNewRoutingVersion(r, get().routings, nowIso());
          set((s) => ({ routings: [...s.routings, draft], auditTrail: [...s.auditTrail, audit('routing-versioned', `Routing "${r.code}" revised to v${draft.version}.`)] }));
          return { ok: true, id: draft.id };
        },

        /* ── Standard cost ────────────────────────────────────────────────── */
        createStandardCostVersion: (itemId, bomId, routingId, outputQuantity) => {
          const bom = get().boms.find((b) => b.id === bomId);
          const routing = get().routings.find((r) => r.id === routingId);
          if (!bom || !routing) return { ok: false, error: 'BOM or routing not found.' };
          const breakdown = calculateStandardManufacturingCost({ itemId, bom, routing, outputQuantity, componentUnitCost, workCenterById });
          const now = nowIso();
          const version: StandardCostVersion = { id: generateId('scv'), entityId: MFG_ENTITY, itemId, effectiveFrom: now.slice(0, 10), breakdown, status: 'active', createdAt: now, createdBy: getCurrentUserName() };
          set((s) => ({
            standardCostVersions: [...s.standardCostVersions.map((v) => (v.itemId === itemId && v.status === 'active' ? { ...v, status: 'superseded' as const, effectiveTo: now.slice(0, 10) } : v)), version],
            auditTrail: [...s.auditTrail, audit('standard-cost-versioned', `Standard cost for ${itemMeta(itemId).code}: ${breakdown.unitCost}/unit.`)],
          }));
          return { ok: true, id: version.id };
        },

        /* ── Work orders ──────────────────────────────────────────────────── */
        createWorkOrder: (input) => {
          const bom = get().boms.find((b) => b.id === input.bomId);
          const routing = get().routings.find((r) => r.id === input.routingId);
          if (!bom || bom.status !== 'approved') return { ok: false, error: 'Select an approved BOM.' };
          if (!routing || routing.status !== 'approved') return { ok: false, error: 'Select an approved routing.' };
          const plant = get().plants.find((p) => p.id === input.plantId);
          if (!plant) return { ok: false, error: 'Select a plant.' };
          const breakdown = calculateStandardManufacturingCost({ itemId: input.productItemId, bom, routing, outputQuantity: input.plannedQuantity, componentUnitCost, workCenterById });
          const now = nowIso();
          const id = generateId('wo');
          const record: ManufacturingWorkOrder = {
            id, entityId: MFG_ENTITY, workOrderNumber: nextMfgNumber(get().settings.workOrderPrefix, get().workOrders.map((w) => w.workOrderNumber), input.plannedStartDate),
            plantId: input.plantId, productionLineId: input.productionLineId, productItemId: input.productItemId,
            bomId: bom.id, bomVersion: bom.version, routingId: routing.id, routingVersion: routing.version,
            plannedQuantity: input.plannedQuantity, completedQuantity: 0, scrappedQuantity: 0, unitId: input.unitId ?? bom.outputUnitId,
            plannedStartDate: input.plannedStartDate, plannedEndDate: input.plannedEndDate,
            rawMaterialWarehouseId: plant.rawMaterialWarehouseId ?? get().settings.defaultRawMaterialWarehouseId ?? '',
            wipWarehouseId: plant.wipWarehouseId ?? get().settings.defaultWipWarehouseId ?? '',
            finishedGoodsWarehouseId: plant.finishedGoodsWarehouseId ?? get().settings.defaultFinishedGoodsWarehouseId ?? '',
            scrapWarehouseId: plant.scrapWarehouseId ?? get().settings.defaultScrapWarehouseId,
            costCenterId: input.costCenterId, projectId: input.projectId, status: 'draft',
            materialRequirements: [], operationSnapshots: [], standardCostSnapshot: breakdown,
            createdAt: now, updatedAt: now,
          };
          set((s) => ({ workOrders: [...s.workOrders, record], auditTrail: [...s.auditTrail, audit('work-order-created', `Work order ${record.workOrderNumber} created.`, { workOrderId: id })] }));
          return { ok: true, id };
        },

        transitionWorkOrder: (id, to) => {
          const w = wo(id); if (!w) return { ok: false, error: 'Work order not found.' };
          if (to === 'released') return get().releaseWorkOrder(id);
          if (to === 'cancelled') return get().cancelWorkOrder(id);
          if (to === 'closed') return get().closeWorkOrder(id);
          if (!canTransition(w.status, to)) return { ok: false, error: `Cannot move a work order from ${w.status} to ${to}.` };
          updateWo(id, { status: to });
          set((s) => ({ auditTrail: [...s.auditTrail, audit('work-order-transitioned', `${w.workOrderNumber}: ${w.status} → ${to}.`, { workOrderId: id })] }));
          return { ok: true, id };
        },

        releaseWorkOrder: (id) => {
          const w = wo(id); if (!w) return { ok: false, error: 'Work order not found.' };
          if (w.status !== 'planned') return { ok: false, error: 'Only a planned work order can be released.' };
          const bom = get().boms.find((b) => b.id === w.bomId);
          const routing = get().routings.find((r) => r.id === w.routingId);
          if (!bom || !routing) return { ok: false, error: 'Snapshot source BOM/routing missing.' };
          const requirements = buildMaterialRequirements(id, bom, w.plannedQuantity, componentUnitCost, itemMeta, w.rawMaterialWarehouseId, () => generateId('req'));
          const operations = buildOperationSnapshots(id, routing, w.plannedQuantity, workCenterById, () => generateId('ops'));
          const breakdown = calculateStandardManufacturingCost({ itemId: w.productItemId, bom, routing, outputQuantity: w.plannedQuantity, componentUnitCost, workCenterById });
          updateWo(id, { status: 'released', materialRequirements: requirements, operationSnapshots: operations, standardCostSnapshot: breakdown, releasedAt: nowIso(), releasedBy: getCurrentUserName(), actualStartDate: w.actualStartDate ?? nowIso().slice(0, 10) });
          set((s) => ({ auditTrail: [...s.auditTrail, audit('work-order-released', `${w.workOrderNumber} released (${requirements.length} requirements snapshotted).`, { workOrderId: id })] }));
          return { ok: true, id };
        },

        cancelWorkOrder: (id) => {
          const w = wo(id); if (!w) return { ok: false, error: 'Work order not found.' };
          if (w.status !== 'draft' && w.status !== 'planned') return { ok: false, error: 'Only a draft or planned work order can be cancelled.' };
          if (hasPostedMovements(id)) return { ok: false, error: 'A work order with posted production movements cannot be cancelled — reverse them first.' };
          updateWo(id, { status: 'cancelled' });
          set((s) => ({ auditTrail: [...s.auditTrail, audit('work-order-cancelled', `${w.workOrderNumber} cancelled.`, { workOrderId: id })] }));
          return { ok: true, id };
        },

        closeWorkOrder: (id) => {
          const w = wo(id); if (!w) return { ok: false, error: 'Work order not found.' };
          if (w.status !== 'completed' && w.status !== 'partially-completed') return { ok: false, error: 'Only a completed work order can be closed.' };
          const activity = getActivity(id);
          const wip = calculateWorkOrderWip(id, activity);
          const actual = calculateActualWorkOrderCost(id, activity);
          const variance = calculateVariance(w.standardCostSnapshot.unitCost, w.standardCostSnapshot, actual);
          const requiredMaterial = w.materialRequirements.reduce((s, r) => s + r.requiredQuantity, 0);
          const issuedMaterial = w.materialRequirements.reduce((s, r) => s + r.issuedQuantity, 0);
          const returnedMaterial = w.materialRequirements.reduce((s, r) => s + r.returnedQuantity, 0);
          const now = nowIso();
          updateWo(id, {
            status: 'closed', closedAt: now, closedBy: getCurrentUserName(), actualEndDate: now.slice(0, 10),
            closeoutSnapshot: { workOrderId: id, plannedOutput: w.plannedQuantity, completedOutput: w.completedQuantity, scrap: w.scrappedQuantity, requiredMaterial, issuedMaterial, returnedMaterial, materialVariance: r2(issuedMaterial - returnedMaterial - requiredMaterial), standardCost: r2(w.standardCostSnapshot.unitCost * w.completedQuantity), actualCost: actual.totalCost, totalVariance: variance.totalVariance, remainingWip: wip.remainingWip, closedAt: now },
          });
          set((s) => ({ auditTrail: [...s.auditTrail, audit('work-order-closed', `${w.workOrderNumber} closed. Variance ${variance.totalVariance}.`, { workOrderId: id })] }));
          return { ok: true, id };
        },

        /* ── Posting: material issue (Dr WIP / Cr RM) ─────────────────────── */
        postMaterialIssue: (input) => {
          const w = wo(input.workOrderId); if (!w) return { ok: false, error: 'Work order not found.' };
          if (!acceptsProductionActivity(w.status)) return { ok: false, error: `Cannot issue material to a ${w.status} work order.` };
          const acc = mfgAccounts();
          if (!acc.wip) return { ok: false, error: 'No WIP account configured.' };
          const invMovements = useInventoryStore.getState().movements;
          const jlines: Array<{ accountId?: string; debit: number; credit: number; description?: string; costCenter?: string }> = [];
          const movLines: Array<{ id: string; itemId: string; warehouseId: string; quantity: number; direction: 'out'; unitCost: number; workOrderId: string }> = [];
          const issueLines: ManufacturingMaterialIssue['lines'] = [];
          let total = 0;
          for (const line of input.lines) {
            const req = line.requirementId ? w.materialRequirements.find((r) => r.id === line.requirementId) : undefined;
            const warehouseId = line.warehouseId ?? req?.warehouseId ?? w.rawMaterialWarehouseId;
            const unitCost = avgCost(line.itemId);
            const onHand = getInventoryBalance(invMovements, { entityId: MFG_ENTITY, itemId: line.itemId, warehouseId }).quantityOnHand;
            if (line.quantity > onHand + 1e-9 && !useInventoryStore.getState().settings.negativeStockPolicy.includes('allow')) return { ok: false, error: `Insufficient stock for ${itemMeta(line.itemId).code}: ${onHand} available, ${line.quantity} requested.` };
            if (req && !get().settings.allowMaterialOverIssue && req.issuedQuantity - req.returnedQuantity + line.quantity > req.requiredQuantity + 1e-9) return { ok: false, error: `Over-issue blocked for ${itemMeta(line.itemId).code} (requirement ${req.requiredQuantity}).` };
            const invAcc = itemInventoryAccount(line.itemId);
            if (!invAcc) return { ok: false, error: `No inventory account for ${itemMeta(line.itemId).code}.` };
            const lineTotal = r2(line.quantity * unitCost);
            total = r2(total + lineTotal);
            jlines.push({ accountId: acc.wip, debit: lineTotal, credit: 0, description: `Issue ${itemMeta(line.itemId).code}`, costCenter: line.costCenterId ?? w.costCenterId });
            jlines.push({ accountId: invAcc, debit: 0, credit: lineTotal, description: `Issue ${itemMeta(line.itemId).code}` });
            movLines.push({ id: generateId('mil'), itemId: line.itemId, warehouseId, quantity: line.quantity, direction: 'out', unitCost, workOrderId: input.workOrderId });
            issueLines.push({ id: movLines[movLines.length - 1]!.id, itemId: line.itemId, requirementId: line.requirementId, quantity: line.quantity, unitId: req?.unitId ?? '', sourceWarehouseId: warehouseId, unitCostSnapshot: unitCost, totalCostSnapshot: lineTotal, costCenterId: line.costCenterId ?? w.costCenterId, projectId: w.projectId });
          }
          if (movLines.length === 0) return { ok: false, error: 'Nothing to issue.' };
          const number = nextMfgNumber(get().settings.materialIssuePrefix, get().materialIssues.map((d) => d.issueNumber), input.date);
          const je = postJournal({ date: input.date, reference: number, description: `Material issue ${number} — ${w.workOrderNumber}`, lines: jlines });
          if (!je.ok || !je.id) return { ok: false, error: je.error };
          const invRes = useInventoryStore.getState().recordLinkedMovements({ date: input.date, reference: number, journalEntryId: je.id, kind: 'mfg-issue', lines: movLines });
          if (!invRes.ok) { const rev = useJournalStore.getState().reverseEntry(je.id); if (rev.ok && rev.id) useJournalStore.getState().postEntry(rev.id); return { ok: false, error: invRes.error }; }
          const now = nowIso();
          const doc: ManufacturingMaterialIssue = { id: generateId('mi'), entityId: MFG_ENTITY, issueNumber: number, workOrderId: input.workOrderId, issueDate: input.date, postingDate: input.date, lines: issueLines, totalCost: total, status: 'posted', journalEntryId: je.id, inventoryDocumentId: invRes.id, postedAt: now, postedBy: getCurrentUserName(), createdAt: now, updatedAt: now };
          set((s) => ({
            materialIssues: [...s.materialIssues, doc],
            workOrders: s.workOrders.map((x) => (x.id === input.workOrderId ? { ...x, status: x.status === 'released' ? 'in-progress' : x.status, materialRequirements: x.materialRequirements.map((r) => { const l = input.lines.find((li) => li.requirementId === r.id); return l ? { ...r, issuedQuantity: r2(r.issuedQuantity + l.quantity) } : r; }), updatedAt: now } : x)),
            auditTrail: [...s.auditTrail, audit('material-issue-posted', `Material issue ${number} posted (${total}).`, { workOrderId: input.workOrderId, documentId: doc.id })],
          }));
          return { ok: true, id: doc.id, journalEntryId: je.id, movementIds: invRes.movementIds };
        },

        /* ── Posting: material return (Dr RM / Cr WIP) ────────────────────── */
        postMaterialReturn: (input) => {
          const w = wo(input.workOrderId); if (!w) return { ok: false, error: 'Work order not found.' };
          if (!acceptsProductionActivity(w.status)) return { ok: false, error: `Cannot return material on a ${w.status} work order.` };
          const acc = mfgAccounts();
          if (!acc.wip) return { ok: false, error: 'No WIP account configured.' };
          const jlines: Array<{ accountId?: string; debit: number; credit: number; description?: string }> = [];
          const movLines: Array<{ id: string; itemId: string; warehouseId: string; quantity: number; direction: 'in'; unitCost: number; workOrderId: string }> = [];
          const returnLines: ManufacturingMaterialReturn['lines'] = [];
          let total = 0;
          for (const line of input.lines) {
            const req = line.requirementId ? w.materialRequirements.find((r) => r.id === line.requirementId) : undefined;
            const warehouseId = line.warehouseId ?? req?.warehouseId ?? w.rawMaterialWarehouseId;
            // Original issue cost: weighted from posted issues for this requirement.
            const issues = get().materialIssues.filter((d) => d.workOrderId === input.workOrderId && d.status === 'posted').flatMap((d) => d.lines).filter((l) => l.itemId === line.itemId && (!line.requirementId || l.requirementId === line.requirementId));
            const issuedQty = issues.reduce((s, l) => s + l.quantity, 0);
            const issuedCost = issues.reduce((s, l) => s + (l.totalCostSnapshot ?? 0), 0);
            const netIssued = req ? req.issuedQuantity - req.returnedQuantity : issuedQty;
            if (line.quantity > netIssued + 1e-9) return { ok: false, error: `Cannot return ${line.quantity}; only ${netIssued} of ${itemMeta(line.itemId).code} were net issued.` };
            const unitCost = issuedQty > 0 ? issuedCost / issuedQty : avgCost(line.itemId);
            const invAcc = itemInventoryAccount(line.itemId);
            if (!invAcc) return { ok: false, error: `No inventory account for ${itemMeta(line.itemId).code}.` };
            const lineTotal = r2(line.quantity * unitCost);
            total = r2(total + lineTotal);
            jlines.push({ accountId: invAcc, debit: lineTotal, credit: 0, description: `Return ${itemMeta(line.itemId).code}` });
            jlines.push({ accountId: acc.wip, debit: 0, credit: lineTotal, description: `Return ${itemMeta(line.itemId).code}` });
            const mlId = generateId('mrl');
            movLines.push({ id: mlId, itemId: line.itemId, warehouseId, quantity: line.quantity, direction: 'in', unitCost, workOrderId: input.workOrderId });
            returnLines.push({ id: mlId, itemId: line.itemId, requirementId: line.requirementId, quantity: line.quantity, unitId: req?.unitId ?? '', warehouseId, unitCostSnapshot: unitCost, totalCostSnapshot: lineTotal, costCenterId: w.costCenterId });
          }
          if (movLines.length === 0) return { ok: false, error: 'Nothing to return.' };
          const number = nextMfgNumber(get().settings.materialReturnPrefix, get().materialReturns.map((d) => d.returnNumber), input.date);
          const je = postJournal({ date: input.date, reference: number, description: `Material return ${number} — ${w.workOrderNumber}`, lines: jlines });
          if (!je.ok || !je.id) return { ok: false, error: je.error };
          const invRes = useInventoryStore.getState().recordLinkedMovements({ date: input.date, reference: number, journalEntryId: je.id, kind: 'mfg-return', lines: movLines });
          if (!invRes.ok) { const rev = useJournalStore.getState().reverseEntry(je.id); if (rev.ok && rev.id) useJournalStore.getState().postEntry(rev.id); return { ok: false, error: invRes.error }; }
          const now = nowIso();
          const doc: ManufacturingMaterialReturn = { id: generateId('mr'), entityId: MFG_ENTITY, returnNumber: number, workOrderId: input.workOrderId, returnDate: input.date, postingDate: input.date, lines: returnLines, totalCost: total, status: 'posted', journalEntryId: je.id, inventoryDocumentId: invRes.id, postedAt: now, postedBy: getCurrentUserName(), createdAt: now, updatedAt: now };
          set((s) => ({
            materialReturns: [...s.materialReturns, doc],
            workOrders: s.workOrders.map((x) => (x.id === input.workOrderId ? { ...x, materialRequirements: x.materialRequirements.map((r) => { const l = input.lines.find((li) => li.requirementId === r.id); return l ? { ...r, returnedQuantity: r2(r.returnedQuantity + l.quantity) } : r; }), updatedAt: now } : x)),
            auditTrail: [...s.auditTrail, audit('material-return-posted', `Material return ${number} posted (${total}).`, { workOrderId: input.workOrderId, documentId: doc.id })],
          }));
          return { ok: true, id: doc.id, journalEntryId: je.id, movementIds: invRes.movementIds };
        },

        /* ── Posting: production receipt (Dr FG / Cr WIP) ─────────────────── */
        postProductionReceipt: (input) => {
          const w = wo(input.workOrderId); if (!w) return { ok: false, error: 'Work order not found.' };
          if (!acceptsProductionActivity(w.status)) return { ok: false, error: `Cannot receive production on a ${w.status} work order.` };
          if (input.completedQuantity <= 0) return { ok: false, error: 'Completed quantity must be positive.' };
          const receivedSoFar = get().productionReceipts.filter((d) => d.workOrderId === input.workOrderId && d.status === 'posted').reduce((s, d) => s + d.completedQuantity, 0);
          if (!get().settings.allowOverproduction && receivedSoFar + input.completedQuantity > w.plannedQuantity + 1e-9) return { ok: false, error: `Overproduction blocked: planned ${w.plannedQuantity}, already ${receivedSoFar}.` };
          const acc = mfgAccounts();
          const fgAcc = itemInventoryAccount(w.productItemId);
          if (!acc.wip || !fgAcc) return { ok: false, error: 'WIP or finished-goods account not configured.' };
          const policy = get().settings.costingPolicy;
          let unitCost = w.standardCostSnapshot.unitCost;
          if (policy === 'actual') { const actual = calculateActualWorkOrderCost(input.workOrderId, getActivity(input.workOrderId)); const remaining = w.plannedQuantity - receivedSoFar; unitCost = remaining > 0 ? r2(actual.totalCost / Math.max(1, remaining)) : actual.costPerCompletedUnit ?? w.standardCostSnapshot.unitCost; }
          const totalCost = r2(input.completedQuantity * unitCost);
          const number = nextMfgNumber(get().settings.productionReceiptPrefix, get().productionReceipts.map((d) => d.receiptNumber), input.date);
          const je = postJournal({ date: input.date, reference: number, description: `Production receipt ${number} — ${w.workOrderNumber}`, lines: [{ accountId: fgAcc, debit: totalCost, credit: 0, description: `Receive ${itemMeta(w.productItemId).code}` }, { accountId: acc.wip, debit: 0, credit: totalCost, description: `WIP → FG ${w.workOrderNumber}` }] });
          if (!je.ok || !je.id) return { ok: false, error: je.error };
          const invRes = useInventoryStore.getState().recordLinkedMovements({ date: input.date, reference: number, journalEntryId: je.id, kind: 'mfg-receipt', lines: [{ id: generateId('prl'), itemId: w.productItemId, warehouseId: w.finishedGoodsWarehouseId, quantity: input.completedQuantity, direction: 'in', unitCost, workOrderId: input.workOrderId }] });
          if (!invRes.ok) { const rev = useJournalStore.getState().reverseEntry(je.id); if (rev.ok && rev.id) useJournalStore.getState().postEntry(rev.id); return { ok: false, error: invRes.error }; }
          const now = nowIso();
          const doc: ManufacturingProductionReceipt = { id: generateId('pr'), entityId: MFG_ENTITY, receiptNumber: number, workOrderId: input.workOrderId, receiptDate: input.date, postingDate: input.date, finishedGoodsWarehouseId: w.finishedGoodsWarehouseId, wipWarehouseId: w.wipWarehouseId, completedQuantity: input.completedQuantity, unitId: w.unitId, status: 'posted', journalEntryId: je.id, inventoryDocumentId: invRes.id, costSnapshot: { costingPolicy: policy, unitCost, totalCost }, postedAt: now, postedBy: getCurrentUserName(), createdAt: now, updatedAt: now };
          const newCompleted = r2(w.completedQuantity + input.completedQuantity);
          set((s) => ({
            productionReceipts: [...s.productionReceipts, doc],
            workOrders: s.workOrders.map((x) => (x.id === input.workOrderId ? { ...x, completedQuantity: newCompleted, status: completionStatus(x.plannedQuantity, newCompleted, x.status), updatedAt: now } : x)),
            auditTrail: [...s.auditTrail, audit('production-receipt-posted', `Production receipt ${number}: ${input.completedQuantity} @ ${unitCost}.`, { workOrderId: input.workOrderId, documentId: doc.id })],
          }));
          return { ok: true, id: doc.id, journalEntryId: je.id, movementIds: invRes.movementIds };
        },

        /* ── Posting: operation cost (Dr WIP / Cr absorption) ─────────────── */
        postOperationCost: (input) => {
          const w = wo(input.workOrderId); if (!w) return { ok: false, error: 'Work order not found.' };
          if (!acceptsProductionActivity(w.status)) return { ok: false, error: `Cannot post conversion to a ${w.status} work order.` };
          const op = w.operationSnapshots.find((o) => o.id === input.operationSnapshotId);
          if (!op) return { ok: false, error: 'Operation snapshot not found.' };
          const runHours = input.runHours ?? op.plannedRunHours;
          const setupHours = input.setupHours ?? op.plannedSetupHours;
          const laborCost = r2(input.laborCost ?? runHours * op.laborRateSnapshot);
          const machineCost = r2(input.machineCost ?? runHours * op.machineRateSnapshot);
          const overheadCost = r2(input.overheadCost ?? runHours * op.overheadRateSnapshot);
          const totalCost = r2(laborCost + machineCost + overheadCost);
          if (totalCost <= 0) return { ok: false, error: 'Operation cost must be positive.' };
          const acc = mfgAccounts();
          if (!acc.wip || !acc.labor || !acc.machine || !acc.overhead) return { ok: false, error: 'WIP / absorption accounts not configured.' };
          const lines: Array<{ accountId?: string; debit: number; credit: number; description?: string; costCenter?: string }> = [{ accountId: acc.wip, debit: totalCost, credit: 0, description: `Conversion ${op.name}`, costCenter: w.costCenterId }];
          if (laborCost > 0) lines.push({ accountId: acc.labor, debit: 0, credit: laborCost, description: 'Labor absorbed' });
          if (machineCost > 0) lines.push({ accountId: acc.machine, debit: 0, credit: machineCost, description: 'Machine absorbed' });
          if (overheadCost > 0) lines.push({ accountId: acc.overhead, debit: 0, credit: overheadCost, description: 'Overhead absorbed' });
          const je = postJournal({ date: input.date, reference: `OPC-${w.workOrderNumber}`, description: `Operation cost — ${w.workOrderNumber} ${op.name}`, lines });
          if (!je.ok || !je.id) return { ok: false, error: je.error };
          const now = nowIso();
          const doc: WorkOrderOperationCostEntry = { id: generateId('opc'), entityId: MFG_ENTITY, workOrderId: input.workOrderId, operationSnapshotId: input.operationSnapshotId, postingDate: input.date, setupHours, runHours, laborCost, machineCost, overheadCost, totalCost, costCenterId: w.costCenterId, status: 'posted', journalEntryId: je.id, createdAt: now };
          set((s) => ({
            operationCosts: [...s.operationCosts, doc],
            workOrders: s.workOrders.map((x) => (x.id === input.workOrderId ? { ...x, operationSnapshots: x.operationSnapshots.map((o) => (o.id === input.operationSnapshotId ? { ...o, actualRunHours: r2(o.actualRunHours + runHours), actualSetupHours: r2(o.actualSetupHours + setupHours), status: 'completed' } : o)), updatedAt: now } : x)),
            auditTrail: [...s.auditTrail, audit('operation-cost-posted', `Conversion ${totalCost} posted for ${w.workOrderNumber} ${op.name}.`, { workOrderId: input.workOrderId, documentId: doc.id })],
          }));
          return { ok: true, id: doc.id, journalEntryId: je.id };
        },

        /* ── Posting: scrap ───────────────────────────────────────────────── */
        postScrap: (input) => {
          const w = wo(input.workOrderId); if (!w) return { ok: false, error: 'Work order not found.' };
          if (!acceptsProductionActivity(w.status)) return { ok: false, error: `Cannot scrap on a ${w.status} work order.` };
          if (input.quantity <= 0) return { ok: false, error: 'Scrap quantity must be positive.' };
          const acc = mfgAccounts();
          if (!acc.wip) return { ok: false, error: 'No WIP account configured.' };
          const unitCost = input.unitCost ?? avgCost(input.itemId) ?? 0;
          const recoverable = input.accountingPolicy === 'normal-to-product-cost';
          const totalCost = recoverable ? r2(input.recoverableValue ?? r2(input.quantity * unitCost)) : r2(input.quantity * unitCost);
          if (totalCost <= 0) return { ok: false, error: 'Scrap cost/recoverable value must be positive.' };
          const number = nextMfgNumber(get().settings.scrapPrefix, get().scraps.map((d) => d.scrapNumber), input.date);
          const costCenterId = input.costCenterId ?? w.costCenterId;
          let je: { ok: boolean; id?: string; error?: string };
          let invId: string | undefined;
          if (recoverable) {
            const scrapWarehouseId = input.scrapWarehouseId ?? w.scrapWarehouseId ?? get().settings.defaultScrapWarehouseId ?? '';
            const invAcc = itemInventoryAccount(input.itemId);
            if (!invAcc) return { ok: false, error: 'No inventory account for the scrap item.' };
            je = postJournal({ date: input.date, reference: number, description: `Recoverable scrap ${number} — ${w.workOrderNumber}`, lines: [{ accountId: invAcc, debit: totalCost, credit: 0, description: 'Scrap to inventory' }, { accountId: acc.wip, debit: 0, credit: totalCost, description: 'WIP → scrap', costCenter: costCenterId }] });
            if (!je.ok || !je.id) return { ok: false, error: je.error };
            const invRes = useInventoryStore.getState().recordLinkedMovements({ date: input.date, reference: number, journalEntryId: je.id, kind: 'mfg-scrap', lines: [{ id: generateId('scl'), itemId: input.itemId, warehouseId: scrapWarehouseId, quantity: input.quantity, direction: 'in', unitCost: r2(totalCost / input.quantity), workOrderId: input.workOrderId }] });
            if (!invRes.ok) { const rev = useJournalStore.getState().reverseEntry(je.id); if (rev.ok && rev.id) useJournalStore.getState().postEntry(rev.id); return { ok: false, error: invRes.error }; }
            invId = invRes.id;
          } else {
            if (!acc.scrapExpense) return { ok: false, error: 'No scrap-expense account configured.' };
            je = postJournal({ date: input.date, reference: number, description: `Abnormal scrap ${number} — ${w.workOrderNumber}`, lines: [{ accountId: acc.scrapExpense, debit: totalCost, credit: 0, description: 'Scrap expense', costCenter: costCenterId }, { accountId: acc.wip, debit: 0, credit: totalCost, description: 'WIP → scrap' }] });
            if (!je.ok || !je.id) return { ok: false, error: je.error };
          }
          const now = nowIso();
          const doc: ManufacturingScrap = { id: generateId('scrap'), entityId: MFG_ENTITY, scrapNumber: number, workOrderId: input.workOrderId, scrapDate: input.date, postingDate: input.date, itemId: input.itemId, quantity: input.quantity, unitId: '', reason: input.reason, accountingPolicy: input.accountingPolicy, recoverableValue: recoverable ? totalCost : undefined, scrapWarehouseId: input.scrapWarehouseId, costCenterId, totalCost, status: 'posted', journalEntryId: je.id, inventoryDocumentId: invId, postedAt: now, postedBy: getCurrentUserName(), createdAt: now, updatedAt: now };
          set((s) => ({
            scraps: [...s.scraps, doc],
            workOrders: s.workOrders.map((x) => (x.id === input.workOrderId ? { ...x, scrappedQuantity: r2(x.scrappedQuantity + input.quantity), updatedAt: now } : x)),
            auditTrail: [...s.auditTrail, audit('scrap-posted', `Scrap ${number}: ${input.quantity} (${input.accountingPolicy}).`, { workOrderId: input.workOrderId, documentId: doc.id })],
          }));
          return { ok: true, id: doc.id, journalEntryId: je.id };
        },

        /* ── Reversal ─────────────────────────────────────────────────────── */
        reverseMaterialIssue: (id) => {
          const doc = get().materialIssues.find((d) => d.id === id);
          if (!doc || doc.status !== 'posted') return { ok: false, error: 'Posted material issue not found.' };
          if (doc.journalEntryId) { const rev = useJournalStore.getState().reverseEntry(doc.journalEntryId); if (rev.ok && rev.id) useJournalStore.getState().postEntry(rev.id); }
          if (doc.inventoryDocumentId) { const r = useInventoryStore.getState().reverseDocument(doc.inventoryDocumentId); if (!r.ok) return { ok: false, error: r.error }; }
          const now = nowIso();
          set((s) => ({
            materialIssues: s.materialIssues.map((d) => (d.id === id ? { ...d, status: 'reversed', updatedAt: now } : d)),
            workOrders: s.workOrders.map((x) => (x.id === doc.workOrderId ? { ...x, materialRequirements: x.materialRequirements.map((r) => { const l = doc.lines.find((li) => li.requirementId === r.id); return l ? { ...r, issuedQuantity: r2(r.issuedQuantity - l.quantity) } : r; }) } : x)),
            auditTrail: [...s.auditTrail, audit('material-issue-reversed', `Material issue ${doc.issueNumber} reversed.`, { workOrderId: doc.workOrderId, documentId: id })],
          }));
          return { ok: true, id };
        },
        reverseProductionReceipt: (id) => {
          const doc = get().productionReceipts.find((d) => d.id === id);
          if (!doc || doc.status !== 'posted') return { ok: false, error: 'Posted production receipt not found.' };
          if (doc.journalEntryId) { const rev = useJournalStore.getState().reverseEntry(doc.journalEntryId); if (rev.ok && rev.id) useJournalStore.getState().postEntry(rev.id); }
          if (doc.inventoryDocumentId) { const r = useInventoryStore.getState().reverseDocument(doc.inventoryDocumentId); if (!r.ok) return { ok: false, error: r.error }; }
          const now = nowIso();
          set((s) => ({
            productionReceipts: s.productionReceipts.map((d) => (d.id === id ? { ...d, status: 'reversed', updatedAt: now } : d)),
            workOrders: s.workOrders.map((x) => (x.id === doc.workOrderId ? { ...x, completedQuantity: r2(x.completedQuantity - doc.completedQuantity), status: completionStatus(x.plannedQuantity, r2(x.completedQuantity - doc.completedQuantity), x.status) } : x)),
            auditTrail: [...s.auditTrail, audit('production-receipt-reversed', `Production receipt ${doc.receiptNumber} reversed.`, { workOrderId: doc.workOrderId, documentId: id })],
          }));
          return { ok: true, id };
        },

        getActivity,
        resetToDefault: () => set({ ...blank() }),
      };
    },
    {
      name: 'ledgora-manufacturing', storage: businessJSONStorage,
      version: 1,
      partialize: (s) => ({ settings: s.settings, plants: s.plants, lines: s.lines, workCenters: s.workCenters, boms: s.boms, routings: s.routings, workOrders: s.workOrders, standardCostVersions: s.standardCostVersions, materialIssues: s.materialIssues, materialReturns: s.materialReturns, productionReceipts: s.productionReceipts, operationCosts: s.operationCosts, scraps: s.scraps, auditTrail: s.auditTrail, seeded: s.seeded }),
    },
  ),
);

/**
 * Whether the active organization is entitled to manufacturing. Deliberately
 * the REAL entitlement — never the operator full-access override — so viewing
 * a subscriber cannot write manufacturing data their package doesn't include.
 */
export function manufacturingEnabled(): boolean {
  return useEntitlementStore.getState().effectiveModuleIds.includes('manufacturing_core');
}
