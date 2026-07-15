import { useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import type { UnitCategory, UnitOfMeasure } from '@/types/inventory';
import { ENTITY } from '@/lib/inventorySeed';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';

const CATS: UnitCategory[] = ['quantity', 'weight', 'volume', 'length', 'area', 'time', 'custom'];

export function UnitsOfMeasurePage() {
  const units = useInventoryStore((s) => s.units);
  const saveUnit = useInventoryStore((s) => s.saveUnit);
  const [form, setForm] = useState({ code: '', name: '', symbol: '', category: 'quantity' as UnitCategory, decimalPlaces: 0 });
  const [msg, setMsg] = useState<string | null>(null);

  const add = (): void => {
    const unit: UnitOfMeasure = { id: generateId('uom'), entityId: ENTITY, code: form.code.trim(), name: form.name.trim(), symbol: form.symbol.trim(), category: form.category, decimalPlaces: form.decimalPlaces, status: 'active' };
    const res = saveUnit(unit);
    if (!res.ok) { setMsg(res.error ?? 'Error'); return; }
    setForm({ code: '', name: '', symbol: '', category: 'quantity', decimalPlaces: 0 }); setMsg(null);
  };

  return (
    <div className="space-y-4">
      {msg && <Alert variant="error" onClose={() => setMsg(null)}>{msg}</Alert>}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-24"><label className="text-xs text-slate-500">Code</label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
        <div className="flex-1"><label className="text-xs text-slate-500">Name</label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="w-24"><label className="text-xs text-slate-500">Symbol</label><Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} /></div>
        <div className="w-36"><label className="text-xs text-slate-500">Category</label><Select options={CATS.map((c) => ({ value: c, label: c }))} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as UnitCategory })} /></div>
        <Button onClick={add} disabled={!form.code.trim()}>Add unit</Button>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Symbol</th><th className="px-4 py-2 text-left">Category</th></tr></thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{u.code}</td><td className="px-4 py-2">{u.name}</td><td className="px-4 py-2">{u.symbol}</td><td className="px-4 py-2">{u.category}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
