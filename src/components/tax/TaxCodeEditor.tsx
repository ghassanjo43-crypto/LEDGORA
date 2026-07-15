import { useMemo, useState } from 'react';
import { Save, CheckCircle2, Info } from 'lucide-react';
import type { TaxCalculationMethod, TaxCategory, TaxCode, TaxDirection, TaxRoundingMethod, TaxScope } from '@/types/taxCode';
import { useStore } from '@/store/useStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { validateTaxCodeForActivation } from '@/lib/taxValidation';
import { cn as cx } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { TaxAccountMappings } from './TaxAccountMappings';
import { TaxRateVersionTable } from './TaxRateVersionTable';
import { TaxReportingBoxPicker } from './TaxReportingBoxPicker';

const CATEGORY_OPTIONS: { value: TaxCategory; label: string }[] = [
  { value: 'standard', label: 'Standard' }, { value: 'reduced', label: 'Reduced' }, { value: 'zero-rated', label: 'Zero-rated' },
  { value: 'exempt', label: 'Exempt' }, { value: 'out-of-scope', label: 'Out of scope' }, { value: 'reverse-charge', label: 'Reverse charge' },
  { value: 'import', label: 'Import' }, { value: 'self-assessed', label: 'Self-assessed' }, { value: 'withholding', label: 'Withholding' }, { value: 'custom', label: 'Custom' },
];
const DIRECTION_OPTIONS: { value: TaxDirection; label: string }[] = [
  { value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }, { value: 'both', label: 'Both' },
  { value: 'withholding-receivable', label: 'Withholding receivable' }, { value: 'withholding-payable', label: 'Withholding payable' },
];
const SCOPE_OPTIONS: { value: TaxScope; label: string }[] = [
  { value: 'domestic', label: 'Domestic' }, { value: 'export', label: 'Export' }, { value: 'import', label: 'Import' },
  { value: 'intra-region', label: 'Intra-region' }, { value: 'international', label: 'International' }, { value: 'government', label: 'Government' }, { value: 'custom', label: 'Custom' },
];
const CALC_OPTIONS: { value: TaxCalculationMethod; label: string }[] = [
  { value: 'exclusive', label: 'Exclusive' }, { value: 'inclusive', label: 'Inclusive' }, { value: 'compound', label: 'Compound' }, { value: 'self-assessed', label: 'Self-assessed' },
];
const ROUNDING_OPTIONS: { value: TaxRoundingMethod; label: string }[] = [{ value: 'line', label: 'Per line' }, { value: 'document', label: 'Per document' }];

export function TaxCodeEditor({ taxCodeId, onClose }: { taxCodeId: string; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const code = useTaxCodeStore((s) => s.taxCodes.find((c) => c.id === taxCodeId));
  const reportingBoxes = useTaxCodeStore((s) => s.reportingBoxes);
  const updateTaxCode = useTaxCodeStore((s) => s.updateTaxCode);
  const activateTaxCode = useTaxCodeStore((s) => s.activateTaxCode);
  const createRateVersion = useTaxCodeStore((s) => s.createRateVersion);
  const rateVersions = useTaxCodeStore((s) => s.rateVersions);
  const versions = useMemo(
    () => rateVersions.filter((v) => v.taxCodeId === taxCodeId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
    [rateVersions, taxCodeId],
  );
  const { notify } = useToast();

  const [draft, setDraft] = useState<TaxCode | undefined>(code);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (code && code.id !== loadedId) { setLoadedId(code.id); setDraft(code); }
  if (!draft || !code) return null;

  const readOnly = code.status === 'archived';
  const set = <K extends keyof TaxCode>(key: K, value: TaxCode[K]): void => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const persist = (): boolean => {
    const res = updateTaxCode(taxCodeId, draft);
    if (!res.ok) { notify(res.error ?? 'Could not save the tax code.', 'error'); return false; }
    return true;
  };
  const onSave = (): void => { if (persist()) { notify('Tax code saved.', 'success'); onClose(); } };
  const onActivate = (): void => {
    if (!persist()) return;
    const res = activateTaxCode(taxCodeId);
    if (res.ok) { notify('Tax code activated.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not activate the tax code.', 'error');
  };

  const boxes = reportingBoxes.filter((b) => !draft.jurisdictionId || b.jurisdictionId === draft.jurisdictionId);
  const activationIssues = validateTaxCodeForActivation({ ...draft, status: 'active' }, { accountsById: new Map(accounts.map((a) => [a.id, a])), existingCodes: useTaxCodeStore.getState().taxCodes, versions: useTaxCodeStore.getState().rateVersions });
  const errors = activationIssues.filter((i) => i.severity === 'error');

  return (
    <Drawer
      open
      onClose={onClose}
      widthClassName="max-w-4xl"
      title={`Tax code ${code.code || '(new)'}`}
      description={readOnly ? `${code.status} — read only` : 'Configure the rate, accounts, effective dates and reporting boxes'}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-xs text-slate-500">{errors.length > 0 ? `${errors.length} issue(s) block activation` : 'Ready to activate'}</div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {!readOnly && <Button variant="secondary" onClick={onSave}><Save className="h-4 w-4" /> Save</Button>}
            {!readOnly && code.status !== 'active' && <Button onClick={onActivate} disabled={errors.length > 0}><CheckCircle2 className="h-4 w-4" /> Activate</Button>}
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <Section title="General">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Code" required><Input value={draft.code} onChange={(e) => set('code', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Name" required className="sm:col-span-2"><Input value={draft.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Category" required><Select options={CATEGORY_OPTIONS} value={draft.category} onChange={(e) => set('category', e.target.value as TaxCategory)} disabled={readOnly} /></Field>
            <Field label="Direction" required><Select options={DIRECTION_OPTIONS} value={draft.direction} onChange={(e) => set('direction', e.target.value as TaxDirection)} disabled={readOnly} /></Field>
            <Field label="Scope"><Select options={SCOPE_OPTIONS} value={draft.scope} onChange={(e) => set('scope', e.target.value as TaxScope)} disabled={readOnly} /></Field>
            <Field label="Description" className="sm:col-span-3"><Input value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} disabled={readOnly} /></Field>
          </div>
        </Section>

        <Section title="Calculation">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Rate %" required><Input type="number" step="0.01" value={draft.rate} onChange={(e) => set('rate', Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            <Field label="Calculation method" required><Select options={CALC_OPTIONS} value={draft.calculationMethod} onChange={(e) => set('calculationMethod', e.target.value as TaxCalculationMethod)} disabled={readOnly} /></Field>
            <Field label="Rounding"><Select options={ROUNDING_OPTIONS} value={draft.roundingMethod} onChange={(e) => set('roundingMethod', e.target.value as TaxRoundingMethod)} disabled={readOnly} /></Field>
            <Field label="Precision"><Input type="number" value={draft.precision} onChange={(e) => set('precision', Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            <Field label="Recoverability %"><Input type="number" step="0.01" value={draft.recoverabilityPercent ?? 100} onChange={(e) => set('recoverabilityPercent', Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
          </div>
        </Section>

        <Section title="Accounts">
          <TaxAccountMappings code={draft} accounts={accounts} onChange={(field, id) => set(field, id)} disabled={readOnly} />
        </Section>

        <Section title="Effective dates">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Effective from" required><Input type="date" value={draft.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} disabled={readOnly} /></Field>
            <Field label="Effective to"><Input type="date" value={draft.effectiveTo ?? ''} onChange={(e) => set('effectiveTo', e.target.value || undefined)} disabled={readOnly} /></Field>
          </div>
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Rate versions</p>
            <TaxRateVersionTable versions={versions} onCreate={(input) => createRateVersion(taxCodeId, input)} disabled={readOnly} />
          </div>
        </Section>

        <Section title="Reporting">
          <div className="space-y-3">
            <TaxReportingBoxPicker boxes={boxes} selected={draft.reportingBoxIds} onChange={(ids) => set('reportingBoxIds', ids)} disabled={readOnly} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Invoice label"><Input value={draft.invoiceLabel ?? ''} onChange={(e) => set('invoiceLabel', e.target.value)} disabled={readOnly} /></Field>
              <Field label="Bill label"><Input value={draft.billLabel ?? ''} onChange={(e) => set('billLabel', e.target.value)} disabled={readOnly} /></Field>
            </div>
          </div>
        </Section>

        <Section title="Defaults & restrictions">
          <div className="flex flex-wrap gap-4 text-xs">
            {([['isDefaultSales', 'Default sales'], ['isDefaultPurchase', 'Default purchase'], ['isDefaultExport', 'Default export'], ['isDefaultImport', 'Default import'], ['requiresTaxNumber', 'Require tax number'], ['requiresReason', 'Require reason'], ['requiresReverseChargeNote', 'Require reverse-charge note']] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={!!draft[key]} onChange={(e) => set(key, e.target.checked as never)} disabled={readOnly} /> {label}
              </label>
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
  return (
    <section className={cx('rounded-xl border border-slate-200 p-4 dark:border-slate-800')}>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      {children}
    </section>
  );
}
