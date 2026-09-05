/**
 * The received-not-invoiced schedule.
 *
 * ── What this balance is ─────────────────────────────────────────────────────
 * Goods the business has taken into stock and has not yet been invoiced for. It
 * is an accrual, not a payable: nobody has sent a demand for a determinate
 * amount, and the value here is what the ORDER committed to, net of any
 * separately recoverable input tax.
 *
 * ── Why the schedule includes order-less warehouse receipts ──────────────────
 * A standalone stock receipt credits the same account. A schedule that listed
 * only ordered deliveries would never equal the account it claims to explain,
 * and the difference would look like a fault in the books rather than a
 * document the report had chosen to leave out. So both appear, and the ones
 * with no order behind them say so instead of borrowing a supplier.
 *
 * ── Nothing here is settled ──────────────────────────────────────────────────
 * Matching a receipt to a supplier invoice does not exist yet. Every line is
 * awaiting one, and the screen says that rather than letting an absent column
 * be read as "cleared".
 */
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money } from '@/pages/inventory/InventoryShared';
import {
  purchasingIsServerAuthoritative,
  usePurchasing,
  loadGrni,
  PURCHASING_LOCAL_UNSUPPORTED,
} from '@/services/purchasing/purchasingBackend';

export function ReceivedNotInvoicedPage() {
  const serverBacked = purchasingIsServerAuthoritative();
  const schedule = usePurchasing((s) => s.grni);
  const state = usePurchasing((s) => s.grniState);
  const error = usePurchasing((s) => s.grniError);

  const [asOfDate, setAsOfDate] = useState('');

  useEffect(() => {
    if (serverBacked) void loadGrni({ asOfDate: asOfDate || undefined });
  }, [serverBacked, asOfDate]);

  if (!serverBacked) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          Received Not Invoiced
        </h2>
        <Alert variant="info">{PURCHASING_LOCAL_UNSUPPORTED}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          Received Not Invoiced
        </h2>
        <div className="w-48">
          <label className="text-xs text-slate-500" htmlFor="grni-as-of">As at</label>
          <Input
            id="grni-as-of"
            aria-label="As at date"
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
          />
        </div>
      </div>

      {state === 'unavailable' && (
        <Alert variant="error">
          {error ?? 'The received-not-invoiced schedule could not be loaded from the server.'}
        </Alert>
      )}

      <Alert variant="info">
        This is what the business has taken into stock and not yet been invoiced for. A line leaves
        it when a supplier bill is matched to the receipt, which clears the accrual for exactly what
        the goods were received at. Purchase returns, debit notes and supplier credits are not
        implemented.
      </Alert>

      {schedule && (
        <Card className="grid gap-4 p-4 md:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-slate-500">Schedule total</p>
            <p className="text-xl font-semibold">{money(Number(schedule.total))}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-500">General ledger</p>
            <p className="text-xl font-semibold">
              {money(Number(schedule.generalLedgerBalance))}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-500">Difference</p>
            <p className="text-xl font-semibold">
              {money(Number(schedule.difference))}{' '}
              <Badge tone={schedule.balanced ? 'green' : 'red'}>
                {schedule.balanced ? 'Reconciled' : 'Out of balance'}
              </Badge>
            </p>
          </div>
        </Card>
      )}

      {schedule && !schedule.balanced && (
        <Alert variant="error">
          The schedule and the ledger disagree. That means something was posted to the
          goods-received-not-invoiced account without a receipt behind it — a manual journal, or an
          opening balance. Neither is corrected automatically: only the person who wrote it knows
          whether the answer is another journal or a stock adjustment.
        </Alert>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Posted</th>
                <th className="px-4 py-2 text-left">Receipt</th>
                <th className="px-4 py-2 text-left">Order</th>
                <th className="px-4 py-2 text-left">Supplier</th>
                <th className="px-4 py-2 text-left">Item</th>
                <th className="px-4 py-2 text-left">Warehouse</th>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-right">Quantity</th>
                <th className="px-4 py-2 text-right">Received</th>
                <th className="px-4 py-2 text-right">Billed</th>
                <th className="px-4 py-2 text-right">Open</th>
              </tr>
            </thead>
            <tbody>
              {(!schedule || schedule.rows.length === 0) && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={11}>
                    {state === 'loading'
                      ? 'Loading…'
                      : 'Nothing has been received and left uninvoiced.'}
                  </td>
                </tr>
              )}
              {schedule?.rows.map((row) => (
                <tr
                  key={`${row.documentId}-${row.itemId}-${row.warehouseId}`}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2">{row.postingDate}</td>
                  <td className="px-4 py-2">
                    {row.receiptNumber ?? (
                      <span className="text-slate-500">{row.documentNumber} (no order)</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{row.orderNumber ?? '—'}</td>
                  <td className="px-4 py-2">{row.supplierName ?? '—'}</td>
                  <td className="px-4 py-2">{row.itemCode} — {row.itemName}</td>
                  <td className="px-4 py-2">{row.warehouseCode}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {row.accountCode} {row.accountName}
                  </td>
                  <td className="px-4 py-2 text-right">{row.quantity}</td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {money(Number(row.value))}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {money(Number(row.clearedValue))}
                  </td>
                  <td className="px-4 py-2 text-right font-medium">
                    {money(Number(row.openValue))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
