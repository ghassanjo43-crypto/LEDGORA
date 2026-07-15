import type { Account, BusinessEntity } from '@/types';
import type { Bill, BillSettlementStatus, BillSettlementSummary } from '@/types/bill';
import type { AgingBucket, AgingBucketId, AgingSummary } from '@/types/statementOfAccount';
import { calculateBillBalance } from '@/lib/billCalculations';
import { agingBucketFor, daysOverdue } from '@/lib/statementAging';
import { roundMoney, BALANCE_TOLERANCE } from '@/lib/journalValidation';

/**
 * Accounts Payable account resolution (§12):
 *   1. supplier-specific payable account
 *   2. entity/system default Trade payables control (2210)
 */
export function resolveAccountsPayableAccount(supplier: BusinessEntity | undefined, accounts: Account[]): string {
  return supplier?.defaultPayableAccount || accounts.find((a) => a.code === '2210')?.id || '';
}

/** Bills whose balance still contributes to what is owed (posted / partially-paid). */
export function isOpenBill(b: Bill): boolean {
  return (b.status === 'posted' || b.status === 'partially-paid') && b.balanceDue > BALANCE_TOLERANCE;
}

/**
 * Settlement summary — never rewrites the bill total.
 *   balanceDue = (grandTotal − withholding) − supplier credits − payments
 */
export function buildBillSettlementSummary(bill: Bill): BillSettlementSummary {
  const originalTotal = roundMoney(bill.grandTotal);
  const supplierCreditsApplied = roundMoney(bill.supplierCreditsApplied);
  const paymentsApplied = roundMoney(bill.amountPaid);
  const balanceDue = calculateBillBalance(bill);
  return { originalTotal, supplierCreditsApplied, paymentsApplied, balanceDue, status: deriveBillSettlementStatus({ balanceDue, supplierCreditsApplied, paymentsApplied }) };
}

export function deriveBillSettlementStatus(s: { balanceDue: number; supplierCreditsApplied: number; paymentsApplied: number }): BillSettlementStatus {
  const settled = s.balanceDue <= BALANCE_TOLERANCE;
  const hasCredits = s.supplierCreditsApplied > BALANCE_TOLERANCE;
  const hasPayments = s.paymentsApplied > BALANCE_TOLERANCE;
  if (settled) {
    if (hasPayments) return 'paid';
    if (hasCredits) return 'fully-credited';
    return 'settled';
  }
  if (hasPayments) return 'partially-paid';
  if (hasCredits) return 'partially-credited';
  return 'outstanding';
}

const BUCKET_LABELS: Record<AgingBucketId, string> = {
  current: 'Current', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '91-120': '91–120 days', '120-plus': 'Over 120 days',
};
const BUCKET_ORDER: AgingBucketId[] = ['current', '1-30', '31-60', '61-90', '91-120', '120-plus'];

/**
 * AP aging (§31): ages the REMAINING bill balance (after payments & credits) by
 * due date, as of a date, over the supplier's open bills.
 */
export function calculateBillAging(bills: Bill[], asOfDate: string): AgingSummary {
  const buckets: Record<AgingBucketId, AgingBucket> = Object.fromEntries(
    BUCKET_ORDER.map((id) => [id, { id, label: BUCKET_LABELS[id], amount: 0, invoiceIds: [] as string[] }]),
  ) as Record<AgingBucketId, AgingBucket>;

  for (const b of bills) {
    if (!isOpenBill(b)) continue;
    const od = daysOverdue(b.dueDate || b.billDate, asOfDate);
    const bucket = buckets[agingBucketFor(od)];
    bucket.amount = roundMoney(bucket.amount + b.balanceDue);
    bucket.invoiceIds.push(b.id);
  }
  const ordered = BUCKET_ORDER.map((id) => buckets[id]);
  return { asOfDate, buckets: ordered, total: roundMoney(ordered.reduce((s, x) => s + x.amount, 0)) };
}

/** Total payable owed to a supplier (sum of open bill balances). */
export function supplierPayableBalance(bills: Bill[], supplierId: string, entityId: string): number {
  return roundMoney(bills.filter((b) => b.supplierId === supplierId && b.entityId === entityId && isOpenBill(b)).reduce((s, b) => s + b.balanceDue, 0));
}
