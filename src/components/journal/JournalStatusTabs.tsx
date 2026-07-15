import type { JournalTab, TabCounts } from '@/lib/journalWorkspace';
import { cn } from '@/lib/utils';

const TABS: { id: JournalTab; label: string; countKey: keyof TabCounts }[] = [
  { id: 'all', label: 'All Entries', countKey: 'all' },
  { id: 'draft', label: 'Draft', countKey: 'draft' },
  { id: 'pending', label: 'Pending Approval', countKey: 'pending' },
  { id: 'posted', label: 'Posted', countKey: 'posted' },
];

export function JournalStatusTabs({
  value,
  counts,
  onChange,
}: {
  value: JournalTab;
  counts: TabCounts;
  onChange: (tab: JournalTab) => void;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto" role="tablist">
      {TABS.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              'focus-ring -mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            {t.label}
            {t.id !== 'all' && (
              <span className={cn('ml-1.5 text-xs', active ? 'text-brand-500' : 'text-slate-400')}>
                ({counts[t.countKey]})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
