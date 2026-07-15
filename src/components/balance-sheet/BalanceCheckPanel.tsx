import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { NegativeFormat } from '@/types/incomeStatement';
import { formatFinancialAmount } from './bsFormat';
import { cn } from '@/lib/utils';

interface Props {
  totalAssets: number;
  totalEquityAndLiabilities: number;
  difference: number;
  isBalanced: boolean;
  base: string;
  negativeFormat: NegativeFormat;
}

const LIKELY_CAUSES = [
  'Unbalanced journal entry',
  'Incorrect account classification',
  'Missing opening balance',
  'Revenue or expense closing issue',
  'Draft / posted status inconsistency',
  'Incorrect normal-balance treatment',
];

export function BalanceCheckPanel({ totalAssets, totalEquityAndLiabilities, difference, isBalanced, base, negativeFormat }: Props) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-xl border px-4 py-3',
        isBalanced ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {isBalanced ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <AlertTriangle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />}
          <div>
            <p className={cn('text-sm font-semibold', isBalanced ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200')}>
              {isBalanced ? 'Balanced' : 'Out of balance'}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300">{isBalanced ? 'Assets = Equity + Liabilities' : 'Assets do not equal Equity + Liabilities'}</p>
          </div>
        </div>
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-xs tabular-nums">
          <div className="text-right">
            <dt className="text-[10px] uppercase tracking-wide text-slate-400">Total assets</dt>
            <dd className="font-semibold text-slate-800 dark:text-slate-100">{formatFinancialAmount(totalAssets, negativeFormat)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-[10px] uppercase tracking-wide text-slate-400">Total equity &amp; liabilities</dt>
            <dd className="font-semibold text-slate-800 dark:text-slate-100">{formatFinancialAmount(totalEquityAndLiabilities, negativeFormat)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-[10px] uppercase tracking-wide text-slate-400">Difference ({base})</dt>
            <dd className={cn('font-bold', isBalanced ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>{formatFinancialAmount(difference, negativeFormat)}</dd>
          </div>
        </dl>
      </div>

      {!isBalanced && (
        <div className="mt-3 border-t border-red-200 pt-2 dark:border-red-500/30">
          <p className="text-xs font-medium text-red-800 dark:text-red-200">Likely causes to review:</p>
          <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-red-700 dark:text-red-300 sm:grid-cols-2">
            {LIKELY_CAUSES.map((c) => <li key={c} className="flex items-center gap-1.5"><span className="h-1 w-1 rounded-full bg-red-400" /> {c}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
