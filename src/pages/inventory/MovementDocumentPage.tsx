/**
 * Goods receipts, goods issues and stock adjustments, on whichever engine this
 * workspace uses.
 *
 * ══ A durable subscriber posts to the server, or not at all ══════════════════
 *
 * Every durable write goes through `stockActions()`. There is no fallback to
 * the browser posting engine, because a receipt written into browser storage
 * looks posted, is not in the books, and would be silently replaced by the next
 * load — after somebody had already acted on the quantity.
 *
 * ══ The idempotency key belongs to the ATTEMPT ═══════════════════════════════
 *
 * It is minted when the form is filled, not when the request is sent, so a
 * retry after a timeout carries the same key and the server answers with the
 * document it already made. A key generated per call would turn every retry
 * into a second receipt.
 */
import { useEffect, useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { generateId } from '@/lib/utils';
import { eligiblePostingAccounts } from '@/lib/accountEligibility';
import { stockActions } from '@/services/inventory/inventoryActions';
import { useStockDocuments } from '@/services/inventory/useStock';
import { newIdempotencyKey } from '@/services/inventory/inventoryBackend';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money, useItemOptions, useWarehouseOptions } from './InventoryShared';

type Mode = 'receipt' | 'issue' | 'adjustment';

interface Line {
  id: string;
  itemId: string;
  warehouseId: string;
  /** Text, not a number: an exact quantity must not pass through a float. */
  quantity: string;
  unitCost: string;
  direction: 'in' | 'out';
}

const TITLES: Record<Mode, string> = {
  receipt: 'Goods Receipt', issue: 'Goods Issue', adjustment: 'Stock Adjustment',
};

function DocumentPage({ mode }: { mode: Mode }) {
  const items = useItemOptions(true);
  const warehouses = useWarehouseOptions();
  const accounts = useStore((s) => s.accounts);
  const { serverBacked, documents, localDocuments, loading, error } = useStockDocuments(mode);
  const browserPost = useInventoryStore((s) => (
    mode === 'receipt' ? s.postGoodsReceipt : mode === 'issue' ? s.postGoodsIssue : s.postAdjustment
  ));

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Line>({
    id: '', itemId: items[0]?.value ?? '', warehouseId: '',
    quantity: '', unitCost: '', direction: 'in',
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  /* One key per attempt: refreshed only once a document has actually posted. */
  const [attemptKey, setAttemptKey] = useState(() => newIdempotencyKey());

  useEffect(() => {
    if (!warehouseId && warehouses[0]) setWarehouseId(warehouses[0].value);
  }, [warehouses, warehouseId]);

  const expenseOptions = useMemo(() => [
    { value: '', label: 'Use the inventory profile default' },
    ...eligiblePostingAccounts({ accounts, purpose: 'purchase-expense' })
      .map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` })),
  ], [accounts]);

  const register = serverBacked
    ? documents.slice(0, 10)
    : localDocuments.filter((d) => d.kind === mode).slice(-10).reverse();

  const addLine = (): void => {
    if (!draft.itemId || !draft.quantity.trim()) return;
    setLines((current) => [...current, { ...draft, id: generateId('l'), warehouseId }]);
    setDraft({
      id: '', itemId: items[0]?.value ?? '', warehouseId: '',
      quantity: '', unitCost: '', direction: 'in',
    });
  };

  const submit = async (): Promise<void> => {
    if (lines.length === 0) { setMsg({ tone: 'error', text: 'Add at least one line.' }); return; }

    if (!serverBacked) {
      /* Free Demo: the browser posting engine, exactly as before this slice. */
      const payload = {
        date,
        reference,
        lines: lines.map((line) => ({
          ...line, warehouseId, unitId: 'uom_ea',
          quantity: Number(line.quantity), unitCost: Number(line.unitCost),
        })),
      };
      const res = browserPost(payload as never);
      if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Posting failed.' }); return; }
      setMsg({ tone: 'success', text: 'Posted and journalized.' });
      setLines([]);
      return;
    }

    setBusy(true);
    try {
      const res = await stockActions().post({
        kind: mode,
        movementDate: date,
        reference,
        reason: mode === 'adjustment' ? reason : undefined,
        lines: lines.map((line) => ({
          itemId: line.itemId,
          warehouseId,
          quantity: line.quantity.trim(),
          unitCost: mode === 'issue' ? undefined : (line.unitCost.trim() || undefined),
          expenseAccountId: mode === 'issue' ? (expenseAccountId || undefined) : undefined,
          direction: mode === 'adjustment' ? line.direction : undefined,
        })),
      }, attemptKey);

      if (!res.ok) {
        /* The SERVER's words: insufficient stock, a locked period, a missing
         * account and a backdated posting each say something different. */
        setMsg({ tone: 'error', text: res.error ?? 'Posting failed.' });
        return;
      }
      setMsg({
        tone: 'success',
        text: res.created === false
          ? `Already posted as ${res.documentNumber}. Nothing was recorded twice.`
          : `Posted as ${res.documentNumber}, with its journal.`,
      });
      setLines([]);
      setReason('');
      /* A new attempt gets a new key; a retry of THIS one would have reused it. */
      setAttemptKey(newIdempotencyKey());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{TITLES[mode]}</h2>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-slate-500" htmlFor="doc-date">Date</label>
            <Input id="doc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="doc-reference">Reference</label>
            <Input id="doc-reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="doc-warehouse">Warehouse</label>
            <Select id="doc-warehouse" options={warehouses} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
          </div>
        </div>

        {/* Stock does not change itself: the server refuses an unexplained one. */}
        {mode === 'adjustment' && (
          <div>
            <label className="text-xs text-slate-500" htmlFor="doc-reason">Reason (required)</label>
            <Input
              id="doc-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why the quantity changed"
            />
          </div>
        )}

        {mode === 'issue' && serverBacked && (
          <div>
            <label className="text-xs text-slate-500" htmlFor="doc-expense">Expense account</label>
            <Select id="doc-expense" options={expenseOptions} value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)} />
          </div>
        )}

        <div className="grid items-end gap-2 sm:grid-cols-[1fr_110px_120px_110px_auto]">
          <div>
            <label className="text-xs text-slate-500" htmlFor="line-item">Item</label>
            <Select id="line-item" options={items} value={draft.itemId} onChange={(e) => setDraft({ ...draft, itemId: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="line-quantity">Quantity</label>
            <Input id="line-quantity" inputMode="decimal" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
          </div>
          {mode !== 'issue' && (
            <div>
              <label className="text-xs text-slate-500" htmlFor="line-cost">Unit cost</label>
              <Input id="line-cost" inputMode="decimal" value={draft.unitCost} onChange={(e) => setDraft({ ...draft, unitCost: e.target.value })} />
            </div>
          )}
          {mode === 'adjustment' && (
            <div>
              <label className="text-xs text-slate-500" htmlFor="line-direction">Direction</label>
              <Select
                id="line-direction"
                options={[{ value: 'in', label: 'Increase' }, { value: 'out', label: 'Decrease' }]}
                value={draft.direction}
                onChange={(e) => setDraft({ ...draft, direction: e.target.value as 'in' | 'out' })}
              />
            </div>
          )}
          <Button variant="outline" onClick={addLine}>Add line</Button>
        </div>

        {lines.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">{items.find((i) => i.value === line.itemId)?.label}</td>
                  <td className="py-1.5 text-right">
                    {mode === 'adjustment' ? `${line.direction === 'out' ? '−' : '+'}${line.quantity}` : line.quantity}
                  </td>
                  {mode !== 'issue' && <td className="py-1.5 text-right">{line.unitCost || '—'}</td>}
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      className="text-xs text-red-600"
                      onClick={() => setLines((x) => x.filter((y) => y.id !== line.id))}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end">
          <Button onClick={() => { void submit(); }} disabled={lines.length === 0 || busy}>
            {busy ? 'Posting…' : `Post ${TITLES[mode].toLowerCase()}`}
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">
          Register {loading && <span className="ml-2 normal-case text-slate-400">loading…</span>}
        </div>
        <table className="w-full text-sm">
          <tbody>
            {serverBacked
              ? documents.slice(0, 10).map((d) => (
                <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{d.documentNumber}</td>
                  <td className="px-4 py-2 text-slate-500">{d.postingDate}</td>
                  <td className="px-4 py-2 text-right">
                    {money(d.movements.reduce((sum, m) => sum + Number(m.totalCost), 0))}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Badge tone={d.status === 'reversed' ? 'red' : 'green'}>{d.status}</Badge>
                  </td>
                </tr>
              ))
              : register.map((d) => (
                <tr key={(d as { id: string }).id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{(d as { number: string }).number}</td>
                  <td className="px-4 py-2 text-slate-500">{(d as { date: string }).date}</td>
                  <td className="px-4 py-2 text-right">{money((d as { total: number }).total)}</td>
                  <td className="px-4 py-2 text-right">
                    <Badge tone={(d as { status: string }).status === 'reversed' ? 'red' : 'green'}>
                      {(d as { status: string }).status}
                    </Badge>
                  </td>
                </tr>
              ))}
            {register.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No documents yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function GoodsReceiptsPage() { return <DocumentPage mode="receipt" />; }
export function GoodsIssuesPage() { return <DocumentPage mode="issue" />; }
export function AdjustmentsPage() { return <DocumentPage mode="adjustment" />; }
