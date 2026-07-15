import { Wand2, Eraser } from 'lucide-react';
import type { Bill } from '@/types/bill';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface Props {
  bills: Bill[];
  currency: string;
  alloc: Record<string, number>;
  onChange: (billId: string, value: number) => void;
  onAutoAllocate?: () => void;
  onClear?: () => void;
  readOnly?: boolean;
}

/** Allocate a supplier payment across the supplier's open bills (oldest-due first). */
export function PaymentAllocationTable({ bills, currency, alloc, onChange, onAutoAllocate, onClear, readOnly }: Props) {
  const money = (n: number): string => formatCurrency(n, currency);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Allocate to open bills</h3>
        {!readOnly && (onAutoAllocate || onClear) && (
          <div className="flex gap-2">
            {onAutoAllocate && <Button type="button" variant="outline" size="sm" onClick={onAutoAllocate}><Wand2 className="h-4 w-4" /> Auto-allocate (oldest due)</Button>}
            {onClear && <Button type="button" variant="ghost" size="sm" onClick={onClear}><Eraser className="h-4 w-4" /> Clear</Button>}
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
            <tr>
              <th className="px-2 py-2 text-left">Bill</th>
              <th className="px-2 py-2 text-left">Supplier inv.</th>
              <th className="px-2 py-2 text-left">Due</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-right">Outstanding</th>
              <th className="px-2 py-2 text-right">Allocate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {bills.length === 0 ? (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-slate-400">No open bills for this supplier.</td></tr>
            ) : bills.map((bill) => {
              const val = alloc[bill.id] ?? 0;
              const over = Number(val) > bill.balanceDue + 0.0001;
              return (
                <tr key={bill.id}>
                  <td className="px-2 py-1.5 font-mono">{bill.billNumber}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">{bill.supplierInvoiceNumber || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-500">{bill.dueDate}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-500">{money(bill.grandTotal)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(bill.balanceDue)}</td>
                  <td className="px-2 py-1.5 w-28"><Input type="number" step="0.01" value={val} onChange={(e) => onChange(bill.id, Number(e.target.value))} disabled={readOnly} className={cx('h-8 text-right', over && 'border-red-400 text-red-600')} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
