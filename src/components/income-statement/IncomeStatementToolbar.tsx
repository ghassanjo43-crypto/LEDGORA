import { Lock } from 'lucide-react';
import type { ComparisonMode, DetailLevel, NegativeFormat, PresentationMode, StatementPeriod } from '@/types/incomeStatement';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { cn } from '@/lib/utils';

interface Props {
  presentation: PresentationMode;
  onPresentation: (p: PresentationMode) => void;
  detail: DetailLevel;
  onDetail: (d: DetailLevel) => void;
  comparison: ComparisonMode;
  onComparison: (c: ComparisonMode) => void;
  period: StatementPeriod;
  onPeriod: (p: StatementPeriod) => void;
  showPercent: boolean;
  onShowPercent: (v: boolean) => void;
  includeZero: boolean;
  onIncludeZero: (v: boolean) => void;
  negativeFormat: NegativeFormat;
  onNegativeFormat: (f: NegativeFormat) => void;
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; disabled?: boolean; icon?: boolean }[] }) {
  return (
    <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          onClick={() => !o.disabled && onChange(o.id)}
          className={cn(
            'flex items-center gap-1 rounded-md px-3 py-1.5 font-medium transition-colors',
            o.disabled ? 'cursor-not-allowed text-slate-300 dark:text-slate-600' : value === o.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200',
          )}
        >
          {o.icon && <Lock className="h-3 w-3" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function IncomeStatementToolbar(p: Props) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={p.presentation}
          onChange={p.onPresentation}
          options={[{ id: 'IAS1', label: 'IAS 1' }, { id: 'IFRS18', label: 'IFRS 18' }]}
        />
        <Segmented
          value={p.detail}
          onChange={p.onDetail}
          options={[{ id: 'summary', label: 'Summary' }, { id: 'standard', label: 'Standard' }, { id: 'detailed', label: 'Detailed' }]}
        />
        <DateRangeFilter
          value={{ dateFrom: p.period.from, dateTo: p.period.to }}
          onChange={(v) => p.onPeriod({ from: v.dateFrom || p.period.from, to: v.dateTo || p.period.to })}
        />
        <Select
          className="h-10 w-auto"
          options={[
            { value: 'none', label: 'No comparison' },
            { value: 'previous-period', label: 'Previous period' },
            { value: 'previous-month', label: 'Previous month' },
            { value: 'previous-quarter', label: 'Previous quarter' },
            { value: 'previous-year', label: 'Previous year' },
            { value: 'previous-ytd', label: 'Previous year-to-date' },
          ]}
          value={p.comparison}
          onChange={(e) => p.onComparison(e.target.value as ComparisonMode)}
          aria-label="Comparative period"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          % of revenue
          <Toggle checked={p.showPercent} onChange={p.onShowPercent} label="Show percentage of revenue" />
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          Zero-value lines
          <Toggle checked={p.includeZero} onChange={p.onIncludeZero} label="Include zero-value lines" />
        </label>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          Negatives
          <Select
            className="h-9 w-auto"
            options={[{ value: 'parentheses', label: '(1,234.00)' }, { value: 'minus', label: '−1,234.00' }]}
            value={p.negativeFormat}
            onChange={(e) => p.onNegativeFormat(e.target.value as NegativeFormat)}
            aria-label="Negative number format"
          />
        </label>
      </div>
    </div>
  );
}
