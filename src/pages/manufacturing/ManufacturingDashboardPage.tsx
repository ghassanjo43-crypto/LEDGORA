import { useMemo } from 'react';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { getInventoryValue } from '@/lib/inventoryBalance';
import { calculateWorkOrderWip } from '@/lib/manufacturingCosting';
import { buildManufacturingReconciliation } from '@/lib/manufacturingReconciliation';
import { ENTITY } from '@/lib/inventorySeed';
import { MetricCard } from '@/components/ui/MetricCard';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Factory, Boxes, Scale, AlertTriangle } from 'lucide-react';
import { money, qty, statusTone } from './ManufacturingShared';

export function ManufacturingDashboardPage() {
  const store = useManufacturingStore((s) => s);
  const movements = useInventoryStore((s) => s.movements);
  const entries = useJournalStore((s) => s.entries);
  const setActiveView = useStore((s) => s.setActiveView);

  const stats = useMemo(() => {
    const open = store.workOrders.filter((w) => !['closed', 'cancelled'].includes(w.status));
    const released = store.workOrders.filter((w) => w.status === 'released' || w.status === 'in-progress' || w.status === 'partially-completed');
    const planned = store.workOrders.reduce((s, w) => s + (['closed', 'cancelled'].includes(w.status) ? 0 : w.plannedQuantity), 0);
    const completed = store.workOrders.reduce((s, w) => s + w.completedQuantity, 0);
    const activity = { issues: store.materialIssues, returns: store.materialReturns, receipts: store.productionReceipts, operationCosts: store.operationCosts, scraps: store.scraps };
    const wip = store.workOrders.reduce((s, w) => s + calculateWorkOrderWip(w.id, activity).remainingWip, 0);
    const scrapQty = store.scraps.filter((d) => d.status === 'posted').reduce((s, d) => s + d.quantity, 0);
    return { open, released, planned, completed, wip, scrapQty };
  }, [store]);

  const wipAccountId = useMemo(() => useStore.getState().accounts.find((a) => a.code === '1212')?.id, []);
  const recon = useMemo(() => buildManufacturingReconciliation({ workOrders: store.workOrders, activity: { issues: store.materialIssues, returns: store.materialReturns, receipts: store.productionReceipts, operationCosts: store.operationCosts, scraps: store.scraps }, journalEntries: entries, wipAccountId }), [store, entries, wipAccountId]);

  const rmValue = useMemo(() => ['mfg_steel', 'mfg_bolt', 'mfg_paint'].reduce((s, id) => s + getInventoryValue(movements, { entityId: ENTITY, itemId: id }), 0), [movements]);
  const fgValue = useMemo(() => getInventoryValue(movements, { entityId: ENTITY, itemId: 'mfg_cabinet' }), [movements]);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Open work orders" value={String(stats.open.length)} icon={Factory} />
        <MetricCard label="WIP value" value={money(stats.wip)} icon={Boxes} tone="amber" />
        <MetricCard label="Completed output" value={qty(stats.completed)} icon={Factory} tone="emerald" />
        <MetricCard label="WIP subledger vs GL" value={recon.balanced ? 'Balanced' : money(recon.wipDifference)} icon={Scale} tone={recon.balanced ? 'emerald' : 'red'} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Raw material value" value={money(rmValue)} icon={Boxes} tone="slate" />
        <MetricCard label="Finished goods value" value={money(fgValue)} icon={Boxes} tone="slate" />
        <MetricCard label="Scrap quantity" value={qty(stats.scrapQty)} icon={AlertTriangle} tone={stats.scrapQty ? 'amber' : 'slate'} />
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Work orders</h3>
          <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setActiveView('manufacturing-work-orders')}>Open work orders</button>
        </div>
        {store.workOrders.length === 0 ? (
          <p className="text-sm text-slate-400">No work orders yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {store.workOrders.slice(0, 8).map((w) => (
                <tr key={w.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-1.5 font-medium">{w.workOrderNumber}</td>
                  <td className="py-1.5 text-slate-500">{qty(w.completedQuantity)} / {qty(w.plannedQuantity)}</td>
                  <td className="py-1.5 text-right"><Badge tone={statusTone(w.status)}>{w.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
