import type { CashFlowStatement } from '@/types/cashFlow';
import type { NegativeFormat } from '@/types/incomeStatement';
import { formatFinancialAmount, formatVariancePercent } from '@/components/balance-sheet/bsFormat';
import { cn } from '@/lib/utils';

interface Props {
  statement: CashFlowStatement;
  detail: boolean;
  negativeFormat: NegativeFormat;
  onDrill: (accountId: string) => void;
}

type RowKind = 'section' | 'subheader' | 'line' | 'subtotal' | 'total' | 'grand';
interface Row {
  id: string;
  label: string;
  current?: number;
  comparative?: number;
  level: number;
  kind: RowKind;
  accountIds?: string[];
}

function buildRows(s: CashFlowStatement, detail: boolean): Row[] {
  const c = s.comparativeTotals;
  const rows: Row[] = [];

  rows.push({ id: 'op-sec', label: 'Cash flows from operating activities', level: 0, kind: 'section' });
  rows.push({ id: 'op-profit', label: s.profitForPeriod < 0 ? 'Net loss for the period' : 'Net profit for the period', current: s.profitForPeriod, comparative: c?.profitForPeriod, level: 1, kind: 'line' });

  if (s.nonCashAdjustments.length && detail) {
    rows.push({ id: 'op-adj', label: 'Adjustments for:', level: 1, kind: 'subheader' });
    for (const l of s.nonCashAdjustments) rows.push({ id: l.id, label: l.label, current: l.amount, comparative: l.comparativeAmount, level: 2, kind: 'line', accountIds: l.accountIds });
  }
  if (s.workingCapitalChanges.length && detail) {
    rows.push({ id: 'op-wc', label: 'Changes in working capital:', level: 1, kind: 'subheader' });
    for (const l of s.workingCapitalChanges) rows.push({ id: l.id, label: l.label, current: l.amount, comparative: l.comparativeAmount, level: 2, kind: 'line', accountIds: l.accountIds });
  }
  rows.push({ id: 'op-cash-gen', label: 'Cash generated from operations', current: s.cashGeneratedFromOperations, comparative: c?.netOperatingCashFlow, level: 1, kind: 'subtotal' });
  if (Math.abs(s.interestPaid) >= 0.005) rows.push({ id: 'op-interest', label: 'Interest paid', current: -Math.abs(s.interestPaid), level: 1, kind: 'line' });
  if (Math.abs(s.taxesPaid) >= 0.005) rows.push({ id: 'op-tax', label: 'Income taxes paid', current: -Math.abs(s.taxesPaid), level: 1, kind: 'line' });
  rows.push({ id: 'op-net', label: 'Net cash generated from operating activities', current: s.netOperatingCashFlow, comparative: c?.netOperatingCashFlow, level: 0, kind: 'total' });

  rows.push({ id: 'inv-sec', label: 'Cash flows from investing activities', level: 0, kind: 'section' });
  if (detail) for (const l of s.investingActivities) rows.push({ id: l.id, label: l.label, current: l.amount, comparative: l.comparativeAmount, level: 1, kind: 'line', accountIds: l.accountIds });
  rows.push({ id: 'inv-net', label: s.netInvestingCashFlow < 0 ? 'Net cash used in investing activities' : 'Net cash from investing activities', current: s.netInvestingCashFlow, comparative: c?.netInvestingCashFlow, level: 0, kind: 'total' });

  rows.push({ id: 'fin-sec', label: 'Cash flows from financing activities', level: 0, kind: 'section' });
  if (detail) for (const l of s.financingActivities) rows.push({ id: l.id, label: l.label, current: l.amount, comparative: l.comparativeAmount, level: 1, kind: 'line', accountIds: l.accountIds });
  rows.push({ id: 'fin-net', label: s.netFinancingCashFlow < 0 ? 'Net cash used in financing activities' : 'Net cash generated from financing activities', current: s.netFinancingCashFlow, comparative: c?.netFinancingCashFlow, level: 0, kind: 'total' });

  rows.push({ id: 'spacer', label: '', level: 0, kind: 'subheader' });
  rows.push({ id: 'net-change', label: 'Net increase / (decrease) in cash and cash equivalents', current: s.netChangeInCash, comparative: c?.netChangeInCash, level: 0, kind: 'subtotal' });
  rows.push({ id: 'open-cash', label: 'Cash and cash equivalents at beginning of period', current: s.openingCash, comparative: c?.openingCash, level: 0, kind: 'line' });
  if (Math.abs(s.exchangeRateEffect) >= 0.005) rows.push({ id: 'fx', label: 'Effect of exchange-rate changes on cash', current: s.exchangeRateEffect, level: 0, kind: 'line' });
  rows.push({ id: 'close-cash', label: 'Cash and cash equivalents at end of period', current: s.calculatedClosingCash, comparative: c?.calculatedClosingCash, level: 0, kind: 'grand' });

  return rows;
}

function amtClass(n: number | undefined): string {
  return n !== undefined && n < 0 ? 'text-red-600 dark:text-red-400' : '';
}

export function CashFlowTable({ statement, detail, negativeFormat, onDrill }: Props) {
  const rows = buildRows(statement, detail);
  const hasComp = statement.hasComparative;
  const cols = 1 + 1 + (hasComp ? 3 : 0);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:bg-slate-800/80 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-4 py-2 text-left font-semibold">Description</th>
            <th scope="col" className="px-4 py-2 text-right font-semibold">Current period</th>
            {hasComp && (
              <>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Comparative</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Variance</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Var %</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (r.id === 'spacer') return <tr key={r.id}><td colSpan={cols} className="py-1.5" /></tr>;
            if (r.kind === 'section') {
              return (
                <tr key={r.id} className="bg-slate-100/70 dark:bg-slate-800/40">
                  <td colSpan={cols} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">{r.label}</td>
                </tr>
              );
            }
            const drillId = r.accountIds?.[0];
            const variance = hasComp && r.current !== undefined && r.comparative !== undefined ? r.current - r.comparative : undefined;
            const varPct = variance !== undefined && r.comparative ? variance / Math.abs(r.comparative) : (variance !== undefined ? null : undefined);
            const strong = r.kind === 'total';
            const grand = r.kind === 'grand';
            const subtotal = r.kind === 'subtotal';
            const subheader = r.kind === 'subheader';

            return (
              <tr
                key={r.id}
                onClick={drillId ? () => onDrill(drillId) : undefined}
                className={cn(
                  drillId && 'cursor-pointer hover:bg-brand-50/50 dark:hover:bg-brand-500/5',
                  (strong || subtotal) && 'bg-slate-50/60 dark:bg-slate-800/30',
                  strong && 'border-t border-slate-200 dark:border-slate-700',
                  grand && 'border-y-[3px] border-double border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-900',
                )}
                title={drillId ? 'Open in General Ledger' : undefined}
              >
                <td
                  className={cn('px-4 py-1.5', subheader && 'text-xs font-medium italic text-slate-500 dark:text-slate-400', (strong || grand) && 'font-bold uppercase tracking-wide text-slate-900 dark:text-white', subtotal && 'font-semibold text-slate-700 dark:text-slate-200', r.kind === 'line' && 'text-slate-600 dark:text-slate-300')}
                  style={{ paddingLeft: `${1 + r.level * 1.25}rem` }}
                >
                  {drillId ? <span className="border-b border-dashed border-slate-300 dark:border-slate-600">{r.label}</span> : r.label}
                </td>
                <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums', (strong || grand) && 'font-bold', subtotal && 'font-semibold', amtClass(r.current))}>
                  {r.current === undefined ? '' : formatFinancialAmount(r.current, negativeFormat)}
                </td>
                {hasComp && (
                  <>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400', amtClass(r.comparative))}>
                      {r.comparative === undefined ? '' : formatFinancialAmount(r.comparative, negativeFormat)}
                    </td>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums', amtClass(variance))}>
                      {variance === undefined ? '' : formatFinancialAmount(variance, negativeFormat)}
                    </td>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono text-xs tabular-nums', varPct == null ? 'text-slate-400' : varPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {variance === undefined ? '' : formatVariancePercent(varPct)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
