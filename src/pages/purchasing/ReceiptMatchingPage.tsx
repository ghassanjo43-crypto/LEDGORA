/**
 * Matching supplier bills to goods receipts.
 *
 * ── What this screen builds ──────────────────────────────────────────────────
 * A receipt-matched supplier bill: one line per receipt line being settled,
 * carrying the receipt line and a quantity and nothing else. The item, the
 * unit, the warehouse, the cost and the goods-received-not-invoiced account all
 * come from the receipt, read by the server inside the posting transaction
 * under that receipt line's own lock. This screen never sends a cost.
 *
 * ── Why the price is shown but not chosen ────────────────────────────────────
 * Matching is EXACT. The supplier's net for the matched quantity has to be what
 * the goods were received at, because a difference is a purchase-price variance
 * and this product resolves no destination for one — inventory is moving-average
 * with no cost layers, so nothing can say how much of a given receipt is still
 * on hand. The form therefore proposes the receipt's own unit cost, and the
 * server refuses anything else with the reason. That refusal is the feature: it
 * keeps a made-up figure out of inventory and out of profit.
 *
 * ── Where the numbers come from ──────────────────────────────────────────────
 * Every outstanding quantity and value on this page is the server's, recomputed
 * on each load from the receipts and the active clearings. Nothing is stored
 * here and nothing is derived here — a capacity figure this browser had worked
 * out for itself could offer a receipt another bill had already settled.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money } from '@/pages/inventory/InventoryShared';
import { useSuppliers } from '@/services/parties/useSuppliers';
import { loadSuppliers } from '@/services/parties/supplierDirectory';
import { useServerTaxCodeStore } from '@/store/serverTaxCodeStore';
import { billGateway } from '@/services/bills/billBackend';
import {
  purchasingIsServerAuthoritative,
  usePurchasing,
  loadEligibleReceiptLines,
  loadMatchHistory,
  refreshAfterBillChange,
  PURCHASING_LOCAL_UNSUPPORTED,
} from '@/services/purchasing/purchasingBackend';
import type { EligibleReceiptLine } from '@/services/api/purchasingApi';

const today = (): string => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The entity a durable bill is issued under, as the bill screens use it. */
const ENTITY = '11111111-1111-1111-1111-111111111111';

export function ReceiptMatchingPage() {
  const serverBacked = purchasingIsServerAuthoritative();
  const { suppliers } = useSuppliers();
  const taxCodes = useServerTaxCodeStore((s) => s.taxCodes);
  const loadTaxCodes = useServerTaxCodeStore((s) => s.load);

  const eligible = usePurchasing((s) => s.eligible);
  const eligibleState = usePurchasing((s) => s.eligibleState);
  const eligibleError = usePurchasing((s) => s.eligibleError);
  const exactValueRequired = usePurchasing((s) => s.exactValueRequired);
  const varianceNote = usePurchasing((s) => s.varianceNote);
  const matches = usePurchasing((s) => s.matches);
  const matchState = usePurchasing((s) => s.matchState);

  const [supplierId, setSupplierId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState(() => addDays(today(), 30));
  const [memo, setMemo] = useState('');
  const [taxCodeId, setTaxCodeId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!serverBacked) return;
    void loadEligibleReceiptLines();
    void loadMatchHistory();
    void loadSuppliers();
    void loadTaxCodes();
  }, [serverBacked, loadTaxCodes]);

  const supplierOptions = useMemo(
    () => [
      { value: '', label: 'Choose a supplier…' },
      ...suppliers
        .filter((s) => s.isActive)
        .map((s) => ({ value: s.id, label: s.legalName || s.tradingName || s.entityCode })),
    ],
    [suppliers],
  );

  /* Only PURCHASE-facing codes: the server refuses a sales code on a bill. */
  const taxOptions = useMemo(
    () => [
      { value: '', label: 'No tax' },
      ...taxCodes
        .filter((code) => code.status === 'active'
          && (code.direction === 'purchase' || code.direction === 'both'))
        .map((code) => ({ value: code.id, label: `${code.code} — ${code.name}` })),
    ],
    [taxCodes],
  );

  /* A supplier's own outstanding deliveries. A bill settles one supplier. */
  const offered = useMemo(
    () => (supplierId ? eligible.filter((line) => line.supplierId === supplierId) : []),
    [eligible, supplierId],
  );

  const chosen = useMemo(
    () => offered
      .map((line) => ({ line, quantity: quantities[line.receiptLineId] ?? '' }))
      .filter((row) => row.quantity.trim() !== '' && Number(row.quantity) > 0),
    [offered, quantities],
  );

  /*
   * What the bill will clear, at the RECEIPT's own unit cost.
   *
   * Shown so a buyer can check the invoice before sending it, and computed the
   * same way the server does — a whole line takes whatever remains of its
   * value, so a partial share can never leave a rounding residue behind. It is
   * displayed only: the server recomputes it and refuses a disagreement.
   */
  const clearing = useMemo(
    () => chosen.reduce((sum, row) => {
      const quantity = Number(row.quantity);
      const remaining = Number(row.line.remainingQuantity);
      const value = quantity === remaining
        ? Number(row.line.remainingValue)
        : (Number(row.line.receiptValue) * quantity) / Number(row.line.receivedQuantity);
      return sum + value;
    }, 0),
    [chosen],
  );

  const unitPriceFor = (line: EligibleReceiptLine, quantity: string): string => {
    const asked = Number(quantity);
    const remaining = Number(line.remainingQuantity);
    /* The last clearing takes the remainder, exactly as the server does. */
    const value = asked === remaining
      ? Number(line.remainingValue)
      : (Number(line.receiptValue) * asked) / Number(line.receivedQuantity);
    return String(value / asked);
  };

  const post = async (): Promise<void> => {
    if (!supplierId) { setMsg({ tone: 'error', text: 'Choose the supplier this invoice is from.' }); return; }
    if (!invoiceNumber.trim()) {
      setMsg({ tone: 'error', text: "Enter the supplier's own invoice number." });
      return;
    }
    if (chosen.length === 0) {
      setMsg({ tone: 'error', text: 'Enter what the invoice covers on at least one delivery.' });
      return;
    }

    setBusy(true);
    try {
      const draft = await billGateway.create({
        issuingEntityId: ENTITY,
        supplierId,
        supplierInvoiceNumber: invoiceNumber.trim(),
        billDate,
        dueDate,
        memo: memo.trim() || undefined,
        /* Stated, and checked against the lines by the server. */
        workflow: 'receipt-matched',
        lines: chosen.map((row) => ({
          description: `${row.line.itemCode} — ${row.line.receiptNumber}`,
          /* The receipt line and the quantity. Never a cost or an account. */
          receiptLineId: row.line.receiptLineId,
          matchedQuantity: row.quantity,
          quantity: row.quantity,
          unitPrice: unitPriceFor(row.line, row.quantity),
          taxCodeId: taxCodeId || null,
        })),
      });

      const posted = await billGateway.post(draft.id, draft.version);
      setMsg({
        tone: 'success',
        text: `${posted.billNumber} posted. ${money(clearing)} of goods-received-not-invoiced was `
          + 'cleared, and the payable and any recoverable input tax were recognised. No stock '
          + 'moved: the goods arrived on the receipt.',
      });
      setQuantities({});
      setInvoiceNumber('');
      await refreshAfterBillChange();
    } catch (error) {
      setMsg({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The supplier bill could not be posted.',
      });
      /* The refusal may have come from stale capacity, so re-read it. */
      await loadEligibleReceiptLines();
    } finally {
      setBusy(false);
    }
  };

  if (!serverBacked) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Receipt Matching</h2>
        <Alert variant="info">{PURCHASING_LOCAL_UNSUPPORTED}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Receipt Matching</h2>

      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {eligibleState === 'unavailable' && (
        <Alert variant="error">
          {eligibleError ?? 'Eligible goods receipts could not be loaded from the server.'}
        </Alert>
      )}

      <Alert variant="info">
        Posting a matched bill clears goods received not invoiced for exactly what the goods were
        received at, and recognises the payable and any recoverable input tax. No stock moves.
        {exactValueRequired && ` ${varianceNote}`}
      </Alert>

      {/* ── The invoice ────────────────────────────────────────────────────── */}
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-5">
          <div className="md:col-span-2">
            <label className="text-xs text-slate-500" htmlFor="match-supplier">Supplier</label>
            <Select
              id="match-supplier"
              aria-label="Supplier"
              options={supplierOptions}
              value={supplierId}
              onChange={(e) => { setSupplierId(e.target.value); setQuantities({}); }}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="match-invoice">
              Supplier&apos;s invoice number
            </label>
            <Input
              id="match-invoice"
              aria-label="Supplier invoice number"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="match-date">Invoice date</label>
            <Input
              id="match-date" aria-label="Invoice date" type="date"
              value={billDate} onChange={(e) => setBillDate(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="match-due">Due</label>
            <Input
              id="match-due" aria-label="Due date" type="date"
              value={dueDate} onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        {!supplierId && (
          <p className="text-sm text-slate-500">
            Choose a supplier to see the deliveries their invoice can settle.
          </p>
        )}

        {supplierId && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2 text-left">Receipt</th>
                  <th className="px-3 py-2 text-left">Order</th>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Already billed</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2 text-right">Unit cost</th>
                  <th className="px-3 py-2 text-right">Billing now</th>
                </tr>
              </thead>
              <tbody>
                {offered.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-500" colSpan={8}>
                      {eligibleState === 'loading'
                        ? 'Loading…'
                        : 'This supplier has no delivered goods awaiting an invoice.'}
                    </td>
                  </tr>
                )}
                {offered.map((line) => (
                  <tr
                    key={line.receiptLineId}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-3 py-2">{line.receiptNumber}</td>
                    <td className="px-3 py-2 text-slate-500">{line.orderNumber}</td>
                    <td className="px-3 py-2">{line.itemCode} — {line.itemName}</td>
                    <td className="px-3 py-2 text-right text-slate-500">
                      {line.receivedQuantity} {line.baseUnitCode}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500">{line.matchedQuantity}</td>
                    <td className="px-3 py-2 text-right font-medium">{line.remainingQuantity}</td>
                    <td className="px-3 py-2 text-right text-slate-500">
                      {money(Number(line.unitCost))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        aria-label={`Quantity billed for ${line.itemCode} on ${line.receiptNumber}`}
                        className="h-8 w-24 text-right"
                        placeholder="0"
                        value={quantities[line.receiptLineId] ?? ''}
                        onChange={(e) => setQuantities((q) => ({
                          ...q, [line.receiptLineId]: e.target.value,
                        }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {supplierId && offered.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-56">
              <label className="text-xs text-slate-500" htmlFor="match-tax">Tax code</label>
              <Select
                id="match-tax"
                aria-label="Tax code"
                options={taxOptions}
                value={taxCodeId}
                onChange={(e) => setTaxCodeId(e.target.value)}
              />
            </div>
            <Input
              aria-label="Memo"
              placeholder="Memo"
              className="w-64"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
            <div className="text-sm">
              <span className="text-slate-500">Clearing</span>{' '}
              <span className="font-semibold">{money(clearing)}</span>
            </div>
            <Button onClick={() => { void post(); }} disabled={busy || chosen.length === 0}>
              {busy ? 'Posting…' : 'Post supplier bill'}
            </Button>
            <span className="text-xs text-slate-500">
              The value comes from the receipt, not from this screen.
            </span>
          </div>
        )}
      </Card>

      {/* ── What has been settled ──────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Bill</th>
                <th className="px-4 py-2 text-left">Supplier invoice</th>
                <th className="px-4 py-2 text-left">Receipt</th>
                <th className="px-4 py-2 text-left">Item</th>
                <th className="px-4 py-2 text-right">Quantity</th>
                <th className="px-4 py-2 text-right">Cleared</th>
                <th className="px-4 py-2 text-right">Difference</th>
                <th className="px-4 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {matches.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={8}>
                    {matchState === 'loading' ? 'Loading…' : 'Nothing has been matched yet.'}
                  </td>
                </tr>
              )}
              {matches.map((row) => (
                <tr key={row.matchId} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{row.billNumber}</td>
                  <td className="px-4 py-2">{row.supplierInvoiceNumber}</td>
                  <td className="px-4 py-2">{row.receiptNumber}</td>
                  <td className="px-4 py-2">{row.itemCode} — {row.itemName}</td>
                  <td className="px-4 py-2 text-right">
                    {row.matchedQuantity} {row.baseUnitCode}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {money(Number(row.matchedReceiptValue))}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {money(Number(row.valueDifference))}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={row.status === 'active' ? 'green' : 'slate'}>
                      {row.status === 'active' ? 'Settled' : 'Withdrawn'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-slate-500">
        A matched bill is withdrawn by reversing it from the Bills screen, which restores the accrual
        and reopens the delivery for invoicing. A bill a payment settles cannot be reversed.
      </p>
    </div>
  );
}
