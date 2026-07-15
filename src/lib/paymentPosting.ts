import type { Account, BusinessEntity } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { Payment, PaymentPostingConfig, PaymentWithholdingPolicy } from '@/types/payment';
import { calculatePaymentTotals, resolveGrossAmount } from '@/lib/paymentCalculations';
import { PAYMENT_TYPE_LABELS } from '@/lib/paymentLabels';
import { roundMoney } from '@/lib/journalValidation';

export interface PaymentPostingContext {
  accountsById: Map<string, Account>;
  config: PaymentPostingConfig;
  withholdingPolicy: PaymentWithholdingPolicy;
  supplier?: BusinessEntity;
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

/** The cash account the money leaves from (bank / cash), by method. */
export function resolveCreditCashAccountId(payment: Payment): string {
  if (payment.method === 'cash') return payment.cashAccountId || payment.bankAccountId || '';
  return payment.bankAccountId || payment.cashAccountId || '';
}

/** The primary debit (liability / expense) account for a payment type. */
export function resolveDebitAccountId(payment: Payment, config: PaymentPostingConfig): string {
  switch (payment.paymentType) {
    case 'supplier-payment':
    case 'unapplied-supplier-payment':
      return config.accountsPayableAccountId;
    case 'supplier-advance':
      return payment.debitAccountId || config.supplierAdvancesAccountId || '';
    case 'customer-refund':
    case 'credit-note-refund':
      return payment.debitAccountId || config.tradeReceivablesAccountId || '';
    case 'loan-repayment':
      return payment.loanAccountId || '';
    case 'lease-payment':
      return payment.leaseLiabilityAccountId || '';
    case 'expense-payment':
    case 'tax-payment':
    case 'payroll-payment':
    case 'owner-drawing':
    case 'dividend-payment':
    case 'other':
    default:
      return payment.debitAccountId || '';
  }
}

/** True when the debit side references the supplier as a subledger party. */
function isSupplierType(payment: Payment): boolean {
  return payment.paymentType === 'supplier-payment' || payment.paymentType === 'unapplied-supplier-payment' || payment.paymentType === 'supplier-advance';
}
function isCustomerType(payment: Payment): boolean {
  return payment.paymentType === 'customer-refund' || payment.paymentType === 'credit-note-refund';
}

/**
 * Build the balanced payment journal, reusing the General Journal form shape so
 * it posts through the existing journal service (never the ledger directly):
 *
 *   Dr <liability/expense>      (gross — AP, advance, expense, tax, loan+interest…)
 *   Dr Bank fees expense        (bank fee, if any)
 *   Dr Realised FX loss         (fx < 0)
 *       Cr Bank / Cash                 net cash (= gross + fee − wht − discount − fx)
 *       Cr Withholding tax payable     (withholding at payment stage, if any)
 *       Cr Purchase discount           (discount taken, if any)
 *       Cr Realised FX gain            (fx > 0)
 *
 * The bank credit takes the NET cash; the liability side is relieved by the full
 * gross so a fee, withholding or discount never under- or over-settles a bill.
 */
export function buildPaymentJournalEntry(payment: Payment, ctx: PaymentPostingContext): JournalFormValues {
  const t = calculatePaymentTotals(payment);
  const gross = resolveGrossAmount(payment);
  const fx = roundMoney(Number(payment.realizedFxAmount) || 0); // +gain / −loss
  const payeeName = ctx.supplier?.legalName ?? ctx.customer?.legalName ?? payment.payeeName ?? '';
  const partyId = isSupplierType(payment) ? payment.supplierId : isCustomerType(payment) ? payment.customerId : undefined;
  const lines: JournalLineFormValues[] = [];
  const memo = `Payment ${payment.paymentNumber}${payeeName ? ` — ${payeeName}` : ''}`;

  /* ── Debit side (liability / expense) ── */
  if (payment.paymentType === 'loan-repayment') {
    const principal = roundMoney(Number(payment.principalAmount) || 0);
    const interest = roundMoney(Number(payment.interestAmount) || 0);
    if (principal > 0 && payment.loanAccountId) lines.push(jLine(ctx.accountsById, payment.loanAccountId, principal, 0, { memo: `Loan principal — ${payment.paymentNumber}` }));
    if (interest > 0 && payment.interestAccountId) lines.push(jLine(ctx.accountsById, payment.interestAccountId, interest, 0, { memo: `Interest — ${payment.paymentNumber}` }));
  } else if (payment.paymentType === 'lease-payment') {
    const principal = roundMoney(Number(payment.leasePrincipalAmount) || 0);
    const finance = roundMoney(Number(payment.financeCostAmount) || 0);
    if (principal > 0 && payment.leaseLiabilityAccountId) lines.push(jLine(ctx.accountsById, payment.leaseLiabilityAccountId, principal, 0, { memo: `Lease principal — ${payment.paymentNumber}` }));
    if (finance > 0 && payment.financeCostAccountId) lines.push(jLine(ctx.accountsById, payment.financeCostAccountId, finance, 0, { memo: `Lease finance cost — ${payment.paymentNumber}` }));
  } else if (gross > 0) {
    const debitAccountId = resolveDebitAccountId(payment, ctx.config);
    const billRefs = payment.allocations.filter((a) => !a.reversed && a.billNumber).map((a) => a.billNumber).join(', ');
    lines.push(jLine(ctx.accountsById, debitAccountId, gross, 0, { entityId: partyId, entityName: partyId ? payeeName : undefined, memo: billRefs ? `${memo} (${billRefs})` : memo }));
  }

  // Bank fee expense (never increases the settled liability).
  if (t.bankFeeAmount > 0 && payment.bankFeeAccountId) {
    lines.push(jLine(ctx.accountsById, payment.bankFeeAccountId, t.bankFeeAmount, 0, { memo: `Bank charges — ${payment.paymentNumber}` }));
  }
  // Realised FX loss.
  if (fx < 0 && (payment.realizedFxAccountId || ctx.config.realizedFxAccountId)) {
    lines.push(jLine(ctx.accountsById, payment.realizedFxAccountId || ctx.config.realizedFxAccountId!, -fx, 0, { memo: `Realised FX loss — ${payment.paymentNumber}` }));
  }

  /* ── Credit side ── */
  // Bank / cash for the net cash leaving (less any FX gain plug).
  lines.push(jLine(ctx.accountsById, resolveCreditCashAccountId(payment), 0, roundMoney(t.netCashAmount - fx), { memo }));
  // Withholding tax withheld at the payment stage.
  if (t.withholdingTaxAmount > 0) {
    const whtAccount = payment.withholdingTaxAccountId || ctx.config.withholdingTaxPayableAccountId;
    if (whtAccount) lines.push(jLine(ctx.accountsById, whtAccount, 0, t.withholdingTaxAmount, { entityId: partyId, entityName: partyId ? payeeName : undefined, memo: `Withholding tax — ${payment.paymentNumber}` }));
  }
  // Discount taken (purchase discount / other income).
  if (t.discountTakenAmount > 0) {
    const discAccount = payment.discountAccountId || ctx.config.purchaseDiscountAccountId;
    if (discAccount) lines.push(jLine(ctx.accountsById, discAccount, 0, t.discountTakenAmount, { memo: `Discount taken — ${payment.paymentNumber}` }));
  }
  // Realised FX gain.
  if (fx > 0 && (payment.realizedFxAccountId || ctx.config.realizedFxAccountId)) {
    lines.push(jLine(ctx.accountsById, payment.realizedFxAccountId || ctx.config.realizedFxAccountId!, 0, fx, { memo: `Realised FX gain — ${payment.paymentNumber}` }));
  }

  const refList = payment.allocations.filter((a) => !a.reversed && a.billNumber).map((a) => a.billNumber).join(', ');
  return {
    entryNumber: '',
    entryDate: payment.paymentDate,
    reference: payment.transactionReference || payment.transferReference || payment.paymentNumber,
    description: `${PAYMENT_TYPE_LABELS[payment.paymentType]} ${payment.paymentNumber}${payeeName ? ` — ${payeeName}` : ''}${refList ? ` (${refList})` : ''}`,
    currency: payment.currency,
    exchangeRate: payment.exchangeRate || 1,
    notes: payment.narration ?? payment.internalMemo ?? '',
    transactionType: PAYMENT_TYPE_LABELS[payment.paymentType],
    createdBy: ctx.createdBy ?? '',
    approvedBy: payment.approvedBy ?? '',
    lines,
  };
}
