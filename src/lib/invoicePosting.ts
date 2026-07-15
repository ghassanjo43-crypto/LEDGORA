import type { Account, BusinessEntity } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { Invoice, InvoicePayment } from '@/types/invoice';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { roundMoney } from '@/lib/journalValidation';
import { expandLineCostCenters } from '@/lib/costCenterLinePosting';

export interface PostingContext {
  accountsById: Map<string, Account>;
  receivableAccountId: string;
  taxPayableAccountId?: string;
  customer?: BusinessEntity;
  createdBy?: string;
}

function jLine(
  accountsById: Map<string, Account>,
  accountId: string,
  debit: number,
  credit: number,
  opts: { entityId?: string; entityName?: string; memo?: string; costCenter?: string; project?: string } = {},
): JournalLineFormValues {
  const acc = accountsById.get(accountId);
  return {
    accountId,
    accountCode: acc?.code ?? '',
    accountName: acc?.name ?? '',
    description: '',
    debit: roundMoney(debit),
    credit: roundMoney(credit),
    entityId: opts.entityId ?? '',
    entityName: opts.entityName ?? '',
    costCenter: opts.costCenter ?? '',
    project: opts.project ?? '',
    taxCode: '',
    taxAmount: 0,
    memo: opts.memo ?? '',
  };
}

/**
 * Build the balanced sales journal for an invoice, reusing the General Journal
 * form shape so it posts through the existing journal service (never touching
 * the ledger directly):
 *
 *   Dr Trade receivables            grandTotal
 *       Cr Revenue (per line, net of discount)
 *       Cr Output VAT / tax payable  taxTotal
 */
export function buildInvoiceJournalEntry(invoice: Invoice, ctx: PostingContext): JournalFormValues {
  const customerName = ctx.customer?.legalName ?? '';
  const lines: JournalLineFormValues[] = [];

  // Debit receivable for the full amount owed.
  lines.push(jLine(ctx.accountsById, ctx.receivableAccountId, invoice.grandTotal, 0, { entityId: invoice.customerId, entityName: customerName, memo: `Invoice ${invoice.invoiceNumber}` }));

  // Credit each revenue line for its net (taxable) amount, tagging the cost
  // center(s) — a split produces one revenue line per cost center, all summing to
  // the line's taxable amount. The receivable and tax lines stay untagged.
  for (const line of invoice.lines) {
    const c = calculateInvoiceLine(line);
    if (c.taxableAmount <= 0 || !line.accountId) continue;
    for (const part of expandLineCostCenters(c.taxableAmount, line)) {
      if (part.amount <= 0) continue;
      lines.push(jLine(ctx.accountsById, line.accountId, 0, part.amount, { entityId: line.entityId, memo: line.description, costCenter: part.costCenterId, project: line.projectId }));
    }
  }

  // Credit output tax (tax control line carries no cost center by default).
  if (invoice.taxTotal > 0 && ctx.taxPayableAccountId) {
    lines.push(jLine(ctx.accountsById, ctx.taxPayableAccountId, 0, invoice.taxTotal, { memo: `Output tax — ${invoice.invoiceNumber}` }));
  }

  return {
    entryNumber: '',
    entryDate: invoice.issueDate,
    reference: invoice.invoiceNumber,
    description: `Invoice ${invoice.invoiceNumber}${customerName ? ` — ${customerName}` : ''}`,
    currency: invoice.currency,
    exchangeRate: invoice.exchangeRate || 1,
    notes: '',
    transactionType: 'Sales Invoice',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines,
  };
}

/**
 * Build a customer-receipt journal for a payment against an invoice:
 *   Dr Bank / Cash    amount
 *       Cr Trade receivables   amount
 * The original invoice journal is never modified.
 */
export function buildInvoicePaymentJournalEntry(invoice: Invoice, payment: InvoicePayment, ctx: PostingContext): JournalFormValues {
  const customerName = ctx.customer?.legalName ?? '';
  return {
    entryNumber: '',
    entryDate: payment.date,
    reference: payment.reference || invoice.invoiceNumber,
    description: `Payment for invoice ${invoice.invoiceNumber}${customerName ? ` — ${customerName}` : ''}`,
    currency: invoice.currency,
    exchangeRate: invoice.exchangeRate || 1,
    notes: '',
    transactionType: 'Customer Receipt',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines: [
      jLine(ctx.accountsById, payment.bankAccountId, payment.amount, 0, { memo: `Receipt — ${invoice.invoiceNumber}` }),
      jLine(ctx.accountsById, ctx.receivableAccountId, 0, payment.amount, { entityId: invoice.customerId, entityName: customerName, memo: `Receipt — ${invoice.invoiceNumber}` }),
    ],
  };
}
