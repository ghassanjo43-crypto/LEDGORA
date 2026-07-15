import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import type { PaymentTotals } from '@/lib/paymentCalculations';

/** Compact summary of a payment's gross → net cash breakdown. */
export function PaymentSummary({ totals, currency }: { totals: PaymentTotals; currency: string }) {
  const money = (n: number): string => formatCurrency(n, currency);
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-800/40 sm:grid-cols-4 lg:grid-cols-7">
      <Stat label="Gross payment" value={money(totals.grossAmount)} strong />
      <Stat label="Allocated" value={money(totals.allocationTotal)} />
      <Stat label="Unapplied" value={money(totals.unappliedAmount)} strong />
      <Stat label="Bank fee" value={money(totals.bankFeeAmount)} />
      <Stat label="Withholding" value={money(totals.withholdingTaxAmount)} />
      <Stat label="Discount" value={money(totals.discountTakenAmount)} />
      <Stat label="Net cash out" value={money(totals.netCashAmount)} strong />
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cx('font-mono', strong ? 'text-sm font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{value}</p>
    </div>
  );
}
