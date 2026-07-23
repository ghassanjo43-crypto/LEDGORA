import { useState } from 'react';
import { Save, ShieldAlert } from 'lucide-react';
import type { Currency, CurrencyType, NegativeFormat, SymbolPosition, ThousandSeparator, DecimalSeparator, RoundingMethod } from '@/types/currency';
import { CURRENCY_TYPES, MAX_MONETARY_DECIMALS, MAX_RATE_DECIMALS, currencyTypeOf, monetaryDecimalsOf, rateDecimalsOf, roundingMethodOf } from '@/types/currency';
import { ROUNDING_METHODS } from '@/lib/decimal';
import { useCurrencyStore } from '@/store/currencyStore';
import { validateCurrency } from '@/lib/currencyValidation';
import { normalizeCurrencyCode, patchTouchesCriticalFields, precisionPreview } from '@/lib/currencyMaster';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

const TYPE_LABELS: Record<CurrencyType, string> = {
  fiat: 'Fiat', cryptocurrency: 'Cryptocurrency', 'digital-token': 'Digital token',
  commodity: 'Commodity', internal: 'Internal unit of account', historical: 'Historical', custom: 'Custom',
};

const ROUNDING_LABELS: Record<RoundingMethod, string> = {
  'half-up': 'Half up (ties away from zero)', 'half-down': 'Half down (ties toward zero)',
  'half-even': 'Half even (banker’s)', 'toward-zero': 'Toward zero (truncate)',
  'away-from-zero': 'Away from zero', floor: 'Floor (toward −∞)', ceiling: 'Ceiling (toward +∞)',
};

export function CurrencyEditor({ currencyId, onClose }: { currencyId: string; onClose: () => void }) {
  const currencies = useCurrencyStore((s) => s.currencies);
  const source = currencies.find((c) => c.id === currencyId);
  const updateCurrency = useCurrencyStore((s) => s.updateCurrency);
  const usedCodes = useCurrencyStore((s) => s.usedCurrencyCodes);
  const { notify } = useToast();

  const [draft, setDraft] = useState<Currency | undefined>(source);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [confirmedImpact, setConfirmedImpact] = useState(false);
  if (source && source.id !== loadedId) { setLoadedId(source.id); setDraft(source); setConfirmedImpact(false); }
  if (!draft || !source) return null;

  const readOnly = source.status === 'archived';
  const inUse = usedCodes().has(normalizeCurrencyCode(source.code));
  const criticalChange = patchTouchesCriticalFields(source, draft);
  const set = <K extends keyof Currency>(k: K, v: Currency[K]): void => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const issues = validateCurrency(draft, currencies);
  const errors = issues.filter((i) => i.severity === 'error');

  const onSave = (): void => {
    if (errors.length) { notify(errors[0]!.message, 'error'); return; }
    const res = updateCurrency(currencyId, draft, { elevated: true, confirmedImpact });
    if (res.ok) { notify('Currency saved.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not save.', 'error');
  };

  const dp = monetaryDecimalsOf(draft);

  return (
    <Drawer open onClose={onClose} widthClassName="max-w-3xl" title={`Currency ${draft.code || '(new)'}`} description={readOnly ? 'archived — read only' : 'Configure code, type, precision, rounding and formatting'}
      footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={onClose}>Close</Button>{!readOnly && <Button onClick={onSave}><Save className="h-4 w-4" /> Save</Button>}</div>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={draft.isIso ? 'blue' : 'violet'}>{draft.isIso ? 'Standard ISO' : 'Custom'}</Badge>
          <Badge tone="slate">{TYPE_LABELS[currencyTypeOf(draft)]}</Badge>
          {draft.isoNumericCode && <Badge tone="slate">ISO #{draft.isoNumericCode}</Badge>}
          {inUse && <Badge tone="amber">used on transactions</Badge>}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={draft.isIso ? 'ISO code' : 'Currency code'} required>
            <Input value={draft.code} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={draft.isIso ? 3 : 12} disabled={readOnly || draft.isIso} />
          </Field>
          <Field label="Name" required className="sm:col-span-2"><Input value={draft.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} /></Field>
          <Field label="Localized name"><Input value={draft.localizedName ?? ''} onChange={(e) => set('localizedName', e.target.value || undefined)} disabled={readOnly} /></Field>
          <Field label="Currency type">
            <Select options={CURRENCY_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))} value={currencyTypeOf(draft)} onChange={(e) => set('currencyType', e.target.value as CurrencyType)} disabled={readOnly || draft.isIso} />
          </Field>
          <Field label="Country / region"><Input value={draft.region ?? ''} onChange={(e) => set('region', e.target.value || undefined)} disabled={readOnly} /></Field>
          <Field label="Symbol" required><Input value={draft.symbol} onChange={(e) => set('symbol', e.target.value)} disabled={readOnly} /></Field>
          <Field label={`Monetary decimals (0–${MAX_MONETARY_DECIMALS})`} required>
            <Input type="number" min={0} max={MAX_MONETARY_DECIMALS} value={draft.decimalPlaces} onChange={(e) => set('decimalPlaces', Number(e.target.value))} disabled={readOnly} className="text-right" />
          </Field>
          <Field label={`Exchange-rate decimals (0–${MAX_RATE_DECIMALS})`}>
            <Input type="number" min={0} max={MAX_RATE_DECIMALS} value={rateDecimalsOf(draft)} onChange={(e) => set('exchangeRateDecimalPlaces', Number(e.target.value))} disabled={readOnly} className="text-right" />
          </Field>
          <Field label="Rounding method">
            <Select options={ROUNDING_METHODS.map((m) => ({ value: m, label: ROUNDING_LABELS[m] }))} value={roundingMethodOf(draft)} onChange={(e) => set('roundingMethod', e.target.value as RoundingMethod)} disabled={readOnly} />
          </Field>
          <Field label="Rounding increment"><Input type="number" step="0.001" value={draft.roundingIncrement ?? ''} onChange={(e) => set('roundingIncrement', e.target.value ? Number(e.target.value) : undefined)} disabled={readOnly} className="text-right" placeholder="e.g. 0.05" /></Field>
          <Field label="Smallest unit"><Input value={draft.minorUnitName ?? ''} onChange={(e) => set('minorUnitName', e.target.value || undefined)} disabled={readOnly} placeholder="cent / fils / satoshi" /></Field>
          <Field label="Smallest unit (plural)"><Input value={draft.minorUnitPluralName ?? ''} onChange={(e) => set('minorUnitPluralName', e.target.value || undefined)} disabled={readOnly} /></Field>
          <Field label="Symbol position"><Select options={[{ value: 'before', label: 'Before ($1)' }, { value: 'after', label: 'After (1$)' }]} value={draft.symbolPosition} onChange={(e) => set('symbolPosition', e.target.value as SymbolPosition)} disabled={readOnly} /></Field>
          <Field label="Symbol spacing">
            <div className="flex h-9 items-center"><Toggle checked={draft.symbolSpacing ?? false} onChange={(v) => set('symbolSpacing', v)} disabled={readOnly} label={draft.symbolSpacing ? '$ 1,234' : '$1,234'} /></div>
          </Field>
          <Field label="Decimal separator"><Select options={[{ value: '.', label: '. (dot)' }, { value: ',', label: ', (comma)' }]} value={draft.decimalSeparator} onChange={(e) => set('decimalSeparator', e.target.value as DecimalSeparator)} disabled={readOnly} /></Field>
          <Field label="Thousand separator"><Select options={[{ value: ',', label: ',' }, { value: '.', label: '.' }, { value: ' ', label: 'space' }, { value: '', label: 'none' }]} value={draft.thousandSeparator} onChange={(e) => set('thousandSeparator', e.target.value as ThousandSeparator)} disabled={readOnly} /></Field>
          <Field label="Negative format"><Select options={[{ value: '-1,234.56', label: '-1,234.56' }, { value: '(1,234.56)', label: '(1,234.56)' }, { value: '1,234.56-', label: '1,234.56-' }]} value={draft.negativeFormat} onChange={(e) => set('negativeFormat', e.target.value as NegativeFormat)} disabled={readOnly} /></Field>
          <Field label="Effective from"><Input type="date" value={draft.effectiveFrom ?? ''} onChange={(e) => set('effectiveFrom', e.target.value || undefined)} disabled={readOnly} /></Field>
          <Field label="Effective to"><Input type="date" value={draft.effectiveTo ?? ''} onChange={(e) => set('effectiveTo', e.target.value || undefined)} disabled={readOnly} /></Field>
        </div>

        {/* Formatted / precision / rounding preview */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-800/40">
          <div className="mb-1 text-xs text-slate-500">Preview — entered 1234.5678 at {dp} decimals ({ROUNDING_LABELS[roundingMethodOf(draft)]}):</div>
          <div className="flex flex-wrap items-center gap-3 font-mono">
            <span className="font-semibold">{formatCurrencyAmount('1234.5678', draft, { showCode: true })}</span>
            <span className="text-slate-400">·</span>
            <span>{formatCurrencyAmount('-1234.5678', draft)}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">raw {precisionPreview('1234.5678', draft)}</span>
            {draft.roundingIncrement ? <span className="text-slate-500">(increment {draft.roundingIncrement})</span> : null}
          </div>
        </div>

        {inUse && criticalChange && !readOnly && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">This currency is already used on transactions.</p>
              <p className="mt-1">Changing its code, precision, rounding or type affects only FUTURE documents — historical values are never rewritten or re-rounded. Prefer creating a new currency definition when the precision itself must change.</p>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={confirmedImpact} onChange={(e) => setConfirmedImpact(e.target.checked)} />
                I reviewed the impact and confirm this controlled change.
              </label>
            </div>
          </div>
        )}

        {errors.length > 0 && <ul className="list-disc rounded-lg border border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">{errors.map((e) => <li key={e.rule}>{e.message}</li>)}</ul>}

        {/* Audit history */}
        <details className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
          <summary className="cursor-pointer font-semibold text-slate-500">Audit history ({source.auditTrail.length})</summary>
          <ul className="mt-2 space-y-1">
            {[...source.auditTrail].reverse().map((ev) => (
              <li key={ev.id} className="flex flex-wrap gap-2 text-slate-500">
                <span className="font-mono">{ev.at.slice(0, 19).replace('T', ' ')}</span>
                <span className="font-semibold">{ev.action}</span>
                {ev.by && <span>by {ev.by}</span>}
                {ev.detail && <span className="text-slate-400">— {ev.detail}</span>}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Drawer>
  );
}
