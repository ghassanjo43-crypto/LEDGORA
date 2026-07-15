import { useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import type { InventoryItem, InventoryItemType } from '@/types/inventory';
import { ENTITY } from '@/lib/inventorySeed';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { money, qty } from './InventoryShared';

const ITEM_TYPES: InventoryItemType[] = ['inventory', 'non-inventory', 'service', 'raw-material', 'component', 'subassembly', 'finished-good', 'packaging', 'consumable', 'spare-part', 'scrap'];

function blankItem(baseUnitId: string): InventoryItem {
  return {
    id: generateId('item'), entityId: ENTITY, code: '', name: '', itemType: 'inventory', baseUnitId,
    isInventoryTracked: true, isPurchasable: true, isSellable: true, isManufacturable: false,
    trackingMode: 'none', valuationMethod: 'weighted-average', status: 'active', createdAt: '', updatedAt: '',
  };
}

export function ItemsPage() {
  const items = useInventoryStore((s) => s.items);
  const units = useInventoryStore((s) => s.units);
  const categories = useInventoryStore((s) => s.categories);
  const movements = useInventoryStore((s) => s.movements);
  const saveItem = useInventoryStore((s) => s.saveItem);
  const archiveItem = useInventoryStore((s) => s.archiveItem);

  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => items.map((item) => ({ item, bal: getInventoryBalance(movements, { entityId: ENTITY, itemId: item.id }) })),
    [items, movements],
  );
  const unitOptions = useMemo(() => units.map((u) => ({ value: u.id, label: u.code })), [units]);
  const categoryOptions = useMemo(() => [{ value: '', label: '—' }, ...categories.map((c) => ({ value: c.id, label: c.name }))], [categories]);

  const save = (): void => {
    if (!editing) return;
    const res = saveItem(editing);
    if (!res.ok) { setError(res.error ?? 'Could not save item.'); return; }
    setEditing(null); setError(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setError(null); setEditing(blankItem(units[0]?.id ?? '')); }}>New item</Button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-4 py-2 text-left">Code</th>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-right">On hand</th>
              <th className="px-4 py-2 text-right">Avg cost</th>
              <th className="px-4 py-2 text-right">Value</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, bal }) => (
              <tr key={item.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{item.code}</td>
                <td className="px-4 py-2">{item.name}</td>
                <td className="px-4 py-2"><Badge tone="slate">{item.itemType}</Badge>{item.status === 'archived' && <Badge tone="red">archived</Badge>}</td>
                <td className="px-4 py-2 text-right">{qty(bal.quantityOnHand)}</td>
                <td className="px-4 py-2 text-right">{money(bal.averageUnitCost)}</td>
                <td className="px-4 py-2 text-right font-medium">{money(bal.inventoryValue)}</td>
                <td className="px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setError(null); setEditing({ ...item }); }}>Edit</Button>
                  {item.status !== 'archived' && <Button size="sm" variant="ghost" onClick={() => archiveItem(item.id)}>Archive</Button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No items yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New item'}>
        {editing && (
          <div className="space-y-4">
            {error && <Alert variant="error">{error}</Alert>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type"><Select options={ITEM_TYPES.map((t) => ({ value: t, label: t }))} value={editing.itemType} onChange={(e) => setEditing({ ...editing, itemType: e.target.value as InventoryItemType })} /></Field>
              <Field label="Base unit"><Select options={unitOptions} value={editing.baseUnitId} onChange={(e) => setEditing({ ...editing, baseUnitId: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category"><Select options={categoryOptions} value={editing.categoryId ?? ''} onChange={(e) => setEditing({ ...editing, categoryId: e.target.value || undefined })} /></Field>
              <Field label="Valuation"><Select options={[{ value: 'weighted-average', label: 'Weighted average' }, { value: 'standard', label: 'Standard' }]} value={editing.valuationMethod} onChange={(e) => setEditing({ ...editing, valuationMethod: e.target.value as InventoryItem['valuationMethod'] })} /></Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.isInventoryTracked} onChange={(e) => setEditing({ ...editing, isInventoryTracked: e.target.checked })} />Stock tracked</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.isPurchasable} onChange={(e) => setEditing({ ...editing, isPurchasable: e.target.checked })} />Purchasable</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.isSellable} onChange={(e) => setEditing({ ...editing, isSellable: e.target.checked })} />Sellable</label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save}>Save item</Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
