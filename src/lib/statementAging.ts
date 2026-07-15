import type { Invoice } from '@/types/invoice';
import type { CreditNote } from '@/types/creditNote';
import type { Receipt } from '@/types/receipt';
import type { AgingBucket, AgingBucketId, AgingSummary, OutstandingInvoiceSummary } from '@/types/statementOfAccount';
import { buildInvoiceSettlementSummary, creditNoteAppliedToInvoice, receiptAppliedToInvoice, deriveSettlementStatus } from '@/lib/invoiceSettlement';
import { roundMoney, BALANCE_TOLERANCE } from '@/lib/journalValidation';

/** Whole days between two ISO dates (asOf − target), floored, never negative for aging. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Days a due date is overdue as of a date (0 when not yet due / due today). */
export function daysOverdue(dueDate: string, asOfDate: string): number {
  return Math.max(0, daysBetween(dueDate, asOfDate));
}

export function agingBucketFor(days: number): AgingBucketId {
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 120) return '91-120';
  return '120-plus';
}

const BUCKET_LABELS: Record<AgingBucketId, string> = {
  current: 'Current',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '91-120': '91–120 days',
  '120-plus': 'Over 120 days',
};

const BUCKET_ORDER: AgingBucketId[] = ['current', '1-30', '31-60', '61-90', '91-120', '120-plus'];

/**
 * Outstanding schedule for a set of (already customer/entity-filtered, issued,
 * non-void) invoices. Uses the shared settlement builder — outstanding balance =
 * original total − applied credit notes − applied receipts — and ages the
 * REMAINING balance (not the original total) by due date.
 */
export function buildOutstandingInvoiceSchedule(
  invoices: Invoice[],
  creditNotes: CreditNote[],
  receipts: Receipt[],
  asOfDate: string,
  opts: { includeSettled?: boolean } = {},
): OutstandingInvoiceSummary[] {
  const rows: OutstandingInvoiceSummary[] = [];
  for (const inv of invoices) {
    const s = buildInvoiceSettlementSummary(inv, creditNotes, receipts);
    const outstanding = s.balanceDue;
    if (!opts.includeSettled && outstanding <= BALANCE_TOLERANCE) continue;
    const due = inv.dueDate || inv.issueDate;
    const od = daysOverdue(due, asOfDate);
    rows.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.issueDate,
      dueDate: due,
      originalTotal: roundMoney(inv.grandTotal),
      creditNotesApplied: roundMoney(creditNotes.reduce((sum, cn) => sum + creditNoteAppliedToInvoice(cn, inv.id), 0)),
      receiptsApplied: roundMoney(receipts.reduce((sum, r) => sum + receiptAppliedToInvoice(r, inv.id), 0)),
      outstandingBalance: outstanding,
      daysOverdue: od,
      agingBucket: agingBucketFor(od),
      status: deriveSettlementStatus(s),
      currency: inv.currency,
    });
  }
  return rows.sort((a, b) => (a.dueDate || a.invoiceDate).localeCompare(b.dueDate || b.invoiceDate));
}

/** Aging summary built from the outstanding schedule (ages remaining balances). */
export function calculateAgingSummary(schedule: OutstandingInvoiceSummary[], asOfDate: string): AgingSummary {
  const buckets: Record<AgingBucketId, AgingBucket> = Object.fromEntries(
    BUCKET_ORDER.map((id) => [id, { id, label: BUCKET_LABELS[id], amount: 0, invoiceIds: [] as string[] }]),
  ) as Record<AgingBucketId, AgingBucket>;

  for (const row of schedule) {
    if (row.outstandingBalance <= BALANCE_TOLERANCE) continue;
    const b = buckets[row.agingBucket];
    b.amount = roundMoney(b.amount + row.outstandingBalance);
    b.invoiceIds.push(row.invoiceId);
  }
  const ordered = BUCKET_ORDER.map((id) => buckets[id]);
  return { asOfDate, buckets: ordered, total: roundMoney(ordered.reduce((s, b) => s + b.amount, 0)) };
}
