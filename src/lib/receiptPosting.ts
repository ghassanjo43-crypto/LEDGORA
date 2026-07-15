import type { Account, BusinessEntity } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { Receipt, ReceiptPostingConfig } from '@/types/receipt';
import { calculateReceiptTotals } from '@/lib/receiptCalculations';
import { roundMoney } from '@/lib/journalValidation';

export interface ReceiptPostingContext {
  accountsById: Map<string, Account>;
  config: ReceiptPostingConfig;
  customer?: BusinessEntity;
  createdBy?: string;
}

function jLine(
  accountsById: Map<string, Account>,
  accountId: string,
  debit: number,
  credit: number,
  opts: { entityId?: string; entityName?: string; memo?: string } = {},
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
    costCenter: '',
    project: '',
    taxCode: '',
    taxAmount: 0,
    memo: opts.memo ?? '',
  };
}

/** The cash account the money lands in (bank / cash / deposit), by receipt method. */
export function resolveDebitAccountId(receipt: Receipt): string {
  return receipt.depositAccountId || receipt.bankAccountId || receipt.cashAccountId || '';
}

/**
 * The credit account for a receipt, by type. Customer receipts relieve trade
 * receivables (one aggregated control line — allocation detail lives in the
 * subledger); other types credit the configured or explicitly selected account.
 */
export function resolveCreditAccountId(receipt: Receipt, config: ReceiptPostingConfig): string {
  switch (receipt.receiptType) {
    case 'customer-payment':
    case 'unapplied-customer-receipt':
      return config.tradeReceivablesAccountId;
    case 'customer-advance':
      return receipt.creditAccountId || config.customerAdvanceAccountId || '';
    case 'miscellaneous-income':
    case 'interest-income':
      return receipt.creditAccountId || config.otherIncomeAccountId || '';
    case 'owner-contribution':
    case 'loan-proceeds':
    case 'supplier-refund':
    case 'other':
    default:
      return receipt.creditAccountId || '';
  }
}

/**
 * Build the balanced receipt journal, reusing the General Journal form shape so
 * it posts through the existing journal service (never the ledger directly):
 *
 *   Dr Bank / Cash            (net = amount − fee − withholding)
 *   Dr Bank fees expense      (fee, if any)
 *   Dr Withholding tax recv.  (withholding, if any)
 *       Cr <credit account>            amount (gross)
 *
 * The debit cash line takes the NET; the credit side is always relieved by the
 * full gross amount, so a bank fee or withholding never under-settles an invoice.
 */
export function buildReceiptJournalEntry(receipt: Receipt, ctx: ReceiptPostingContext): JournalFormValues {
  const t = calculateReceiptTotals(receipt);
  const debitAccountId = resolveDebitAccountId(receipt);
  const creditAccountId = resolveCreditAccountId(receipt, ctx.config);
  const payer = ctx.customer?.legalName ?? receipt.payerName ?? '';
  const lines: JournalLineFormValues[] = [];

  // Debit the cash account for the net amount that actually lands there.
  lines.push(jLine(ctx.accountsById, debitAccountId, t.netBankAmount, 0, { memo: `Receipt ${receipt.receiptNumber}${receipt.transactionReference ? ` — ${receipt.transactionReference}` : ''}` }));

  // Bank fee deducted from the deposit.
  if (t.bankFeeAmount > 0 && receipt.bankFeeAccountId) {
    lines.push(jLine(ctx.accountsById, receipt.bankFeeAccountId, t.bankFeeAmount, 0, { memo: `Bank charges — ${receipt.receiptNumber}` }));
  }
  // Withholding tax withheld by the customer.
  if (t.withholdingTaxAmount > 0 && receipt.withholdingTaxAccountId) {
    lines.push(jLine(ctx.accountsById, receipt.withholdingTaxAccountId, t.withholdingTaxAmount, 0, { entityId: receipt.customerId, entityName: payer, memo: `Withholding tax — ${receipt.receiptNumber}` }));
  }

  // Credit the receipt-type account for the full gross amount.
  const isCustomer = receipt.receiptType === 'customer-payment' || receipt.receiptType === 'unapplied-customer-receipt' || receipt.receiptType === 'customer-advance';
  lines.push(jLine(ctx.accountsById, creditAccountId, 0, t.amount, { entityId: isCustomer ? receipt.customerId : undefined, entityName: isCustomer ? payer : undefined, memo: `Receipt ${receipt.receiptNumber}${payer ? ` — ${payer}` : ''}` }));

  const invoiceRefs = receipt.allocations.filter((a) => !a.reversed && a.invoiceNumber).map((a) => a.invoiceNumber).join(', ');
  return {
    entryNumber: '',
    entryDate: receipt.receiptDate,
    reference: receipt.transactionReference || receipt.receiptNumber,
    description: `Receipt ${receipt.receiptNumber}${payer ? ` — ${payer}` : ''}${invoiceRefs ? ` (${invoiceRefs})` : ''}`,
    currency: receipt.currency,
    exchangeRate: receipt.exchangeRate || 1,
    notes: receipt.narration ?? '',
    transactionType: 'Customer Receipt',
    createdBy: ctx.createdBy ?? '',
    approvedBy: '',
    lines,
  };
}
