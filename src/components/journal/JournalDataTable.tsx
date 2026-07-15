import { useEffect, useRef, useState } from 'react';
import type { JournalEntry, JournalLine } from '@/types/journal';
import { JOURNAL_COLUMNS, type JournalColumnId } from '@/lib/journalColumns';
import { formatAmountCell } from '@/lib/journalSelectors';
import { formatDate, cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { BookOpen } from 'lucide-react';

interface Row {
  entry: JournalEntry;
  line: JournalLine;
  first: boolean;
}

function flatten(entries: JournalEntry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    entry.lines.forEach((line, i) => rows.push({ entry, line, first: i === 0 }));
  }
  return rows;
}

/**
 * Truncated cell text. When the content overflows the (narrow) column, the cell
 * becomes clickable — clicking reveals the full text inline (and hovering shows
 * it as a native tooltip). Non-truncated cells pass the click through to the row.
 */
function TruncText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const canToggle = truncated || expanded;
  return (
    <span
      ref={ref}
      title={!expanded && truncated ? text : undefined}
      onClick={canToggle ? (e) => { e.stopPropagation(); setExpanded((v) => !v); } : undefined}
      className={cn('block', expanded ? 'whitespace-normal break-words' : 'truncate', canToggle && 'cursor-pointer', className)}
    >
      {text}
    </span>
  );
}

interface JournalDataTableProps {
  entries: JournalEntry[];
  columns: Record<JournalColumnId, boolean>;
  selectedIds: Set<string>;
  focusedId: string | null;
  allSelected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onOpenEntry: (id: string) => void;
  onAdd: () => void;
  searchActive: boolean;
}

export function JournalDataTable({
  entries,
  columns,
  selectedIds,
  focusedId,
  allSelected,
  onToggleSelect,
  onToggleAll,
  onOpenEntry,
  onAdd,
  searchActive,
}: JournalDataTableProps) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title={searchActive ? 'No journal entries match your filters.' : 'No journal entries yet.'}
        description={searchActive ? 'Try a different tab, search or date range.' : 'Record your first double-entry transaction to get started.'}
        action={!searchActive ? <Button size="sm" onClick={onAdd}>New journal entry</Button> : undefined}
      />
    );
  }

  const rows = flatten(entries);
  const visible = (id: JournalColumnId): boolean => columns[id];
  const th = (id: JournalColumnId) => {
    const def = JOURNAL_COLUMNS.find((c) => c.id === id);
    if (!def || !visible(id)) return null;
    return (
      <th key={id} className={cn('whitespace-nowrap px-2.5 py-2 font-semibold', def.align === 'right' && 'text-right', def.align === 'center' && 'text-center')}>
        {def.label}
      </th>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs [table-layout:auto] lg:min-w-0">
        <thead className="table-head-sticky">
          <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
            <th className="w-9 px-2.5 py-2">
              <input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all" className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            </th>
            {JOURNAL_COLUMNS.map((c) => th(c.id))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, line, first }) => {
            const selected = selectedIds.has(entry.id);
            const focused = focusedId === entry.id;
            return (
              <tr
                key={line.id}
                onClick={() => onOpenEntry(entry.id)}
                className={cn(
                  'cursor-pointer border-b border-slate-100 transition-colors dark:border-slate-800/60',
                  first && 'border-t border-t-slate-200/70 dark:border-t-slate-800',
                  focused
                    ? 'bg-brand-50/70 dark:bg-brand-500/10'
                    : selected
                      ? 'bg-brand-50/40 dark:bg-brand-500/[0.06]'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40',
                )}
              >
                <td className="px-2.5 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelect(entry.id)}
                    aria-label={`Select ${entry.entryNumber}`}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                </td>
                {visible('date') && <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{first ? formatDate(entry.entryDate) : ''}</td>}
                {visible('journalNo') && (
                  <td className="whitespace-nowrap px-2.5 py-1.5">
                    {first && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenEntry(entry.id); }}
                        className="focus-ring rounded font-medium text-brand-600 hover:underline dark:text-brand-300"
                      >
                        {entry.entryNumber}
                      </button>
                    )}
                  </td>
                )}
                {visible('reference') && <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{first ? <TruncText text={entry.reference || '—'} className="max-w-[5.5rem]" /> : null}</td>}
                {visible('entity') && <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-300"><TruncText text={line.entityName || '—'} className="max-w-[7rem]" /></td>}
                {visible('accountCode') && <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{line.accountCode || '—'}</td>}
                {visible('accountName') && <td className="px-2.5 py-1.5 text-slate-700 dark:text-slate-200">{line.accountName ? <TruncText text={line.accountName} className="max-w-[8.5rem]" /> : <span className="text-red-500">No account</span>}</td>}
                {visible('description') && <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400"><TruncText text={line.memo || line.description || entry.description} className="max-w-[11rem]" /></td>}
                {visible('debit') && <td className="whitespace-nowrap px-2.5 py-1.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatAmountCell(line.debit)}</td>}
                {visible('credit') && <td className="whitespace-nowrap px-2.5 py-1.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatAmountCell(line.credit)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
