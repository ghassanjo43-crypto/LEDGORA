import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useBillStore } from './billStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useInventoryStore } from './inventoryStore';
import { useJournalStore } from './journalStore';
import { useEntitlementStore } from './entitlementStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { getInventoryValue, getQuantityOnHand } from '@/lib/inventoryBalance';
import { buildInventoryReconciliation } from '@/lib/inventoryReconciliation';
import { makeInventorySeed, ENTITY } from '@/lib/inventorySeed';
import type { BillLine } from '@/types/bill';

const inv = () => useInventoryStore.getState();
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const firstSupplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
const journalCount = () => useJournalStore.getState().entries.length;

function seedInventory(): void {
  const s = makeInventorySeed('core');
  useInventoryStore.setState({ ...s, movements: [], documents: [], auditTrail: [], seeded: true });
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault(); // enterprise dev, has inventory_basic, active
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  useInventoryStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  seedInventory();
});

/* ── Invoice issue-on-invoice ─────────────────────────────────────────────── */

describe('invoice issue-on-invoice', () => {
  function inventoryInvoice(quantity: number): string {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const draft = useInvoiceStore.getState().getInvoice(id!)!;
    const line = {
      ...draft.lines[0]!, accountId: acc('4110'), description: 'Trading goods', quantity, unitPrice: 20, taxRate: 0,
      inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryFulfillmentMode: 'issue-on-invoice' as const,
    };
    useInvoiceStore.getState().updateDraft(id!, { lines: [line] });
    return id!;
  }

  it('posts a separate COGS journal + outbound movement and preserves the issued cost', () => {
    inv().postGoodsReceipt({ date: '2026-03-01', reference: 'GRN', lines: [{ id: 'l1', itemId: 'item_goods', warehouseId: 'wh_main', quantity: 100, unitId: 'uom_ea', unitCost: 10 }] });
    const before = journalCount();
    const id = inventoryInvoice(10);
    const res = useInvoiceStore.getState().issueInvoice(id);
    expect(res.ok).toBe(true);
    // Two journals: the revenue journal AND the COGS journal.
    expect(journalCount()).toBe(before + 2);
    const cogsEntry = useJournalStore.getState().entries.find((e) => e.lines.some((l) => l.accountId === acc('5500') && l.debit === 100));
    expect(cogsEntry).toBeTruthy(); // Dr COGS 100 (10 units × 10)
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(90);
    // Issued cost preserved on the invoice line.
    const issued = useInvoiceStore.getState().getInvoice(id)!;
    expect(issued.lines[0]!.issuedUnitCost).toBe(10);
  });

  it('blocks the whole issue when stock is insufficient (no revenue journal posted)', () => {
    inv().postGoodsReceipt({ date: '2026-03-01', reference: 'GRN', lines: [{ id: 'l1', itemId: 'item_goods', warehouseId: 'wh_main', quantity: 5, unitId: 'uom_ea', unitCost: 10 }] });
    const before = journalCount();
    const id = inventoryInvoice(50);
    const res = useInvoiceStore.getState().issueInvoice(id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/insufficient/i);
    expect(journalCount()).toBe(before); // nothing posted
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('draft');
  });
});

/* ── Bill receive-on-bill ─────────────────────────────────────────────────── */

describe('bill receive-on-bill', () => {
  it('records an inbound movement linked to the bill journal (no second journal)', () => {
    const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-07-10', dueDate: '2026-08-10', currency: 'USD' });
    const bill = useBillStore.getState().getBill(id!)!;
    const line: BillLine = {
      ...bill.lines[0]!, accountId: acc('1213'), description: 'Trading goods', quantity: 100, unitPrice: 10, taxRate: 0,
      inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryReceiptMode: 'receive-on-bill',
    };
    useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: 'INV-1', lines: [line] });
    const before = journalCount();
    const res = useBillStore.getState().postBill(id!);
    expect(res.ok).toBe(true);
    // Exactly ONE journal (the bill's own — it already debits inventory).
    expect(journalCount()).toBe(before + 1);
    const billJe = useBillStore.getState().getBill(id!)!.journalEntryId;
    const mv = inv().movements.find((m) => m.itemId === 'item_goods' && m.direction === 'in');
    expect(mv).toBeTruthy();
    expect(mv!.journalEntryId).toBe(billJe); // linked to the bill journal
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(1000);
  });
});

/* ── Supplier credit physical return ──────────────────────────────────────── */

describe('supplier credit physical return', () => {
  it('records an outbound movement linked to the supplier-credit journal', () => {
    // Receive 100 via a bill first.
    const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-07-10', dueDate: '2026-08-10', currency: 'USD' });
    const bill = useBillStore.getState().getBill(id!)!;
    useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: 'INV-2', lines: [{ ...bill.lines[0]!, accountId: acc('1213'), quantity: 100, unitPrice: 10, taxRate: 0, inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryReceiptMode: 'receive-on-bill' }] });
    useBillStore.getState().postBill(id!);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(100);

    const res = useBillStore.getState().createSupplierCredit(id!, {
      netAmount: 200, taxAmount: 0, creditAccountId: acc('1213'), reason: 'return',
      returnInventory: true, returnItemId: 'item_goods', returnWarehouseId: 'wh_main', returnQuantity: 20, returnUnitCost: 10,
    });
    expect(res.ok).toBe(true);
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(80);
    const out = inv().movements.find((m) => m.direction === 'out' && m.sourceDocumentType === 'supplier-credit');
    expect(out).toBeTruthy();
    expect(out!.journalEntryId).toBeTruthy();
  });
});

/* ── Non-inventory documents unaffected ───────────────────────────────────── */

describe('documents without inventory lines', () => {
  it('a service invoice creates no stock movement', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const draft = useInvoiceStore.getState().getInvoice(id!)!;
    useInvoiceStore.getState().updateDraft(id!, { lines: [{ ...draft.lines[0]!, accountId: acc('4120'), description: 'Consulting', quantity: 1, unitPrice: 500, taxRate: 0 }] });
    const movesBefore = inv().movements.length;
    expect(useInvoiceStore.getState().issueInvoice(id!).ok).toBe(true);
    expect(inv().movements.length).toBe(movesBefore);
  });
});

/* ── Subledger reconciles after wired postings ────────────────────────────── */

describe('subledger reconciles to GL after document postings', () => {
  it('bill receipt + invoice issue keep the inventory subledger equal to GL', () => {
    // Receive 100 @ 10 via a bill (Dr Inventory 1000).
    const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-07-10', dueDate: '2026-08-10', currency: 'USD' });
    const bill = useBillStore.getState().getBill(id!)!;
    useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: 'INV-3', lines: [{ ...bill.lines[0]!, accountId: acc('1213'), quantity: 100, unitPrice: 10, taxRate: 0, inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryReceiptMode: 'receive-on-bill' }] });
    useBillStore.getState().postBill(id!);
    // Sell 40 (Cr Inventory 400 via COGS).
    const sale = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const sd = useInvoiceStore.getState().getInvoice(sale.id!)!;
    useInvoiceStore.getState().updateDraft(sale.id!, { lines: [{ ...sd.lines[0]!, accountId: acc('4110'), quantity: 40, unitPrice: 20, taxRate: 0, inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryFulfillmentMode: 'issue-on-invoice' }] });
    useInvoiceStore.getState().issueInvoice(sale.id!);

    const recon = buildInventoryReconciliation({ entityId: ENTITY, movements: inv().movements, journalEntries: useJournalStore.getState().entries });
    expect(recon.subledgerValue).toBeCloseTo(600, 2);
    expect(recon.glBalance).toBeCloseTo(600, 2);
    expect(recon.balanced).toBe(true);
  });
});
