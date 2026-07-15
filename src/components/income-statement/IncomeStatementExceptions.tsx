import { X, AlertOctagon, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { IncomeStatementException } from '@/types/incomeStatement';
import { isAmount } from './isFormat';
import { cn } from '@/lib/utils';

interface Props {
  exceptions: IncomeStatementException[];
  onClose: () => void;
  onReviewAccount: (accountCode: string) => void;
}

/** Read-only diagnostics: P&L accounts with activity but missing mappings. */
export function IncomeStatementExceptions({ exceptions, onClose, onReviewAccount }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md animate-[slideIn_0.2s_ease-out] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Mapping exceptions</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Accounts with period activity but incomplete IFRS mapping.</p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close exceptions panel">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
          {exceptions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-10 text-center dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <ShieldCheck className="h-8 w-8 text-emerald-500" />
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">All accounts are mapped</p>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">Every profit-or-loss account with activity has a complete IFRS mapping.</p>
            </div>
          ) : (
            exceptions.map((ex) => {
              const Icon = ex.severity === 'error' ? AlertOctagon : AlertTriangle;
              const tone = ex.severity === 'error' ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
              return (
                <div key={ex.id} className={cn('rounded-xl border p-3', tone)}>
                  <div className="flex items-start gap-2.5">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px]">{ex.accountCode}</span>
                        <span className="font-mono text-[11px] tabular-nums">{isAmount(ex.amount)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-700 dark:text-slate-200">{ex.message}</p>
                      <button type="button" onClick={() => onReviewAccount(ex.accountCode)} className="focus-ring mt-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
                        Review account →
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
