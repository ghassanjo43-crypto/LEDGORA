import { useState } from 'react';
import { Plus, Landmark } from 'lucide-react';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

export function TaxJurisdictionsPage() {
  const jurisdictions = useTaxCodeStore((s) => s.jurisdictions);
  const reportingBoxes = useTaxCodeStore((s) => s.reportingBoxes);
  const createJurisdiction = useTaxCodeStore((s) => s.createJurisdiction);
  const { notify } = useToast();

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [authority, setAuthority] = useState('');

  const save = (): void => {
    if (!code.trim() || !name.trim()) { notify('Code and name are required.', 'error'); return; }
    const res = createJurisdiction({ code, name, taxAuthorityName: authority });
    if (res.ok) { notify('Jurisdiction created.', 'success'); setOpen(false); setCode(''); setName(''); setAuthority(''); }
  };

  return (
    <>
      <PageActions><Button onClick={() => setOpen((o) => !o)}><Plus className="h-4 w-4" /> New jurisdiction</Button></PageActions>

      {open && (
        <Card className="mb-4"><CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Code" required><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Tax authority"><Input value={authority} onChange={(e) => setAuthority(e.target.value)} /></Field>
          </div>
          <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save}>Create</Button></div>
        </CardBody></Card>
      )}

      {jurisdictions.length === 0 ? (
        <Card><CardBody><EmptyState icon={Landmark} title="No jurisdictions" description="Add a tax jurisdiction to group tax codes, registrations, reporting boxes and periods." /></CardBody></Card>
      ) : (
        <div className="space-y-4">
          <Card className="overflow-hidden"><div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
                {['Code', 'Name', 'Authority', 'Filing', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {jurisdictions.map((j) => (
                  <tr key={j.id}>
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{j.code}</td>
                    <td className="px-3 py-2">{j.name}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{j.taxAuthorityName ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{j.filingFrequency ?? '—'}</td>
                    <td className="px-3 py-2"><Badge tone={j.status === 'active' ? 'green' : 'slate'}>{j.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></Card>

          <Card><CardBody>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Reporting boxes</h3>
            <table className="min-w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-400"><tr>
                {['Box', 'Name', 'Report type', 'Basis', 'Sign'].map((h) => <th key={h} className="px-2 py-1.5 text-left font-semibold">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {[...reportingBoxes].sort((a, b) => a.sortOrder - b.sortOrder).map((b) => (
                  <tr key={b.id}>
                    <td className="px-2 py-1.5 font-mono text-xs font-semibold">{b.code}</td>
                    <td className="px-2 py-1.5">{b.name}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{b.reportType}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{b.amountBasis}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{b.sign}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody></Card>
        </div>
      )}
    </>
  );
}
