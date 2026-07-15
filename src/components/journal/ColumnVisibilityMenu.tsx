import { Columns3, RotateCcw } from 'lucide-react';
import { Dropdown, MenuLabel, MenuSeparator } from '@/components/ui/Dropdown';
import { Toggle } from '@/components/ui/Toggle';
import { JOURNAL_COLUMNS } from '@/lib/journalColumns';
import { useJournalView } from '@/store/journalViewStore';

export function ColumnVisibilityMenu() {
  const columns = useJournalView((s) => s.columns);
  const toggleColumn = useJournalView((s) => s.toggleColumn);
  const resetColumns = useJournalView((s) => s.resetColumns);

  return (
    <Dropdown
      label="Column visibility"
      closeOnClick={false}
      panelClassName="w-60"
      trigger={(o) => (
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          data-open={o}
          title="Columns"
        >
          <Columns3 className="h-4 w-4" />
        </span>
      )}
    >
      <MenuLabel>Columns</MenuLabel>
      <div className="max-h-72 overflow-y-auto">
        {JOURNAL_COLUMNS.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5">
            <span className="text-sm text-slate-700 dark:text-slate-200">{c.label}</span>
            <Toggle
              checked={columns[c.id]}
              disabled={c.required}
              onChange={() => toggleColumn(c.id)}
              label={`Toggle ${c.label}`}
            />
          </div>
        ))}
      </div>
      <MenuSeparator />
      <button
        type="button"
        onClick={resetColumns}
        className="focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <RotateCcw className="h-4 w-4 text-slate-400" /> Reset columns
      </button>
    </Dropdown>
  );
}
