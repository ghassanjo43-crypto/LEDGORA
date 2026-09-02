/**
 * Move a posted payment onto different bills — all of it, or none of it.
 *
 * ══ Why there is no "unallocate" here ════════════════════════════════════════
 *
 * This dialog can only submit a set that totals the payment exactly. Detaching
 * an allocation and leaving the rest would create an unapplied balance, and the
 * product has no account for one: no controlled supplier-advances mapping and
 * no refund workflow. So the two complete corrections are this — a full
 * replacement — and reversing the payment. The dialog says so, and the button
 * stays disabled until the numbers agree.
 *
 * The bill the payment currently settles is INCLUDED in the list with its own
 * allocation added back to its outstanding amount, because that is what will be
 * true the instant the old rows are superseded. Leaving it out would make the
 * only obvious correction — "move some of it" — impossible to express.
 */
import { useMemo, useState } from 'react';
import { Link2, AlertTriangle } from 'lucide-react';
import type { Payment } from '@/types/payment';
import { useServerPayments, UNALLOCATE_UNSUPPORTED } from '@/services/payments/paymentBackend';
import { paymentActions, type AllocationDraft } from '@/services/payments/paymentActions';
import { formatCurrency } from '@/lib/money';
import { roundToCompanyPrecision } from '@/lib/monetaryPrecision';
import { cn as cx } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

export function DurableReallocateDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const { notify } = useToast();
  const outstanding = useServerPayments((s) => s.outstanding);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** What this payment currently holds against each bill. */
  const held = useMemo(() => {
    const map = new Map<string, number>();
    for (const allocation of payment.allocations) {
      if (allocation.billId) map.set(allocation.billId, allocation.amount);
    }
    return map;
  }, [payment.allocations]);

  /*
   * Every posted bill for this supplier and currency, with what it would owe
   * once THIS payment's rows are superseded — its server outstanding plus
   * whatever this payment currently holds against it.
   */
  const rows = useMemo(() => {
    const eligible = outstanding.filter((row) => (
      row.supplierId === payment.supplierId
      && row.currency.toUpperCase() === payment.currency.toUpperCase()
    ));
    const seen = new Set(eligible.map((row) => row.billId));
    const settled = payment.allocations
      .filter((a) => a.billId && !seen.has(a.billId))
      .map((a) => ({
        billId: a.billId!,
        billNumber: a.billNumber ?? '',
        dueDate: '',
        available: a.amount,
      }));

    return [
      ...eligible.map((row) => ({
        billId: row.billId,
        billNumber: row.billNumber,
        dueDate: row.dueDate,
        available: roundToCompanyPrecision(Number(row.outstanding) + (held.get(row.billId) ?? 0)),
      })),
      ...settled,
    ].sort((a, b) => a.billNumber.localeCompare(b.billNumber));
  }, [outstanding, payment.supplierId, payment.currency, payment.allocations, held]);

  const [allocation, setAllocation] = useState<Record<string, number>>(
    () => Object.fromEntries(held),
  );

  const money = (n: number): string => formatCurrency(n, payment.currency);
  const total = roundToCompanyPrecision(
    Object.values(allocation).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  const remaining = roundToCompanyPrecision(payment.grossAmount - total);
  const balanced = Math.abs(remaining) < 0.0000005;

  const submit = async (): Promise<void> => {
    const drafts: AllocationDraft[] = Object.entries(allocation)
      .filter(([, value]) => Number(value) > 0)
      .map(([billId, value]) => ({ billId, amount: Number(value) }));

    setBusy(true);
    try {
      const result = await paymentActions().reallocate(payment.id, drafts);
      if (result.ok) {
        notify('Payment reallocated. The old rows are kept, marked superseded.', 'success');
        onClose();
        return;
      }
      /* The SERVER's words: over-allocation, a different supplier and a
       * reversed bill each say something different. */
      const message = result.error ?? 'Could not reallocate the payment.';
      setError(message);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reallocate payment ${payment.paymentNumber}`}
        className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">Reallocate payment — {payment.paymentNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {money(payment.grossAmount)} in total · allocating {money(total)}
        </p>
        <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300">
          {UNALLOCATE_UNSUPPORTED}
        </p>

        {error && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        {rows.length === 0 ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            This supplier has no other posted bill to move the money onto. Reverse the payment
            instead.
          </p>
        ) : (
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                <tr>
                  <th className="px-2 py-2 text-left">Bill</th>
                  <th className="px-2 py-2 text-right">Can take</th>
                  <th className="px-2 py-2 text-right">Allocate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((row) => {
                  const value = allocation[row.billId] ?? 0;
                  const over = Number(value) > row.available + 0.0000005;
                  return (
                    <tr key={row.billId} data-testid="reallocate-row">
                      <td className="px-2 py-1.5 font-mono">{row.billNumber}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.available)}</td>
                      <td className="w-32 px-2 py-1.5">
                        <Input
                          aria-label={`Reallocate to ${row.billNumber}`}
                          type="number" step="0.001"
                          value={value}
                          onChange={(e) => setAllocation((prev) => ({
                            ...prev, [row.billId]: Number(e.target.value),
                          }))}
                          className={cx('h-8 text-right', over && 'border-red-400 text-red-600')}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p
          data-testid="reallocate-remaining"
          className={cx('mt-2 text-xs', balanced ? 'text-slate-500' : 'text-red-600 dark:text-red-400')}
        >
          {balanced
            ? 'The whole payment is allocated.'
            : remaining > 0
              ? `${money(remaining)} still needs a bill — a partial reallocation cannot be saved.`
              : `${money(-remaining)} more than the payment is allocated.`}
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!balanced || busy} onClick={() => void submit()}>
            <Link2 className="h-4 w-4" /> Replace allocations
          </Button>
        </div>
      </div>
    </div>
  );
}
