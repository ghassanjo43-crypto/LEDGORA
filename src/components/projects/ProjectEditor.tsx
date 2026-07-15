import { useState } from 'react';
import { Save, CheckCircle2, Info } from 'lucide-react';
import type { Project, ProjectStatus } from '@/types/project';
import { useProjectStore } from '@/store/projectStore';
import { useEntityStore } from '@/store/useEntityStore';
import { validateProjectForActivation } from '@/lib/projectValidation';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';

const STATUSES: ProjectStatus[] = ['planning', 'active', 'on-hold', 'completed', 'cancelled', 'archived'];

export function ProjectEditor({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const projects = useProjectStore((s) => s.projects);
  const source = projects.find((p) => p.id === projectId);
  const updateProject = useProjectStore((s) => s.updateProject);
  const activateProject = useProjectStore((s) => s.activateProject);
  const entities = useEntityStore((s) => s.entities);
  const customers = entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both');
  const { notify } = useToast();

  const [draft, setDraft] = useState<Project | undefined>(source);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (source && source.id !== loadedId) { setLoadedId(source.id); setDraft(source); }
  if (!draft || !source) return null;

  const readOnly = source.status === 'archived';
  const set = <K extends keyof Project>(k: K, v: Project[K]): void => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const errors = validateProjectForActivation({ ...draft, status: 'active' }, { existing: projects }).filter((i) => i.severity === 'error');

  const onSave = (): void => {
    const res = updateProject(projectId, draft);
    if (res.ok) { notify('Project saved.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not save.', 'error');
  };
  const onActivate = (): void => {
    onSave();
    const res = activateProject(projectId);
    if (res.ok) notify('Project activated.', 'success'); else notify(res.error ?? 'Could not activate.', 'error');
  };

  return (
    <Drawer open onClose={onClose} widthClassName="max-w-2xl" title={`Project ${draft.code || '(new)'}`} description={readOnly ? 'archived — read only' : 'Configure the project, customer, dates and budget'}
      footer={<div className="flex w-full items-center justify-between gap-3"><span className="text-xs text-slate-500">{errors.length ? `${errors.length} issue(s) block activation` : 'Ready'}</span><div className="flex gap-2"><Button variant="outline" onClick={onClose}>Close</Button>{!readOnly && <Button variant="secondary" onClick={onSave}><Save className="h-4 w-4" /> Save</Button>}{!readOnly && draft.status !== 'active' && <Button onClick={onActivate} disabled={errors.length > 0}><CheckCircle2 className="h-4 w-4" /> Activate</Button>}</div></div>}>
      <div className="space-y-5">
        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">General</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Code" required><Input value={draft.code} onChange={(e) => set('code', e.target.value.toUpperCase())} disabled={readOnly} /></Field>
            <Field label="Name" required className="sm:col-span-2"><Input value={draft.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Status"><Select options={STATUSES.map((s) => ({ value: s, label: s }))} value={draft.status} onChange={(e) => set('status', e.target.value as ProjectStatus)} disabled={readOnly} /></Field>
            <Field label="Customer" className="sm:col-span-2"><EntityPicker value={draft.customerId ?? ''} entities={customers} onChange={(e) => set('customerId', e?.id)} placeholder="Optional customer" disabled={readOnly} /></Field>
            <Field label="Description" className="sm:col-span-3"><Input value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} disabled={readOnly} /></Field>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Dates, budget & ownership</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Start date" required><Input type="date" value={draft.startDate} onChange={(e) => set('startDate', e.target.value)} disabled={readOnly} /></Field>
            <Field label="End date"><Input type="date" value={draft.endDate ?? ''} onChange={(e) => set('endDate', e.target.value || undefined)} disabled={readOnly} /></Field>
            <Field label="Manager"><Input value={draft.managerName ?? ''} onChange={(e) => set('managerName', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Budget"><Input type="number" step="0.01" value={draft.budgetAmount ?? 0} onChange={(e) => set('budgetAmount', Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            <label className="mt-6 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={!!draft.isBillable} onChange={(e) => set('isBillable', e.target.checked)} disabled={readOnly} /> Billable project</label>
          </div>
        </section>

        {errors.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <p className="flex items-center gap-1.5 font-semibold"><Info className="h-3.5 w-3.5" /> Resolve before activating:</p>
            <ul className="mt-1 list-disc pl-5">{errors.map((e) => <li key={e.rule}>{e.message}</li>)}</ul>
          </div>
        )}
      </div>
    </Drawer>
  );
}
