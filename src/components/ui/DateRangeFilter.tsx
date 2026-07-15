import { CalendarDays, ChevronDown } from 'lucide-react';
import { Dropdown } from './Dropdown';
import { cn } from '@/lib/utils';

export interface DateRangeValue {
  dateFrom: string;
  dateTo: string;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Named quick-ranges resolved against today. */
function presets(): { label: string; range: DateRangeValue }[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const startOfMonth = new Date(y, m, 1);
  const endOfMonth = new Date(y, m + 1, 0);
  const startOfPrevMonth = new Date(y, m - 1, 1);
  const endOfPrevMonth = new Date(y, m, 0);
  const q = Math.floor(m / 3);
  const startOfQuarter = new Date(y, q * 3, 1);
  return [
    { label: 'All time', range: { dateFrom: '', dateTo: '' } },
    { label: 'This month', range: { dateFrom: iso(startOfMonth), dateTo: iso(endOfMonth) } },
    { label: 'Last month', range: { dateFrom: iso(startOfPrevMonth), dateTo: iso(endOfPrevMonth) } },
    { label: 'This quarter', range: { dateFrom: iso(startOfQuarter), dateTo: iso(endOfMonth) } },
    { label: 'Year to date', range: { dateFrom: iso(new Date(y, 0, 1)), dateTo: iso(now) } },
  ];
}

function label(value: DateRangeValue): string {
  if (!value.dateFrom && !value.dateTo) return 'All dates';
  if (value.dateFrom && value.dateTo) return `${value.dateFrom} → ${value.dateTo}`;
  if (value.dateFrom) return `From ${value.dateFrom}`;
  return `Until ${value.dateTo}`;
}

export function DateRangeFilter({
  value,
  onChange,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
}) {
  const active = !!value.dateFrom || !!value.dateTo;
  return (
    <Dropdown
      align="left"
      closeOnClick={false}
      panelClassName="w-72 p-3"
      label="Filter by date range"
      trigger={(open) => (
        <span
          className={cn(
            'flex h-10 items-center gap-2 rounded-lg border px-3 text-sm transition-colors',
            active
              ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-200'
              : 'border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
            open && 'ring-2 ring-brand-500/30',
          )}
        >
          <CalendarDays className="h-4 w-4 text-slate-400" />
          <span className="max-w-[180px] truncate">{label(value)}</span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </span>
      )}
    >
      <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        Quick ranges
      </p>
      <div className="grid grid-cols-2 gap-1">
        {presets().map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(p.range)}
            className="focus-ring rounded-md px-2 py-1.5 text-left text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <label className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          From
          <input
            type="date"
            value={value.dateFrom}
            onChange={(e) => onChange({ ...value, dateFrom: e.target.value })}
            className="focus-ring rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          To
          <input
            type="date"
            value={value.dateTo}
            onChange={(e) => onChange({ ...value, dateTo: e.target.value })}
            className="focus-ring rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
      </div>
    </Dropdown>
  );
}
