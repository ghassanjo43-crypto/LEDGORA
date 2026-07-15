import { useState } from 'react';
import { Save, CheckCircle2, Info } from 'lucide-react';
import type { CostCenter, CostCenterType } from '@/types/costCenter';
import { useCostCenterStore } from '@/store/costCenterStore';
import { validateCostCenterForActivation } from '@/lib/costCenterValidation';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

const TYPES: CostCenterType[] = ['operating', 'administrative', 'sales', 'production', 'service', 'support', 'shared', 'corporate', 'custom'];

export function CostCenterEditor({ costCenterId, onClose }: { costCenterId: string; onClose: () => void }) {
  const centers = useCostCenterStore((s) => s.costCenters);
  const source = centers.find((c) => c.id === costCenterId);
  const updateCostCenter = useCostCenterStore((s) => s.updateCostCenter);
  const moveCostCenter = useCostCenterStore((s) => s.moveCostCenter);
  const activateCostCenter = useCostCenterStore((s) => s.activateCostCenter);
  const { notify } = useToast();

  const [draft, setDraft] = useState<CostCenter | undefined>(source);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (source && source.id !== loadedId) { setLoadedId(source.id); setDraft(source); }
  if (!draft || !source) return null;

  const readOnly = source.status === 'archived';
  const set = <K extends keyof CostCenter>(k: K, v: CostCenter[K]): void => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const issues = validateCostCenterForActivation({ ...draft, status: 'active' }, { existing: centers });
  const errors = issues.filter((i) => i.severity === 'error');

  const parentOptions = [{ value: '', label: '— none (root) —' }, ...centers.filter((c) => c.id !== draft.id && c.entityId === draft.entityId).sort((a, b) => a.hierarchyPath.length - b.hierarchyPath.length || a.code.localeCompare(b.code)).map((c) => ({ value: c.id, label: `${'· '.repeat(c.level)}${c.code} · ${c.name}` }))];

  const onSave = (): void => {
    // Parent changes route through moveCostCenter to re-path descendants.
    if (draft.parentId !== source.parentId) {
      const m = moveCostCenter(draft.id, draft.parentId || undefined);
      if (!m.ok) { notify(m.error ?? 'Could not move.', 'error'); return; }
    }
    const { parentId, ...rest } = draft;
    void parentId;
    const res = updateCostCenter(costCenterId, rest);
    if (res.ok) { notify('Cost center saved.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not save.', 'error');
  };
  const onActivate = (): void => {
    onSave();
    const res = activateCostCenter(costCenterId);
    if (res.ok) notify('Cost center activated.', 'success'); else notify(res.error ?? 'Could not activate.', 'error');
  };

  return (
    <Drawer open onClose={onClose} widthClassName="max-w-2xl" title={`Cost center ${draft.code || '(new)'}`} description={readOnly ? 'archived — read only' : 'Configure code, hierarchy, effective dates and capabilities'}
      footer={<div className="flex w-full items-center justify-between gap-3"><span className="text-xs text-slate-500">{errors.length ? `${errors.length} issue(s) block activation` : 'Ready'}</span><div className="flex gap-2"><Button variant="outline" onClick={onClose}>Close</Button>{!readOnly && <Button variant="secondary" onClick={onSave}><Save className="h-4 w-4" /> Save</Button>}{!readOnly && draft.status !== 'active' && <Button onClick={onActivate} disabled={errors.length > 0}><CheckCircle2 className="h-4 w-4" /> Activate</Button>}</div></div>}>
      <div className="space-y-5">
        <Section title="General">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Code" required><Input value={draft.code} onChange={(e) => set('code', e.target.value.toUpperCase())} disabled={readOnly} /></Field>
            <Field label="Name" required className="sm:col-span-2"><Input value={draft.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Type"><Select options={TYPES.map((t) => ({ value: t, label: t }))} value={draft.type} onChange={(e) => set('type', e.target.value as CostCenterType)} disabled={readOnly} /></Field>
            <Field label="Description" className="sm:col-span-2"><Input value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} disabled={readOnly} /></Field>
          </div>
        </Section>

        <Section title="Hierarchy">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Parent" className="sm:col-span-2"><Select options={parentOptions} value={draft.parentId ?? ''} onChange={(e) => set('parentId', e.target.value || undefined)} disabled={readOnly} /></Field>
            <Field label="Sort order"><Input type="number" value={draft.sortOrder} onChange={(e) => set('sortOrder', Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={draft.isPostingAllowed} onChange={(e) => set('isPostingAllowed', e.target.checked)} disabled={readOnly} /> Posting allowed (leaf nodes only; summary nodes cannot be posted to)</label>
        </Section>

        <Section title="Ownership & effective dates">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Manager"><Input value={draft.managerName ?? ''} onChange={(e) => set('managerName', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Effective from" required><Input type="date" value={draft.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Effective to"><Input type="date" value={draft.effectiveTo ?? ''} onChange={(e) => set('effectiveTo', e.target.value || undefined)} disabled={readOnly} /></Field>
          </div>
        </Section>

        <Section title="Capabilities">
          <div className="flex flex-wrap gap-4 text-xs">
            {([['isBudgetEnabled', 'Budget enabled'], ['isAllocationSource', 'Allocation source'], ['isAllocationTarget', 'Allocation target']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300"><input type="checkbox" checked={!!draft[k]} onChange={(e) => set(k, e.target.checked as never)} disabled={readOnly} /> {label}</label>
            ))}
          </div>
        </Section>

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>{children}</section>;
}
