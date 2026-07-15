import { useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { buildInventoryReconciliation } from '@/lib/inventoryReconciliation';
import { ENTITY } from '@/lib/inventorySeed';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { money, qty, useItemBalances } from './InventoryShared';

type Report = 'valuation' | 'reconciliation' | 'registers';

export function InventoryReportsPage() {
  const [tab, setTab] = useState<Report>('reconciliation');
  const balances = useItemBalances();
  const movements = useInventoryStore((s) => s.movements);
  const documents = useInventoryStore((s) => s.documents);
  const entries = useJournalStore((s) => s.entries);
  const accounts = useStore((s) => s.accounts);
  const [asOf, setAsOf] = useState('');

  const recon = useMemo(
    () => buildInventoryReconciliation({ entityId: ENTITY, movements, journalEntries: entries, asOfDate: asOf || undefined }),
    [movements, entries, asOf],
  );
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.code ?? id;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['reconciliation', 'valuation', 'registers'] as Report[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={'rounded-lg px-3 py-1.5 text-sm ' + (tab === t ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
            {t === 'reconciliation' ? 'GL Reconciliation' : t === 'valuation' ? 'Valuation' : 'Registers'}
          </button>
        ))}
      </div>

      {tab === 'reconciliation' && (
        <div className="space-y-3">
          <Card className="flex items-end gap-3 p-4">
            <div><label className="text-xs text-slate-500">As of date</label><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
            <div className="ml-auto text-right">
              {recon.balanced
                ? <Badge tone="green">Subledger reconciles to GL</Badge>
                : <Badge tone="red">Difference {money(recon.difference)}</Badge>}
            </div>
          </Card>
          {!recon.balanced && <Alert variant="warning" title="Reconciliation difference">The inventory subledger does not match the General Ledger inventory account balance. Review the accounts below.</Alert>}
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Inventory account</th><th className="px-4 py-2 text-right">Subledger</th><th className="px-4 py-2 text-right">GL balance</th><th className="px-4 py-2 text-right">Difference</th></tr></thead>
              <tbody>
                {recon.byAccount.map((r) => (
                  <tr key={r.accountId} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 font-medium">{accountName(r.accountId)}</td>
                    <td className="px-4 py-2 text-right">{money(r.subledgerValue)}</td>
                    <td className="px-4 py-2 text-right">{money(r.glBalance)}</td>
                    <td className={'px-4 py-2 text-right font-medium ' + (Math.abs(r.difference) > 0.005 ? 'text-red-600' : 'text-emerald-600')}>{money(r.difference)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200 font-semibold dark:border-slate-700">
                  <td className="px-4 py-2">Total</td><td className="px-4 py-2 text-right">{money(recon.subledgerValue)}</td><td className="px-4 py-2 text-right">{money(recon.glBalance)}</td><td className="px-4 py-2 text-right">{money(recon.difference)}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {tab === 'valuation' && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Item</th><th className="px-4 py-2 text-right">On hand</th><th className="px-4 py-2 text-right">Avg cost</th><th className="px-4 py-2 text-right">Value</th></tr></thead>
            <tbody>
              {balances.filter((b) => b.quantityOnHand !== 0 || b.inventoryValue !== 0).map((b) => (
                <tr key={b.item.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{b.item.code}</td><td className="px-4 py-2">{b.item.name}</td><td className="px-4 py-2 text-right">{qty(b.quantityOnHand)}</td><td className="px-4 py-2 text-right">{money(b.averageUnitCost)}</td><td className="px-4 py-2 text-right font-medium">{money(b.inventoryValue)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'registers' && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Document</th><th className="px-4 py-2 text-left">Kind</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-right">Value</th><th className="px-4 py-2 text-left">Journal</th><th className="px-4 py-2 text-right">Status</th></tr></thead>
            <tbody>
              {[...documents].reverse().map((d) => (
                <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.number}</td><td className="px-4 py-2">{d.kind}</td><td className="px-4 py-2 text-slate-500">{d.date}</td><td className="px-4 py-2 text-right">{money(d.total)}</td><td className="px-4 py-2 text-xs text-slate-400">{d.journalEntryId ? '✓' : '—'}</td><td className="px-4 py-2 text-right"><Badge tone={d.status === 'reversed' ? 'red' : 'green'}>{d.status}</Badge></td></tr>
              ))}
              {documents.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No documents yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
