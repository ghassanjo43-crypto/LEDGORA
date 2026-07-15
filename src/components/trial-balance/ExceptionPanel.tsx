import { X, AlertOctagon, AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import type { TrialBalanceException, TbSeverity } from '@/types/trialBalance';
import { cn } from '@/lib/utils';

interface Props {
  exceptions: TrialBalanceException[];
  onClose: () => void;
  onAction: (exception: TrialBalanceException) => void;
}

const SEVERITY: Record<TbSeverity, { icon: typeof Info; ring: string; text: string; label: string }> = {
  error: { icon: AlertOctagon, ring: 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10', text: 'text-red-700 dark:text-red-300', label: 'Error' },
  warning: { icon: AlertTriangle, ring: 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10', text: 'text-amber-700 dark:text-amber-300', label: 'Warning' },
  info: { icon: Info, ring: 'border-sky-200 bg-sky-50 dark:border-sky-500/30 dark:bg-sky-500/10', text: 'text-sky-700 dark:text-sky-300', label: 'Info' },
};

const ACTION_LABEL: Record<NonNullable<TrialBalanceException['action']>, string> = {
  journal: 'Open journal',
  'general-ledger': 'View ledger',
  tree: 'View account',
  mapping: 'View mapping',
};

/** Read-only diagnostics slide-over. The Trial Balance itself is never editable. */
export function ExceptionPanel({ exceptions, onClose, onAction }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md animate-[slideIn_0.2s_ease-out] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Data exceptions</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Diagnostics only — review these in the source records.</p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close exceptions panel">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
          {exceptions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-10 text-center dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <ShieldCheck className="h-8 w-8 text-emerald-500" />
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">No exceptions detected</p>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">The trial balance reconciles and every posting account is valid.</p>
            </div>
          ) : (
            exceptions.map((ex) => {
              const meta = SEVERITY[ex.severity];
              const Icon = meta.icon;
              return (
                <div key={ex.id} className={cn('rounded-xl border p-3', meta.ring)}>
                  <div className="flex items-start gap-2.5">
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.text)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('text-[10px] font-bold uppercase tracking-wide', meta.text)}>{meta.label}</span>
                        <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{ex.reference}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-700 dark:text-slate-200">{ex.message}</p>
                      {ex.action && (
                        <button type="button" onClick={() => onAction(ex)} className="focus-ring mt-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
                          {ACTION_LABEL[ex.action]} →
                        </button>
                      )}
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
