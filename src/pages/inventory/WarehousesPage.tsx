/**
 * The warehouse register, on whichever engine this workspace uses.
 *
 * ══ Archive, not delete ══════════════════════════════════════════════════════
 *
 * Free Demo could delete a warehouse because nothing durable pointed at one. On
 * server books a warehouse is an identity that documents will name, so it is
 * archived and brought back instead — and the server refuses to archive the one
 * the company still points at as its default, naming that reason.
 *
 * ══ No quantities ═══════════════════════════════════════════════════════════
 *
 * There is no on-hand column here and no stock to show. A warehouse in I1 is a
 * place; what is in it arrives with the movement ledger.
 */
import { useEffect, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import type { Warehouse, WarehouseType } from '@/types/inventory';
import { ENTITY } from '@/lib/inventorySeed';
import { generateId } from '@/lib/utils';
import { useInventoryMasterData } from '@/services/inventory/useInventoryMasterData';
import { inventoryActions } from '@/services/inventory/inventoryActions';
import { IMPORT_REQUIRED, loadWarehouses } from '@/services/inventory/inventoryBackend';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';

const TYPES: WarehouseType[] = ['main', 'raw-material', 'wip', 'finished-goods', 'returns', 'quarantine', 'scrap', 'site', 'transit', 'virtual'];

export function WarehousesPage() {
  const {
    warehouses, serverBacked, loading, error: registerError, strandedWarehouses,
  } = useInventoryMasterData();
  const deleteWarehouse = useInventoryStore((s) => s.deleteWarehouse);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const blank = (): Warehouse => ({ id: generateId('wh'), entityId: ENTITY, code: '', name: '', type: 'main', status: 'active', createdAt: '', updatedAt: '' });

  /* The SERVER searches on server books — see `ItemsPage` for why. */
  useEffect(() => {
    if (!serverBacked) return undefined;
    const timer = setTimeout(() => { void loadWarehouses({ search: search.trim() }); }, 150);
    return () => clearTimeout(timer);
  }, [serverBacked, search]);

  const term = search.trim().toLowerCase();
  const rows = serverBacked || !term
    ? warehouses
    : warehouses.filter((w) => w.code.toLowerCase().includes(term)
      || w.name.toLowerCase().includes(term)
      || (w.location ?? '').toLowerCase().includes(term));

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    try {
      const res = await inventoryActions().saveWarehouse(editing);
      if (!res.ok) { setMsg(res.error ?? 'Error'); return; }
      setEditing(null);
      setMsg(null);
    } finally {
      setBusy(false);
    }
  };

  const setArchived = async (id: string, archived: boolean): Promise<void> => {
    setBusy(true);
    try {
      const res = await inventoryActions().setWarehouseArchived(id, archived);
      /* The SERVER's words: it names the default-warehouse reason itself. */
      if (!res.ok) setMsg(res.error ?? 'Error');
      else setMsg(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Input
          className="h-9 max-w-xs"
          placeholder="Search code, name or location"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search warehouses"
        />
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-slate-400">Loading…</span>}
          <Button disabled={busy} onClick={() => { setMsg(null); setEditing(blank()); }}>New warehouse</Button>
        </div>
      </div>

      {registerError && <Alert variant="error">{registerError}</Alert>}
      {msg && <Alert variant="error" onClose={() => setMsg(null)}>{msg}</Alert>}

      {serverBacked && strandedWarehouses > 0 && (
        <Alert variant="warning">
          {strandedWarehouses} warehouse{strandedWarehouses === 1 ? '' : 's'} remain in this browser
          and are not part of these books. {IMPORT_REQUIRED}
        </Alert>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2"></th></tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{w.code}</td>
                <td className="px-4 py-2">{w.name}</td>
                <td className="px-4 py-2"><Badge tone="slate">{w.type}</Badge></td>
                <td className="px-4 py-2">{w.status}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setMsg(null); setEditing({ ...w }); }}>Edit</Button>
                  {serverBacked
                    ? (w.status !== 'archived'
                      ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void setArchived(w.id, true); }}>Archive</Button>
                      : <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void setArchived(w.id, false); }}>Reactivate</Button>)
                    : <Button size="sm" variant="ghost" onClick={() => { const r = deleteWarehouse(w.id); if (!r.ok) setMsg(r.error ?? 'Error'); }}>Delete</Button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No warehouses.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New warehouse'}>
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input aria-label="Warehouse code" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input aria-label="Warehouse name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <Field label="Type"><Select options={TYPES.map((t) => ({ value: t, label: t }))} value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as WarehouseType })} /></Field>
            <Field label="Location"><Input value={editing.location ?? ''} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field>
            <Field label="Description"><Input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            {/* Negative stock is an enforcement rule about quantities, and there
                are none yet. It stays a Free Demo control until movements land. */}
            {!serverBacked && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!editing.allowNegativeStock} onChange={(e) => setEditing({ ...editing, allowNegativeStock: e.target.checked })} />Allow negative stock</label>}
            <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save'}</Button></div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
