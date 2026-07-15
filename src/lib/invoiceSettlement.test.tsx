import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useCreditNoteEditor } from '@/store/creditNoteEditorStore';
import { buildInvoiceSettlementSummary, deriveSettlementStatus, creditNoteAppliedToInvoice, creditNotesForInvoice } from '@/lib/invoiceSettlement';
import { InvoiceRenderer } from '@/components/invoices/InvoiceRenderer';

const cnStore = () => useCreditNoteStore.getState();
const iStore = () => useInvoiceStore.getState();
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const revenueId = () => useStore.getState().accounts.find((a) => a.code === '4120')!.id;

function issuedInvoice(qty: number, unitPrice: number, taxRate: number): string {
  const { id } = iStore().createDraft({ customerId: firstCustomerId() });
  const inv = iStore().getInvoice(id!)!;
  iStore().updateDraft(id!, { lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Service', quantity: qty, unitPrice, taxRate }] });
  iStore().issueInvoice(id!);
  return id!;
}
/** Create a credit note against an invoice for a given amount, optionally issue it. */
function creditNote(invoiceId: string, amount: number, issue = true): string {
  const { id } = cnStore().createCreditNoteFromInvoice(invoiceId);
  const cn = cnStore().getCreditNoteById(id!)!;
  cnStore().updateCreditNote(id!, { lines: [{ ...cn.lines[0]!, revenueAccountId: revenueId(), quantity: 1, unitPrice: amount, taxRate: 0 }] });
  if (issue) cnStore().issueCreditNote(id!);
  return id!;
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

describe('invoice settlement summary (INV total 8,000, CN 3,000 → 5,000)', () => {
  it('applies the issued credit note, keeps the original total and derives the balance', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditNote(invId, 3000);
    // Excluded noise: a draft and a voided credit note against the same invoice.
    creditNote(invId, 1000, false); // draft
    const voided = creditNote(invId, 500, true);
    cnStore().voidCreditNote(voided, 'issued in error');

    const summary = buildInvoiceSettlementSummary(iStore().getInvoice(invId)!, cnStore().creditNotes, useReceiptStore.getState().receipts);
    expect(summary.originalTotal).toBe(8000);
    expect(summary.creditNotesApplied).toBe(3000); // only the issued, non-void note
    expect(summary.paymentsApplied).toBe(0);
    expect(summary.balanceDue).toBe(5000);
    expect(iStore().getInvoice(invId)!.grandTotal).toBe(8000); // historically immutable

    // The credit note is visibly linked, with its applied amount.
    const linked = creditNotesForInvoice(invId, cnStore().creditNotes);
    expect(linked.map((c) => c.id)).toContain(cnId);
    expect(linked.map((c) => c.id)).not.toContain(voided);
    expect(creditNoteAppliedToInvoice(cnStore().getCreditNoteById(cnId)!, invId)).toBe(3000);
    expect(deriveSettlementStatus(summary)).toBe('partially-credited');
  });

  it('later credit notes update the current settlement summary', () => {
    const invId = issuedInvoice(1, 8000, 0);
    creditNote(invId, 3000);
    let summary = buildInvoiceSettlementSummary(iStore().getInvoice(invId)!, cnStore().creditNotes, useReceiptStore.getState().receipts);
    expect(summary.balanceDue).toBe(5000);

    creditNote(invId, 1000); // a second issued credit note
    summary = buildInvoiceSettlementSummary(iStore().getInvoice(invId)!, cnStore().creditNotes, useReceiptStore.getState().receipts);
    expect(summary.creditNotesApplied).toBe(4000);
    expect(summary.balanceDue).toBe(4000);
    expect(iStore().getInvoice(invId)!.grandTotal).toBe(8000); // still immutable
  });

  it('combines receipts and credits (paid-after-credit when fully settled)', () => {
    const invId = issuedInvoice(1, 8000, 0);
    creditNote(invId, 3000); // balance 5,000
    // Receipt settling the remaining 5,000.
    const r = useReceiptStore.getState().createDraft({ customerId: firstCustomerId(), amount: 5000 });
    const inv = iStore().getInvoice(invId)!;
    const now = new Date().toISOString();
    useReceiptStore.getState().updateDraft(r.id!, { transactionReference: 'TRX', allocations: [{ id: 'a1', entityId: inv.entityId, receiptId: r.id!, customerId: inv.customerId, invoiceId: invId, invoiceNumber: inv.invoiceNumber, allocationType: 'invoice', amount: 5000, baseCurrencyAmount: 5000, allocationDate: now.slice(0, 10), createdAt: now, updatedAt: now }] });
    useReceiptStore.getState().postReceipt(r.id!);

    const summary = buildInvoiceSettlementSummary(iStore().getInvoice(invId)!, cnStore().creditNotes, useReceiptStore.getState().receipts);
    expect(summary.creditNotesApplied).toBe(3000);
    expect(summary.paymentsApplied).toBe(5000);
    expect(summary.balanceDue).toBe(0);
    expect(deriveSettlementStatus(summary)).toBe('paid-after-credit');
  });

  it('fully-credited when a credit alone clears the balance', () => {
    const invId = issuedInvoice(1, 8000, 0);
    creditNote(invId, 8000);
    const summary = buildInvoiceSettlementSummary(iStore().getInvoice(invId)!, cnStore().creditNotes, useReceiptStore.getState().receipts);
    expect(summary.balanceDue).toBe(0);
    expect(deriveSettlementStatus(summary)).toBe('fully-credited');
  });
});

describe('the View action opens the linked credit note', () => {
  it('requestOpen queues the credit note for the editor and consume returns it', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditNote(invId, 3000);
    useCreditNoteEditor.getState().requestOpen(cnId);
    expect(useCreditNoteEditor.getState().requestedEditorId).toBe(cnId);
    expect(useCreditNoteEditor.getState().consume()).toBe(cnId); // the Credit Notes page opens it on arrival
    expect(useCreditNoteEditor.getState().requestedEditorId).toBeNull();
  });
});

describe('printed invoice: original vs current copy', () => {
  it('the original document omits the account-position panel; the current copy shows it', () => {
    const invId = issuedInvoice(1, 8000, 0);
    creditNote(invId, 3000);
    const invoice = iStore().getInvoice(invId)!;
    const snap = iStore().previewSnapshot(invId)!;
    const summary = buildInvoiceSettlementSummary(invoice, cnStore().creditNotes, useReceiptStore.getState().receipts);

    const original = renderToStaticMarkup(createElement(InvoiceRenderer, { invoice, snapshot: snap }));
    expect(original).not.toContain('Updated account position');

    // The base totals block itself now shows the applied credit so the balance
    // reconciles even on the plain document (the earlier defect: a silent gap).
    expect(original).toMatch(/credit notes/i);
    expect(original).toContain('3,000.00'); // less credit notes
    expect(original).toContain('5,000.00'); // balance due reconciles

    const current = renderToStaticMarkup(createElement(InvoiceRenderer, { invoice, snapshot: snap, settlement: summary, settlementAsOf: '2026-07-12' }));
    expect(current).toContain('Updated account position');
    expect(current).toContain('as of');
    // Assert the injected as-of date as rendered ("12 July 2026") so the test is
    // independent of the current system date (the renderer formats ISO → long date).
    expect(current).toContain('12 July 2026');
    expect(current).toContain('8,000.00'); // original total preserved
    expect(current).toContain('3,000.00'); // less credit notes
    expect(current).toContain('5,000.00'); // current balance due
    expect(current).toContain('Current balance due');
  });
});
