import type { Account, BusinessEntity } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { Bill, BillPayment, BillPostingConfig, BillSupplierCredit, WithholdingTaxPolicy } from '@/types/bill';
import { calculateBillLine, calculateBillTotals, calculateWithholdingTax } from '@/lib/billCalculations';
import { roundMoney } from '@/lib/journalValidation';
import { expandLineCostCenters } from '@/lib/costCenterLinePosting';

export interface BillPostingContext {
  accountsById: Map<string, Account>;
  config: BillPostingConfig;
  withholdingPolicy: WithholdingTaxPolicy;
  supplier?: BusinessEntity;
  createdBy?: string;
}

function jLine(
  accountsById: Map<string, Account>,
  accountId: string,
  debit: number,
  credit: number,
  opts: { entityId?: string; entityName?: string; memo?: string; project?: string; costCenter?: string } = {},
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
 * Build the balanced bill journal (§13), posting through the General Journal:
 *
 *   Dr Expense / Asset / Inventory   (net per line, preserving classification)
 *   Dr Input VAT recoverable         (input tax)
 *       Cr Trade payables                    (grand total − withholding tax)
 *       Cr Withholding tax payable           (withholding, if recognised on posting)
 */
export function buildBillJournalEntry(bill: Bill, ctx: BillPostingContext): JournalFormValues {
  const supplierName = ctx.supplier?.legalName ?? '';
  const t = calculateBillTotals(bill.lines, bill.additionalChargesTotal);
  const wht = ctx.withholdingPolicy.recognition === 'bill-posting' ? t.withholdingTaxTotal : 0;
  const lines: JournalLineFormValues[] = [];

  // Debit each expense/asset/inventory line for its net (taxable) amount, tagging
  // the cost center(s). A split produces one debit per cost center, all summing to
  // the line amount. The AP and recoverable-tax control lines stay untagged.
  for (const line of bill.lines) {
    const c = calculateBillLine(line);
    if (c.taxableAmount <= 0 || !line.accountId) continue;
    for (const part of expandLineCostCenters(c.taxableAmount, line)) {
      if (part.amount <= 0) continue;
      lines.push(jLine(ctx.accountsById, line.accountId, part.amount, 0, { memo: line.description || `Bill ${bill.billNumber}`, project: line.projectId, costCenter: part.costCenterId }));
    }
  }
  // Debit recoverable input VAT.
  if (t.taxTotal > 0 && ctx.config.inputTaxAccountId) {
    lines.push(jLine(ctx.accountsById, ctx.config.inputTaxAccountId, t.taxTotal, 0, { memo: `Input tax — ${bill.billNumber}` }));
  }
  // Credit trade payables for the net amount owed to the supplier.
  lines.push(jLine(ctx.accountsById, ctx.config.accountsPayableAccountId, 0, roundMoney(t.grandTotal - wht), { entityId: bill.supplierId, entityName: supplierName, memo: `Bill ${bill.billNumber} · ${bill.supplierInvoiceNumber}` }));
  // Credit withholding tax payable.
  if (wht > 0) {
    const whtAccount = ctx.withholdingPolicy.payableAccountId || ctx.config.withholdingTaxPayableAccountId;
    if (whtAccount) lines.push(jLine(ctx.accountsById, whtAccount, 0, wht, { memo: `Withholding tax — ${bill.billNumber}` }));
  }

  return {
    entryNumber: '',
    entryDate: bill.postingDate || bill.billDate,
    reference: bill.supplierInvoiceNumber || bill.billNumber,
    description: `Bill ${bill.billNumber}${supplierName ? ` — ${supplierName}` : ''}${bill.purchaseOrderId ? ` (PO ${bill.purchaseOrderId})` : ''}`,
    currency: bill.currency,
    exchangeRate: bill.exchangeRate || 1,
    notes: bill.internalMemo ?? '',
    transactionType: 'Supplier Bill',
    createdBy: ctx.createdBy ?? '',
    approvedBy: bill.approvedBy ?? '',
    lines,
  };
}

/**
 * Supplier payment (§19): Dr Trade payables / Cr Bank, with optional bank fees
 * and a realised FX gain/loss on a foreign-currency settlement.
 */
export function buildBillPaymentJournalEntry(bill: Bill, payment: BillPayment, ctx: BillPostingContext): JournalFormValues {
  const supplierName = ctx.supplier?.legalName ?? '';
  const fee = roundMoney(Math.max(0, Number(payment.bankFeeAmount) || 0));
  const fx = roundMoney(Number(payment.realizedFxAmount) || 0); // +gain / −loss
  const lines: JournalLineFormValues[] = [
    jLine(ctx.accountsById, ctx.config.accountsPayableAccountId, payment.amount, 0, { entityId: bill.supplierId, entityName: supplierName, memo: `Payment — ${bill.billNumber}` }),
  ];
  if (fee > 0 && payment.bankFeeAccountId) lines.push(jLine(ctx.accountsById, payment.bankFeeAccountId, fee, 0, { memo: `Bank charges — ${bill.billNumber}` }));
  if (fx < 0 && ctx.config.realizedFxAccountId) lines.push(jLine(ctx.accountsById, ctx.config.realizedFxAccountId, -fx, 0, { memo: `Realised FX loss — ${bill.billNumber}` }));
  if (fx > 0 && ctx.config.realizedFxAccountId) lines.push(jLine(ctx.accountsById, ctx.config.realizedFxAccountId, 0, fx, { memo: `Realised FX gain — ${bill.billNumber}` }));
  lines.push(jLine(ctx.accountsById, payment.bankAccountId, 0, roundMoney(payment.amount + fee - fx), { memo: `Payment — ${bill.billNumber}` }));

  return {
    entryNumber: '',
    entryDate: payment.date,
    reference: payment.reference || bill.billNumber,
    description: `Payment for bill ${bill.billNumber}${supplierName ? ` — ${supplierName}` : ''}`,
    currency: bill.currency,
    exchangeRate: bill.exchangeRate || 1,
    notes: '',
    transactionType: 'Supplier Payment',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines,
  };
}

/**
 * Supplier credit (§18): Dr Trade payables / Cr Expense (returns) / Cr Input VAT.
 * `creditAccountId` is the expense/asset/inventory account the credit reverses.
 */
export function buildSupplierCreditJournalEntry(bill: Bill, credit: BillSupplierCredit, creditAccountId: string, ctx: BillPostingContext): JournalFormValues {
  const supplierName = ctx.supplier?.legalName ?? '';
  const net = roundMoney(credit.netAmount);
  const tax = roundMoney(credit.taxAmount);
  // Inherit the cost center from the ORIGINAL bill line the credit reverses (the
  // first matching expense/asset/inventory line), never a current default.
  const originalLine = bill.lines.find((l) => l.accountId === creditAccountId);
  const lines: JournalLineFormValues[] = [
    jLine(ctx.accountsById, ctx.config.accountsPayableAccountId, credit.amount, 0, { entityId: bill.supplierId, entityName: supplierName, memo: `Supplier credit ${credit.creditNumber} — ${bill.billNumber}` }),
  ];
  if (net > 0 && creditAccountId) {
    for (const part of expandLineCostCenters(net, originalLine ?? {})) {
      if (part.amount <= 0) continue;
      lines.push(jLine(ctx.accountsById, creditAccountId, 0, part.amount, { memo: `Credit — ${credit.creditNumber}`, costCenter: part.costCenterId, project: originalLine?.projectId }));
    }
  }
  if (tax > 0 && ctx.config.inputTaxAccountId) lines.push(jLine(ctx.accountsById, ctx.config.inputTaxAccountId, 0, tax, { memo: `Input tax reversal — ${credit.creditNumber}` }));

  return {
    entryNumber: '',
    entryDate: credit.date,
    reference: credit.creditNumber,
    description: `Supplier credit ${credit.creditNumber} for ${bill.billNumber}${supplierName ? ` — ${supplierName}` : ''}`,
    currency: bill.currency,
    exchangeRate: bill.exchangeRate || 1,
    notes: credit.reason ?? '',
    transactionType: 'Supplier Credit',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines,
  };
}

/** Convenience re-export for callers computing withholding on a bill line. */
export { calculateWithholdingTax };
