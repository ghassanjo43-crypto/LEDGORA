import type { IncomeStatementMargins, IncomeStatementTotals } from '@/types/incomeStatement';
import { isAmount, isPercent, isVariancePercent } from './isFormat';
import { cn } from '@/lib/utils';

interface Props {
  totals: IncomeStatementTotals;
  margins: IncomeStatementMargins;
  comparativeTotals: IncomeStatementTotals;
  hasComparative: boolean;
  base: string;
}

interface Metric {
  label: string;
  value: number;
  prior?: number;
  sub?: string;
  tone: 'neutral' | 'good' | 'bad';
}

function variancePct(current: number, prior: number): number | null {
  return Math.abs(prior) < 0.005 ? null : (current - prior) / Math.abs(prior);
}

export function MetricCards({ totals, margins, comparativeTotals, hasComparative, base }: Props) {
  const metrics: Metric[] = [
    { label: 'Revenue', value: totals.revenue, prior: comparativeTotals.revenue, tone: 'neutral' },
    { label: 'Gross profit', value: totals.grossProfit, prior: comparativeTotals.grossProfit, sub: `Margin ${isPercent(margins.grossMargin)}`, tone: totals.grossProfit >= 0 ? 'good' : 'bad' },
    { label: 'Operating profit', value: totals.operatingProfit, prior: comparativeTotals.operatingProfit, sub: `Margin ${isPercent(margins.operatingMargin)}`, tone: totals.operatingProfit >= 0 ? 'good' : 'bad' },
    { label: 'Profit before tax', value: totals.profitBeforeTax, prior: comparativeTotals.profitBeforeTax, tone: totals.profitBeforeTax >= 0 ? 'good' : 'bad' },
    { label: totals.netProfit < 0 ? 'Net loss' : 'Net profit', value: totals.netProfit, prior: comparativeTotals.netProfit, sub: `Margin ${isPercent(margins.netMargin)}`, tone: totals.netProfit >= 0 ? 'good' : 'bad' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {metrics.map((m) => {
        const vpct = hasComparative && m.prior !== undefined ? variancePct(m.value, m.prior) : undefined;
        return (
          <div key={m.label} className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{m.label}</p>
            <p className={cn('mt-1 font-mono text-lg font-bold tabular-nums', m.tone === 'bad' ? 'text-red-600 dark:text-red-400' : m.tone === 'good' ? 'text-slate-900 dark:text-white' : 'text-slate-900 dark:text-white')}>
              {isAmount(m.value)}
            </p>
            <div className="mt-0.5 flex items-center justify-between gap-1">
              {m.sub ? <span className="text-[11px] text-slate-500 dark:text-slate-400">{m.sub}</span> : <span className="text-[11px] text-slate-400">{base}</span>}
              {vpct !== undefined && (
                <span className={cn('text-[11px] font-medium', vpct === null ? 'text-slate-400' : vpct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                  {isVariancePercent(vpct)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
