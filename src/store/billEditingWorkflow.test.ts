import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billRevision, useBillStore } from './billStore';
import { useJournalStore } from './journalStore';
import { useInventoryStore } from './inventoryStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';
import { useAuthStore } from './authStore';

function createDraft(): string {
  const result = useBillStore.getState().createDraft({ billDate: '2026-08-01', dueDate: '2026-08-31' });
  expect(result.ok).toBe(true);
  return result.id!;
}

beforeEach(() => {
  useAuthStore.setState({ users: [], currentUserId: null });
  useInvoiceTemplateStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  useJournalStore.getState().resetToDefault();
  useInventoryStore.setState({ movements: [], documents: [], auditTrail: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bill draft editing boundary', () => {
  it('updates the same bill ID and number without creating accounting or inventory activity', () => {
    const id = createDraft();
    const before = useBillStore.getState().getBill(id)!;
    const journals = useJournalStore.getState().entries.length;
    const movements = useInventoryStore.getState().movements.length;

    const receiptLine = { ...before.lines[0]!, inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryReceiptMode: 'receive-on-bill' as const };
    const result = useBillStore.getState().updateDraft(id, { supplierInvoiceNumber: 'SUP-42', notes: 'updated', lines: [receiptLine] }, { expectedRevision: billRevision(before) });

    const after = useBillStore.getState().getBill(id)!;
    expect(result.ok).toBe(true);
    expect(after.id).toBe(id);
    expect(after.billNumber).toBe(before.billNumber);
    expect(after.auditTrail.at(-1)?.action).toBe('bill-draft-updated');
    expect(after.lines[0]).toMatchObject({ inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryReceiptMode: 'receive-on-bill' });
    expect(useBillStore.getState().bills).toHaveLength(1);
    expect(useJournalStore.getState().entries).toHaveLength(journals);
    expect(useInventoryStore.getState().movements).toHaveLength(movements);
  });

  it('preserves protected identity, workflow, snapshot, and settlement fields from a malicious patch', () => {
    const id = createDraft();
    const before = useBillStore.getState().getBill(id)!;
    const snapshot = { templateName: 'Historical' } as never;
    useBillStore.setState({ bills: [{ ...before, templateSnapshot: snapshot }] });

    expect(useBillStore.getState().updateDraft(id, { id: 'replacement', billNumber: 'OTHER', status: 'posted', journalEntryId: 'je_fake', amountPaid: 99, payments: [{}] } as never).ok).toBe(true);
    const after = useBillStore.getState().getBill(id)!;
    expect(after).toMatchObject({ id, billNumber: before.billNumber, status: 'draft', amountPaid: 0 });
    expect(after.journalEntryId).toBeUndefined();
    expect(after.payments).toEqual([]);
    expect(after.templateSnapshot).toBe(snapshot);
  });

  it('rejects stale and cross-entity updates even within the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const id = createDraft();
    const version = billRevision(useBillStore.getState().getBill(id)!);
    expect(useBillStore.getState().updateDraft(id, { notes: 'new' }, { expectedRevision: version }).ok).toBe(true);
    expect(useBillStore.getState().getBill(id)!.revision).toBe(version + 1);
    expect(useBillStore.getState().updateDraft(id, { notes: 'stale' }, { expectedRevision: version }).error).toMatch(/another session/i);

    const current = useBillStore.getState().getBill(id)!;
    useBillStore.setState({ bills: [{ ...current, entityId: `${INVOICE_ENTITY_ID}-other` }] });
    expect(useBillStore.getState().updateDraft(id, { notes: 'cross tenant' }).error).toMatch(/current entity/i);
  });

  it('loads legacy bills without a revision at zero and preserves revisions across reloads', () => {
    const id = createDraft();
    const legacy = { ...useBillStore.getState().getBill(id)! };
    delete legacy.revision;
    useBillStore.getState().replaceAll([legacy]);
    expect(useBillStore.getState().getBill(id)!.revision).toBe(0);

    expect(useBillStore.getState().updateDraft(id, { notes: 'persisted' }, { expectedRevision: 0 }).ok).toBe(true);
    const persistedCopy = structuredClone(useBillStore.getState().bills);
    useBillStore.getState().resetToDefault();
    useBillStore.getState().replaceAll(persistedCopy);
    expect(useBillStore.getState().getBill(id)!.revision).toBe(1);
  });

  it('does not permit a viewer to edit', () => {
    const id = createDraft();
    useAuthStore.setState({ users: [{ id: 'viewer', role: 'viewer' } as never], currentUserId: 'viewer' });
    expect(useBillStore.getState().updateDraft(id, { notes: 'forbidden' }).error).toMatch(/does not include/i);
  });
});

describe('bill workflow editability', () => {
  it('requires submitted bills to be recalled and audits the transition', () => {
    const id = createDraft();
    expect(useBillStore.getState().submitBill(id).ok).toBe(true);
    expect(useBillStore.getState().updateDraft(id, { notes: 'blocked' }).error).toMatch(/return.*draft/i);
    expect(useBillStore.getState().returnToDraft(id, 'supplier correction').ok).toBe(true);
    const bill = useBillStore.getState().getBill(id)!;
    expect(bill.status).toBe('draft');
    expect(bill.auditTrail.at(-1)).toMatchObject({ action: 'bill-submission-recalled', detail: 'supplier correction' });
    expect(useBillStore.getState().updateDraft(id, { notes: 'allowed' }).ok).toBe(true);
  });

  it('requires approved unposted bills to be reopened and audits the reason', () => {
    const id = createDraft();
    expect(useBillStore.getState().approveBill(id).ok).toBe(true);
    expect(useBillStore.getState().updateDraft(id, { notes: 'blocked' }).ok).toBe(false);
    expect(useBillStore.getState().returnToDraft(id, 'coding correction').ok).toBe(true);
    expect(useBillStore.getState().getBill(id)!.auditTrail.at(-1)).toMatchObject({ action: 'bill-reopened', detail: 'coding correction' });
  });

  it('keeps posted journals and inventory movements unchanged and rejects direct edits', () => {
    const id = createDraft();
    const draft = useBillStore.getState().getBill(id)!;
    useBillStore.getState().updateDraft(id, { supplierInvoiceNumber: 'POST-1', lines: [{ ...draft.lines[0]!, accountId: 'acc_expense', description: 'Manual', quantity: 1, unitPrice: 1 }] });
    // Posting validation may depend on seeded accounts, so install an immutable posted record directly.
    useBillStore.setState({ bills: [{ ...useBillStore.getState().getBill(id)!, status: 'posted', journalEntryId: 'je_historical' }] });
    const journals = structuredClone(useJournalStore.getState().entries);
    const movements = structuredClone(useInventoryStore.getState().movements);
    const result = useBillStore.getState().updateDraft(id, { notes: 'rewrite' });
    expect(result.error).toMatch(/affected the ledger/i);
    expect(useBillStore.getState().getBill(id)!.journalEntryId).toBe('je_historical');
    expect(useJournalStore.getState().entries).toEqual(journals);
    expect(useInventoryStore.getState().movements).toEqual(movements);
  });

  it('protects payment allocations and refuses to reopen settled activity', () => {
    const id = createDraft();
    const bill = useBillStore.getState().getBill(id)!;
    useBillStore.setState({ bills: [{ ...bill, status: 'submitted', amountPaid: 10, payments: [{ id: 'p1' }] as never }] });
    expect(useBillStore.getState().returnToDraft(id).error).toMatch(/payment activity/i);
    expect(useBillStore.getState().getBill(id)!.payments).toHaveLength(1);
  });
});
