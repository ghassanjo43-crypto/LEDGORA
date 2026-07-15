import type { Account, BusinessEntity } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { CreditNote, CreditNotePostingConfig, CreditNoteRefund } from '@/types/creditNote';
import { calculateCreditNoteLine } from '@/lib/creditNoteCalculations';
import { roundMoney } from '@/lib/journalValidation';
import { expandLineCostCenters } from '@/lib/costCenterLinePosting';

export interface CreditNotePostingContext {
  accountsById: Map<string, Account>;
  config: CreditNotePostingConfig;
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
 * Build the balanced credit-note journal, reusing the General Journal form shape
 * so it posts through the existing journal service (never the ledger directly).
 * This is the exact reverse side of the sales invoice:
 *
 *   Dr Sales returns & allowances   (net per line — or the original revenue account)
 *   Dr Output VAT / tax payable     taxTotal
 *       Cr Trade receivables                     grandTotal
 *
 * Posting policy: debit the configured sales-returns account where available,
 * otherwise debit each line's original revenue account — preserving its revenue
 * classification, project and cost-center dimensions.
 */
export function buildCreditNoteJournalEntry(cn: CreditNote, ctx: CreditNotePostingContext): JournalFormValues {
  const customerName = ctx.customer?.legalName ?? '';
  const ref = cn.originalInvoiceNumber ? `${cn.creditNoteNumber} ↔ ${cn.originalInvoiceNumber}` : cn.creditNoteNumber;
  const lines: JournalLineFormValues[] = [];

  // Debit the returns/adjustment side for each line's net (taxable) amount,
  // inheriting the ORIGINAL invoice line's cost center(s). A split produces one
  // reversal line per cost center, all summing to the line amount.
  for (const line of cn.lines) {
    const c = calculateCreditNoteLine(line);
    if (c.taxableAmount <= 0) continue;
    const debitAccountId = ctx.config.salesReturnsAccountId || line.revenueAccountId;
    if (!debitAccountId) continue;
    for (const part of expandLineCostCenters(c.taxableAmount, line)) {
      if (part.amount <= 0) continue;
      lines.push(
        jLine(ctx.accountsById, debitAccountId, part.amount, 0, {
          entityId: line.entityId,
          memo: line.description || `Credit — ${cn.creditNoteNumber}`,
          project: line.projectId,
          costCenter: part.costCenterId,
        }),
      );
    }
  }

  // Debit output tax (the same account originally credited by the invoice).
  if (cn.taxTotal > 0 && ctx.config.outputTaxAccountId) {
    lines.push(jLine(ctx.accountsById, ctx.config.outputTaxAccountId, cn.taxTotal, 0, { memo: `Tax reversal — ${cn.creditNoteNumber}` }));
  }

  // Credit the customer receivables control for the gross amount.
  lines.push(
    jLine(ctx.accountsById, ctx.config.customerReceivablesAccountId, 0, cn.grandTotal, {
      entityId: cn.customerId,
      entityName: customerName,
      memo: `Credit note ${cn.creditNoteNumber}`,
    }),
  );

  return {
    entryNumber: '',
    entryDate: cn.issueDate,
    reference: ref,
    description: `Credit note ${cn.creditNoteNumber}${cn.originalInvoiceNumber ? ` for ${cn.originalInvoiceNumber}` : ''}${customerName ? ` — ${customerName}` : ''}`,
    currency: cn.currency,
    exchangeRate: cn.exchangeRate || 1,
    notes: cn.reasonDescription ? `Reason: ${cn.reasonDescription}` : `Reason: ${cn.reasonCode}`,
    transactionType: 'Credit Note',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines,
  };
}

/**
 * Build the inventory-return journal (only when goods are physically returned):
 *   Dr Inventory       cost
 *       Cr Cost of goods sold   cost
 * Cost basis comes from the original cost data — never derived from selling price.
 */
export function buildInventoryReturnJournalEntry(cn: CreditNote, ctx: CreditNotePostingContext): JournalFormValues | null {
  const lines: JournalLineFormValues[] = [];
  let total = 0;
  for (const line of cn.lines) {
    if (!line.returnToInventory) continue;
    const cost = roundMoney(Number(line.costAmount) || 0);
    if (cost <= 0) continue;
    const inventoryAccountId = line.inventoryAccountId || ctx.config.inventoryAccountId;
    const cogsAccountId = line.costOfGoodsSoldAccountId || ctx.config.costOfGoodsSoldAccountId;
    if (!inventoryAccountId || !cogsAccountId) continue;
    lines.push(jLine(ctx.accountsById, inventoryAccountId, cost, 0, { memo: `Inventory return — ${cn.creditNoteNumber}` }));
    lines.push(jLine(ctx.accountsById, cogsAccountId, 0, cost, { memo: `COGS reversal — ${cn.creditNoteNumber}` }));
    total += cost;
  }
  if (total <= 0 || lines.length === 0) return null;

  return {
    entryNumber: '',
    entryDate: cn.issueDate,
    reference: cn.creditNoteNumber,
    description: `Inventory return — credit note ${cn.creditNoteNumber}`,
    currency: cn.currency,
    exchangeRate: cn.exchangeRate || 1,
    notes: '',
    transactionType: 'Inventory Return',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines,
  };
}

/**
 * Build a cash-refund journal for a credit note (a separate transaction — the
 * original credit-note entry is never altered):
 *   Dr Trade receivables (clears the customer's credit)   amount
 *       Cr Bank                                                    amount
 */
export function buildCreditNoteRefundJournalEntry(
  cn: CreditNote,
  refund: CreditNoteRefund,
  ctx: CreditNotePostingContext,
): JournalFormValues {
  const customerName = ctx.customer?.legalName ?? '';
  return {
    entryNumber: '',
    entryDate: refund.refundDate,
    reference: refund.reference || cn.creditNoteNumber,
    description: `Refund of credit note ${cn.creditNoteNumber}${customerName ? ` — ${customerName}` : ''}`,
    currency: cn.currency,
    exchangeRate: cn.exchangeRate || 1,
    notes: refund.memo ?? '',
    transactionType: 'Customer Refund',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines: [
      jLine(ctx.accountsById, ctx.config.customerReceivablesAccountId, refund.amount, 0, { entityId: cn.customerId, entityName: customerName, memo: `Refund — ${cn.creditNoteNumber}` }),
      jLine(ctx.accountsById, refund.bankAccountId, 0, refund.amount, { memo: `Refund — ${cn.creditNoteNumber}` }),
    ],
  };
}
