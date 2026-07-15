import { X } from 'lucide-react';
import type { NegativeFormat } from '@/types/incomeStatement';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Button } from '@/components/ui/Button';

interface Props {
  entityOptions: { value: string; label: string }[];
  entityId: string;
  onEntityId: (id: string) => void;
  asOfDate: string;
  onAsOfDate: (d: string) => void;
  comparativeDate: string;
  onComparativeDate: (d: string) => void;
  detail: boolean;
  onDetail: (v: boolean) => void;
  includeZero: boolean;
  onIncludeZero: (v: boolean) => void;
  negativeFormat: NegativeFormat;
  onNegativeFormat: (f: NegativeFormat) => void;
}

const dateInput = 'focus-ring h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900';

export function BalanceSheetToolbar(p: Props) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          Entity
          <Select className="h-10 w-auto max-w-[220px]" options={p.entityOptions} value={p.entityId} onChange={(e) => p.onEntityId(e.target.value)} aria-label="Entity" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          As at
          <input type="date" className={dateInput} value={p.asOfDate} onChange={(e) => p.onAsOfDate(e.target.value)} aria-label="As-at date" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          Compare to
          <input type="date" className={dateInput} value={p.comparativeDate} onChange={(e) => p.onComparativeDate(e.target.value)} aria-label="Comparative date" />
        </label>
        {p.comparativeDate && (
          <Button variant="ghost" size="sm" onClick={() => p.onComparativeDate('')}><X className="h-4 w-4" /> Clear comparison</Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          Account detail
          <Toggle checked={p.detail} onChange={p.onDetail} label="Show individual accounts" />
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          Zero-balance accounts
          <Toggle checked={p.includeZero} onChange={p.onIncludeZero} label="Include zero-balance accounts" />
        </label>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          Negatives
          <Select className="h-9 w-auto" options={[{ value: 'parentheses', label: '(1,234.00)' }, { value: 'minus', label: '−1,234.00' }]} value={p.negativeFormat} onChange={(e) => p.onNegativeFormat(e.target.value as NegativeFormat)} aria-label="Negative number format" />
        </label>
      </div>
    </div>
  );
}
