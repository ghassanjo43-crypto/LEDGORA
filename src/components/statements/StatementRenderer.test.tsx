import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from '@/store/invoiceTemplateStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { buildStatementOfAccount } from '@/lib/statementOfAccount';
import { createStatementTemplateSnapshot } from '@/lib/statementTemplate';
import { StatementRenderer } from './StatementRenderer';
import type { StatementOptions } from '@/types/statementOfAccount';

const cid = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const revenueId = () => useStore.getState().accounts.find((a) => a.code === '4120')!.id;

function issuedInvoice(customerId: string, issueDate: string, unitPrice: number): string {
  const { id } = useInvoiceStore.getState().createDraft({ customerId, issueDate, dueDate: issueDate, currency: 'USD' });
  const inv = useInvoiceStore.getState().getInvoice(id!)!;
  useInvoiceStore.getState().updateDraft(id!, { lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Svc', quantity: 1, unitPrice, taxRate: 0 }] });
  useInvoiceStore.getState().issueInvoice(id!);
  return id!;
}

function statementSnapshot(customerName: string) {
  const ts = useInvoiceTemplateStore.getState();
  const resolved = ts.resolve({ entityId: INVOICE_ENTITY_ID });
  const template = ts.getTemplate(resolved.templateId)!;
  const version = ts.getVersion(resolved.templateVersionId)!;
  return createStatementTemplateSnapshot(template, version, { legalName: 'Acme Holdings Ltd.' }, { name: customerName });
}

const OPTIONS: StatementOptions = {
  statementType: 'balance-forward', statementBasis: 'document', periodStart: '2026-07-01', periodEnd: '2026-07-31', asOfDate: '2026-07-31',
  currencyMode: 'single-currency', currency: 'USD', includeSettledInvoices: false, includeUnappliedReceipts: true, includeAllocationDetails: true, includeAging: true, includeOutstandingSchedule: true, includeZeroValueActivity: false,
};

function build(customerId: string) {
  return buildStatementOfAccount({
    entityId: 'primary', customerId, options: OPTIONS,
    invoices: useInvoiceStore.getState().invoices, creditNotes: useCreditNoteStore.getState().creditNotes, receipts: useReceiptStore.getState().receipts,
    journalEntries: useJournalStore.getState().entries, customers: useEntityStore.getState().entities, accounts: useStore.getState().accounts, baseCurrency: 'USD',
  });
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

describe('StatementRenderer', () => {
  it('renders the statement document with title, customer, balances and aging', () => {
    const customerId = cid();
    issuedInvoice(customerId, '2026-06-15', 2000); // opening
    issuedInvoice(customerId, '2026-07-12', 8000);
    const st = build(customerId);
    const html = renderToStaticMarkup(createElement(StatementRenderer, { statement: st, snapshot: statementSnapshot(st.customerName) }));

    expect(html).toContain('Statement of Account');
    expect(html).toContain(st.customerName);
    expect(html).toContain('Opening balance');
    expect(html).toContain('2,000.00'); // opening
    expect(html).toContain('10,000.00'); // closing (2,000 + 8,000)
    expect(html).toContain('Aging');
  });

  it('renders an empty customer statement safely', () => {
    const st = build(cid());
    expect(() => renderToStaticMarkup(createElement(StatementRenderer, { statement: st, snapshot: statementSnapshot(st.customerName) }))).not.toThrow();
  });
});
