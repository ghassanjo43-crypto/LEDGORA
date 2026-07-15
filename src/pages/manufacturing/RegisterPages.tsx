/** Manufacturing document registers (material issues/returns, receipts, scrap). */
import { useManufacturingStore } from '@/store/manufacturingStore';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { money, qty, useItemName } from './ManufacturingShared';

function Reg({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}
function statusBadge(status: string) {
  return <Badge tone={status === 'posted' ? 'green' : status === 'reversed' ? 'red' : 'amber'}>{status}</Badge>;
}
const empty = (c: number, t: string) => <tr><td colSpan={c} className="px-4 py-8 text-center text-slate-400">{t}</td></tr>;
const woNumber = (id: string) => useManufacturingStore.getState().workOrders.find((w) => w.id === id)?.workOrderNumber ?? id;

export function MaterialIssuesPage() {
  const docs = useManufacturingStore((s) => s.materialIssues);
  return (
    <Reg head={['Issue', 'Work order', 'Date', 'Lines', 'Cost', 'Journal', 'Status']}>
      {[...docs].reverse().map((d) => (
        <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.issueNumber}</td><td className="px-4 py-2">{woNumber(d.workOrderId)}</td><td className="px-4 py-2 text-slate-500">{d.postingDate}</td><td className="px-4 py-2">{d.lines.length}</td><td className="px-4 py-2">{money(d.totalCost)}</td><td className="px-4 py-2 text-xs text-slate-400">{d.journalEntryId ? '✓' : '—'}</td><td className="px-4 py-2">{statusBadge(d.status)}</td></tr>
      ))}
      {docs.length === 0 && empty(7, 'No material issues.')}
    </Reg>
  );
}

export function MaterialReturnsPage() {
  const docs = useManufacturingStore((s) => s.materialReturns);
  return (
    <Reg head={['Return', 'Work order', 'Date', 'Cost', 'Status']}>
      {[...docs].reverse().map((d) => (<tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.returnNumber}</td><td className="px-4 py-2">{woNumber(d.workOrderId)}</td><td className="px-4 py-2 text-slate-500">{d.postingDate}</td><td className="px-4 py-2">{money(d.totalCost)}</td><td className="px-4 py-2">{statusBadge(d.status)}</td></tr>))}
      {docs.length === 0 && empty(5, 'No material returns.')}
    </Reg>
  );
}

export function ProductionReceiptsPage() {
  const docs = useManufacturingStore((s) => s.productionReceipts);
  const reverse = useManufacturingStore((s) => s.reverseProductionReceipt);
  return (
    <Reg head={['Receipt', 'Work order', 'Date', 'Qty', 'Unit cost', 'Total', 'Status', '']}>
      {[...docs].reverse().map((d) => (
        <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.receiptNumber}</td><td className="px-4 py-2">{woNumber(d.workOrderId)}</td><td className="px-4 py-2 text-slate-500">{d.postingDate}</td><td className="px-4 py-2">{qty(d.completedQuantity)}</td><td className="px-4 py-2">{money(d.costSnapshot.unitCost)}</td><td className="px-4 py-2">{money(d.costSnapshot.totalCost)}</td><td className="px-4 py-2">{statusBadge(d.status)}</td><td className="px-4 py-2 text-right">{d.status === 'posted' && <button className="text-xs text-red-600 hover:underline" onClick={() => reverse(d.id)}>Reverse</button>}</td></tr>
      ))}
      {docs.length === 0 && empty(8, 'No production receipts.')}
    </Reg>
  );
}

export function ManufacturingScrapPage() {
  const docs = useManufacturingStore((s) => s.scraps);
  const itemName = useItemName();
  return (
    <Reg head={['Scrap', 'Work order', 'Item', 'Qty', 'Reason', 'Policy', 'Cost', 'Status']}>
      {[...docs].reverse().map((d) => (
        <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{d.scrapNumber}</td><td className="px-4 py-2">{woNumber(d.workOrderId)}</td><td className="px-4 py-2">{itemName(d.itemId)}</td><td className="px-4 py-2">{qty(d.quantity)}</td><td className="px-4 py-2 text-slate-500">{d.reason}</td><td className="px-4 py-2 text-xs">{d.accountingPolicy === 'normal-to-product-cost' ? 'recoverable' : 'abnormal'}</td><td className="px-4 py-2">{money(d.totalCost)}</td><td className="px-4 py-2">{statusBadge(d.status)}</td></tr>
      ))}
      {docs.length === 0 && empty(8, 'No scrap.')}
    </Reg>
  );
}
