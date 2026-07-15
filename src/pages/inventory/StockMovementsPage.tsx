import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { money, qty, useItemOptions, useWarehouseOptions, useMovementLedger, movementsToCsv, downloadCsv } from './InventoryShared';

export function StockMovementsPage() {
  const items = useItemOptions();
  const warehouses = useWarehouseOptions();
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const rows = useMovementLedger({ itemId: itemId || undefined, warehouseId: warehouseId || undefined });

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-64"><label className="text-xs text-slate-500">Item</label><Select options={[{ value: '', label: 'All items' }, ...items]} value={itemId} onChange={(e) => setItemId(e.target.value)} /></div>
        <div className="w-56"><label className="text-xs text-slate-500">Warehouse</label><Select options={[{ value: '', label: 'All warehouses' }, ...warehouses]} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} /></div>
        <div className="ml-auto"><Button variant="outline" onClick={() => downloadCsv('stock-movements.csv', movementsToCsv(rows))}>Export CSV</Button></div>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Movement</th><th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Item</th><th className="px-3 py-2 text-left">Warehouse</th>
              <th className="px-3 py-2 text-right">In</th><th className="px-3 py-2 text-right">Out</th><th className="px-3 py-2 text-right">Run qty</th>
              <th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">Run value</th><th className="px-3 py-2 text-left">Journal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = r.movement;
              return (
                <tr key={m.id} className={'border-t border-slate-100 dark:border-slate-800 ' + (m.status === 'reversed' ? 'text-slate-400 line-through' : '')}>
                  <td className="px-3 py-1.5">{m.postingDate}</td>
                  <td className="px-3 py-1.5 font-medium">{m.movementNumber}</td>
                  <td className="px-3 py-1.5"><Badge tone={m.direction === 'in' ? 'green' : 'amber'}>{m.movementType}</Badge></td>
                  <td className="px-3 py-1.5">{m.itemSnapshot.code}</td>
                  <td className="px-3 py-1.5">{m.warehouseSnapshot.code}</td>
                  <td className="px-3 py-1.5 text-right">{m.direction === 'in' ? qty(m.quantity) : ''}</td>
                  <td className="px-3 py-1.5 text-right">{m.direction === 'out' ? qty(m.quantity) : ''}</td>
                  <td className="px-3 py-1.5 text-right">{qty(r.runningQty)}</td>
                  <td className="px-3 py-1.5 text-right">{money(m.unitCostBase)}</td>
                  <td className="px-3 py-1.5 text-right">{money(r.runningValue)}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-400">{m.journalEntryId ? '✓' : '—'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">No stock movements.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
