import { describe, it, expect, beforeEach } from 'vitest';
import { useManufacturingStore } from './manufacturingStore';
import { useInventoryStore } from './inventoryStore';
import { useJournalStore } from './journalStore';
import { useEntitlementStore } from './entitlementStore';
import { useCostCenterStore } from './costCenterStore';
import { useSessionStore } from './sessionStore';
import { getInventoryValue } from '@/lib/inventoryBalance';
import { calculateWorkOrderWip, calculateActualWorkOrderCost, calculateVariance } from '@/lib/manufacturingCosting';
import { buildManufacturingReconciliation } from '@/lib/manufacturingReconciliation';
import { ENTITY } from '@/lib/inventorySeed';

const mfg = () => useManufacturingStore.getState();
const wipAccountId = () => useJournalStore.getState().entries.flatMap((e) => e.lines).find((l) => l.accountCode === '1212')?.accountId;

function releasedWorkOrder(): string {
  return mfg().workOrders.find((w) => w.status !== 'draft' && w.status !== 'planned' && w.materialRequirements.length > 0)!.id;
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault(); // enterprise dev → manufacturing enabled
  useCostCenterStore.getState().resetToDefault?.();
  useInventoryStore.getState().resetToDefault();
  useManufacturingStore.getState().resetToDefault();
  useSessionStore.setState({ role: 'admin', userName: 'Plant Manager' });
  useManufacturingStore.getState().ensureSeeded();
});

/* ── Standard cost (acceptance §34) ───────────────────────────────────────── */

describe('standard manufacturing cost', () => {
  it('rolls up material 49 + conversion 15 = 64 per unit (640 for 10)', () => {
    // The cost VERSION is per unit output (49 material + 15 conversion = 64).
    const scv = mfg().standardCostVersions.find((v) => v.itemId === 'mfg_cabinet' && v.status === 'active')!;
    expect(scv.breakdown.materialCost).toBe(49);
    expect(scv.breakdown.laborCost + scv.breakdown.machineCost + scv.breakdown.overheadCost).toBe(15);
    expect(scv.breakdown.totalCost).toBe(64);
    expect(scv.breakdown.unitCost).toBe(64);
    // The released work order snapshots the cost for its 10-unit output (640).
    const wo = mfg().workOrders.find((w) => w.id === releasedWorkOrder())!;
    expect(wo.standardCostSnapshot.totalCost).toBe(640);
  });

  it('creating a new version supersedes the previous active one', () => {
    mfg().createStandardCostVersion('mfg_cabinet', 'mfg_bom_cabinet', 'mfg_rtg_cabinet', 1);
    const active = mfg().standardCostVersions.filter((v) => v.itemId === 'mfg_cabinet' && v.status === 'active');
    expect(active).toHaveLength(1);
    expect(mfg().standardCostVersions.filter((v) => v.itemId === 'mfg_cabinet' && v.status === 'superseded').length).toBeGreaterThanOrEqual(1);
  });
});

/* ── Work order release + requirements ────────────────────────────────────── */

describe('work order release', () => {
  it('snapshots BOM requirements and a standard cost of 64/unit', () => {
    const wo = mfg().workOrders.find((w) => w.id === releasedWorkOrder())!;
    const steel = wo.materialRequirements.find((r) => r.itemId === 'mfg_steel')!;
    expect(steel.requiredQuantity).toBe(20); // 2/unit × 10
    expect(wo.materialRequirements.find((r) => r.itemId === 'mfg_bolt')!.requiredQuantity).toBe(40);
    expect(wo.standardCostSnapshot.unitCost).toBe(64);
    expect(wo.operationSnapshots).toHaveLength(3);
  });
});

/* ── Posting pipeline + WIP + reconciliation ──────────────────────────────── */

describe('posting pipeline (seeded work order)', () => {
  it('material issue Dr WIP 490, conversion 150, receipt Dr FG, scrap Cr WIP', () => {
    // Material issue posted Dr WIP 490 / Cr RM.
    const wipDr = useJournalStore.getState().entries.filter((e) => e.transactionType === 'Manufacturing').flatMap((e) => e.lines).filter((l) => l.accountCode === '1212' && l.debit > 0);
    expect(wipDr.reduce((s, l) => s + l.debit, 0)).toBeCloseTo(490 + 150, 2); // issue + conversion debit WIP
    // Finished goods received (5 units × 64 = 320).
    expect(getInventoryValue(useInventoryStore.getState().movements, { entityId: ENTITY, itemId: 'mfg_cabinet' })).toBeCloseTo(320, 2);
  });

  it('derives WIP = issued − returned + conversion − received − scrap', () => {
    const id = releasedWorkOrder();
    const wip = calculateWorkOrderWip(id, mfg().getActivity(id));
    // 490 + 150 − 320 (5×64) − 40 (2 steel × 20 abnormal) = 280
    expect(wip.materialsIssued).toBe(490);
    expect(wip.laborAbsorbed + wip.machineAbsorbed + wip.overheadAbsorbed).toBe(150);
    expect(wip.finishedGoodsReceived).toBe(320);
    expect(wip.remainingWip).toBe(280);
  });

  it('reconciles the manufacturing WIP subledger to the GL WIP account', () => {
    const s = mfg();
    const activity = { issues: s.materialIssues, returns: s.materialReturns, receipts: s.productionReceipts, operationCosts: s.operationCosts, scraps: s.scraps };
    const recon = buildManufacturingReconciliation({ workOrders: s.workOrders, activity, journalEntries: useJournalStore.getState().entries, wipAccountId: wipAccountId() });
    expect(recon.wipSubledger).toBeCloseTo(280, 2);
    expect(recon.wipGl).toBeCloseTo(280, 2);
    expect(recon.balanced).toBe(true);
  });

  it('computes actual cost and variance for completed output', () => {
    const id = releasedWorkOrder();
    const actual = calculateActualWorkOrderCost(id, mfg().getActivity(id));
    expect(actual.materialCost).toBe(490);
    expect(actual.completedQuantity).toBe(5);
    const wo = mfg().workOrders.find((w) => w.id === id)!;
    const variance = calculateVariance(wo.standardCostSnapshot.unitCost, wo.standardCostSnapshot, actual);
    expect(variance.standardCostForOutput).toBe(320); // 5 × 64
    expect(variance.totalVariance).toBe(Math.round((actual.totalCost - 320) * 100) / 100);
  });
});

/* ── Rules ────────────────────────────────────────────────────────────────── */

describe('posting rules', () => {
  function newReleasedWo(qty = 2): string {
    const cc = useCostCenterStore.getState().costCenters[0]?.id ?? '';
    const c = mfg().createWorkOrder({ productItemId: 'mfg_cabinet', bomId: 'mfg_bom_cabinet', routingId: 'mfg_rtg_cabinet', plannedQuantity: qty, plantId: 'mfg_plant_01', costCenterId: cc, plannedStartDate: '2026-03-01', plannedEndDate: '2026-03-05' });
    mfg().transitionWorkOrder(c.id!, 'planned');
    mfg().releaseWorkOrder(c.id!);
    return c.id!;
  }

  it('blocks insufficient stock', () => {
    const id = newReleasedWo(2);
    const res = mfg().postMaterialIssue({ workOrderId: id, date: '2026-03-01', lines: [{ itemId: 'mfg_steel', quantity: 999999, warehouseId: 'mfg_rm_wh' }] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/insufficient/i);
  });

  it('blocks over-issue beyond the requirement', () => {
    const id = newReleasedWo(2);
    const req = mfg().workOrders.find((w) => w.id === id)!.materialRequirements.find((r) => r.itemId === 'mfg_steel')!; // required 4
    const res = mfg().postMaterialIssue({ workOrderId: id, date: '2026-03-01', lines: [{ itemId: 'mfg_steel', requirementId: req.id, quantity: req.requiredQuantity + 10, warehouseId: 'mfg_rm_wh' }] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/over-issue/i);
  });

  it('blocks overproduction beyond the planned quantity', () => {
    const id = newReleasedWo(2);
    const res = mfg().postProductionReceipt({ workOrderId: id, date: '2026-03-04', completedQuantity: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/overproduction/i);
  });

  it('reverses a production receipt at original cost and restores completed quantity', () => {
    const id = releasedWorkOrder();
    const receipt = mfg().productionReceipts.find((d) => d.workOrderId === id && d.status === 'posted')!;
    const completedBefore = mfg().workOrders.find((w) => w.id === id)!.completedQuantity;
    const res = mfg().reverseProductionReceipt(receipt.id);
    expect(res.ok).toBe(true);
    expect(mfg().productionReceipts.find((d) => d.id === receipt.id)!.status).toBe('reversed');
    expect(mfg().workOrders.find((w) => w.id === id)!.completedQuantity).toBe(completedBefore - receipt.completedQuantity);
  });
});
