import { X } from 'lucide-react';
import type { NegativeFormat } from '@/types/incomeStatement';
import type { CashFlowPolicy } from '@/types/cashFlow';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Button } from '@/components/ui/Button';

interface Props {
  entityOptions: { value: string; label: string }[];
  entityId: string;
  onEntityId: (id: string) => void;
  periodStart: string;
  onPeriodStart: (d: string) => void;
  periodEnd: string;
  onPeriodEnd: (d: string) => void;
  comparativeStart: string;
  comparativeEnd: string;
  onComparative: (start: string, end: string) => void;
  detail: boolean;
  onDetail: (v: boolean) => void;
  negativeFormat: NegativeFormat;
  onNegativeFormat: (f: NegativeFormat) => void;
  policy: CashFlowPolicy;
  onPolicy: (patch: Partial<CashFlowPolicy>) => void;
}

const di = 'focus-ring h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900';

export function CashFlowToolbar(p: Props) {
  const hasComp = !!(p.comparativeStart && p.comparativeEnd);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">Entity
          <Select className="h-10 w-auto max-w-[200px]" options={p.entityOptions} value={p.entityId} onChange={(e) => p.onEntityId(e.target.value)} aria-label="Entity" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">From
          <input type="date" className={di} value={p.periodStart} onChange={(e) => p.onPeriodStart(e.target.value)} aria-label="Period start" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">To
          <input type="date" className={di} value={p.periodEnd} onChange={(e) => p.onPeriodEnd(e.target.value)} aria-label="Period end" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">Compare
          <input type="date" className={di} value={p.comparativeStart} onChange={(e) => p.onComparative(e.target.value, p.comparativeEnd || e.target.value)} aria-label="Comparative start" />
          <span className="text-slate-300">–</span>
          <input type="date" className={di} value={p.comparativeEnd} onChange={(e) => p.onComparative(p.comparativeStart || e.target.value, e.target.value)} aria-label="Comparative end" />
        </label>
        {hasComp && <Button variant="ghost" size="sm" onClick={() => p.onComparative('', '')}><X className="h-4 w-4" /> Clear</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">Detail
          <Toggle checked={p.detail} onChange={p.onDetail} label="Show line detail" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">Interest paid
          <Select className="h-9 w-auto" options={[{ value: 'operating', label: 'Operating' }, { value: 'financing', label: 'Financing' }]} value={p.policy.interestPaid} onChange={(e) => p.onPolicy({ interestPaid: e.target.value as CashFlowPolicy['interestPaid'] })} aria-label="Interest paid policy" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">Interest received
          <Select className="h-9 w-auto" options={[{ value: 'investing', label: 'Investing' }, { value: 'operating', label: 'Operating' }]} value={p.policy.interestReceived} onChange={(e) => p.onPolicy({ interestReceived: e.target.value as CashFlowPolicy['interestReceived'] })} aria-label="Interest received policy" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">Dividends paid
          <Select className="h-9 w-auto" options={[{ value: 'financing', label: 'Financing' }, { value: 'operating', label: 'Operating' }]} value={p.policy.dividendsPaid} onChange={(e) => p.onPolicy({ dividendsPaid: e.target.value as CashFlowPolicy['dividendsPaid'] })} aria-label="Dividends paid policy" />
        </label>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">Negatives
          <Select className="h-9 w-auto" options={[{ value: 'parentheses', label: '(1,234.00)' }, { value: 'minus', label: '−1,234.00' }]} value={p.negativeFormat} onChange={(e) => p.onNegativeFormat(e.target.value as NegativeFormat)} aria-label="Negative number format" />
        </label>
      </div>
    </div>
  );
}
