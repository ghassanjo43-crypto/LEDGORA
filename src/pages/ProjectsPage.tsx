import { useMemo, useState } from 'react';
import { Plus, ChevronDown, Pencil, Power, Archive, FolderKanban } from 'lucide-react';
import type { Project } from '@/types/project';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useProjectStore } from '@/store/projectStore';
import { buildProjectSummary } from '@/lib/projectReporting';
import { formatCurrency } from '@/lib/money';
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
import { ProjectEditor } from '@/components/projects/ProjectEditor';

const STATUS_TONE: Record<Project['status'], BadgeTone> = { planning: 'slate', active: 'green', 'on-hold': 'amber', completed: 'blue', cancelled: 'red', archived: 'red', closed: 'violet' };

export function ProjectsPage() {
  const base = useStore((s) => s.settings.baseCurrency);
  const accounts = useStore((s) => s.accounts);
  const entries = useJournalStore((s) => s.entries);
  const entities = useEntityStore((s) => s.entities);
  const projects = useProjectStore((s) => s.projects);
  const store = useProjectStore();
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  const money = (n: number): string => formatCurrency(n, base);
  const custName = (id: string | undefined): string => (id ? entities.find((e) => e.id === id)?.legalName ?? '—' : '—');
  const summary = useMemo(() => new Map(buildProjectSummary(entries, accounts, projects, { base }).map((r) => [r.projectId, r])), [entries, accounts, projects, base]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => (statusFilter === 'ALL' ? true : p.status === statusFilter))
      .filter((p) => (q ? `${p.code} ${p.name}`.toLowerCase().includes(q) : true))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [projects, statusFilter, search]);

  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };
  const onNew = (): void => { const r = store.createProject(); if (r.ok && r.id) setEditorId(r.id); };

  return (
    <>
      <PageActions><Button onClick={onNew}><Plus className="h-4 w-4" /> New project</Button></PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto" options={[{ value: 'ALL', label: 'All statuses' }, ...['planning', 'active', 'on-hold', 'completed', 'cancelled', 'archived'].map((s) => ({ value: s, label: s }))]} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status" />
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or name…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={FolderKanban} title="No projects" description="Track temporary initiatives, contracts and jobs. Tag journal, invoice and bill lines with a project — actuals derive from posted journal lines, not a separate balance." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Code', 'Name', 'Customer', 'Status', 'Start', 'Revenue', 'Cost', 'Margin', 'Budget', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Revenue', 'Cost', 'Margin', 'Budget'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((p) => {
                const s = summary.get(p.id);
                return (
                  <tr key={p.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{p.code}</td>
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{custName(p.customerId)}</td>
                    <td className="px-3 py-2"><Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge></td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.startDate}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(s?.revenue ?? 0)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(s?.cost ?? 0)}</td>
                    <td className={cx('px-3 py-2 text-right font-mono font-semibold', (s?.margin ?? 0) < 0 ? 'text-red-600' : '')}>{money(s?.margin ?? 0)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(p.budgetAmount ?? 0)}</td>
                    <td className="px-3 py-2 text-right">
                      <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                        <MenuItem onClick={() => setEditorId(p.id)}><Pencil className="h-4 w-4" /> {p.status === 'archived' ? 'View' : 'Edit'}</MenuItem>
                        {p.status !== 'active' && p.status !== 'archived' ? <MenuItem onClick={() => act(() => store.activateProject(p.id), 'Activated.')}><Power className="h-4 w-4" /> Activate</MenuItem> : p.status === 'active' ? <MenuItem onClick={() => act(() => store.setStatus(p.id, 'on-hold'), 'Put on hold.')}><Power className="h-4 w-4" /> Put on hold</MenuItem> : null}
                        {p.status !== 'archived' && <MenuItem onClick={() => act(() => store.setStatus(p.id, 'archived'), 'Archived.')}><Archive className="h-4 w-4" /> Archive</MenuItem>}
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div></Card>
      )}

      {editorId && <ProjectEditor projectId={editorId} onClose={() => setEditorId(null)} />}
    </>
  );
}
