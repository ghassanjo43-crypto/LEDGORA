import { useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import { ENTITY } from '@/lib/inventorySeed';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money, qty, useWarehouseOptions } from './InventoryShared';

interface CountLine { id: string; itemId: string; code: string; systemQuantity: number; frozenUnitCost: number; countedQuantity: number }

export function StockCountsPage() {
  const warehouses = useWarehouseOptions();
  const items = useInventoryStore((s) => s.items);
  const movements = useInventoryStore((s) => s.movements);
  const documents = useInventoryStore((s) => s.documents);
  const postStockCount = useInventoryStore((s) => s.postStockCount);

  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [frozen, setFrozen] = useState<CountLine[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const register = useMemo(() => documents.filter((d) => d.kind === 'count').slice(-10).reverse(), [documents]);

  const startCount = (): void => {
    const lines: CountLine[] = items
      .filter((i) => i.status === 'active' && i.itemType !== 'service' && i.itemType !== 'non-inventory')
      .map((i) => {
        const bal = getInventoryBalance(movements, { entityId: ENTITY, itemId: i.id, warehouseId });
        return { id: generateId('c'), itemId: i.id, code: `${i.code} — ${i.name}`, systemQuantity: bal.quantityOnHand, frozenUnitCost: bal.averageUnitCost, countedQuantity: bal.quantityOnHand };
      });
    setFrozen(lines);
    setMsg({ tone: 'success', text: 'System quantities frozen. Enter counted quantities and post variances.' });
  };

  const post = (): void => {
    if (!frozen) return;
    const res = postStockCount({ date: new Date().toISOString().slice(0, 10), reference: '', warehouseId, lines: frozen.map((l) => ({ id: l.id, itemId: l.itemId, warehouseId, systemQuantity: l.systemQuantity, countedQuantity: l.countedQuantity, frozenUnitCost: l.frozenUnitCost })) });
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'No variance to post.' }); return; }
    setMsg({ tone: 'success', text: 'Variances posted through the General Journal.' });
    setFrozen(null);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Stock Count</h2>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-64"><label className="text-xs text-slate-500">Warehouse</label><Select options={warehouses} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} /></div>
        <Button variant="outline" onClick={startCount}>Start count (freeze)</Button>
        {frozen && <Button onClick={post}>Post variances</Button>}
      </Card>

      {frozen && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Item</th><th className="px-4 py-2 text-right">System</th><th className="px-4 py-2 text-right">Counted</th><th className="px-4 py-2 text-right">Variance</th><th className="px-4 py-2 text-right">Cost</th></tr></thead>
            <tbody>
              {frozen.map((l, idx) => (
                <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2">{l.code}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{qty(l.systemQuantity)}</td>
                  <td className="px-4 py-2 text-right"><Input type="number" className="h-8 w-24 text-right" value={l.countedQuantity} onChange={(e) => setFrozen((f) => f!.map((x, i) => (i === idx ? { ...x, countedQuantity: Number(e.target.value) } : x)))} /></td>
                  <td className="px-4 py-2 text-right font-medium">{qty(l.countedQuantity - l.systemQuantity)}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{money(l.frozenUnitCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">Count register</div>
        <table className="w-full text-sm"><tbody>
          {register.map((d) => (<tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.number}</td><td className="px-4 py-2 text-slate-500">{d.date}</td><td className="px-4 py-2 text-right">{money(d.total)}</td><td className="px-4 py-2 text-right"><Badge tone={d.status === 'reversed' ? 'red' : 'green'}>{d.status}</Badge></td></tr>))}
          {register.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No counts yet.</td></tr>}
        </tbody></table>
      </Card>
    </div>
  );
}
