import type { ValidationIssue } from '@/types';
import { useStore } from '@/store/useStore';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export function ValidationPanel({
  issues,
  emptyMessage = 'No validation issues. Your chart of accounts is consistent.',
}: {
  issues: ValidationIssue[];
  emptyMessage?: string;
}) {
  const setActiveView = useStore((s) => s.setActiveView);

  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
          <Icon.Check className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">All checks passed</p>
        <p className="max-w-xs text-xs text-slate-400">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {issues.map((issue) => (
        <li key={issue.id} className="flex items-start gap-3 py-3">
          <span
            className={cn(
              'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              issue.severity === 'error'
                ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
                : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300',
            )}
          >
            {issue.severity === 'error' ? (
              <Icon.Alert className="h-4 w-4" />
            ) : (
              <Icon.Warning className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={issue.severity === 'error' ? 'red' : 'amber'}>
                {issue.severity === 'error' ? 'Error' : 'Warning'}
              </Badge>
              {issue.accountCode && (
                <button
                  type="button"
                  onClick={() => setActiveView('tree')}
                  className="font-mono text-xs font-semibold text-brand-600 hover:underline dark:text-brand-300"
                >
                  {issue.accountCode}
                </button>
              )}
              <span className="text-[11px] uppercase tracking-wide text-slate-400">{issue.rule}</span>
            </div>
            <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{issue.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
