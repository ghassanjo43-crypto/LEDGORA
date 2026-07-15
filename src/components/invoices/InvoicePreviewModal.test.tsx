// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { InvoicePreviewModal } from './InvoicePreviewModal';
import { ToastProvider } from '@/components/ui/Toast';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';

const cnStore = () => useCreditNoteStore.getState();
const iStore = () => useInvoiceStore.getState();
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const revenueId = () => useStore.getState().accounts.find((a) => a.code === '4120')!.id;

function issuedInvoice(unitPrice: number): string {
  const { id } = iStore().createDraft({ customerId: firstCustomerId() });
  const inv = iStore().getInvoice(id!)!;
  iStore().updateDraft(id!, { lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Service', quantity: 1, unitPrice, taxRate: 0 }] });
  iStore().issueInvoice(id!);
  return id!;
}
function creditNote(invoiceId: string, amount: number): string {
  const { id } = cnStore().createCreditNoteFromInvoice(invoiceId);
  const cn = cnStore().getCreditNoteById(id!)!;
  cnStore().updateCreditNote(id!, { lines: [{ ...cn.lines[0]!, revenueAccountId: revenueId(), quantity: 1, unitPrice: amount, taxRate: 0 }] });
  cnStore().issueCreditNote(id!);
  return id!;
}

function setup(): { invoiceId: string; invoiceNumber: string; cnNumber: string } {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  const invoiceId = issuedInvoice(8000); // 8,000, no tax
  const cnId = creditNote(invoiceId, 3000); // 3,000 applied → balance 5,000
  return {
    invoiceId,
    invoiceNumber: iStore().getInvoice(invoiceId)!.invoiceNumber,
    cnNumber: cnStore().getCreditNoteById(cnId)!.creditNoteNumber,
  };
}

/** The on-screen (not print-portal) copy of the document. */
function screenDoc(): HTMLElement {
  const pages = document.querySelectorAll('.invoice-page');
  // The modal renders the screen copy first, then the PrintDocument copy.
  return pages[0] as HTMLElement;
}

beforeEach(() => setup());
afterEach(() => cleanup());

describe('InvoicePreviewModal — copy mode wiring', () => {
  it('Original copy hides the account-position panel', () => {
    const { invoiceId } = setup();
    render(<ToastProvider><InvoicePreviewModal invoiceId={invoiceId} onClose={() => {}} /></ToastProvider>);
    // Defaults to Original.
    expect(screen.queryByText(/Updated account position/i)).toBeNull();
  });

  it('Current copy shows the panel with original total, the credit note deduction and the revised balance (zero payment does not suppress it)', () => {
    const { invoiceId, cnNumber } = setup();
    render(<ToastProvider><InvoicePreviewModal invoiceId={invoiceId} onClose={() => {}} /></ToastProvider>);

    // Toggle to Current copy.
    fireEvent.click(screen.getByRole('button', { name: /Current copy/i }));

    const doc = within(screenDoc());
    expect(doc.getByText(/Updated account position/i)).toBeTruthy();
    expect(doc.getByText(/as of/i)).toBeTruthy();
    // Per-credit-note deduction line references the real CN number.
    expect(doc.getByText(new RegExp(cnNumber))).toBeTruthy();
    // The financial figures.
    expect(doc.getAllByText(/8,000\.00/).length).toBeGreaterThan(0);
    expect(doc.getAllByText(/\(?\$?3,000\.00\)?/).length).toBeGreaterThan(0);
    expect(doc.getByText(/Current balance due/i)).toBeTruthy();
    expect(doc.getAllByText(/5,000\.00/).length).toBeGreaterThan(0);
    // A zero payment renders as an explicit amount, not a hidden row.
    expect(doc.getByText(/payments received/i)).toBeTruthy();
  });

  it('toggling back to Original removes the panel again', () => {
    const { invoiceId } = setup();
    render(<ToastProvider><InvoicePreviewModal invoiceId={invoiceId} onClose={() => {}} /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Current copy/i }));
    expect(screen.getAllByText(/Updated account position/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Original copy/i }));
    expect(screen.queryByText(/Updated account position/i)).toBeNull();
  });

  it('the current-copy panel reflects LIVE credit notes added after the modal opened', () => {
    const { invoiceId } = setup();
    render(<ToastProvider><InvoicePreviewModal invoiceId={invoiceId} onClose={() => {}} /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Current copy/i }));
    expect(within(screenDoc()).getAllByText(/5,000\.00/).length).toBeGreaterThan(0);

    // Issue another credit note while the modal is open → live update to 4,000.
    act(() => { creditNote(invoiceId, 1000); });
    expect(cnStore().creditNotes.filter((c) => c.status === 'applied' || c.status === 'partially-applied').length).toBe(2);
    expect(within(screenDoc()).getAllByText(/4,000\.00/).length).toBeGreaterThan(0);
  });
});
