import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { TrialBalanceReconciliation } from '@/types/trialBalance';
import { tbAmountAlways } from './tbFormat';
import { cn } from '@/lib/utils';

interface Props {
  reconciliation: TrialBalanceReconciliation;
  base: string;
  exceptionCount: number;
  onReviewDifference: () => void;
}

/** Prominent balanced / out-of-balance status strip for the report. */
export function ReconciliationBanner({ reconciliation, base, exceptionCount, onReviewDifference }: Props) {
  const { balanced, totalDebit, totalCredit, difference } = reconciliation;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3',
        balanced
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10'
          : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10',
      )}
    >
      <div className="flex items-center gap-3">
        {balanced ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        )}
        <div>
          <p className={cn('text-sm font-semibold', balanced ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200')}>
            {balanced ? 'Trial Balance is balanced' : 'Trial Balance is out of balance'}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            <span className="font-mono">Debit {tbAmountAlways(totalDebit)}</span>
            <span className="mx-2 text-slate-400">·</span>
            <span className="font-mono">Credit {tbAmountAlways(totalCredit)}</span>
            <span className="mx-2 text-slate-400">·</span>
            <span className="font-mono">Difference {tbAmountAlways(difference)} {base}</span>
            {!balanced && <span className="ml-2">— review posted journal data and currency conversion.</span>}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onReviewDifference}
        className={cn(
          'focus-ring inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium print:hidden',
          exceptionCount > 0
            ? 'border-amber-300 bg-white text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-300'
            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-transparent dark:text-slate-300',
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        Review difference{exceptionCount > 0 ? ` (${exceptionCount})` : ''}
      </button>
    </div>
  );
}
