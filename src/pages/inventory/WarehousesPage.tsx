import { useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import type { Warehouse, WarehouseType } from '@/types/inventory';
import { ENTITY } from '@/lib/inventorySeed';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';

const TYPES: WarehouseType[] = ['main', 'raw-material', 'wip', 'finished-goods', 'returns', 'quarantine', 'scrap', 'site', 'transit', 'virtual'];

export function WarehousesPage() {
  const warehouses = useInventoryStore((s) => s.warehouses);
  const saveWarehouse = useInventoryStore((s) => s.saveWarehouse);
  const deleteWarehouse = useInventoryStore((s) => s.deleteWarehouse);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const blank = (): Warehouse => ({ id: generateId('wh'), entityId: ENTITY, code: '', name: '', type: 'main', status: 'active', createdAt: '', updatedAt: '' });

  const save = (): void => {
    if (!editing) return;
    const res = saveWarehouse(editing);
    if (!res.ok) { setMsg(res.error ?? 'Error'); return; }
    setEditing(null); setMsg(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blank()); }}>New warehouse</Button></div>
      {msg && <Alert variant="error" onClose={() => setMsg(null)}>{msg}</Alert>}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2"></th></tr>
          </thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{w.code}</td>
                <td className="px-4 py-2">{w.name}</td>
                <td className="px-4 py-2"><Badge tone="slate">{w.type}</Badge></td>
                <td className="px-4 py-2">{w.status}</td>
                <td className="px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...w }); }}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => { const r = deleteWarehouse(w.id); if (!r.ok) setMsg(r.error ?? 'Error'); }}>Delete</Button>
                </td>
              </tr>
            ))}
            {warehouses.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No warehouses.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New warehouse'}>
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <Field label="Type"><Select options={TYPES.map((t) => ({ value: t, label: t }))} value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as WarehouseType })} /></Field>
            <Field label="Location"><Input value={editing.location ?? ''} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!editing.allowNegativeStock} onChange={(e) => setEditing({ ...editing, allowNegativeStock: e.target.checked })} />Allow negative stock</label>
            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
