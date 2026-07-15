import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CostCenter, CostCenterAssignment } from '@/types/costCenter';
import { allocateAmountAcrossCostCenters, validateCostCenterSplit } from '@/lib/costCenterAllocation';
import { roundMoney } from '@/lib/journalValidation';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CostCenterPicker } from './CostCenterPicker';

interface Props {
  amount: number;
  currency?: string;
  assignments: CostCenterAssignment[];
  onChange: (assignments: CostCenterAssignment[]) => void;
  costCenters: CostCenter[];
  postingDate?: string;
  disabled?: boolean;
}

type Mode = 'percentage' | 'fixed-amount';

/**
 * Reusable split-allocation editor (§6). Distributes one source line amount across
 * multiple cost centers by percentage or fixed amount, with a live remaining
 * indicator and exact-reconciliation validation. Shared by journal, invoice,
 * credit-note, bill and supplier-credit line editors.
 */
export function CostCenterSplitEditor({ amount, currency = 'USD', assignments, onChange, costCenters, postingDate, disabled }: Props) {
  const initialMode: Mode = assignments.some((a) => a.amount !== undefined && a.percentage === undefined) ? 'fixed-amount' : 'percentage';
  const [mode, setMode] = useState<Mode>(initialMode);
  const money = (n: number): string => formatCurrency(n, currency);

  const rows = assignments.length > 0 ? assignments : [{ costCenterId: '', percentage: 100 }];
  const setRows = (next: CostCenterAssignment[]): void => onChange(next);

  const total = mode === 'percentage'
    ? roundMoney(rows.reduce((s, r) => s + (Number(r.percentage) || 0), 0))
    : roundMoney(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const target = mode === 'percentage' ? 100 : roundMoney(amount);
  const remaining = roundMoney(target - total);
  const issues = validateCostCenterSplit(amount, rows);
  const preview = allocateAmountAcrossCostCenters(amount, rows);

  const update = (idx: number, patch: Partial<CostCenterAssignment>): void => setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addRow = (): void => setRows([...rows, mode === 'percentage' ? { costCenterId: '', percentage: 0 } : { costCenterId: '', amount: 0 }]);
  const removeRow = (idx: number): void => setRows(rows.filter((_, i) => i !== idx));
  const switchMode = (m: Mode): void => {
    setMode(m);
    // Reset the value dimension so the two modes never mix on one line.
    setRows(rows.map((r) => (m === 'percentage' ? { costCenterId: r.costCenterId, percentage: r.percentage ?? 0 } : { costCenterId: r.costCenterId, amount: r.amount ?? 0 })));
  };

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
          {(['percentage', 'fixed-amount'] as Mode[]).map((m) => (
            <button key={m} type="button" disabled={disabled} onClick={() => switchMode(m)} className={cx('rounded-md px-2 py-1', mode === m ? 'bg-brand-500 text-white' : 'text-slate-600 dark:text-slate-300')}>{m === 'percentage' ? 'Percentage' : 'Fixed amount'}</button>
          ))}
        </div>
        <span className={cx('text-xs font-medium', Math.abs(remaining) < 0.005 ? 'text-green-600' : 'text-amber-600')}>
          {mode === 'percentage' ? `Remaining ${remaining}%` : `Remaining ${money(remaining)}`}
        </span>
      </div>

      {rows.map((r, idx) => {
        const line = preview.lines[idx];
        return (
          <div key={idx} className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><CostCenterPicker value={r.costCenterId} onChange={(id) => update(idx, { costCenterId: id })} costCenters={costCenters} postingDate={postingDate} disabled={disabled} allowClear={false} /></div>
            {mode === 'percentage' ? (
              <Input type="number" step="0.01" value={r.percentage ?? 0} onChange={(e) => update(idx, { percentage: Number(e.target.value) })} disabled={disabled} className="h-9 w-20 text-right" />
            ) : (
              <Input type="number" step="0.01" value={r.amount ?? 0} onChange={(e) => update(idx, { amount: Number(e.target.value) })} disabled={disabled} className="h-9 w-24 text-right" />
            )}
            <span className="w-24 shrink-0 text-right font-mono text-xs text-slate-500">{line ? money(line.amount) : '—'}</span>
            <button type="button" onClick={() => removeRow(idx)} disabled={disabled || rows.length <= 1} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800"><Trash2 className="h-4 w-4" /></button>
          </div>
        );
      })}

      {!disabled && <Button type="button" variant="ghost" size="sm" onClick={addRow}><Plus className="h-4 w-4" /> Add cost center</Button>}
      {issues.length > 0 && <p className="text-xs text-amber-600">{issues[0]!.message}</p>}
    </div>
  );
}
