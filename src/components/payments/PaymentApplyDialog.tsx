import { useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';
import type { Payment } from '@/types/payment';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { getEligibleBillsForPayment, autoAllocatePayment } from '@/lib/paymentAllocations';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

/** Apply a posted payment's unapplied balance (advance) to open bills — subledger only, no new cash journal. */
export function PaymentApplyDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const bills = useBillStore((s) => s.bills);
  const applyPaymentToBills = usePaymentStore((s) => s.applyPaymentToBills);
  const { notify } = useToast();

  const eligible = useMemo(
    () => (payment.supplierId ? getEligibleBillsForPayment(bills, { entityId: payment.entityId, supplierId: payment.supplierId, currency: payment.currency }) : []),
    [bills, payment.supplierId, payment.entityId, payment.currency],
  );
  const [alloc, setAlloc] = useState<Record<string, number>>(() => Object.fromEntries(autoAllocatePayment(eligible, payment.unappliedAmount, 'oldest-due')));
  const money = (n: number): string => formatCurrency(n, payment.currency);
  const total = Math.round(Object.values(alloc).reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;

  const submit = (): void => {
    const allocations = Object.entries(alloc).filter(([, a]) => Number(a) > 0).map(([billId, amount]) => ({ billId, amount: Number(amount) }));
    const res = applyPaymentToBills(payment.id, allocations);
    if (res.ok) { notify('Payment applied to bills.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not apply the payment.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Apply payment — {payment.paymentNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Unapplied {money(payment.unappliedAmount)} · allocating {money(total)}</p>
        {eligible.length === 0 ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">This supplier has no open bills to apply the payment to.</p>
        ) : (
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                <tr><th className="px-2 py-2 text-left">Bill</th><th className="px-2 py-2 text-right">Outstanding</th><th className="px-2 py-2 text-right">Allocate</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {eligible.map((bill) => {
                  const val = alloc[bill.id] ?? 0;
                  const over = Number(val) > bill.balanceDue + 0.0001;
                  return (
                    <tr key={bill.id}>
                      <td className="px-2 py-1.5 font-mono">{bill.billNumber}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(bill.balanceDue)}</td>
                      <td className="px-2 py-1.5 w-28"><Input type="number" step="0.01" value={val} onChange={(e) => setAlloc((p) => ({ ...p, [bill.id]: Number(e.target.value) }))} className={cx('h-8 text-right', over && 'border-red-400 text-red-600')} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={total <= 0 || total > payment.unappliedAmount + 0.005} onClick={submit}><Link2 className="h-4 w-4" /> Apply</Button>
        </div>
      </div>
    </div>
  );
}
