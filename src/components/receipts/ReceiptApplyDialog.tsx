import { useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';
import type { Receipt } from '@/types/receipt';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useReceiptStore } from '@/store/receiptStore';
import { getEligibleInvoicesForReceipt, autoAllocateReceipt } from '@/lib/receiptAllocations';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

/** Apply a posted receipt's unapplied balance to open invoices (subledger — no new cash journal). */
export function ReceiptApplyDialog({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  const invoices = useInvoiceStore((s) => s.invoices);
  const applyReceiptToInvoices = useReceiptStore((s) => s.applyReceiptToInvoices);
  const { notify } = useToast();

  const eligible = useMemo(
    () => (receipt.customerId ? getEligibleInvoicesForReceipt(invoices, { entityId: receipt.entityId, customerId: receipt.customerId, currency: receipt.currency }) : []),
    [invoices, receipt.customerId, receipt.entityId, receipt.currency],
  );
  const [alloc, setAlloc] = useState<Record<string, number>>(() => Object.fromEntries(autoAllocateReceipt(eligible, receipt.unappliedAmount, 'oldest-due')));
  const money = (n: number): string => formatCurrency(n, receipt.currency);
  const total = Math.round(Object.values(alloc).reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;

  const submit = (): void => {
    const allocations = Object.entries(alloc).filter(([, a]) => Number(a) > 0).map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount) }));
    const res = applyReceiptToInvoices(receipt.id, allocations);
    if (res.ok) { notify('Receipt applied to invoices.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not apply the receipt.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Apply receipt — {receipt.receiptNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Unapplied {money(receipt.unappliedAmount)} · allocating {money(total)}</p>
        {eligible.length === 0 ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">This customer has no open invoices to apply the receipt to.</p>
        ) : (
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                <tr><th className="px-2 py-2 text-left">Invoice</th><th className="px-2 py-2 text-right">Outstanding</th><th className="px-2 py-2 text-right">Allocate</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {eligible.map((inv) => {
                  const val = alloc[inv.id] ?? 0;
                  const over = Number(val) > inv.balanceDue + 0.0001;
                  return (
                    <tr key={inv.id}>
                      <td className="px-2 py-1.5 font-mono">{inv.invoiceNumber}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(inv.balanceDue)}</td>
                      <td className="px-2 py-1.5 w-28"><Input type="number" step="0.01" value={val} onChange={(e) => setAlloc((p) => ({ ...p, [inv.id]: Number(e.target.value) }))} className={cx('h-8 text-right', over && 'border-red-400 text-red-600')} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={total <= 0 || total > receipt.unappliedAmount + 0.005} onClick={submit}><Link2 className="h-4 w-4" /> Apply</Button>
        </div>
      </div>
    </div>
  );
}
