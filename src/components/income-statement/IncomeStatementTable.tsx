import type { IncomeStatementLine, NegativeFormat } from '@/types/incomeStatement';
import { isAmount, isPercent, isVariancePercent } from './isFormat';
import { cn } from '@/lib/utils';

interface Props {
  lines: IncomeStatementLine[];
  hasComparative: boolean;
  showPercent: boolean;
  negativeFormat: NegativeFormat;
  onDrill: (accountId: string) => void;
}

function amountClass(n: number): string {
  return n < 0 ? 'text-red-600 dark:text-red-400' : '';
}

export function IncomeStatementTable({ lines, hasComparative, showPercent, negativeFormat, onDrill }: Props) {
  const cols = 1 + 1 + (hasComparative ? 3 : 0) + (showPercent ? 1 : 0);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:bg-slate-800/80 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-4 py-2 text-left font-semibold">Line item</th>
            <th scope="col" className="px-4 py-2 text-right font-semibold">Current period</th>
            {hasComparative && (
              <>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Comparative</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Variance</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Var %</th>
              </>
            )}
            {showPercent && <th scope="col" className="px-4 py-2 text-right font-semibold">% of rev.</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            if (l.lineType === 'spacer') {
              return <tr key={l.id}><td colSpan={cols} className="py-1.5" /></tr>;
            }
            if (l.lineType === 'section') {
              return (
                <tr key={l.id} className="bg-slate-100/60 dark:bg-slate-800/40">
                  <td colSpan={cols} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">{l.label}</td>
                </tr>
              );
            }

            const isAccount = l.lineType === 'account';
            const isSubtotal = l.lineType === 'subtotal';
            const strong = l.emphasis === 'strong';
            const final = l.emphasis === 'final';
            const drillId = isAccount && l.accountIds?.[0];

            return (
              <tr
                key={l.id}
                onClick={drillId ? () => onDrill(drillId) : undefined}
                className={cn(
                  drillId && 'cursor-pointer hover:bg-brand-50/50 dark:hover:bg-brand-500/5',
                  isSubtotal && 'bg-slate-50/60 dark:bg-slate-800/30',
                  final && 'border-y-2 border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900',
                  strong && 'border-t border-slate-200 dark:border-slate-700',
                )}
                title={drillId ? 'Open in General Ledger' : undefined}
              >
                <td
                  className={cn(
                    'px-4 py-1.5',
                    l.lineType === 'category' && 'text-slate-600 dark:text-slate-300',
                    isAccount && 'text-slate-500 dark:text-slate-400',
                    (strong || final) && 'font-bold text-slate-900 dark:text-white',
                    isSubtotal && !strong && !final && 'font-semibold text-slate-700 dark:text-slate-200',
                  )}
                  style={{ paddingLeft: `${1 + l.level * 1.25}rem` }}
                >
                  {isAccount && l.accountIds?.[0] ? <span className="border-b border-dashed border-slate-300 dark:border-slate-600">{l.label}</span> : l.label}
                </td>
                <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums', (strong || final) && 'font-bold', isSubtotal && 'font-semibold', amountClass(l.currentAmount))}>
                  {isAmount(l.currentAmount, negativeFormat)}
                </td>
                {hasComparative && (
                  <>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400', amountClass(l.comparativeAmount ?? 0))}>
                      {l.comparativeAmount === undefined ? '' : isAmount(l.comparativeAmount, negativeFormat)}
                    </td>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono tabular-nums', amountClass(l.variance ?? 0))}>
                      {l.variance === undefined ? '' : isAmount(l.variance, negativeFormat)}
                    </td>
                    <td className={cn('whitespace-nowrap px-4 py-1.5 text-right font-mono text-xs tabular-nums', l.variancePercent == null ? 'text-slate-400' : (l.variancePercent >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'))}>
                      {l.variancePercent === undefined ? '' : isVariancePercent(l.variancePercent)}
                    </td>
                  </>
                )}
                {showPercent && (
                  <td className="whitespace-nowrap px-4 py-1.5 text-right font-mono text-xs tabular-nums text-slate-400">
                    {l.percentageOfRevenue === undefined ? '' : isPercent(l.percentageOfRevenue)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
