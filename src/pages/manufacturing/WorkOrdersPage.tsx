import { useMemo, useState } from 'react';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import type { ManufacturingWorkOrder } from '@/types/manufacturingDocuments';
import { allowedTransitions } from '@/lib/workOrderLifecycle';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { money, qty, statusTone, useItemName, useWorkOrderMetrics } from './ManufacturingShared';

export function WorkOrdersPage() {
  const workOrders = useManufacturingStore((s) => s.workOrders);
  const boms = useManufacturingStore((s) => s.boms);
  const routings = useManufacturingStore((s) => s.routings);
  const plants = useManufacturingStore((s) => s.plants);
  const create = useManufacturingStore((s) => s.createWorkOrder);
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const itemName = useItemName();

  const productOptions = useMemo(() => boms.filter((b) => b.status === 'approved').map((b) => ({ value: b.id, label: `${itemName(b.productItemId)} · ${b.code} v${b.version}` })), [boms, itemName]);

  const [form, setForm] = useState({ bomId: '', quantity: 10, plantId: '' });
  const submitCreate = (): void => {
    const bom = boms.find((b) => b.id === form.bomId);
    const routing = routings.find((r) => r.productItemId === bom?.productItemId && r.status === 'approved');
    const plant = plants.find((p) => p.id === form.plantId) ?? plants[0];
    if (!bom || !routing || !plant) { setMsg({ tone: 'error', text: 'Select an approved BOM (its product needs an approved routing) and a plant.' }); return; }
    const res = create({ productItemId: bom.productItemId, bomId: bom.id, routingId: routing.id, plannedQuantity: Number(form.quantity), plantId: plant.id, costCenterId: plant.defaultCostCenterId ?? costCenters[0]?.id ?? '', plannedStartDate: new Date().toISOString().slice(0, 10), plannedEndDate: new Date().toISOString().slice(0, 10) });
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Could not create work order.' }); return; }
    setCreating(false); setMsg({ tone: 'success', text: 'Work order created (draft).' });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setCreating(true); }}>New work order</Button></div>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">WO</th><th className="px-4 py-2 text-left">Product</th><th className="px-4 py-2 text-right">Planned</th><th className="px-4 py-2 text-right">Completed</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2"></th></tr>
          </thead>
          <tbody>
            {workOrders.map((w) => (
              <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{w.workOrderNumber}</td>
                <td className="px-4 py-2">{itemName(w.productItemId)}</td>
                <td className="px-4 py-2 text-right">{qty(w.plannedQuantity)}</td>
                <td className="px-4 py-2 text-right">{qty(w.completedQuantity)}</td>
                <td className="px-4 py-2"><Badge tone={statusTone(w.status)}>{w.status}</Badge></td>
                <td className="px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => { setMsg(null); setOpenId(w.id); }}>Open</Button></td>
              </tr>
            ))}
            {workOrders.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No work orders.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Drawer open={creating} onClose={() => setCreating(false)} title="New work order">
        <div className="space-y-4">
          <div><label className="text-xs text-slate-500">Product (approved BOM)</label><Select options={[{ value: '', label: 'Select…' }, ...productOptions]} value={form.bomId} onChange={(e) => setForm({ ...form, bomId: e.target.value })} /></div>
          <div><label className="text-xs text-slate-500">Planned quantity</label><Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} /></div>
          <div><label className="text-xs text-slate-500">Plant</label><Select options={plants.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))} value={form.plantId} onChange={(e) => setForm({ ...form, plantId: e.target.value })} /></div>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button onClick={submitCreate}>Create</Button></div>
        </div>
      </Drawer>

      {openId && <WorkOrderDrawer workOrderId={openId} onClose={() => setOpenId(null)} onMessage={setMsg} />}
    </div>
  );
}

function WorkOrderDrawer({ workOrderId, onClose, onMessage }: { workOrderId: string; onClose: () => void; onMessage: (m: { tone: 'error' | 'success'; text: string }) => void }) {
  const wo = useManufacturingStore((s) => s.workOrders.find((w) => w.id === workOrderId)) as ManufacturingWorkOrder | undefined;
  const transition = useManufacturingStore((s) => s.transitionWorkOrder);
  const postIssue = useManufacturingStore((s) => s.postMaterialIssue);
  const postConversion = useManufacturingStore((s) => s.postOperationCost);
  const postReceipt = useManufacturingStore((s) => s.postProductionReceipt);
  const postScrap = useManufacturingStore((s) => s.postScrap);
  const metrics = useWorkOrderMetrics(workOrderId);
  const itemName = useItemName();
  const [receiptQty, setReceiptQty] = useState(1);

  if (!wo) return null;
  const today = new Date().toISOString().slice(0, 10);
  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); onMessage(r.ok ? { tone: 'success', text: ok } : { tone: 'error', text: r.error ?? 'Action failed.' }); };
  const issueAll = (): void => act(() => postIssue({ workOrderId, date: today, lines: wo.materialRequirements.filter((r) => r.issuedQuantity - r.returnedQuantity < r.requiredQuantity).map((r) => ({ itemId: r.itemId, requirementId: r.id, quantity: r.requiredQuantity - (r.issuedQuantity - r.returnedQuantity), warehouseId: r.warehouseId })) }), 'Material issued to WIP.');
  const conversionAll = (): void => { for (const op of wo.operationSnapshots) postConversion({ workOrderId, operationSnapshotId: op.id, date: today, runHours: op.plannedRunHours }); onMessage({ tone: 'success', text: 'Conversion cost absorbed into WIP.' }); };

  return (
    <Drawer open onClose={onClose} title={`${wo.workOrderNumber} · ${itemName(wo.productItemId)}`} widthClassName="max-w-2xl">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Badge tone={statusTone(wo.status)}>{wo.status}</Badge>
          <div className="flex gap-1">
            {allowedTransitions(wo.status).map((to) => (
              <Button key={to} size="sm" variant="outline" onClick={() => act(() => transition(workOrderId, to), `Moved to ${to}.`)}>{to}</Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-sm">
          <Stat label="Std cost" value={money(wo.standardCostSnapshot.totalCost)} />
          <Stat label="WIP" value={money(metrics.wip.remainingWip)} />
          <Stat label="Variance" value={metrics.variance ? money(metrics.variance.totalVariance) : '—'} />
        </div>

        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Material requirements</h4>
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400"><tr><th className="text-left">Item</th><th className="text-right">Required</th><th className="text-right">Issued</th><th className="text-right">Returned</th></tr></thead>
            <tbody>
              {wo.materialRequirements.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">{r.bomComponentSnapshot.itemCode}</td><td className="py-1 text-right">{qty(r.requiredQuantity)}</td><td className="py-1 text-right">{qty(r.issuedQuantity)}</td><td className="py-1 text-right">{qty(r.returnedQuantity)}</td></tr>
              ))}
              {wo.materialRequirements.length === 0 && <tr><td colSpan={4} className="py-2 text-slate-400">Release the work order to snapshot requirements.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <h4 className="text-xs font-semibold uppercase text-slate-500">Production actions</h4>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={issueAll} disabled={wo.materialRequirements.length === 0}>Issue material</Button>
            <Button size="sm" variant="outline" onClick={conversionAll} disabled={wo.operationSnapshots.length === 0}>Absorb conversion</Button>
            <span className="flex items-center gap-1">
              <Input type="number" className="h-8 w-20" value={receiptQty} onChange={(e) => setReceiptQty(Number(e.target.value))} />
              <Button size="sm" variant="outline" onClick={() => act(() => postReceipt({ workOrderId, date: today, completedQuantity: receiptQty }), 'Production received.')}>Receive FG</Button>
            </span>
            <Button size="sm" variant="outline" onClick={() => act(() => postScrap({ workOrderId, date: today, itemId: wo.materialRequirements[0]?.itemId ?? wo.productItemId, quantity: 1, reason: 'damage', accountingPolicy: 'abnormal-to-expense' }), 'Scrap posted.')}>Scrap 1</Button>
          </div>
          <p className="text-[11px] text-slate-400">Every action posts an atomic journal + inventory movement and updates work-order quantities.</p>
        </section>
      </div>
    </Drawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-slate-200 p-2 dark:border-slate-700"><p className="text-[10px] uppercase text-slate-400">{label}</p><p className="font-semibold">{value}</p></div>;
}
