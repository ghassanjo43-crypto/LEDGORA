import { useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money, qty, useItemOptions, useWarehouseOptions } from './InventoryShared';

type Mode = 'receipt' | 'issue' | 'adjustment';

interface Line { id: string; itemId: string; warehouseId: string; quantity: number; unitCost: number }

const TITLES: Record<Mode, string> = { receipt: 'Goods Receipt', issue: 'Goods Issue', adjustment: 'Stock Adjustment' };

function DocumentPage({ mode }: { mode: Mode }) {
  const items = useItemOptions(true);
  const warehouses = useWarehouseOptions();
  const documents = useInventoryStore((s) => s.documents);
  const post = useInventoryStore((s) => (mode === 'receipt' ? s.postGoodsReceipt : mode === 'issue' ? s.postGoodsIssue : s.postAdjustment));

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Line>({ id: '', itemId: items[0]?.value ?? '', warehouseId: '', quantity: 0, unitCost: 0 });
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const kind = mode === 'receipt' ? 'receipt' : mode === 'issue' ? 'issue' : 'adjustment';
  const register = useMemo(() => documents.filter((d) => d.kind === kind).slice(-10).reverse(), [documents, kind]);

  const addLine = (): void => {
    if (!draft.itemId || draft.quantity === 0) return;
    setLines((l) => [...l, { ...draft, id: generateId('l'), warehouseId }]);
    setDraft({ id: '', itemId: items[0]?.value ?? '', warehouseId: '', quantity: 0, unitCost: 0 });
  };

  const submit = (): void => {
    if (lines.length === 0) { setMsg({ tone: 'error', text: 'Add at least one line.' }); return; }
    const payload = { date, reference, lines: lines.map((l) => ({ ...l, warehouseId, unitId: 'uom_ea', unitCost: l.unitCost })) };
    const res = post(payload as never);
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Posting failed.' }); return; }
    setMsg({ tone: 'success', text: 'Posted and journalized.' });
    setLines([]);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{TITLES[mode]}</h2>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="text-xs text-slate-500">Date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className="text-xs text-slate-500">Reference</label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <div><label className="text-xs text-slate-500">Warehouse</label><Select options={warehouses} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} /></div>
        </div>

        <div className="grid items-end gap-2 sm:grid-cols-[1fr_100px_120px_auto]">
          <div><label className="text-xs text-slate-500">Item</label><Select options={items} value={draft.itemId} onChange={(e) => setDraft({ ...draft, itemId: e.target.value })} /></div>
          <div><label className="text-xs text-slate-500">{mode === 'adjustment' ? 'Qty (±)' : 'Quantity'}</label><Input type="number" value={draft.quantity || ''} onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })} /></div>
          {mode !== 'issue' && <div><label className="text-xs text-slate-500">Unit cost</label><Input type="number" value={draft.unitCost || ''} onChange={(e) => setDraft({ ...draft, unitCost: Number(e.target.value) })} /></div>}
          <Button variant="outline" onClick={addLine}>Add line</Button>
        </div>

        {lines.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">{items.find((i) => i.value === l.itemId)?.label}</td>
                  <td className="py-1.5 text-right">{qty(l.quantity)}</td>
                  {mode !== 'issue' && <td className="py-1.5 text-right">{money(l.unitCost)}</td>}
                  <td className="py-1.5 text-right"><button className="text-xs text-red-600" onClick={() => setLines((x) => x.filter((y) => y.id !== l.id))}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end"><Button onClick={submit} disabled={lines.length === 0}>Post {TITLES[mode].toLowerCase()}</Button></div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">Register</div>
        <table className="w-full text-sm">
          <tbody>
            {register.map((d) => (
              <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{d.number}</td>
                <td className="px-4 py-2 text-slate-500">{d.date}</td>
                <td className="px-4 py-2 text-right">{money(d.total)}</td>
                <td className="px-4 py-2 text-right"><Badge tone={d.status === 'reversed' ? 'red' : 'green'}>{d.status}</Badge></td>
              </tr>
            ))}
            {register.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No documents yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function GoodsReceiptsPage() { return <DocumentPage mode="receipt" />; }
export function GoodsIssuesPage() { return <DocumentPage mode="issue" />; }
export function AdjustmentsPage() { return <DocumentPage mode="adjustment" />; }
