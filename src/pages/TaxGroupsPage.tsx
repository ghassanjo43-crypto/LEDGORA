import { useMemo, useState } from 'react';
import { Plus, Boxes } from 'lucide-react';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { calculateTaxGroup } from '@/lib/taxCalculations';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

export function TaxGroupsPage() {
  const allTaxCodes = useTaxCodeStore((s) => s.taxCodes);
  const taxCodes = useMemo(() => allTaxCodes.filter((c) => c.status === 'active'), [allTaxCodes]);
  const groups = useTaxCodeStore((s) => s.taxGroups);
  const createTaxGroup = useTaxCodeStore((s) => s.createTaxGroup);
  const { notify } = useToast();

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [order, setOrder] = useState<'parallel' | 'sequential'>('parallel');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const codeName = (id: string): string => taxCodes.find((c) => c.id === id)?.code ?? id;
  const toggle = (id: string): void => setMemberIds((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  const save = (): void => {
    if (!code.trim() || memberIds.length === 0) { notify('A group needs a code and at least one tax code.', 'error'); return; }
    const res = createTaxGroup({ code, name, calculationOrder: order, taxCodeIds: memberIds });
    if (res.ok) { notify('Tax group created.', 'success'); setOpen(false); setCode(''); setName(''); setMemberIds([]); }
  };

  // Live preview of the group calculation on a 1,000 base.
  const preview = calculateTaxGroup(1000, memberIds.map((id) => { const c = taxCodes.find((x) => x.id === id)!; return { taxCodeId: id, rate: c.rate, category: c.category }; }), order);

  return (
    <>
      <PageActions><Button onClick={() => setOpen((o) => !o)}><Plus className="h-4 w-4" /> New tax group</Button></PageActions>

      {open && (
        <Card className="mb-4"><CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Code" required><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Calculation order"><Select options={[{ value: 'parallel', label: 'Parallel (same base)' }, { value: 'sequential', label: 'Sequential (compound)' }]} value={order} onChange={(e) => setOrder(e.target.value as 'parallel' | 'sequential')} /></Field>
          </div>
          <p className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Member tax codes</p>
          <div className="flex flex-wrap gap-2">
            {taxCodes.map((c) => (
              <button key={c.id} type="button" onClick={() => toggle(c.id)} className={cx('rounded-lg border px-2.5 py-1.5 text-xs', memberIds.includes(c.id) ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10' : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700')}>
                <span className="font-mono font-semibold">{c.code}</span> · {c.rate}%
              </button>
            ))}
          </div>
          {memberIds.length > 0 && <p className="mt-3 text-xs text-slate-500">On a 1,000 base → tax {preview.taxTotal.toFixed(2)}, gross {preview.grossAmount.toFixed(2)} ({order}).</p>}
          <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save}>Create group</Button></div>
        </CardBody></Card>
      )}

      {groups.length === 0 ? (
        <Card><CardBody><EmptyState icon={Boxes} title="No tax groups" description="Tax groups apply several tax codes to one line — parallel (all on the same base) or sequential (compound: each on base plus prior taxes)." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Code', 'Name', 'Order', 'Members', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {groups.map((g) => (
                <tr key={g.id}>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{g.code}</td>
                  <td className="px-3 py-2">{g.name}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{g.calculationOrder}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{g.taxCodeIds.map(codeName).join(', ')}</td>
                  <td className="px-3 py-2"><Badge tone={g.status === 'active' ? 'green' : 'slate'}>{g.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}
    </>
  );
}
