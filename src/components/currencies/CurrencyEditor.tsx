import { useState } from 'react';
import { Save } from 'lucide-react';
import type { Currency, NegativeFormat, SymbolPosition, ThousandSeparator, DecimalSeparator } from '@/types/currency';
import { useCurrencyStore } from '@/store/currencyStore';
import { validateCurrency } from '@/lib/currencyValidation';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

export function CurrencyEditor({ currencyId, onClose }: { currencyId: string; onClose: () => void }) {
  const currencies = useCurrencyStore((s) => s.currencies);
  const source = currencies.find((c) => c.id === currencyId);
  const updateCurrency = useCurrencyStore((s) => s.updateCurrency);
  const { notify } = useToast();

  const [draft, setDraft] = useState<Currency | undefined>(source);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (source && source.id !== loadedId) { setLoadedId(source.id); setDraft(source); }
  if (!draft || !source) return null;

  const readOnly = source.status === 'archived';
  const set = <K extends keyof Currency>(k: K, v: Currency[K]): void => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const issues = validateCurrency(draft, currencies);
  const errors = issues.filter((i) => i.severity === 'error');

  const onSave = (): void => {
    if (errors.length) { notify(errors[0]!.message, 'error'); return; }
    const res = updateCurrency(currencyId, draft);
    if (res.ok) { notify('Currency saved.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not save.', 'error');
  };

  return (
    <Drawer open onClose={onClose} widthClassName="max-w-2xl" title={`Currency ${draft.code || '(new)'}`} description={readOnly ? 'archived — read only' : 'Configure ISO code, symbol, precision and formatting'}
      footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={onClose}>Close</Button>{!readOnly && <Button onClick={onSave}><Save className="h-4 w-4" /> Save</Button>}</div>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="ISO code" required><Input value={draft.code} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={3} disabled={readOnly} /></Field>
          <Field label="Name" required className="sm:col-span-2"><Input value={draft.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} /></Field>
          <Field label="Symbol" required><Input value={draft.symbol} onChange={(e) => set('symbol', e.target.value)} disabled={readOnly} /></Field>
          <Field label="Decimal places" required><Input type="number" min={0} max={6} value={draft.decimalPlaces} onChange={(e) => set('decimalPlaces', Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
          <Field label="Rounding increment"><Input type="number" step="0.001" value={draft.roundingIncrement ?? ''} onChange={(e) => set('roundingIncrement', e.target.value ? Number(e.target.value) : undefined)} disabled={readOnly} className="text-right" /></Field>
          <Field label="Symbol position"><Select options={[{ value: 'before', label: 'Before ($1)' }, { value: 'after', label: 'After (1$)' }]} value={draft.symbolPosition} onChange={(e) => set('symbolPosition', e.target.value as SymbolPosition)} disabled={readOnly} /></Field>
          <Field label="Decimal separator"><Select options={[{ value: '.', label: '. (dot)' }, { value: ',', label: ', (comma)' }]} value={draft.decimalSeparator} onChange={(e) => set('decimalSeparator', e.target.value as DecimalSeparator)} disabled={readOnly} /></Field>
          <Field label="Thousand separator"><Select options={[{ value: ',', label: ',' }, { value: '.', label: '.' }, { value: ' ', label: 'space' }, { value: '', label: 'none' }]} value={draft.thousandSeparator} onChange={(e) => set('thousandSeparator', e.target.value as ThousandSeparator)} disabled={readOnly} /></Field>
          <Field label="Negative format"><Select options={[{ value: '-1,234.56', label: '-1,234.56' }, { value: '(1,234.56)', label: '(1,234.56)' }]} value={draft.negativeFormat} onChange={(e) => set('negativeFormat', e.target.value as NegativeFormat)} disabled={readOnly} /></Field>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-800/40">
          <span className="text-xs text-slate-500">Preview: </span>
          <span className="font-mono font-semibold">{formatCurrencyAmount(1234567.891, draft)}</span>
          <span className="mx-2 text-slate-300">·</span>
          <span className="font-mono">{formatCurrencyAmount(-1234.5, draft)}</span>
        </div>
        {errors.length > 0 && <ul className="list-disc rounded-lg border border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">{errors.map((e) => <li key={e.rule}>{e.message}</li>)}</ul>}
      </div>
    </Drawer>
  );
}
