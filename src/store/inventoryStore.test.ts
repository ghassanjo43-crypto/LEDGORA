import { describe, it, expect, beforeEach } from 'vitest';
import { useInventoryStore } from './inventoryStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntitlementStore } from './entitlementStore';
import { useSessionStore } from './sessionStore';
import { getInventoryValue, getQuantityOnHand } from '@/lib/inventoryBalance';
import { buildInventoryReconciliation } from '@/lib/inventoryReconciliation';
import { makeInventorySeed, ENTITY } from '@/lib/inventorySeed';

const inv = () => useInventoryStore.getState();
const ITEM = 'item_goods';
const MAIN = 'wh_main';

function accountId(code: string): string {
  return useStore.getState().accounts.find((a) => a.code === code)!.id;
}

/** Seed inventory master data deterministically (trading edition set). */
function seed(): void {
  const s = makeInventorySeed('core');
  useInventoryStore.setState({ ...s, movements: [], documents: [], auditTrail: [], seeded: true });
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault(); // enterprise dev, active → posting allowed
  useSessionStore.setState({ role: 'admin', userName: 'Inv Tester' });
  useInventoryStore.getState().resetToDefault();
  seed();
});

const H = (date = '2026-03-01', reference = 'REF') => ({ date, reference });

/* ── Documents + weighted average ─────────────────────────────────────────── */

describe('goods receipt + issue + weighted average', () => {
  it('posts a receipt with a balanced Dr Inventory / Cr GRNI journal', () => {
    const beforeJe = useJournalStore.getState().entries.length;
    const res = inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    expect(res.ok).toBe(true);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(100);
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(1000);
    const je = useJournalStore.getState().entries.find((e) => e.id === res.journalEntryId)!;
    expect(useJournalStore.getState().entries.length).toBe(beforeJe + 1);
    expect(je.status).toBe('posted');
    expect(je.totalDebit).toBe(je.totalCredit);
    const invLine = je.lines.find((l) => l.accountId === accountId('1213'))!;
    expect(invLine.debit).toBe(1000);
  });

  it('averages a second receipt and issues at the average (COGS via invoice)', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l2', itemId: ITEM, warehouseId: MAIN, quantity: 50, unitId: 'uom_ea', unitCost: 14 }] });
    const before = useJournalStore.getState().entries.length;
    const res = inv().postInvoiceIssue({ ...H(), lines: [{ id: 'i1', itemId: ITEM, warehouseId: MAIN, quantity: 60, unitId: 'uom_ea' }] });
    expect(res.ok).toBe(true);
    // COGS posts exactly once.
    expect(useJournalStore.getState().entries.length).toBe(before + 1);
    const je = useJournalStore.getState().entries.find((e) => e.id === res.journalEntryId)!;
    const cogs = je.lines.find((l) => l.accountId === accountId('5500'))!;
    expect(cogs.debit).toBeCloseTo(680, 2);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(90);
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBeCloseTo(1020, 2);
  });

  it('blocks an issue that exceeds available stock (block policy)', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 10, unitId: 'uom_ea', unitCost: 10 }] });
    const res = inv().postInvoiceIssue({ ...H(), lines: [{ id: 'i1', itemId: ITEM, warehouseId: MAIN, quantity: 50, unitId: 'uom_ea' }] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/insufficient/i);
  });
});

/* ── Service items create no movement ─────────────────────────────────────── */

describe('service items', () => {
  it('an invoice with only service lines creates no stock movement or COGS', () => {
    inv().saveItem({ ...inv().items[0]!, id: 'svc', code: 'SVC-1', name: 'Consulting', itemType: 'service', isInventoryTracked: false });
    const before = useJournalStore.getState().entries.length;
    const res = inv().postInvoiceIssue({ ...H(), lines: [{ id: 'i1', itemId: 'svc', warehouseId: MAIN, quantity: 5, unitId: 'uom_ea' }] });
    expect(res.ok).toBe(true);
    expect(res.movementIds).toEqual([]);
    expect(useJournalStore.getState().entries.length).toBe(before);
  });
});

/* ── Transfer: cost-neutral ───────────────────────────────────────────────── */

describe('warehouse transfer', () => {
  it('moves quantity between warehouses with equal value and no journal', () => {
    inv().saveWarehouse({ id: 'wh_site', entityId: ENTITY, code: 'SITE', name: 'Site', type: 'site', status: 'active', createdAt: '', updatedAt: '' });
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    const jeBefore = useJournalStore.getState().entries.length;
    const res = inv().postTransfer({ ...H(), sourceWarehouseId: MAIN, destinationWarehouseId: 'wh_site', lines: [{ id: 't1', itemId: ITEM, quantity: 20, unitId: 'uom_ea' }] });
    expect(res.ok).toBe(true);
    expect(res.journalEntryId).toBeUndefined(); // no GL entry (same inventory account)
    expect(useJournalStore.getState().entries.length).toBe(jeBefore);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM, warehouseId: MAIN })).toBe(80);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM, warehouseId: 'wh_site' })).toBe(20);
    // Total company quantity and value unchanged.
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(100);
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(1000);
  });
});

/* ── Adjustments + stock count ────────────────────────────────────────────── */

describe('adjustments and counts', () => {
  it('posts increase (Dr Inventory / Cr Gain) and decrease (Dr Loss / Cr Inventory)', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    const inc = inv().postAdjustment({ ...H(), reason: 'found', lines: [{ id: 'a1', itemId: ITEM, warehouseId: MAIN, quantity: 5, unitId: 'uom_ea', unitCost: 12 }] });
    const incJe = useJournalStore.getState().entries.find((e) => e.id === inc.journalEntryId)!;
    expect(incJe.lines.find((l) => l.accountId === accountId('1213'))!.debit).toBe(60);
    expect(incJe.lines.find((l) => l.accountId === accountId('4300'))!.credit).toBe(60);
    const dec = inv().postAdjustment({ ...H(), reason: 'damage', lines: [{ id: 'a2', itemId: ITEM, warehouseId: MAIN, quantity: -3, unitId: 'uom_ea' }] });
    const decJe = useJournalStore.getState().entries.find((e) => e.id === dec.journalEntryId)!;
    expect(decJe.lines.find((l) => l.accountId === accountId('5600'))!.debit).toBeGreaterThan(0);
  });

  it('posts a negative count variance (Dr Loss / Cr Inventory) using the frozen cost', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 90, unitId: 'uom_ea', unitCost: 11.333333 }] });
    const res = inv().postStockCount({ ...H(), warehouseId: MAIN, lines: [{ id: 'c1', itemId: ITEM, warehouseId: MAIN, systemQuantity: 90, countedQuantity: 87, frozenUnitCost: 11.333333 }] });
    expect(res.ok).toBe(true);
    const je = useJournalStore.getState().entries.find((e) => e.id === res.journalEntryId)!;
    expect(je.lines.find((l) => l.accountId === accountId('5600'))!.debit).toBeCloseTo(34, 1);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(87);
  });
});

/* ── Bill receipt + recoverable tax ───────────────────────────────────────── */

describe('bill direct receipt', () => {
  it('posts Dr Inventory + Dr Recoverable Tax / Cr Payables, tax excluded from value', () => {
    const res = inv().postBillReceipt({ ...H(), lines: [{ id: 'b1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10, taxAmount: 150 }] });
    expect(res.ok).toBe(true);
    const je = useJournalStore.getState().entries.find((e) => e.id === res.journalEntryId)!;
    expect(je.lines.find((l) => l.accountId === accountId('1213'))!.debit).toBe(1000); // value excludes tax
    expect(je.lines.find((l) => l.accountId === accountId('2210'))!.credit).toBe(1150);
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(1000);
  });
});

/* ── Returns ──────────────────────────────────────────────────────────────── */

describe('returns', () => {
  it('customer physical return uses the original issue cost and reverses COGS; over-return blocked', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    inv().postInvoiceIssue({ ...H(), lines: [{ id: 'i1', itemId: ITEM, warehouseId: MAIN, quantity: 60, unitId: 'uom_ea' }] });
    const ret = inv().postCustomerReturn({ ...H(), lines: [{ id: 'r1', itemId: ITEM, warehouseId: MAIN, quantity: 10, unitId: 'uom_ea', originalUnitCost: 10, originalQuantity: 60 }] });
    expect(ret.ok).toBe(true);
    const je = useJournalStore.getState().entries.find((e) => e.id === ret.journalEntryId)!;
    expect(je.lines.find((l) => l.accountId === accountId('1213'))!.debit).toBe(100);
    expect(je.lines.find((l) => l.accountId === accountId('5500'))!.credit).toBe(100);
    // Over-return beyond delivered quantity is blocked.
    const over = inv().postCustomerReturn({ ...H(), lines: [{ id: 'r2', itemId: ITEM, warehouseId: MAIN, quantity: 70, unitId: 'uom_ea', originalUnitCost: 10, originalQuantity: 60 }] });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/returnable/i);
  });

  it('supplier physical return uses original receipt cost; over-return blocked', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    const ret = inv().postSupplierReturn({ ...H(), lines: [{ id: 's1', itemId: ITEM, warehouseId: MAIN, quantity: 20, unitId: 'uom_ea', originalUnitCost: 10, originalQuantity: 100 }] });
    expect(ret.ok).toBe(true);
    const je = useJournalStore.getState().entries.find((e) => e.id === ret.journalEntryId)!;
    expect(je.lines.find((l) => l.accountId === accountId('2210'))!.debit).toBe(200);
    expect(je.lines.find((l) => l.accountId === accountId('1213'))!.credit).toBe(200);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(80);
    const over = inv().postSupplierReturn({ ...H(), lines: [{ id: 's2', itemId: ITEM, warehouseId: MAIN, quantity: 200, unitId: 'uom_ea', originalUnitCost: 10, originalQuantity: 100 }] });
    expect(over.ok).toBe(false);
  });
});

/* ── Reversal ─────────────────────────────────────────────────────────────── */

describe('reversal', () => {
  it('reverses a receipt at original cost and restores stock + GL', () => {
    const rec = inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    const rev = inv().reverseDocument(rec.id!);
    expect(rev.ok).toBe(true);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(0);
    expect(inv().documents.find((d) => d.id === rec.id)!.status).toBe('reversed');
    // Original + counter-movement are both excluded from the live balance.
    expect(inv().movements.filter((m) => m.status === 'reversed').length).toBe(2);
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: ITEM })).toBe(0);
  });

  it('blocks reversal of a receipt whose stock has been consumed', () => {
    const rec = inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    inv().postInvoiceIssue({ ...H(), lines: [{ id: 'i1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea' }] });
    const rev = inv().reverseDocument(rec.id!);
    expect(rev.ok).toBe(false);
    expect(rev.error).toMatch(/consumed|remain/i);
  });
});

/* ── Master-data rules ────────────────────────────────────────────────────── */

describe('master data rules', () => {
  it('blocks a valuation-method change once movements exist, and deletes only empty warehouses', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 5, unitId: 'uom_ea', unitCost: 10 }] });
    const change = inv().saveItem({ ...inv().items.find((i) => i.id === ITEM)!, valuationMethod: 'standard' });
    expect(change.ok).toBe(false);
    const del = inv().deleteWarehouse(MAIN);
    expect(del.ok).toBe(false);
    expect(del.error).toMatch(/cannot be deleted/i);
  });

  it('enforces unique item and warehouse codes', () => {
    expect(inv().saveItem({ ...inv().items[0]!, id: 'dup', code: 'GOODS-001' }).ok).toBe(false);
    expect(inv().saveWarehouse({ id: 'dupw', entityId: ENTITY, code: 'MAIN', name: 'x', type: 'main', status: 'active', createdAt: '', updatedAt: '' }).ok).toBe(false);
  });
});

/* ── Reconciliation subledger ↔ GL ────────────────────────────────────────── */

describe('inventory-to-GL reconciliation', () => {
  it('subledger equals GL after inventory postings, and exposes a manual-entry difference', () => {
    inv().postGoodsReceipt({ ...H(), lines: [{ id: 'l1', itemId: ITEM, warehouseId: MAIN, quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    inv().postInvoiceIssue({ ...H(), lines: [{ id: 'i1', itemId: ITEM, warehouseId: MAIN, quantity: 40, unitId: 'uom_ea' }] });
    const recon = buildInventoryReconciliation({ entityId: ENTITY, movements: inv().movements, journalEntries: useJournalStore.getState().entries });
    expect(recon.subledgerValue).toBeCloseTo(600, 2);
    expect(recon.glBalance).toBeCloseTo(600, 2);
    expect(recon.balanced).toBe(true);

    // A rogue manual journal against the inventory account creates a difference.
    useJournalStore.getState().insertPostedEntry({
      entryDate: '2026-03-05', reference: 'ROGUE', description: 'manual', currency: 'USD', exchangeRate: 1,
      lines: [{ accountId: accountId('1213'), debit: 50, credit: 0 }, { accountId: accountId('1252'), debit: 0, credit: 50 }],
    });
    const recon2 = buildInventoryReconciliation({ entityId: ENTITY, movements: inv().movements, journalEntries: useJournalStore.getState().entries });
    expect(recon2.balanced).toBe(false);
    expect(recon2.difference).toBeCloseTo(-50, 2);
  });
});
