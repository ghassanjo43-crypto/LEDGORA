import { useMemo } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { buildInventoryReconciliation } from '@/lib/inventoryReconciliation';
import { ENTITY } from '@/lib/inventorySeed';
import { MetricCard } from '@/components/ui/MetricCard';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Boxes, PackageX, PackageCheck, Scale } from 'lucide-react';
import { money, qty, useItemBalances, useSubledgerValue, useMovementLedger } from './InventoryShared';

export function InventoryDashboardPage() {
  const balances = useItemBalances();
  const subledger = useSubledgerValue();
  const movements = useInventoryStore((s) => s.movements);
  const entries = useJournalStore((s) => s.entries);
  const setActiveView = useStore((s) => s.setActiveView);
  const recentLedger = useMovementLedger();

  const stats = useMemo(() => {
    const active = balances.filter((b) => b.item.status === 'active');
    const low = active.filter((b) => b.item.reorderLevel != null && b.quantityOnHand <= (b.item.reorderLevel ?? 0) && b.quantityOnHand > 0);
    const out = active.filter((b) => b.quantityOnHand <= 0 && (b.item.itemType !== 'service' && b.item.itemType !== 'non-inventory'));
    const negative = active.filter((b) => b.quantityOnHand < 0);
    return { activeCount: active.length, low, out, negative };
  }, [balances]);

  const recon = useMemo(
    () => buildInventoryReconciliation({ entityId: ENTITY, movements, journalEntries: entries }),
    [movements, entries],
  );

  const topValue = useMemo(
    () => [...balances].filter((b) => b.inventoryValue > 0).sort((a, b) => b.inventoryValue - a.inventoryValue).slice(0, 6),
    [balances],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Inventory value" value={money(subledger)} icon={Boxes} />
        <MetricCard label="Active items" value={String(stats.activeCount)} icon={PackageCheck} />
        <MetricCard label="Out of stock" value={String(stats.out.length)} icon={PackageX} tone={stats.out.length ? 'amber' : 'slate'} />
        <MetricCard label="Subledger vs GL" value={recon.balanced ? 'Balanced' : money(recon.difference)} icon={Scale} tone={recon.balanced ? 'emerald' : 'red'} />
      </div>

      {stats.negative.length > 0 && (
        <Card className="border-red-200 bg-red-50/50 p-4 dark:border-red-500/30 dark:bg-red-500/10">
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">Negative-stock exceptions</p>
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{stats.negative.map((b) => b.item.code).join(', ')}</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Top value items</h3>
          {topValue.length === 0 ? (
            <p className="text-sm text-slate-400">No stock on hand yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {topValue.map((b) => (
                  <tr key={b.item.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-1.5">{b.item.code} <span className="text-slate-400">{b.item.name}</span></td>
                    <td className="py-1.5 text-right text-slate-500">{qty(b.quantityOnHand)}</td>
                    <td className="py-1.5 text-right font-medium">{money(b.inventoryValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Recent movements</h3>
            <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setActiveView('inventory-movements')}>View ledger</button>
          </div>
          {recentLedger.length === 0 ? (
            <p className="text-sm text-slate-400">No movements yet.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {recentLedger.slice(0, 8).map((r) => (
                <li key={r.movement.id} className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-300">
                    <Badge tone={r.movement.direction === 'in' ? 'green' : 'amber'}>{r.movement.direction}</Badge>{' '}
                    {r.movement.itemSnapshot.code} · {r.movement.movementType}
                  </span>
                  <span className="text-slate-400">{qty(r.movement.quantity)} @ {money(r.movement.unitCostBase)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {stats.low.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Low stock</h3>
          <p className="text-xs text-slate-500">{stats.low.map((b) => `${b.item.code} (${qty(b.quantityOnHand)})`).join(', ')}</p>
        </Card>
      )}
    </div>
  );
}
