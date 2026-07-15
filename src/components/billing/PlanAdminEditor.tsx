import { useMemo, useState } from 'react';
import { Plus, Save, Archive, RotateCcw, Loader2, ShieldCheck } from 'lucide-react';
import type { SubscriptionPlan } from '@/types/billing';
import type { LedgoraEdition } from '@/types/entitlements';
import { useBillingStore } from '@/store/billingStore';
import { usePlans, useIsAdmin } from '@/store/billingHooks';
import { ALL_EDITIONS } from '@/config/editions';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { EmptyState } from '@/components/ui/EmptyState';

type Draft = Pick<
  SubscriptionPlan,
  'name' | 'description' | 'edition' | 'priceMonthly' | 'currency' | 'userLimit' | 'entityLimit' | 'isActive' | 'isPublic'
>;

const EDITION_OPTIONS = ALL_EDITIONS.map((e) => ({ value: e, label: EDITION_INFO[e].name }));

function toDraft(p: SubscriptionPlan): Draft {
  return {
    name: p.name,
    description: p.description,
    edition: p.edition,
    priceMonthly: p.priceMonthly,
    currency: p.currency,
    userLimit: p.userLimit,
    entityLimit: p.entityLimit,
    isActive: p.isActive,
    isPublic: p.isPublic,
  };
}

/**
 * Administrator package editor. Names, prices, limits, edition-entitlement and
 * availability are all editable and persisted — nothing is hard-coded.
 */
export function PlanAdminEditor() {
  const plans = usePlans();
  const isAdmin = useIsAdmin();
  const updatePlan = useBillingStore((s) => s.updatePlan);
  const archivePlan = useBillingStore((s) => s.archivePlan);
  const restorePlan = useBillingStore((s) => s.restorePlan);
  const createPlan = useBillingStore((s) => s.createPlan);

  const sorted = useMemo(() => [...plans].sort((a, b) => a.sortOrder - b.sortOrder), [plans]);

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Administrator access required" description="Only administrators can edit packages and pricing." />;
  }

  const onAdd = (): void => {
    const nextOrder = plans.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1;
    createPlan({
      code: `custom_${nextOrder}`,
      name: 'New package',
      description: '',
      edition: 'core',
      priceMonthly: 0,
      currency: 'USD',
      userLimit: 1,
      entityLimit: 1,
      addOnModules: [],
      removedModules: [],
      isActive: true,
      isPublic: false,
      sortOrder: nextOrder,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onAdd}><Plus className="h-4 w-4" /> Add package</Button>
      </div>
      {sorted.map((plan) => (
        <PlanRow
          key={plan.id}
          plan={plan}
          onSave={(draft) => updatePlan(plan.id, draft)}
          onArchive={() => archivePlan(plan.id)}
          onRestore={() => restorePlan(plan.id)}
        />
      ))}
    </div>
  );
}

function PlanRow({
  plan,
  onSave,
  onArchive,
  onRestore,
}: {
  plan: SubscriptionPlan;
  onSave: (draft: Draft) => { ok: boolean; error?: string; fieldErrors?: Record<string, string> };
  onArchive: () => void;
  onRestore: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((d) => ({ ...d, [key]: value }));

  const save = (): void => {
    setStatus('saving');
    setMessage(null);
    const res = onSave(draft);
    if (!res.ok) {
      setStatus('error');
      setErrors(res.fieldErrors ?? {});
      setMessage(res.error ?? 'Could not save.');
      return;
    }
    setErrors({});
    setStatus('saved');
    window.setTimeout(() => setStatus('idle'), 1500);
  };

  return (
    <Card className={plan.isActive ? '' : 'opacity-70'}>
      <CardHeader
        title={plan.name}
        description={`Code: ${plan.code}`}
        actions={
          <div className="flex items-center gap-1.5">
            {!plan.isActive && <Badge tone="amber">Archived</Badge>}
            {plan.isPublic && plan.isActive && <Badge tone="green">Public</Badge>}
          </div>
        }
      />
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FieldInput label="Package name" value={draft.name} error={errors.name} onChange={(v) => set('name', v)} />
          <FieldSelect label="Edition (entitlements)" value={draft.edition} options={EDITION_OPTIONS} onChange={(v) => set('edition', v as LedgoraEdition)} />
          <FieldInput label={`Monthly price (${draft.currency})`} type="number" value={String(draft.priceMonthly)} error={errors.priceMonthly} onChange={(v) => set('priceMonthly', Number(v))} />
          <FieldInput label="User limit" type="number" value={String(draft.userLimit)} error={errors.userLimit} onChange={(v) => set('userLimit', Number(v))} />
          <FieldInput label="Entity limit" type="number" value={String(draft.entityLimit)} error={errors.entityLimit} onChange={(v) => set('entityLimit', Number(v))} />
          <FieldInput label="Currency" value={draft.currency} error={errors.currency} onChange={(v) => set('currency', v)} />
        </div>
        <FieldInput label="Description" value={draft.description} onChange={(v) => set('description', v)} />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Toggle checked={draft.isActive} onChange={(v) => set('isActive', v)} label="Available for purchase" /> Available
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Toggle checked={draft.isPublic} onChange={(v) => set('isPublic', v)} label="Shown in catalog" /> In catalog
          </label>
          <div className="ml-auto flex items-center gap-2">
            {message && <span className="text-xs text-red-600">{message}</span>}
            {status === 'saved' && <span className="text-xs text-emerald-600">Saved</span>}
            {plan.isActive ? (
              <Button variant="ghost" size="sm" onClick={onArchive}><Archive className="h-4 w-4" /> Archive</Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onRestore}><RotateCcw className="h-4 w-4" /> Restore</Button>
            )}
            <Button variant="primary" size="sm" onClick={save} disabled={status === 'saving'}>
              {status === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function FieldInput({ label, value, onChange, error, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; error?: string; type?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <Input type={type} value={value} hasError={!!error} onChange={(e) => onChange(e.target.value)} />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function FieldSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <Select value={value} options={options} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
