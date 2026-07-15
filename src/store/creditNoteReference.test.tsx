import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { useCreditNoteStore } from './creditNoteStore';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { buildCreditNoteInvoiceReference } from '@/lib/creditNoteInvoiceReference';
import { CreditNoteRenderer } from '@/components/credit-notes/CreditNoteRenderer';

const cnStore = () => useCreditNoteStore.getState();
const iStore = () => useInvoiceStore.getState();
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const revenueId = () => useStore.getState().accounts.find((a) => a.code === '4120')!.id;
const bankId = () => useStore.getState().accounts.find((a) => a.code === '1252')!.id;

/** An issued invoice: qty × unitPrice @ taxRate%. */
function issuedInvoice(qty: number, unitPrice: number, taxRate: number): string {
  const { id } = iStore().createDraft({ customerId: firstCustomerId() });
  const inv = iStore().getInvoice(id!)!;
  iStore().updateDraft(id!, { lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Service', quantity: qty, unitPrice, taxRate }] });
  iStore().issueInvoice(id!);
  return id!;
}

/** Create a credit note against an invoice and set its single line's unit price (amount credit). */
function creditByAmount(invoiceId: string, creditAmount: number): string {
  const { id } = cnStore().createCreditNoteFromInvoice(invoiceId);
  const cn = cnStore().getCreditNoteById(id!)!;
  cnStore().updateCreditNote(id!, { lines: [{ ...cn.lines[0]!, quantity: 1, unitPrice: creditAmount, taxRate: 0 }] });
  return id!;
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

describe('credit-note invoice reconciliation (8,000 − 3,000 = 5,000)', () => {
  it('computes previous credits, balance before, and revised balance correctly', () => {
    const invId = issuedInvoice(1, 8000, 0); // total 8,000
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId);

    const ref = cnStore().invoiceReference(cnId)!;
    expect(ref.originalInvoiceTotal).toBe(8000);
    expect(ref.previousCreditsTotal).toBe(0);
    expect(ref.paymentsAppliedBeforeCredit).toBe(0);
    expect(ref.invoiceBalanceBeforeCredit).toBe(8000);
    expect(ref.currentCreditAmount).toBe(3000);
    expect(ref.invoiceBalanceAfterCredit).toBe(5000); // 8,000 − 3,000
  });

  it('does not subtract the current credit twice (uses original total, not the updated balance)', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId); // auto-applies → invoice.balanceDue becomes 5,000
    expect(iStore().getInvoice(invId)!.balanceDue).toBe(5000);

    // Recomputing live from the (already-updated) invoice must STILL be 5,000, not 2,000.
    const cn = cnStore().getCreditNoteById(cnId)!;
    const live = buildCreditNoteInvoiceReference(cn, iStore().getInvoice(invId)!, cnStore().creditNotes);
    expect(live.invoiceBalanceAfterCredit).toBe(5000);
  });

  it('previous credits accumulate across earlier issued notes', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cn1 = creditByAmount(invId, 2000);
    cnStore().issueCreditNote(cn1);
    const cn2 = creditByAmount(invId, 1000);
    cnStore().issueCreditNote(cn2);

    const ref2 = cnStore().invoiceReference(cn2)!;
    expect(ref2.previousCreditsTotal).toBe(2000); // cn1
    expect(ref2.invoiceBalanceBeforeCredit).toBe(6000); // 8,000 − 2,000
    expect(ref2.invoiceBalanceAfterCredit).toBe(5000); // 6,000 − 1,000
  });
});

describe('frozen reference snapshot immutability', () => {
  it('remains unchanged after the invoice later receives a payment', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId);
    const before = JSON.stringify(cnStore().getCreditNoteById(cnId)!.invoiceReferenceSnapshot);

    // Later payment on the invoice.
    iStore().recordPayment(invId, { amount: 1000, date: '2026-08-01', bankAccountId: bankId() });
    expect(iStore().getInvoice(invId)!.amountPaid).toBe(1000);

    const after = JSON.stringify(cnStore().getCreditNoteById(cnId)!.invoiceReferenceSnapshot);
    expect(after).toBe(before);
    expect(cnStore().invoiceReference(cnId)!.paymentsAppliedBeforeCredit).toBe(0); // still frozen at 0
  });

  it('remains unchanged after a later credit note is issued against the same invoice', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cn1 = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cn1);
    const before = JSON.stringify(cnStore().getCreditNoteById(cn1)!.invoiceReferenceSnapshot);

    const cn2 = creditByAmount(invId, 1000);
    cnStore().issueCreditNote(cn2);

    const after = JSON.stringify(cnStore().getCreditNoteById(cn1)!.invoiceReferenceSnapshot);
    expect(after).toBe(before);
    expect(cnStore().invoiceReference(cn1)!.previousCreditsTotal).toBe(0); // unaffected by cn2
  });

  it('a partial amount credit retains the ORIGINAL line value (8,000), not the credited 3,000', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId);
    const line = cnStore().invoiceReference(cnId)!.lines[0]!;
    expect(line.originalUnitPrice).toBe(8000);
    expect(line.originalLineTotal).toBe(8000);
    expect(line.creditNoteLineTotal).toBe(3000);
    expect(line.creditBasis).toBe('amount');
  });
});

describe('rendered credit-note document', () => {
  function markup(cnId: string): string {
    const cn = cnStore().getCreditNoteById(cnId)!;
    const snap = cnStore().previewSnapshot(cnId)!;
    const ref = cnStore().invoiceReference(cnId);
    return renderToStaticMarkup(createElement(CreditNoteRenderer, { creditNote: cn, snapshot: snap, reference: ref }));
  }

  it('shows the original invoice number, date, total, the credit deduction and revised balance', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const invoiceNumber = iStore().getInvoice(invId)!.invoiceNumber;
    const invoiceDate = iStore().getInvoice(invId)!.issueDate; // e.g. 2026-07-12
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId);
    const html = markup(cnId);

    expect(html).toContain(invoiceNumber); // original invoice reference
    expect(html).toContain('Credit against Invoice');
    const longDate = new Date(invoiceDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    expect(html).toContain(longDate); // original invoice date, prominently
    expect(html).toContain('8,000.00'); // original invoice total / original line value
    expect(html).toContain('(') ; // deductions shown in parentheses
    expect(html).toContain('3,000.00'); // this credit note
    expect(html).toContain('5,000.00'); // revised invoice balance
    expect(html).toContain('Revised invoice balance');
    expect(html).toContain('Amount adjustment'); // partial amount credit basis
  });

  it('empty / unlinked datasets render safely (no reference)', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditByAmount(invId, 3000);
    const cn = cnStore().getCreditNoteById(cnId)!;
    const snap = cnStore().previewSnapshot(cnId)!;
    expect(() => renderToStaticMarkup(createElement(CreditNoteRenderer, { creditNote: cn, snapshot: snap, reference: null }))).not.toThrow();
  });

  it('hides the Amount applied / Remaining credit rows when fully applied to the linked invoice', () => {
    const invId = issuedInvoice(1, 8000, 0);
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId); // auto-applied 3,000 → remaining 0
    const cn = cnStore().getCreditNoteById(cnId)!;
    expect(cn.amountApplied).toBe(3000);
    expect(cn.remainingCredit).toBe(0);
    const html = markup(cnId);
    expect(html).not.toContain('Amount applied');
    expect(html).not.toContain('Remaining credit');
    // The reconciliation panel still communicates the effect.
    expect(html).toContain('Revised invoice balance');
    expect(html).toContain('5,000.00');
  });

  it('still shows Remaining credit for an unapplied credit (e.g. against a paid invoice)', () => {
    const invId = issuedInvoice(1, 8000, 0);
    iStore().recordPayment(invId, { amount: 8000, date: '2026-08-01', bankAccountId: bankId() });
    const cnId = creditByAmount(invId, 3000);
    cnStore().issueCreditNote(cnId); // invoice balance 0 → nothing auto-applied
    const cn = cnStore().getCreditNoteById(cnId)!;
    expect(cn.amountApplied).toBe(0);
    expect(cn.remainingCredit).toBe(3000);
    expect(markup(cnId)).toContain('Remaining credit');
  });
});

describe('print isolation mechanism', () => {
  it('index.css hides the app shell and shows only the print document in print', () => {
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/has-print-document\s+#root\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.print-document\s*\{\s*display:\s*block/);
    expect(css).toMatch(/@page/);
  });
});
