import { X, ChevronsUpDown, ChevronsDownUp, Lock } from 'lucide-react';
import type { AccountType } from '@/types';
import type { TrialBalanceFilters, TrialBalancePeriod, TrialBalanceViewMode } from '@/types/trialBalance';
import { ACCOUNT_TYPE_OPTIONS } from '@/data/ifrsOptions';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Button } from '@/components/ui/Button';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { cn } from '@/lib/utils';

interface Props {
  viewMode: TrialBalanceViewMode;
  onViewMode: (m: TrialBalanceViewMode) => void;
  grouped: boolean;
  onGrouped: (g: boolean) => void;
  period: TrialBalancePeriod;
  onPeriod: (p: TrialBalancePeriod) => void;
  filters: TrialBalanceFilters;
  onFilters: (patch: Partial<TrialBalanceFilters>) => void;
  onReset: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

const MODES: { id: TrialBalanceViewMode | 'adjusted'; label: string; disabled?: boolean }[] = [
  { id: 'standard', label: 'Standard' },
  { id: 'movement', label: 'Movement' },
  { id: 'adjusted', label: 'Adjusted', disabled: true },
];

export function TrialBalanceToolbar({ viewMode, onViewMode, grouped, onGrouped, period, onPeriod, filters, onFilters, onReset, onExpandAll, onCollapseAll }: Props) {
  const typeOptions = [{ value: 'ALL', label: 'All types' }, ...ACCOUNT_TYPE_OPTIONS];
  const dirty = filters.search !== '' || filters.type !== 'ALL' || filters.active !== 'active' || filters.includeZero;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        {/* View mode */}
        <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={m.disabled}
              onClick={() => !m.disabled && onViewMode(m.id as TrialBalanceViewMode)}
              title={m.disabled ? 'Adjustment classification coming soon' : undefined}
              className={cn(
                'flex items-center gap-1 rounded-md px-3 py-1.5 font-medium transition-colors',
                m.disabled
                  ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                  : viewMode === m.id
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {m.disabled && <Lock className="h-3 w-3" />}
              {m.label}
            </button>
          ))}
        </div>

        <DateRangeFilter
          value={{ dateFrom: period.from, dateTo: period.to }}
          onChange={(v) => onPeriod({ from: v.dateFrom || period.from, to: v.dateTo || period.to })}
        />

        <Select
          className="h-10 w-auto max-w-[180px]"
          options={typeOptions}
          value={filters.type}
          onChange={(e) => onFilters({ type: e.target.value as AccountType | 'ALL' })}
          aria-label="Filter by account type"
        />

        <Select
          className="h-10 w-auto"
          options={[
            { value: 'active', label: 'Active accounts' },
            { value: 'all', label: 'All accounts' },
            { value: 'inactive', label: 'Inactive only' },
          ]}
          value={filters.active}
          onChange={(e) => onFilters({ active: e.target.value as TrialBalanceFilters['active'] })}
          aria-label="Account status filter"
        />

        {dirty && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <X className="h-4 w-4" /> Reset
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Input
            value={filters.search}
            onChange={(e) => onFilters({ search: e.target.value })}
            placeholder="Search account code, name, type, IFRS category…"
            className="h-9"
            aria-label="Search accounts"
          />
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          Grouped
          <Toggle checked={grouped} onChange={onGrouped} label="Group accounts by family" />
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          Zero-balance
          <Toggle checked={filters.includeZero} onChange={(v) => onFilters({ includeZero: v })} label="Include zero-balance accounts" />
        </label>

        {grouped && (
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" onClick={onExpandAll}><ChevronsUpDown className="h-4 w-4" /> Expand all</Button>
            <Button variant="ghost" size="sm" onClick={onCollapseAll}><ChevronsDownUp className="h-4 w-4" /> Collapse all</Button>
          </div>
        )}
      </div>
    </div>
  );
}
