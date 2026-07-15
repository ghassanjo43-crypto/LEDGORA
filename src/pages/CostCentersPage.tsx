import { useMemo, useState } from 'react';
import { Plus, ChevronDown, Pencil, Power, Archive, Target, GitBranch, Upload } from 'lucide-react';
import type { CostCenter } from '@/types/costCenter';
import { useCostCenterStore } from '@/store/costCenterStore';
import { buildCostCenterTree, flattenCostCenterTree } from '@/lib/costCenterHierarchy';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { CostCenterEditor } from '@/components/cost-centers/CostCenterEditor';
import { CostCenterImportDialog } from '@/components/cost-centers/CostCenterImportDialog';

const STATUS_TONE: Record<CostCenter['status'], BadgeTone> = { active: 'green', inactive: 'slate', archived: 'red' };

export function CostCentersPage() {
  const centers = useCostCenterStore((s) => s.costCenters);
  const store = useCostCenterStore();
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  const ordered = useMemo(() => flattenCostCenterTree(buildCostCenterTree(centers)), [centers]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ordered
      .filter((c) => (statusFilter === 'ALL' ? true : c.status === statusFilter))
      .filter((c) => (q ? `${c.code} ${c.name}`.toLowerCase().includes(q) : true));
  }, [ordered, statusFilter, search]);

  const nameOf = (id: string | undefined): string => (id ? centers.find((c) => c.id === id)?.code ?? '—' : '—');
  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };
  const onNew = (parentId?: string): void => { const r = store.createCostCenter({ parentId }); if (r.ok && r.id) setEditorId(r.id); };

  return (
    <>
      <PageActions>
        <Button variant="outline" onClick={() => setImporting(true)}><Upload className="h-4 w-4" /> Import CSV</Button>
        <Button onClick={() => onNew()}><Plus className="h-4 w-4" /> New cost center</Button>
      </PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto" options={[{ value: 'ALL', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }]} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status" />
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or name…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={Target} title="No cost centers" description="Build an organizational hierarchy. Summary nodes cannot be posted to; leaf nodes carry the cost-center tag on posted journal lines. Actuals derive entirely from posted journals." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Code', 'Name', 'Type', 'Parent', 'Level', 'Manager', 'Posting', 'Effective', 'Status', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Level' ? 'text-right' : 'text-left')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs font-semibold"><span style={{ paddingLeft: c.level * 14 }}>{c.code}</span></td>
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{c.type}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{nameOf(c.parentId)}</td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500">{c.level}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{c.managerName ?? '—'}</td>
                  <td className="px-3 py-2">{c.isPostingAllowed ? <Badge tone="blue">posting</Badge> : <Badge tone="slate">summary</Badge>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.effectiveFrom}{c.effectiveTo ? `…${c.effectiveTo}` : ''}</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                      <MenuItem onClick={() => setEditorId(c.id)}><Pencil className="h-4 w-4" /> {c.status === 'archived' ? 'View' : 'Edit'}</MenuItem>
                      <MenuItem onClick={() => onNew(c.id)}><GitBranch className="h-4 w-4" /> Add child</MenuItem>
                      {c.status === 'active' ? <MenuItem onClick={() => act(() => store.setStatus(c.id, 'inactive'), 'Deactivated.')}><Power className="h-4 w-4" /> Deactivate</MenuItem> : c.status === 'inactive' ? <MenuItem onClick={() => act(() => store.activateCostCenter(c.id), 'Activated.')}><Power className="h-4 w-4" /> Activate</MenuItem> : null}
                      {c.status !== 'archived' && <MenuItem onClick={() => act(() => store.setStatus(c.id, 'archived'), 'Archived.')}><Archive className="h-4 w-4" /> Archive</MenuItem>}
                    </Dropdown>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}

      {editorId && <CostCenterEditor costCenterId={editorId} onClose={() => setEditorId(null)} />}
      {importing && <CostCenterImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
