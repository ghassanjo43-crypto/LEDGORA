/**
 * Purchase orders: raising a commitment, approving it, issuing it, and watching
 * what is still outstanding.
 *
 * ── Nothing on this screen posts anything ────────────────────────────────────
 * An order is a commercial commitment. Creating, approving, issuing, closing
 * and cancelling one leave the ledger exactly as they found it — inventory is
 * recognised by the goods receipt, and the supplier liability and recoverable
 * input tax by the supplier bill. The screen says so, because a buyer who
 * believed an approved order had already been accrued would be reading the
 * business's position wrong by the whole value of the order.
 *
 * ── Every figure comes back from the server ──────────────────────────────────
 * The form sends quantities, unit prices, a discount and a tax code. It sends
 * no line amount, no tax amount and no total, and it displays only what the
 * server computed and returned — so what is on screen is what the books hold,
 * not an arithmetic the browser did in parallel and might disagree about.
 *
 * ── On browser books there is nothing here ───────────────────────────────────
 * Advanced purchasing exists only on durable books. There is no local
 * purchase-order document in this product and no way to post the inventory a
 * receipt recognises, so the screen says that plainly rather than offering a
 * local imitation whose numbers no ledger would honour.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { generateId } from '@/lib/utils';
import { money, useItemOptions, useWarehouseOptions } from '@/pages/inventory/InventoryShared';
import { useSuppliers } from '@/services/parties/useSuppliers';
import { loadSuppliers } from '@/services/parties/supplierDirectory';
import { useServerTaxCodeStore } from '@/store/serverTaxCodeStore';
import {
  purchasingIsServerAuthoritative,
  usePurchasing,
  loadOrders,
  loadOpenLines,
  purchasingGateway,
  PURCHASING_LOCAL_UNSUPPORTED,
} from '@/services/purchasing/purchasingBackend';
import type {
  PurchaseOrderStatus, ServerPurchaseOrder,
} from '@/services/api/purchasingApi';

interface DraftLine {
  id: string;
  itemId: string;
  warehouseId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountType: '' | 'percentage' | 'amount';
  discountValue: string;
  taxCodeId: string;
}

const STATUS_TONE: Record<PurchaseOrderStatus, BadgeTone> = {
  draft: 'slate',
  approved: 'blue',
  issued: 'indigo',
  partially_received: 'amber',
  received: 'green',
  closed: 'slate',
  cancelled: 'red',
};

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  issued: 'Issued',
  partially_received: 'Partially received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const today = (): string => new Date().toISOString().slice(0, 10);

const blankLine = (warehouseId: string): DraftLine => ({
  id: generateId('pol'),
  itemId: '',
  warehouseId,
  description: '',
  quantity: '1',
  unitPrice: '0',
  discountType: '',
  discountValue: '',
  taxCodeId: '',
});

export function PurchaseOrdersPage() {
  const serverBacked = purchasingIsServerAuthoritative();
  const items = useItemOptions(true);
  const warehouses = useWarehouseOptions();
  const { suppliers } = useSuppliers();
  const taxCodes = useServerTaxCodeStore((s) => s.taxCodes);
  const loadTaxCodes = useServerTaxCodeStore((s) => s.load);

  const orders = usePurchasing((s) => s.orders);
  const orderState = usePurchasing((s) => s.orderState);
  const orderError = usePurchasing((s) => s.orderError);

  const [supplierId, setSupplierId] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [expectedDate, setExpectedDate] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!serverBacked) return;
    void loadOrders();
    void loadOpenLines();
    void loadSuppliers();
    void loadTaxCodes();
  }, [serverBacked, loadTaxCodes]);

  useEffect(() => {
    if (lines.length === 0 && warehouses[0]) setLines([blankLine(warehouses[0].value)]);
  }, [warehouses, lines.length]);

  /* Only PURCHASE-facing codes: a sales code on a bill is a filing error, and
   * the server refuses one — offering it here would be a trap. */
  const purchaseTaxOptions = useMemo(
    () => [
      { value: '', label: 'No tax' },
      ...taxCodes
        .filter((code) => code.status === 'active'
          && (code.direction === 'purchase' || code.direction === 'both'))
        .map((code) => ({ value: code.id, label: `${code.code} — ${code.name}` })),
    ],
    [taxCodes],
  );

  const supplierOptions = useMemo(
    () => [
      { value: '', label: 'Choose a supplier…' },
      ...suppliers
        .filter((s) => s.isActive)
        .map((s) => ({ value: s.id, label: s.legalName || s.tradingName || s.entityCode })),
    ],
    [suppliers],
  );

  const selected = useMemo(
    () => orders.find((o) => o.id === selectedId) ?? null,
    [orders, selectedId],
  );

  const resetForm = (): void => {
    setEditingId(null);
    setEditingVersion(0);
    setSupplierId('');
    setOrderDate(today());
    setExpectedDate('');
    setSupplierReference('');
    setMemo('');
    setLines([blankLine(warehouses[0]?.value ?? '')]);
  };

  const startEdit = (order: ServerPurchaseOrder): void => {
    setEditingId(order.id);
    setEditingVersion(order.version);
    setSupplierId(order.supplierId);
    setOrderDate(order.orderDate);
    setExpectedDate(order.expectedDate ?? '');
    setSupplierReference(order.supplierReference);
    setMemo(order.memo);
    setLines(order.lines.map((line) => ({
      id: generateId('pol'),
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      description: line.description,
      quantity: line.orderedQuantity,
      unitPrice: line.unitPrice,
      discountType: (line.discountType as DraftLine['discountType']) ?? '',
      discountValue: line.discountValue,
      taxCodeId: line.taxCodeId ?? '',
    })));
    setMsg(null);
  };

  const payload = () => ({
    supplierId,
    orderDate,
    expectedDate: expectedDate || null,
    supplierReference: supplierReference.trim(),
    memo: memo.trim(),
    /* Quantities, prices, a discount and a tax code. No amounts, ever. */
    lines: lines
      .filter((line) => line.itemId)
      .map((line) => ({
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        description: line.description.trim() || undefined,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountType: line.discountType || null,
        discountValue: line.discountValue || null,
        taxCodeId: line.taxCodeId || null,
      })),
  });

  const save = async (): Promise<void> => {
    const body = payload();
    if (!body.supplierId) { setMsg({ tone: 'error', text: 'Choose the supplier.' }); return; }
    if (body.lines.length === 0) { setMsg({ tone: 'error', text: 'Add at least one line.' }); return; }

    setBusy(true);
    try {
      const order = editingId
        ? await purchasingGateway.updateOrder(editingId, editingVersion, body)
        : await purchasingGateway.createOrder(body);
      setMsg({
        tone: 'success',
        text: `${order.orderNumber} saved as a draft. Nothing has been posted: an order commits the `
          + 'business to buy, and the books record the purchase when the goods arrive.',
      });
      resetForm();
      setSelectedId(order.id);
    } catch (error) {
      setMsg({ tone: 'error', text: error instanceof Error ? error.message : 'The order could not be saved.' });
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    what: 'approve' | 'issue' | 'close' | 'cancel',
    order: ServerPurchaseOrder,
  ): Promise<void> => {
    if ((what === 'close' || what === 'cancel') && reason.trim().length < 5) {
      setMsg({ tone: 'error', text: 'Say why this commitment is being abandoned — at least five characters.' });
      return;
    }
    setBusy(true);
    try {
      const updated = what === 'approve'
        ? await purchasingGateway.approveOrder(order.id, order.version)
        : what === 'issue'
          ? await purchasingGateway.issueOrder(order.id, order.version)
          : what === 'close'
            ? await purchasingGateway.closeOrder(order.id, order.version, reason.trim())
            : await purchasingGateway.cancelOrder(order.id, order.version, reason.trim());
      setReason('');
      setMsg({
        tone: 'success',
        text: `${updated.orderNumber} is now ${STATUS_LABEL[updated.status].toLowerCase()}. `
          + 'No ledger entry was made.',
      });
    } catch (error) {
      setMsg({ tone: 'error', text: error instanceof Error ? error.message : 'That could not be done.' });
    } finally {
      setBusy(false);
    }
  };

  if (!serverBacked) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Purchase Orders</h2>
        <Alert variant="info">{PURCHASING_LOCAL_UNSUPPORTED}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Purchase Orders</h2>
        {editingId && <Button variant="outline" onClick={resetForm}>New order</Button>}
      </div>

      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {orderState === 'unavailable' && (
        <Alert variant="error">
          {orderError ?? 'Purchase orders could not be loaded from the server.'}
        </Alert>
      )}

      <Alert variant="info">
        A purchase order posts nothing. Inventory is recognised when the goods are received; the
        supplier liability and any recoverable input tax are recognised when the supplier&apos;s
        invoice is posted. The tax shown here is the buyer&apos;s estimate, not a tax position.
      </Alert>

      {/* ── The editor ─────────────────────────────────────────────────────── */}
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="text-xs text-slate-500" htmlFor="po-supplier">Supplier</label>
            <Select
              id="po-supplier"
              aria-label="Supplier"
              options={supplierOptions}
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="po-date">Order date</label>
            <Input
              id="po-date" aria-label="Order date" type="date"
              value={orderDate} onChange={(e) => setOrderDate(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="po-expected">Expected</label>
            <Input
              id="po-expected" aria-label="Expected date" type="date"
              value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="po-ref">
              Supplier&apos;s reference
            </label>
            <Input
              id="po-ref"
              aria-label="Supplier reference"
              placeholder="Their quotation number"
              value={supplierReference}
              onChange={(e) => setSupplierReference(e.target.value)}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-left">Deliver to</th>
                <th className="px-3 py-2 text-right">Quantity</th>
                <th className="px-3 py-2 text-right">Unit price</th>
                <th className="px-3 py-2 text-left">Discount</th>
                <th className="px-3 py-2 text-left">Tax code</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Item on line ${index + 1}`}
                      options={[{ value: '', label: 'Choose an item…' }, ...items]}
                      value={line.itemId}
                      onChange={(e) => setLines((f) => f.map((x, i) => (
                        i === index ? { ...x, itemId: e.target.value } : x
                      )))}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Warehouse on line ${index + 1}`}
                      options={warehouses}
                      value={line.warehouseId}
                      onChange={(e) => setLines((f) => f.map((x, i) => (
                        i === index ? { ...x, warehouseId: e.target.value } : x
                      )))}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      aria-label={`Quantity on line ${index + 1}`}
                      className="h-8 w-24 text-right"
                      value={line.quantity}
                      onChange={(e) => setLines((f) => f.map((x, i) => (
                        i === index ? { ...x, quantity: e.target.value } : x
                      )))}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      aria-label={`Unit price on line ${index + 1}`}
                      className="h-8 w-28 text-right"
                      value={line.unitPrice}
                      onChange={(e) => setLines((f) => f.map((x, i) => (
                        i === index ? { ...x, unitPrice: e.target.value } : x
                      )))}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Select
                        aria-label={`Discount type on line ${index + 1}`}
                        className="h-8"
                        options={[
                          { value: '', label: 'None' },
                          { value: 'percentage', label: '%' },
                          { value: 'amount', label: 'Amount' },
                        ]}
                        value={line.discountType}
                        onChange={(e) => setLines((f) => f.map((x, i) => (
                          i === index
                            ? { ...x, discountType: e.target.value as DraftLine['discountType'] }
                            : x
                        )))}
                      />
                      <Input
                        aria-label={`Discount value on line ${index + 1}`}
                        className="h-8 w-20 text-right"
                        value={line.discountValue}
                        onChange={(e) => setLines((f) => f.map((x, i) => (
                          i === index ? { ...x, discountValue: e.target.value } : x
                        )))}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Tax code on line ${index + 1}`}
                      options={purchaseTaxOptions}
                      value={line.taxCodeId}
                      onChange={(e) => setLines((f) => f.map((x, i) => (
                        i === index ? { ...x, taxCodeId: e.target.value } : x
                      )))}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => setLines((f) => f.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setLines((f) => [...f, blankLine(warehouses[0]?.value ?? '')])}
          >
            Add line
          </Button>
          <Input
            aria-label="Memo"
            placeholder="Memo"
            className="w-72"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <Button onClick={() => { void save(); }} disabled={busy}>
            {busy ? 'Saving…' : editingId ? 'Save draft' : 'Create draft order'}
          </Button>
        </div>
      </Card>

      {/* ── The register ───────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Order</th>
                <th className="px-4 py-2 text-left">Supplier</th>
                <th className="px-4 py-2 text-left">Date</th>
                <th className="px-4 py-2 text-right">Net</th>
                <th className="px-4 py-2 text-right">Est. tax</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={7}>
                    {orderState === 'loading' ? 'Loading…' : 'No purchase orders yet.'}
                  </td>
                </tr>
              )}
              {orders.map((order) => (
                <tr
                  key={order.id}
                  className={`cursor-pointer border-t border-slate-100 dark:border-slate-800 ${
                    order.id === selectedId ? 'bg-slate-50 dark:bg-slate-800/40' : ''
                  }`}
                  onClick={() => setSelectedId(order.id)}
                >
                  <td className="px-4 py-2 font-medium">{order.orderNumber}</td>
                  <td className="px-4 py-2">{order.supplierName}</td>
                  <td className="px-4 py-2">{order.orderDate}</td>
                  <td className="px-4 py-2 text-right">
                    {money(Number(order.total) - Number(order.estimatedTaxTotal), order.currency)}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {money(Number(order.estimatedTaxTotal), order.currency)}
                  </td>
                  <td className="px-4 py-2 text-right">{money(Number(order.total), order.currency)}</td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── The selected order ─────────────────────────────────────────────── */}
      {selected && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">
              {selected.orderNumber} — {selected.supplierName}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {selected.status === 'draft' && (
                <>
                  <Button variant="outline" onClick={() => startEdit(selected)}>Edit</Button>
                  <Button onClick={() => { void act('approve', selected); }} disabled={busy}>
                    Approve
                  </Button>
                </>
              )}
              {selected.status === 'approved' && (
                <Button onClick={() => { void act('issue', selected); }} disabled={busy}>
                  Issue to supplier
                </Button>
              )}
              {['approved', 'issued', 'partially_received', 'received'].includes(selected.status) && (
                <Button variant="outline" onClick={() => { void act('close', selected); }} disabled={busy}>
                  Close balance
                </Button>
              )}
              {['draft', 'approved', 'issued'].includes(selected.status) && (
                <Button variant="outline" onClick={() => { void act('cancel', selected); }} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </div>

          {['approved', 'issued', 'partially_received', 'received', 'draft'].includes(selected.status) && (
            <Input
              aria-label="Reason for closing or cancelling"
              placeholder="Reason (required to close or cancel)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}

          {selected.closureReason && (
            <p className="text-xs text-slate-500">
              {STATUS_LABEL[selected.status]}: {selected.closureReason}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-left">Warehouse</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((line) => (
                  <tr key={line.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2">{line.itemCode} — {line.itemName}</td>
                    <td className="px-3 py-2">{line.warehouseCode}</td>
                    <td className="px-3 py-2 text-right">
                      {line.orderedQuantity} {line.baseUnitCode}
                    </td>
                    <td className="px-3 py-2 text-right">{line.receivedQuantity}</td>
                    <td className="px-3 py-2 text-right font-medium">{line.remainingQuantity}</td>
                    <td className="px-3 py-2 text-right">
                      {money(Number(line.netAmount), selected.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            Received and outstanding quantities are derived by the server from posted receipts.
            Nothing on this screen stores them.
          </p>
        </Card>
      )}
    </div>
  );
}
