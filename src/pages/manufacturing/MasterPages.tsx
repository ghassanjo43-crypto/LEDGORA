/** Manufacturing master-data pages (plants, lines, work centers, BOMs, routings). */
import { useMemo, useState } from 'react';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import type { BillOfMaterials, BomComponent, ManufacturingPlant, ManufacturingRouting, ProductionLine, RoutingOperation, WorkCenter, WorkCenterType } from '@/types/manufacturing';
import { MFG_ENTITY } from '@/lib/manufacturingSeed';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { money, useItemName } from './ManufacturingShared';

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}
const empty = (cols: number, text: string) => <tr><td colSpan={cols} className="px-4 py-8 text-center text-slate-400">{text}</td></tr>;

/** Shared option lists for the editors. */
function useMfgOptions() {
  const warehouses = useInventoryStore((s) => s.warehouses);
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const warehouseOptions = useMemo(() => [{ value: '', label: '—' }, ...warehouses.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))], [warehouses]);
  const costCenterOptions = useMemo(() => [{ value: '', label: '—' }, ...costCenters.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))], [costCenters]);
  return { warehouseOptions, costCenterOptions };
}
const STATUS_OPTIONS = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }];

/* ── Plants ───────────────────────────────────────────────────────────────── */

function blankPlant(): ManufacturingPlant {
  return { id: generateId('plant'), entityId: MFG_ENTITY, code: '', name: '', status: 'active', createdAt: '', updatedAt: '' };
}

export function PlantsPage() {
  const plants = useManufacturingStore((s) => s.plants);
  const savePlant = useManufacturingStore((s) => s.savePlant);
  const deletePlant = useManufacturingStore((s) => s.deletePlant);
  const { warehouseOptions, costCenterOptions } = useMfgOptions();
  const [editing, setEditing] = useState<ManufacturingPlant | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const save = (): void => {
    if (!editing) return;
    const res = savePlant(editing);
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Could not save plant.' }); return; }
    setEditing(null); setMsg({ tone: 'success', text: 'Plant saved.' });
  };
  const remove = (id: string): void => { const r = deletePlant(id); setMsg(r.ok ? { tone: 'success', text: 'Plant deleted.' } : { tone: 'error', text: r.error ?? 'Could not delete.' }); };

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blankPlant()); }}>New plant</Button></div>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Table head={['Code', 'Name', 'Manager', 'Warehouses', 'Status', '']}>
        {plants.map((p) => (
          <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{p.code}</td><td className="px-4 py-2">{p.name}</td><td className="px-4 py-2 text-slate-500">{p.managerName ?? '—'}</td>
            <td className="px-4 py-2 text-xs text-slate-400">{[p.rawMaterialWarehouseId, p.wipWarehouseId, p.finishedGoodsWarehouseId, p.scrapWarehouseId].filter(Boolean).length} linked</td>
            <td className="px-4 py-2"><Badge tone={p.status === 'active' ? 'green' : 'slate'}>{p.status}</Badge></td>
            <td className="px-4 py-2 text-right whitespace-nowrap">
              <Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...p }); }}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => remove(p.id)}>Delete</Button>
            </td>
          </tr>
        ))}
        {plants.length === 0 && empty(6, 'No plants yet.')}
      </Table>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New plant'}>
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Manager"><Input value={editing.managerName ?? ''} onChange={(e) => setEditing({ ...editing, managerName: e.target.value })} /></Field>
              <Field label="Status"><Select options={STATUS_OPTIONS} value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as ManufacturingPlant['status'] })} /></Field>
            </div>
            <Field label="Address"><Input value={editing.address ?? ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} /></Field>
            <Field label="Default cost center"><Select options={costCenterOptions} value={editing.defaultCostCenterId ?? ''} onChange={(e) => setEditing({ ...editing, defaultCostCenterId: e.target.value || undefined })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Raw-material warehouse"><Select options={warehouseOptions} value={editing.rawMaterialWarehouseId ?? ''} onChange={(e) => setEditing({ ...editing, rawMaterialWarehouseId: e.target.value || undefined })} /></Field>
              <Field label="WIP warehouse"><Select options={warehouseOptions} value={editing.wipWarehouseId ?? ''} onChange={(e) => setEditing({ ...editing, wipWarehouseId: e.target.value || undefined })} /></Field>
              <Field label="Finished-goods warehouse"><Select options={warehouseOptions} value={editing.finishedGoodsWarehouseId ?? ''} onChange={(e) => setEditing({ ...editing, finishedGoodsWarehouseId: e.target.value || undefined })} /></Field>
              <Field label="Scrap warehouse"><Select options={warehouseOptions} value={editing.scrapWarehouseId ?? ''} onChange={(e) => setEditing({ ...editing, scrapWarehouseId: e.target.value || undefined })} /></Field>
            </div>
            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save plant</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ── Production lines ─────────────────────────────────────────────────────── */

export function ProductionLinesPage() {
  const lines = useManufacturingStore((s) => s.lines);
  const plants = useManufacturingStore((s) => s.plants);
  const saveLine = useManufacturingStore((s) => s.saveLine);
  const { costCenterOptions } = useMfgOptions();
  const [editing, setEditing] = useState<ProductionLine | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const plantName = (id: string) => plants.find((p) => p.id === id)?.code ?? id;
  const plantOptions = useMemo(() => plants.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })), [plants]);

  const blank = (): ProductionLine => ({ id: generateId('line'), entityId: MFG_ENTITY, plantId: plants[0]?.id ?? '', code: '', name: '', status: 'active', createdAt: '', updatedAt: '' });
  const save = (): void => { if (!editing) return; const res = saveLine(editing); if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Error' }); return; } setEditing(null); setMsg({ tone: 'success', text: 'Line saved.' }); };

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blank()); }} disabled={plants.length === 0}>New line</Button></div>
      {plants.length === 0 && <Alert variant="info">Create a plant first.</Alert>}
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Table head={['Code', 'Name', 'Plant', 'Status', '']}>
        {lines.map((l) => (
          <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{l.code}</td><td className="px-4 py-2">{l.name}</td><td className="px-4 py-2 text-slate-500">{plantName(l.plantId)}</td>
            <td className="px-4 py-2"><Badge tone={l.status === 'active' ? 'green' : 'slate'}>{l.status}</Badge></td>
            <td className="px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...l }); }}>Edit</Button></td>
          </tr>
        ))}
        {lines.length === 0 && empty(5, 'No production lines.')}
      </Table>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New line'}>
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <Field label="Plant" required><Select options={plantOptions} value={editing.plantId} onChange={(e) => setEditing({ ...editing, plantId: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default cost center"><Select options={costCenterOptions} value={editing.defaultCostCenterId ?? ''} onChange={(e) => setEditing({ ...editing, defaultCostCenterId: e.target.value || undefined })} /></Field>
              <Field label="Status"><Select options={STATUS_OPTIONS} value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as ProductionLine['status'] })} /></Field>
            </div>
            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save line</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ── Work centers ─────────────────────────────────────────────────────────── */

const WC_TYPES: WorkCenterType[] = ['labor', 'machine', 'assembly', 'inspection', 'packaging', 'mixed'];

export function WorkCentersPage() {
  const workCenters = useManufacturingStore((s) => s.workCenters);
  const plants = useManufacturingStore((s) => s.plants);
  const lines = useManufacturingStore((s) => s.lines);
  const saveWorkCenter = useManufacturingStore((s) => s.saveWorkCenter);
  const { costCenterOptions } = useMfgOptions();
  const [editing, setEditing] = useState<WorkCenter | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const plantOptions = useMemo(() => plants.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })), [plants]);
  const lineOptions = useMemo(() => [{ value: '', label: '—' }, ...lines.map((l) => ({ value: l.id, label: l.code }))], [lines]);

  const blank = (): WorkCenter => ({ id: generateId('wc'), entityId: MFG_ENTITY, plantId: plants[0]?.id ?? '', code: '', name: '', type: 'machine', costCenterId: '', availableHoursPerDay: 8, efficiencyPercent: 100, setupRatePerHour: 0, laborRatePerHour: 0, machineRatePerHour: 0, overheadRatePerHour: 0, status: 'active', createdAt: '', updatedAt: '' });
  const num = (k: keyof WorkCenter) => (e: React.ChangeEvent<HTMLInputElement>) => setEditing((w) => (w ? { ...w, [k]: Number(e.target.value) } : w));
  const save = (): void => { if (!editing) return; const res = saveWorkCenter(editing); if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Error' }); return; } setEditing(null); setMsg({ tone: 'success', text: 'Work center saved.' }); };

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blank()); }} disabled={plants.length === 0}>New work center</Button></div>
      {plants.length === 0 && <Alert variant="info">Create a plant first.</Alert>}
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Table head={['Code', 'Name', 'Type', 'Labor', 'Machine', 'Overhead', 'Status', '']}>
        {workCenters.map((w) => (
          <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{w.code}</td><td className="px-4 py-2">{w.name}</td><td className="px-4 py-2"><Badge tone="slate">{w.type}</Badge></td>
            <td className="px-4 py-2">{money(w.laborRatePerHour)}</td><td className="px-4 py-2">{money(w.machineRatePerHour)}</td><td className="px-4 py-2">{money(w.overheadRatePerHour)}</td>
            <td className="px-4 py-2"><Badge tone={w.status === 'active' ? 'green' : 'slate'}>{w.status}</Badge></td>
            <td className="px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...w }); }}>Edit</Button></td>
          </tr>
        ))}
        {workCenters.length === 0 && empty(8, 'No work centers.')}
      </Table>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New work center'} widthClassName="max-w-lg">
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Plant" required><Select options={plantOptions} value={editing.plantId} onChange={(e) => setEditing({ ...editing, plantId: e.target.value })} /></Field>
              <Field label="Production line"><Select options={lineOptions} value={editing.productionLineId ?? ''} onChange={(e) => setEditing({ ...editing, productionLineId: e.target.value || undefined })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type"><Select options={WC_TYPES.map((t) => ({ value: t, label: t }))} value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as WorkCenterType })} /></Field>
              <Field label="Cost center" required><Select options={costCenterOptions} value={editing.costCenterId} onChange={(e) => setEditing({ ...editing, costCenterId: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Setup rate / hr"><Input type="number" value={editing.setupRatePerHour} onChange={num('setupRatePerHour')} /></Field>
              <Field label="Labor rate / hr"><Input type="number" value={editing.laborRatePerHour} onChange={num('laborRatePerHour')} /></Field>
              <Field label="Machine rate / hr"><Input type="number" value={editing.machineRatePerHour} onChange={num('machineRatePerHour')} /></Field>
              <Field label="Overhead rate / hr"><Input type="number" value={editing.overheadRatePerHour} onChange={num('overheadRatePerHour')} /></Field>
              <Field label="Available hrs / day"><Input type="number" value={editing.availableHoursPerDay} onChange={num('availableHoursPerDay')} /></Field>
              <Field label="Efficiency %"><Input type="number" value={editing.efficiencyPercent} onChange={num('efficiencyPercent')} /></Field>
            </div>
            <Field label="Status"><Select options={STATUS_OPTIONS} value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as WorkCenter['status'] })} /></Field>
            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save work center</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ── Item / unit / warehouse options for BOM & routing editors ────────────── */

function useProductAndComponentOptions() {
  const items = useInventoryStore((s) => s.items);
  const units = useInventoryStore((s) => s.units);
  const warehouses = useInventoryStore((s) => s.warehouses);
  const active = useMemo(() => items.filter((i) => i.status !== 'archived'), [items]);
  const productOptions = useMemo(() => active.filter((i) => i.itemType === 'finished-good' || i.itemType === 'subassembly' || i.isManufacturable).map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` })), [active]);
  const componentOptions = useMemo(() => active.filter((i) => i.itemType !== 'service' && i.itemType !== 'non-inventory' && i.isInventoryTracked).map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` })), [active]);
  const unitOptions = useMemo(() => units.map((u) => ({ value: u.id, label: u.code })), [units]);
  const warehouseOptions = useMemo(() => [{ value: '', label: 'Default' }, ...warehouses.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: w.code }))], [warehouses]);
  return { productOptions, componentOptions, unitOptions, warehouseOptions };
}

/* ── Bills of Materials (list + authoring editor) ─────────────────────────── */

function blankBom(): BillOfMaterials {
  const id = generateId('bom');
  return { id, entityId: MFG_ENTITY, code: '', name: '', productItemId: '', version: 1, status: 'draft', effectiveFrom: new Date().toISOString().slice(0, 10), outputQuantity: 1, outputUnitId: '', expectedYieldPercent: 100, components: [], createdAt: '', updatedAt: '' };
}

export function BillsOfMaterialsPage() {
  const boms = useManufacturingStore((s) => s.boms);
  const saveBom = useManufacturingStore((s) => s.saveBom);
  const approveBom = useManufacturingStore((s) => s.approveBom);
  const reviseBom = useManufacturingStore((s) => s.reviseBom);
  const itemName = useItemName();
  const { productOptions, componentOptions, unitOptions, warehouseOptions } = useProductAndComponentOptions();
  const [editing, setEditing] = useState<BillOfMaterials | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const save = (): void => {
    if (!editing) return;
    const bom: BillOfMaterials = { ...editing, components: editing.components.map((c, i) => ({ ...c, bomId: editing.id, sequence: i + 1, quantity: c.quantityPerOutput })) };
    const res = saveBom(bom);
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Could not save BOM.' }); return; }
    setEditing(null); setMsg({ tone: 'success', text: 'BOM saved as draft. Approve it to use it in work orders.' });
  };
  const addComponent = (): void => setEditing((b) => (b ? { ...b, components: [...b.components, { id: generateId('bc'), bomId: b.id, sequence: b.components.length + 1, itemId: componentOptions[0]?.value ?? '', quantity: 1, unitId: unitOptions[0]?.value ?? '', quantityPerOutput: 1, isOptional: false }] } : b));
  const setComp = (id: string, patch: Partial<BomComponent>): void => setEditing((b) => (b ? { ...b, components: b.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : b));

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blankBom()); }}>New BOM</Button></div>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Table head={['Code', 'Product', 'Version', 'Components', 'Status', '']}>
        {boms.map((b) => (
          <tr key={b.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{b.code}</td><td className="px-4 py-2">{itemName(b.productItemId)}</td><td className="px-4 py-2">v{b.version}</td>
            <td className="px-4 py-2 text-slate-500">{b.components.length}</td>
            <td className="px-4 py-2"><Badge tone={b.status === 'approved' ? 'green' : b.status === 'draft' ? 'amber' : 'slate'}>{b.status}</Badge></td>
            <td className="px-4 py-2 text-right whitespace-nowrap">
              {b.status === 'draft' && <><Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...b, components: b.components.map((c) => ({ ...c })) }); }}>Edit</Button><button className="ml-2 text-xs font-medium text-brand-600 hover:underline" onClick={() => approveBom(b.id)}>Approve</button></>}
              {b.status === 'approved' && <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => { const r = reviseBom(b.id); if (r.ok && r.id) setMsg({ tone: 'success', text: 'New draft version created — edit it below.' }); }}>New version</button>}
            </td>
          </tr>
        ))}
        {boms.length === 0 && empty(6, 'No bills of materials. Click “New BOM” to create one.')}
      </Table>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `BOM ${editing.code}` : 'New BOM'} widthClassName="max-w-2xl">
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} placeholder="BOM-CABINET" /></Field>
              <Field label="Name"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <Field label="Finished product" required><Select options={[{ value: '', label: 'Select a manufacturable item…' }, ...productOptions]} value={editing.productItemId} onChange={(e) => setEditing({ ...editing, productItemId: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Output quantity"><Input type="number" value={editing.outputQuantity} onChange={(e) => setEditing({ ...editing, outputQuantity: Number(e.target.value) })} /></Field>
              <Field label="Output unit"><Select options={[{ value: '', label: '—' }, ...unitOptions]} value={editing.outputUnitId} onChange={(e) => setEditing({ ...editing, outputUnitId: e.target.value })} /></Field>
              <Field label="Expected scrap %"><Input type="number" value={editing.expectedScrapPercent ?? 0} onChange={(e) => setEditing({ ...editing, expectedScrapPercent: Number(e.target.value) })} /></Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase text-slate-500">Components</h4>
                <Button size="sm" variant="outline" onClick={addComponent}>Add component</Button>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400"><tr><th className="text-left">Item</th><th className="text-right">Qty / output</th><th className="text-left">Unit</th><th className="text-left">Issue WH</th><th className="text-center">Opt.</th><th></th></tr></thead>
                <tbody>
                  {editing.components.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-2"><Select className="h-8" options={componentOptions} value={c.itemId} onChange={(e) => setComp(c.id, { itemId: e.target.value })} /></td>
                      <td className="py-1 px-1 w-24"><Input className="h-8 text-right" type="number" value={c.quantityPerOutput} onChange={(e) => setComp(c.id, { quantityPerOutput: Number(e.target.value) })} /></td>
                      <td className="py-1 px-1 w-20"><Select className="h-8" options={unitOptions} value={c.unitId} onChange={(e) => setComp(c.id, { unitId: e.target.value })} /></td>
                      <td className="py-1 px-1 w-24"><Select className="h-8" options={warehouseOptions} value={c.issueWarehouseId ?? ''} onChange={(e) => setComp(c.id, { issueWarehouseId: e.target.value || undefined })} /></td>
                      <td className="py-1 text-center"><input type="checkbox" checked={c.isOptional} onChange={(e) => setComp(c.id, { isOptional: e.target.checked })} /></td>
                      <td className="py-1 text-right"><button className="text-xs text-red-600" onClick={() => setEditing((b) => (b ? { ...b, components: b.components.filter((x) => x.id !== c.id) } : b))}>remove</button></td>
                    </tr>
                  ))}
                  {editing.components.length === 0 && <tr><td colSpan={6} className="py-3 text-center text-slate-400">Add at least one component.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save draft</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ── Routings (list + authoring editor) ───────────────────────────────────── */

function blankRouting(): ManufacturingRouting {
  return { id: generateId('rtg'), entityId: MFG_ENTITY, code: '', name: '', productItemId: '', version: 1, status: 'draft', effectiveFrom: new Date().toISOString().slice(0, 10), operations: [], createdAt: '', updatedAt: '' };
}

export function RoutingsPage() {
  const routings = useManufacturingStore((s) => s.routings);
  const workCenters = useManufacturingStore((s) => s.workCenters);
  const saveRouting = useManufacturingStore((s) => s.saveRouting);
  const approveRouting = useManufacturingStore((s) => s.approveRouting);
  const reviseRouting = useManufacturingStore((s) => s.reviseRouting);
  const itemName = useItemName();
  const { productOptions } = useProductAndComponentOptions();
  const wcOptions = useMemo(() => workCenters.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })), [workCenters]);
  const [editing, setEditing] = useState<ManufacturingRouting | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const save = (): void => {
    if (!editing) return;
    const res = saveRouting({ ...editing, operations: editing.operations.map((o) => ({ ...o, routingId: editing.id })) });
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Could not save routing.' }); return; }
    setEditing(null); setMsg({ tone: 'success', text: 'Routing saved as draft. Approve it to use it in work orders.' });
  };
  const addOp = (): void => setEditing((r) => (r ? { ...r, operations: [...r.operations, { id: generateId('op'), routingId: r.id, operationNumber: (r.operations.length + 1) * 10, name: '', workCenterId: wcOptions[0]?.value ?? '', setupHours: 0, runHoursPerUnit: 1, requiresInspection: false, isOutsourced: false }] } : r));
  const setOp = (id: string, patch: Partial<RoutingOperation>): void => setEditing((r) => (r ? { ...r, operations: r.operations.map((o) => (o.id === id ? { ...o, ...patch } : o)) } : r));

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blankRouting()); }}>New routing</Button></div>
      {workCenters.length === 0 && <Alert variant="info">Create at least one work center before adding a routing.</Alert>}
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Table head={['Code', 'Product', 'Version', 'Operations', 'Status', '']}>
        {routings.map((r) => (
          <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{r.code}</td><td className="px-4 py-2">{itemName(r.productItemId)}</td><td className="px-4 py-2">v{r.version}</td>
            <td className="px-4 py-2 text-slate-500">{r.operations.length}</td>
            <td className="px-4 py-2"><Badge tone={r.status === 'approved' ? 'green' : r.status === 'draft' ? 'amber' : 'slate'}>{r.status}</Badge></td>
            <td className="px-4 py-2 text-right whitespace-nowrap">
              {r.status === 'draft' && <><Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...r, operations: r.operations.map((o) => ({ ...o })) }); }}>Edit</Button><button className="ml-2 text-xs font-medium text-brand-600 hover:underline" onClick={() => approveRouting(r.id)}>Approve</button></>}
              {r.status === 'approved' && <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => reviseRouting(r.id)}>New version</button>}
            </td>
          </tr>
        ))}
        {routings.length === 0 && empty(6, 'No routings. Click “New routing” to create one.')}
      </Table>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Routing ${editing.code}` : 'New routing'} widthClassName="max-w-2xl">
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} placeholder="RTG-CABINET" /></Field>
              <Field label="Name"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <Field label="Product" required><Select options={[{ value: '', label: 'Select a manufacturable item…' }, ...productOptions]} value={editing.productItemId} onChange={(e) => setEditing({ ...editing, productItemId: e.target.value })} /></Field>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase text-slate-500">Operations</h4>
                <Button size="sm" variant="outline" onClick={addOp} disabled={wcOptions.length === 0}>Add operation</Button>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400"><tr><th className="text-left w-16">Op #</th><th className="text-left">Name</th><th className="text-left">Work center</th><th className="text-right w-20">Setup h</th><th className="text-right w-20">Run h/u</th><th></th></tr></thead>
                <tbody>
                  {editing.operations.map((o) => (
                    <tr key={o.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-1 w-16"><Input className="h-8 text-right" type="number" value={o.operationNumber} onChange={(e) => setOp(o.id, { operationNumber: Number(e.target.value) })} /></td>
                      <td className="py-1 px-1"><Input className="h-8" value={o.name} onChange={(e) => setOp(o.id, { name: e.target.value })} placeholder="Cut" /></td>
                      <td className="py-1 px-1"><Select className="h-8" options={wcOptions} value={o.workCenterId} onChange={(e) => setOp(o.id, { workCenterId: e.target.value })} /></td>
                      <td className="py-1 px-1 w-20"><Input className="h-8 text-right" type="number" value={o.setupHours} onChange={(e) => setOp(o.id, { setupHours: Number(e.target.value) })} /></td>
                      <td className="py-1 px-1 w-20"><Input className="h-8 text-right" type="number" value={o.runHoursPerUnit} onChange={(e) => setOp(o.id, { runHoursPerUnit: Number(e.target.value) })} /></td>
                      <td className="py-1 text-right"><button className="text-xs text-red-600" onClick={() => setEditing((r) => (r ? { ...r, operations: r.operations.filter((x) => x.id !== o.id) } : r))}>remove</button></td>
                    </tr>
                  ))}
                  {editing.operations.length === 0 && <tr><td colSpan={6} className="py-3 text-center text-slate-400">Add at least one operation.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save draft</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
