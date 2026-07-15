import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { NegativeFormat } from '@/types/incomeStatement';
import { formatFinancialAmount } from '@/components/balance-sheet/bsFormat';
import { cn } from '@/lib/utils';

interface Props {
  netChangeInCash: number;
  openingCash: number;
  calculatedClosingCash: number;
  balanceSheetClosingCash: number;
  reconciliationDifference: number;
  isReconciled: boolean;
  base: string;
  negativeFormat: NegativeFormat;
}

const LIKELY_CAUSES = [
  'Unclassified cash transaction',
  'Incorrect cash-account mapping',
  'Cash-equivalent transfer counted twice',
  'Draft / posted status inconsistency',
  'Opening balance mismatch',
  'Incorrect financing or investing classification',
  'Foreign-exchange movement not classified',
];

export function CashReconciliationPanel({ netChangeInCash, openingCash, calculatedClosingCash, balanceSheetClosingCash, reconciliationDifference, isReconciled, base, negativeFormat }: Props) {
  return (
    <div role="status" className={cn('rounded-xl border px-4 py-3', isReconciled ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {isReconciled ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <AlertTriangle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />}
          <div>
            <p className={cn('text-sm font-semibold', isReconciled ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200')}>
              {isReconciled ? 'Reconciled' : 'Cash-flow reconciliation difference'}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              {isReconciled ? 'Calculated closing cash agrees with the Balance Sheet.' : 'Calculated closing cash does not agree with the Balance Sheet.'}
            </p>
          </div>
        </div>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs tabular-nums">
          <Fig label="Net change" value={netChangeInCash} nf={negativeFormat} />
          <Fig label="Opening cash" value={openingCash} nf={negativeFormat} />
          <Fig label="Calculated closing" value={calculatedClosingCash} nf={negativeFormat} />
          <Fig label={`BS closing (${base})`} value={balanceSheetClosingCash} nf={negativeFormat} />
          <div className="text-right">
            <dt className="text-[10px] uppercase tracking-wide text-slate-400">Difference</dt>
            <dd className={cn('font-bold', isReconciled ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>{formatFinancialAmount(reconciliationDifference, negativeFormat)}</dd>
          </div>
        </dl>
      </div>
      {!isReconciled && (
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

function Fig({ label, value, nf }: { label: string; value: number; nf: NegativeFormat }) {
  return (
    <div className="text-right">
      <dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="font-semibold text-slate-800 dark:text-slate-100">{formatFinancialAmount(value, nf)}</dd>
    </div>
  );
}
