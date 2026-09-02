/**
 * Warehouse transfers, on whichever engine this workspace uses.
 *
 * ══ One act, two legs, no journal ════════════════════════════════════════════
 *
 * A transfer is a single business operation: the same quantity leaves one
 * warehouse and arrives in another at the same cost, so no value is created or
 * destroyed and the general ledger has no opinion about it. The server writes
 * both legs in one transaction or neither, which is why this screen posts one
 * document rather than two movements.
 */
import { useEffect, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { generateId } from '@/lib/utils';
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

/** Quantity is text: an exact figure must not pass through a float. */
interface Line { id: string; itemId: string; quantity: string }

export function TransfersPage() {
  const items = useItemOptions(true);
  const warehouses = useWarehouseOptions();
  const { serverBacked, documents, localDocuments, loading, error } = useStockDocuments('transfer');
  const browserTransfer = useInventoryStore((s) => s.postTransfer);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState('');
  const [dest, setDest] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Line>({ id: '', itemId: items[0]?.value ?? '', quantity: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [attemptKey, setAttemptKey] = useState(() => newIdempotencyKey());

  useEffect(() => {
    if (!source && warehouses[0]) setSource(warehouses[0].value);
    if (!dest && warehouses[1]) setDest(warehouses[1].value);
  }, [warehouses, source, dest]);

  const register = serverBacked
    ? documents.slice(0, 10)
    : localDocuments.filter((d) => d.kind === 'transfer').slice(-10).reverse();

  const submit = async (): Promise<void> => {
    if (lines.length === 0) return;

    if (!serverBacked) {
      const res = browserTransfer({
        date,
        reference: '',
        sourceWarehouseId: source,
        destinationWarehouseId: dest,
        lines: lines.map((l) => ({
          id: l.id, itemId: l.itemId, quantity: Number(l.quantity), unitId: 'uom_ea',
        })),
      });
      if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Transfer failed.' }); return; }
      setMsg({ tone: 'success', text: 'Transfer posted (cost-neutral).' });
      setLines([]);
      return;
    }

    setBusy(true);
    try {
      const res = await stockActions().post({
        kind: 'transfer',
        movementDate: date,
        sourceWarehouseId: source,
        destinationWarehouseId: dest,
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() })),
      }, attemptKey);

      if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Transfer failed.' }); return; }
      setMsg({
        tone: 'success',
        text: res.created === false
          ? `Already transferred as ${res.documentNumber}. Nothing moved twice.`
          : `Transferred as ${res.documentNumber}. Cost-neutral: no ledger entry.`,
      });
      setLines([]);
      setAttemptKey(newIdempotencyKey());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Warehouse Transfer</h2>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-slate-500" htmlFor="trf-date">Date</label>
            <Input id="trf-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="trf-from">From</label>
            <Select id="trf-from" options={warehouses} value={source} onChange={(e) => setSource(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="trf-to">To</label>
            <Select id="trf-to" options={warehouses} value={dest} onChange={(e) => setDest(e.target.value)} />
          </div>
        </div>
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_120px_auto]">
          <div>
            <label className="text-xs text-slate-500" htmlFor="trf-item">Item</label>
            <Select id="trf-item" options={items} value={draft.itemId} onChange={(e) => setDraft({ ...draft, itemId: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-slate-500" htmlFor="trf-quantity">Quantity</label>
            <Input id="trf-quantity" inputMode="decimal" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              if (!draft.itemId || !draft.quantity.trim()) return;
              setLines((l) => [...l, { ...draft, id: generateId('l') }]);
              setDraft({ id: '', itemId: items[0]?.value ?? '', quantity: '' });
            }}
          >
            Add line
          </Button>
        </div>
        {lines.length > 0 && (
          <table className="w-full text-sm"><tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1.5">{items.find((i) => i.value === l.itemId)?.label}</td>
                <td className="py-1.5 text-right">{l.quantity}</td>
                <td className="py-1.5 text-right">
                  <button type="button" className="text-xs text-red-600" onClick={() => setLines((x) => x.filter((y) => y.id !== l.id))}>remove</button>
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
        <div className="flex justify-end">
          <Button onClick={() => { void submit(); }} disabled={lines.length === 0 || source === dest || busy}>
            {busy ? 'Posting…' : 'Post transfer'}
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">
          Transfer register {loading && <span className="ml-2 normal-case text-slate-400">loading…</span>}
        </div>
        <table className="w-full text-sm"><tbody>
          {serverBacked
            ? documents.slice(0, 10).map((d) => (
              <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{d.documentNumber}</td>
                <td className="px-4 py-2 text-slate-500">{d.postingDate}</td>
                <td className="px-4 py-2 text-right">
                  {money(d.movements
                    .filter((m) => m.direction === 'out')
                    .reduce((sum, m) => sum + Number(m.totalCost), 0))}
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
            <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No transfers yet.</td></tr>
          )}
        </tbody></table>
      </Card>
    </div>
  );
}
