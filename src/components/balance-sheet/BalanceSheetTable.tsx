import { AlertTriangle } from 'lucide-react';
import type { BalanceSheetLine } from '@/types/balanceSheet';
import type { NegativeFormat } from '@/types/incomeStatement';
import { formatFinancialAmount, formatVariancePercent } from './bsFormat';
import { cn } from '@/lib/utils';

interface Props {
  lines: BalanceSheetLine[];
  hasComparative: boolean;
  negativeFormat: NegativeFormat;
  onDrill: (accountId: string) => void;
}

function amtClass(n: number): string {
  return n < 0 ? 'text-red-600 dark:text-red-400' : '';
}

export function BalanceSheetTable({ lines, hasComparative, negativeFormat, onDrill }: Props) {
  const cols = 1 + 1 + (hasComparative ? 3 : 0);
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:bg-slate-800/80 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-4 py-2 text-left font-semibold">Account / description</th>
            <th scope="col" className="px-4 py-2 text-right font-semibold">Current period</th>
            {hasComparative && (
              <>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Comparative</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Variance</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Var %</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            if (l.lineType === 'spacer') return <tr key={l.id}><td colSpan={cols} className="py-2" /></tr>;

            if (l.lineType === 'section' || (l.lineType === 'total' && l.currentAmount === 0)) {
              // section heading or major header (Assets / Equity and liabilities)
              const major = l.lineType === 'total';
              return (
                <tr key={l.id} className={cn(major ? 'bg-slate-800 text-white dark:bg-slate-700' : 'bg-slate-100/70 dark:bg-slate-800/40')}>
                  <td colSpan={cols} className={cn('px-4', major ? 'py-2 text-xs font-bold uppercase tracking-widest' : 'py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300')}>{l.label}</td>
                </tr>
              );
            }

            const isAccount = l.lineType === 'account';
            const isGroup = l.lineType === 'group';
            const isSubtotal = l.lineType === 'subtotal';
            const isTotal = l.lineType === 'total';
            const isGrand = l.lineType === 'grand-total';
            const drillId = isAccount && !l.isSynthetic ? l.accountIds?.[0] : undefined;

            return (
              <tr
                key={l.id}
                onClick={drillId ? () => onDrill(drillId) : undefined}
                className={cn(
                  drillId && 'cursor-pointer hover:bg-brand-50/50 dark:hover:bg-brand-500/5',
                  (isSubtotal || isTotal) && 'bg-slate-50/60 dark:bg-slate-800/30',
                  isGrand && 'border-y-[3px] border-double border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-900',
                  isTotal && l.emphasis === 'strong' && 'border-t-2 border-slate-300 dark:border-slate-600',
                )}
                title={drillId ? 'Open in General Ledger' : undefined}
              >
                <td
                  className={cn(
                    'px-4 py-1.5',
                    isGroup && 'font-medium text-slate-700 dark:text-slate-200',
                    isAccount && 'text-slate-600 dark:text-slate-300',
                    (isTotal || isGrand) && 'font-bold uppercase tracking-wide text-slate-900 dark:text-white',
                    isSubtotal && 'font-semibold text-slate-700 dark:text-slate-200',
                  )}
                  style={{ paddingLeft: `${1 + l.level * 1.25}rem` }}
                >
                  <span className="inline-flex items-center gap-2">
                    {drillId ? <span className="border-b border-dashed border-slate-300 dark:border-slate-600">{l.label}</span> : l.label}
                    {l.isAbnormal && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" title={`Abnormal ${l.abnormalSide} balance`}>
                        <AlertTriangle className="h-3 w-3" /> Abnormal {l.abnormalSide === 'debit' ? 'Dr' : 'Cr'}
                      </span>
                    )}
                  </span>
                </td>
                <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums', (isTotal || isGrand) && 'font-bold', isSubtotal && 'font-semibold', amtClass(l.currentAmount))}>
                  {l.lineType === 'group' && l.currentAmount === 0 && !l.accountIds ? '' : formatFinancialAmount(l.currentAmount, negativeFormat)}
                </td>
                {hasComparative && (
                  <>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400', amtClass(l.comparativeAmount ?? 0))}>
                      {l.comparativeAmount === undefined ? '' : formatFinancialAmount(l.comparativeAmount, negativeFormat)}
                    </td>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums', amtClass(l.variance ?? 0))}>
                      {l.variance === undefined ? '' : formatFinancialAmount(l.variance, negativeFormat)}
                    </td>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono text-xs tabular-nums', l.variancePercent == null ? 'text-slate-400' : l.variancePercent >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {l.comparativeAmount === undefined ? '' : formatVariancePercent(l.variancePercent)}
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
