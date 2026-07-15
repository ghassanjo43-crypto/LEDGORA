import { useState } from 'react';
import { Save, ShieldCheck } from 'lucide-react';
import type { CommercialBasePlan, OverageRates, RenderCostAssumptions } from '@/types/metering';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useIsMeteringAdmin } from '@/store/meteringHooks';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * Super-administrator editor for all metering configuration: base-plan prices &
 * allowances, optional-module prices, customer overage rates, Render cost
 * assumptions and warning thresholds. Everything here is data-driven and
 * persisted — nothing is hard-coded.
 */
export function MeteringConfigEditor() {
  const isAdmin = useIsMeteringAdmin();
  const config = useMeteringConfigStore((s) => s.config);
  const updateBasePlan = useMeteringConfigStore((s) => s.updateBasePlan);
  const updateOptionalModule = useMeteringConfigStore((s) => s.updateOptionalModule);
  const updateOverageRates = useMeteringConfigStore((s) => s.updateOverageRates);
  const updateRenderCosts = useMeteringConfigStore((s) => s.updateRenderCosts);
  const updateThresholds = useMeteringConfigStore((s) => s.updateThresholds);

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Super administrator required" description="Only the super administrator can edit metering configuration and prices." />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Base plans & allowances" description="Monthly price and per-metric allowances for each package." />
        <CardBody className="space-y-4">
          {[...config.basePlans].sort((a, b) => a.sortOrder - b.sortOrder).map((plan) => (
            <BasePlanEditor key={plan.id} plan={plan} onSave={(patch) => updateBasePlan(plan.id, patch)} />
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Optional modules" description="Priced add-on modules." />
        <CardBody className="space-y-2">
          {[...config.optionalModules].sort((a, b) => a.sortOrder - b.sortOrder).map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800">
              <span className="min-w-[9rem] font-medium text-slate-700 dark:text-slate-200">{m.name}</span>
              <NumberField label="Price / month" value={m.priceMonthly} onCommit={(v) => updateOptionalModule(m.id, { priceMonthly: v })} />
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
                <Toggle checked={m.isActive} onChange={(v) => updateOptionalModule(m.id, { isActive: v })} label={`Toggle ${m.name}`} /> Active
              </label>
            </div>
          ))}
        </CardBody>
      </Card>

      <OverageRatesEditor rates={config.overageRates} onSave={updateOverageRates} />
      <RenderCostsEditor costs={config.renderCosts} onSave={updateRenderCosts} />

      <Card>
        <CardHeader title="Warning thresholds" description="Percentages at which usage warnings appear." />
        <CardBody>
          <ThresholdEditor value={config.thresholds} onSave={updateThresholds} />
        </CardBody>
      </Card>
    </div>
  );
}

function BasePlanEditor({ plan, onSave }: { plan: CommercialBasePlan; onSave: (patch: Partial<CommercialBasePlan>) => { ok: boolean; error?: string } }) {
  const [price, setPrice] = useState(plan.priceMonthly);
  const [a, setA] = useState(plan.allowances);
  const [saved, setSaved] = useState(false);
  const setAllow = (k: keyof typeof a, v: number): void => setA((prev) => ({ ...prev, [k]: v }));

  const save = (): void => {
    const res = onSave({ priceMonthly: price, allowances: a });
    if (res.ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1200);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-slate-800 dark:text-slate-100">{plan.name}{plan.startingAt && <span className="ml-1 text-xs text-slate-400">(starting at)</span>}</span>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
          <Button variant="primary" size="sm" onClick={save}><Save className="h-4 w-4" /> Save</Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <NumberField label="Price / month" value={price} onCommit={setPrice} />
        <NumberField label="Users" value={a.users} onCommit={(v) => setAllow('users', v)} />
        <NumberField label="Companies" value={a.companies} onCommit={(v) => setAllow('companies', v)} />
        <NumberField label="Storage GB" value={a.storageGb} onCommit={(v) => setAllow('storageGb', v)} />
        <NumberField label="Bandwidth GB" value={a.bandwidthGb} onCommit={(v) => setAllow('bandwidthGb', v)} />
        <NumberField label="Journal entries" value={a.journalEntries} onCommit={(v) => setAllow('journalEntries', v)} />
        <NumberField label="API requests" value={a.apiRequests} onCommit={(v) => setAllow('apiRequests', v)} />
        <NumberField label="Invoices" value={a.invoices} onCommit={(v) => setAllow('invoices', v)} />
        <NumberField label="AI units" value={a.aiUnits} onCommit={(v) => setAllow('aiUnits', v)} />
      </div>
    </div>
  );
}

function OverageRatesEditor({ rates, onSave }: { rates: OverageRates; onSave: (patch: Partial<OverageRates>) => { ok: boolean } }) {
  const [r, setR] = useState(rates);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof OverageRates, v: number): void => setR((prev) => ({ ...prev, [k]: v }));
  return (
    <Card>
      <CardHeader title="Customer overage rates" description="Charged for usage beyond the plan allowance." actions={
        <Button variant="primary" size="sm" onClick={() => { onSave(r); setSaved(true); window.setTimeout(() => setSaved(false), 1200); }}>
          <Save className="h-4 w-4" /> Save{saved ? 'd' : ''}
        </Button>
      } />
      <CardBody className="flex flex-wrap gap-3">
        <NumberField label="Storage $/GB-mo" value={r.storagePerGbMonth} step="0.01" onCommit={(v) => set('storagePerGbMonth', v)} />
        <NumberField label="Bandwidth $/GB" value={r.bandwidthPerGb} step="0.01" onCommit={(v) => set('bandwidthPerGb', v)} />
        <NumberField label="Extra user $/mo" value={r.extraUserMonth} onCommit={(v) => set('extraUserMonth', v)} />
        <NumberField label="Extra company $/mo" value={r.extraCompanyMonth} onCommit={(v) => set('extraCompanyMonth', v)} />
        <NumberField label="JE block size" value={r.journalEntriesBlock} onCommit={(v) => set('journalEntriesBlock', v)} />
        <NumberField label="JE block $" value={r.journalEntriesBlockPrice} onCommit={(v) => set('journalEntriesBlockPrice', v)} />
        <NumberField label="API block size" value={r.apiRequestsBlock} onCommit={(v) => set('apiRequestsBlock', v)} />
        <NumberField label="API block $" value={r.apiRequestsBlockPrice} onCommit={(v) => set('apiRequestsBlockPrice', v)} />
      </CardBody>
    </Card>
  );
}

function RenderCostsEditor({ costs, onSave }: { costs: RenderCostAssumptions; onSave: (patch: Partial<RenderCostAssumptions>) => { ok: boolean } }) {
  const [c, setC] = useState(costs);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof RenderCostAssumptions, v: number): void => setC((prev) => ({ ...prev, [k]: v }));
  return (
    <Card>
      <CardHeader title="Render cost assumptions" description="Your real infrastructure costs, used to estimate cost recovery." actions={
        <Button variant="primary" size="sm" onClick={() => { onSave(c); setSaved(true); window.setTimeout(() => setSaved(false), 1200); }}>
          <Save className="h-4 w-4" /> Save{saved ? 'd' : ''}
        </Button>
      } />
      <CardBody className="flex flex-wrap gap-3">
        <NumberField label="Web service $/mo" value={c.webServiceMonthly} onCommit={(v) => set('webServiceMonthly', v)} />
        <NumberField label="Postgres $/mo" value={c.postgresMonthly} onCommit={(v) => set('postgresMonthly', v)} />
        <NumberField label="Storage $/GB-mo" value={c.objectStoragePerGbMonth} step="0.01" onCommit={(v) => set('objectStoragePerGbMonth', v)} />
        <NumberField label="Egress $/GB" value={c.egressPerGb} step="0.01" onCommit={(v) => set('egressPerGb', v)} />
        <NumberField label="AI $/unit" value={c.aiCostPerUnit} step="0.0001" onCommit={(v) => set('aiCostPerUnit', v)} />
        <NumberField label="API $/million" value={c.perMillionApiRequests} step="0.01" onCommit={(v) => set('perMillionApiRequests', v)} />
        <NumberField label="Overhead $/mo" value={c.overheadMonthly} onCommit={(v) => set('overheadMonthly', v)} />
      </CardBody>
    </Card>
  );
}

function ThresholdEditor({ value, onSave }: { value: number[]; onSave: (t: number[]) => { ok: boolean; error?: string } }) {
  const [text, setText] = useState(value.join(', '));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-500">Thresholds (%)</label>
        <Input value={text} onChange={(e) => setText(e.target.value)} className="w-56" />
      </div>
      <Button variant="primary" size="sm" onClick={() => {
        const parsed = text.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        const res = onSave(parsed);
        setError(res.ok ? null : res.error ?? 'Invalid thresholds.');
      }}><Save className="h-4 w-4" /> Save</Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

function NumberField({ label, value, onCommit, step }: { label: string; value: number; onCommit: (v: number) => void; step?: string }) {
  return (
    <div className="w-32">
      <label className="mb-1 block text-[11px] font-medium text-slate-500">{label}</label>
      <Input
        type="number"
        step={step ?? '1'}
        defaultValue={value}
        key={value}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v !== value) onCommit(v);
        }}
      />
    </div>
  );
}
