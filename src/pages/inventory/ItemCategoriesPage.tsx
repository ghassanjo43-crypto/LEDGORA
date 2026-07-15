import { useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import type { ItemCategory } from '@/types/inventory';
import { ENTITY } from '@/lib/inventorySeed';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';

export function ItemCategoriesPage() {
  const categories = useInventoryStore((s) => s.categories);
  const saveCategory = useInventoryStore((s) => s.saveCategory);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const add = (): void => {
    const cat: ItemCategory = { id: generateId('cat'), entityId: ENTITY, code: code.trim(), name: name.trim(), status: 'active' };
    const res = saveCategory(cat);
    if (!res.ok) { setMsg(res.error ?? 'Error'); return; }
    setCode(''); setName(''); setMsg(null);
  };

  return (
    <div className="space-y-4">
      {msg && <Alert variant="error" onClose={() => setMsg(null)}>{msg}</Alert>}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-32"><label className="text-xs text-slate-500">Code</label><Input value={code} onChange={(e) => setCode(e.target.value)} /></div>
        <div className="flex-1"><label className="text-xs text-slate-500">Name</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <Button onClick={add} disabled={!code.trim() || !name.trim()}>Add category</Button>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Status</th></tr></thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-2 font-medium">{c.code}</td><td className="px-4 py-2">{c.name}</td><td className="px-4 py-2">{c.status}</td></tr>
            ))}
            {categories.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">No categories.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
