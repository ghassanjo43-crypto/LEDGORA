/**
 * Goods receipts: recording what arrived against an issued purchase order.
 *
 * ── What this screen sends, and what it does not ─────────────────────────────
 * An order line and a quantity. Nothing else. The item, the unit, the
 * destination warehouse, the permitted quantity and the cost all come from the
 * order, read by the server inside the posting transaction under the order's
 * own lock — so a delivery cannot arrive at a price nobody agreed, and the
 * outstanding quantity shown here cannot be stale in a way that matters. If it
 * is, the server refuses the over-receipt rather than accepting it.
 *
 * ── The idempotency key belongs to the ATTEMPT ───────────────────────────────
 * Minted when the form is filled, not when the request is sent, so a retry
 * after a timeout carries the same key and the server answers with the receipt
 * it already made. A key generated per call would turn every retry into a
 * second delivery.
 *
 * ── What a posted receipt means ──────────────────────────────────────────────
 * Dr Inventory, Cr Goods received not invoiced — and nothing else. No supplier
 * is owed a determinate amount until their invoice is posted, and no input tax
 * is recoverable until then either. The screen says so, because a receipt read
 * as a payable would overstate what the business owes by the whole delivery.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money } from '@/pages/inventory/InventoryShared';
import {
  purchasingIsServerAuthoritative,
  usePurchasing,
  loadOrders,
  loadOpenLines,
  loadReceipts,
  purchasingGateway,
  newReceiptKey,
  PURCHASING_LOCAL_UNSUPPORTED,
} from '@/services/purchasing/purchasingBackend';
import type { ServerGoodsReceipt } from '@/services/api/purchasingApi';

const today = (): string => new Date().toISOString().slice(0, 10);

export function GoodsReceiptsPage() {
  const serverBacked = purchasingIsServerAuthoritative();

  const orders = usePurchasing((s) => s.orders);
  const openLines = usePurchasing((s) => s.openLines);
  const receipts = usePurchasing((s) => s.receipts);
  const receiptState = usePurchasing((s) => s.receiptState);
  const receiptError = usePurchasing((s) => s.receiptError);
  const matchingSupported = usePurchasing((s) => s.matchingSupported);
  const matchingNote = usePurchasing((s) => s.matchingNote);

  const [orderId, setOrderId] = useState('');
  const [receiptDate, setReceiptDate] = useState(today);
  const [deliveryNote, setDeliveryNote] = useState('');
  const [memo, setMemo] = useState('');
  /* Minted for the ATTEMPT, so a retry of the same delivery carries the same
   * key and cannot receive the goods twice. */
  const [attemptKey, setAttemptKey] = useState(newReceiptKey);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!serverBacked) return;
    void loadOrders();
    void loadOpenLines();
    void loadReceipts();
  }, [serverBacked]);

  /* Only orders that can actually take a delivery. */
  const receivableOrders = useMemo(
    () => orders.filter((o) => o.status === 'issued' || o.status === 'partially_received'),
    [orders],
  );

  useEffect(() => {
    if (!orderId && receivableOrders[0]) setOrderId(receivableOrders[0].id);
  }, [receivableOrders, orderId]);

  const eligible = useMemo(
    () => openLines.filter((line) => line.orderId === orderId),
    [openLines, orderId],
  );

  const post = async (): Promise<void> => {
    const lines = eligible
      .map((line) => ({ orderLineId: line.orderLineId, quantity: quantities[line.orderLineId] ?? '' }))
      .filter((line) => line.quantity.trim() !== '' && Number(line.quantity) > 0);

    if (lines.length === 0) {
      setMsg({ tone: 'error', text: 'Enter what actually arrived on at least one line.' });
      return;
    }

    setBusy(true);
    try {
      const { receipt, created } = await purchasingGateway.postReceipt({
        orderId,
        receiptDate,
        deliveryNoteReference: deliveryNote.trim() || undefined,
        memo: memo.trim() || undefined,
        idempotencyKey: attemptKey,
        /* The order line and the quantity. Never a cost, a warehouse or an item. */
        lines,
      });
      setMsg({
        tone: 'success',
        text: created
          ? `${receipt.receiptNumber} posted ${money(Number(receipt.totalValue))} to inventory, `
            + 'against goods received not invoiced. No supplier liability and no input tax were '
            + 'recognised — those arrive with the supplier’s invoice.'
          : `${receipt.receiptNumber} was already recorded. Nothing was received a second time.`,
      });
      setQuantities({});
      setAttemptKey(newReceiptKey());
    } catch (error) {
      setMsg({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The receipt could not be posted.',
      });
    } finally {
      setBusy(false);
    }
  };

  const reverse = async (receipt: ServerGoodsReceipt): Promise<void> => {
    if (reason.trim().length < 5) {
      setMsg({ tone: 'error', text: 'Say why this receipt is being withdrawn — at least five characters.' });
      return;
    }
    setBusy(true);
    try {
      const reversed = await purchasingGateway.reverseReceipt(
        receipt.id, receipt.version, reason.trim(),
      );
      setReversing(null);
      setReason('');
      setMsg({
        tone: 'success',
        text: `${reversed.receiptNumber} withdrawn. The stock left at the cost it came in at, the `
          + 'goods-received-not-invoiced credit was reversed, and the order line is outstanding again.',
      });
    } catch (error) {
      setMsg({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The receipt could not be withdrawn.',
      });
    } finally {
      setBusy(false);
    }
  };

  if (!serverBacked) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Goods Receipts</h2>
        <Alert variant="info">{PURCHASING_LOCAL_UNSUPPORTED}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Goods Receipts</h2>

      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {receiptState === 'unavailable' && (
        <Alert variant="error">
          {receiptError ?? 'Goods receipts could not be loaded from the server.'}
        </Alert>
      )}

      <Alert variant="info">
        Receiving records Dr Inventory / Cr Goods received not invoiced. The supplier liability and
        any recoverable input tax are recognised when their invoice is posted.
        {!matchingSupported && ` ${matchingNote}`}
      </Alert>

      {receivableOrders.length === 0 && (
        <Alert variant="info">
          There is no issued purchase order to receive against. Goods can only be received against a
          controlled order: it is the only record of what was agreed, at what price, into which
          warehouse. An unordered purchase is recorded as a stocked supplier bill.
        </Alert>
      )}

      {receivableOrders.length > 0 && (
        <Card className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="text-xs text-slate-500" htmlFor="gr-order">Purchase order</label>
              <Select
                id="gr-order"
                aria-label="Purchase order"
                options={receivableOrders.map((o) => ({
                  value: o.id, label: `${o.orderNumber} — ${o.supplierName}`,
                }))}
                value={orderId}
                onChange={(e) => { setOrderId(e.target.value); setQuantities({}); }}
              />
            </div>
            <div>
              <label className="text-xs text-slate-500" htmlFor="gr-date">Received on</label>
              <Input
                id="gr-date" aria-label="Receipt date" type="date"
                value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-slate-500" htmlFor="gr-note">Delivery note</label>
              <Input
                id="gr-note"
                aria-label="Delivery note reference"
                placeholder="Their note number"
                value={deliveryNote}
                onChange={(e) => setDeliveryNote(e.target.value)}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-left">Deliver to</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Already in</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2 text-right">Receiving now</th>
                </tr>
              </thead>
              <tbody>
                {eligible.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-500" colSpan={6}>
                      Every line on this order has been received in full.
                    </td>
                  </tr>
                )}
                {eligible.map((line) => (
                  <tr key={line.orderLineId} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2">{line.itemCode} — {line.itemName}</td>
                    <td className="px-3 py-2">{line.warehouseCode}</td>
                    <td className="px-3 py-2 text-right text-slate-500">
                      {line.orderedQuantity} {line.baseUnitCode}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500">{line.receivedQuantity}</td>
                    <td className="px-3 py-2 text-right font-medium">{line.remainingQuantity}</td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        aria-label={`Quantity received for ${line.itemCode}`}
                        className="h-8 w-24 text-right"
                        placeholder="0"
                        value={quantities[line.orderLineId] ?? ''}
                        onChange={(e) => setQuantities((q) => ({
                          ...q, [line.orderLineId]: e.target.value,
                        }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Memo"
              placeholder="Memo"
              className="w-72"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
            <Button onClick={() => { void post(); }} disabled={busy || eligible.length === 0}>
              {busy ? 'Posting…' : 'Post goods receipt'}
            </Button>
            <span className="text-xs text-slate-500">
              The cost comes from the order, not from this screen.
            </span>
          </div>
        </Card>
      )}

      {/* ── Receipt history ────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Receipt</th>
                <th className="px-4 py-2 text-left">Order</th>
                <th className="px-4 py-2 text-left">Supplier</th>
                <th className="px-4 py-2 text-left">Posted</th>
                <th className="px-4 py-2 text-right">Value</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {receipts.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={7}>
                    {receiptState === 'loading' ? 'Loading…' : 'Nothing has been received yet.'}
                  </td>
                </tr>
              )}
              {receipts.map((receipt) => (
                <tr key={receipt.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{receipt.receiptNumber}</td>
                  <td className="px-4 py-2">{receipt.orderNumber}</td>
                  <td className="px-4 py-2">{receipt.supplierName}</td>
                  <td className="px-4 py-2">{receipt.postingDate}</td>
                  <td className="px-4 py-2 text-right">{money(Number(receipt.totalValue))}</td>
                  <td className="px-4 py-2">
                    <Badge tone={receipt.status === 'posted' ? 'amber' : 'slate'}>
                      {receipt.status === 'posted' ? 'Awaiting invoice' : 'Reversed'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {receipt.status === 'posted' && (
                      <Button
                        variant="ghost"
                        onClick={() => { setReversing(receipt.id); setReason(''); }}
                      >
                        Reverse
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {reversing && (
        <Card className="space-y-3 p-4">
          <h3 className="font-semibold">Withdraw a goods receipt</h3>
          <p className="text-sm text-slate-500">
            The stock leaves at the cost it came in at — never at today&apos;s average — and the
            goods-received-not-invoiced credit is reversed with it. If the goods have since been
            issued, sold or transferred, the withdrawal is refused: record a correcting adjustment
            instead.
          </p>
          <Input
            aria-label="Reason for reversal"
            placeholder="Why is this being withdrawn?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              onClick={() => {
                const receipt = receipts.find((r) => r.id === reversing);
                if (receipt) void reverse(receipt);
              }}
              disabled={busy}
            >
              {busy ? 'Withdrawing…' : 'Withdraw'}
            </Button>
            <Button variant="outline" onClick={() => setReversing(null)}>Cancel</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
