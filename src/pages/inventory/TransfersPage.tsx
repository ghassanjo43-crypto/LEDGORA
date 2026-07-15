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

interface Line { id: string; itemId: string; quantity: number }

export function TransfersPage() {
  const items = useItemOptions(true);
  const warehouses = useWarehouseOptions();
  const documents = useInventoryStore((s) => s.documents);
  const postTransfer = useInventoryStore((s) => s.postTransfer);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState(warehouses[0]?.value ?? '');
  const [dest, setDest] = useState(warehouses[1]?.value ?? '');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Line>({ id: '', itemId: items[0]?.value ?? '', quantity: 0 });
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const register = useMemo(() => documents.filter((d) => d.kind === 'transfer').slice(-10).reverse(), [documents]);

  const submit = (): void => {
    if (lines.length === 0) return;
    const res = postTransfer({ date, reference: '', sourceWarehouseId: source, destinationWarehouseId: dest, lines: lines.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity, unitId: 'uom_ea' })) });
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Transfer failed.' }); return; }
    setMsg({ tone: 'success', text: 'Transfer posted (cost-neutral).' });
    setLines([]);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Warehouse Transfer</h2>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="text-xs text-slate-500">Date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className="text-xs text-slate-500">From</label><Select options={warehouses} value={source} onChange={(e) => setSource(e.target.value)} /></div>
          <div><label className="text-xs text-slate-500">To</label><Select options={warehouses} value={dest} onChange={(e) => setDest(e.target.value)} /></div>
        </div>
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_120px_auto]">
          <div><label className="text-xs text-slate-500">Item</label><Select options={items} value={draft.itemId} onChange={(e) => setDraft({ ...draft, itemId: e.target.value })} /></div>
          <div><label className="text-xs text-slate-500">Quantity</label><Input type="number" value={draft.quantity || ''} onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })} /></div>
          <Button variant="outline" onClick={() => { if (draft.itemId && draft.quantity > 0) { setLines((l) => [...l, { ...draft, id: generateId('l') }]); setDraft({ id: '', itemId: items[0]?.value ?? '', quantity: 0 }); } }}>Add line</Button>
        </div>
        {lines.length > 0 && (
          <table className="w-full text-sm"><tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1.5">{items.find((i) => i.value === l.itemId)?.label}</td><td className="py-1.5 text-right">{qty(l.quantity)}</td><td className="py-1.5 text-right"><button className="text-xs text-red-600" onClick={() => setLines((x) => x.filter((y) => y.id !== l.id))}>remove</button></td></tr>
            ))}
          </tbody></table>
        )}
        <div className="flex justify-end"><Button onClick={submit} disabled={lines.length === 0 || source === dest}>Post transfer</Button></div>
      </Card>
      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">Transfer register</div>
        <table className="w-full text-sm"><tbody>
          {register.map((d) => (
            <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.number}</td><td className="px-4 py-2 text-slate-500">{d.date}</td><td className="px-4 py-2 text-right">{money(d.total)}</td><td className="px-4 py-2 text-right"><Badge tone={d.status === 'reversed' ? 'red' : 'green'}>{d.status}</Badge></td></tr>
          ))}
          {register.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No transfers yet.</td></tr>}
        </tbody></table>
      </Card>
    </div>
  );
}
