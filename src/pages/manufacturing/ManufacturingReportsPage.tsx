import { useMemo, useState } from 'react';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { calculateWorkOrderWip, calculateActualWorkOrderCost, calculateVariance } from '@/lib/manufacturingCosting';
import { buildManufacturingReconciliation } from '@/lib/manufacturingReconciliation';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money, useItemName } from './ManufacturingShared';

type Tab = 'wip' | 'variance' | 'reconciliation';

export function ManufacturingReportsPage() {
  const store = useManufacturingStore((s) => s);
  const entries = useJournalStore((s) => s.entries);
  const itemName = useItemName();
  const [tab, setTab] = useState<Tab>('wip');

  const activity = useMemo(() => ({ issues: store.materialIssues, returns: store.materialReturns, receipts: store.productionReceipts, operationCosts: store.operationCosts, scraps: store.scraps }), [store]);
  const wipAccountId = useMemo(() => useStore.getState().accounts.find((a) => a.code === '1212')?.id, []);
  const recon = useMemo(() => buildManufacturingReconciliation({ workOrders: store.workOrders, activity, journalEntries: entries, wipAccountId }), [store.workOrders, activity, entries, wipAccountId]);

  const rows = useMemo(() => store.workOrders.map((w) => {
    const wip = calculateWorkOrderWip(w.id, activity);
    const actual = calculateActualWorkOrderCost(w.id, activity);
    const variance = calculateVariance(w.standardCostSnapshot.unitCost, w.standardCostSnapshot, actual);
    return { w, wip, actual, variance };
  }), [store.workOrders, activity]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['wip', 'variance', 'reconciliation'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={'rounded-lg px-3 py-1.5 text-sm ' + (tab === t ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
            {t === 'wip' ? 'WIP by Work Order' : t === 'variance' ? 'Standard vs Actual' : 'GL Reconciliation'}
          </button>
        ))}
      </div>

      {tab === 'wip' && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Work order</th><th className="px-4 py-2 text-right">Issued</th><th className="px-4 py-2 text-right">Conversion</th><th className="px-4 py-2 text-right">Received</th><th className="px-4 py-2 text-right">Scrap</th><th className="px-4 py-2 text-right">WIP</th></tr></thead>
            <tbody>
              {rows.map(({ w, wip }) => (
                <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{w.workOrderNumber}</td><td className="px-4 py-2 text-right">{money(wip.materialsIssued - wip.materialsReturned)}</td><td className="px-4 py-2 text-right">{money(wip.laborAbsorbed + wip.machineAbsorbed + wip.overheadAbsorbed)}</td><td className="px-4 py-2 text-right">{money(wip.finishedGoodsReceived)}</td><td className="px-4 py-2 text-right">{money(wip.recoverableScrap)}</td><td className="px-4 py-2 text-right font-semibold">{money(wip.remainingWip)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'variance' && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Work order</th><th className="px-4 py-2 text-left">Product</th><th className="px-4 py-2 text-right">Std (output)</th><th className="px-4 py-2 text-right">Actual</th><th className="px-4 py-2 text-right">Variance</th></tr></thead>
            <tbody>
              {rows.map(({ w, variance }) => (
                <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{w.workOrderNumber}</td><td className="px-4 py-2">{itemName(w.productItemId)}</td><td className="px-4 py-2 text-right">{money(variance.standardCostForOutput)}</td><td className="px-4 py-2 text-right">{money(variance.actualCostForOutput)}</td><td className={'px-4 py-2 text-right font-medium ' + (variance.totalVariance > 0 ? 'text-red-600' : 'text-emerald-600')}>{money(variance.totalVariance)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'reconciliation' && (
        <div className="space-y-3">
          {recon.balanced ? <Badge tone="green">WIP subledger reconciles to the GL</Badge> : <Alert variant="warning" title="Reconciliation difference">The manufacturing WIP subledger does not match the GL Work-in-Progress account.</Alert>}
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Account</th><th className="px-4 py-2 text-right">Subledger</th><th className="px-4 py-2 text-right">GL balance</th><th className="px-4 py-2 text-right">Difference</th></tr></thead>
              <tbody>
                {recon.rows.map((r) => (
                  <tr key={r.accountId || r.label} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{r.label}</td><td className="px-4 py-2 text-right">{money(r.subledger)}</td><td className="px-4 py-2 text-right">{money(r.glBalance)}</td><td className={'px-4 py-2 text-right font-medium ' + (Math.abs(r.difference) > 0.01 ? 'text-red-600' : 'text-emerald-600')}>{money(r.difference)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
