import { useMemo, useState } from 'react';
import { Plus, Ban, Copy, ArrowLeftRight } from 'lucide-react';
import type { ExchangeRate, ExchangeRateType, ExchangeRateSource } from '@/types/exchangeRate';
import { useCurrencyStore } from '@/store/currencyStore';
import { useExchangeRateStore } from '@/store/exchangeRateStore';
import { roundExchangeRate } from '@/lib/currencyConversion';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { CurrencySelector } from '@/components/currencies/CurrencySelector';
import { CurrencyConversionPreview } from '@/components/currencies/CurrencyConversionPreview';

const STATUS_TONE: Record<ExchangeRate['status'], BadgeTone> = { active: 'green', superseded: 'amber', inactive: 'slate' };
const RATE_TYPES: ExchangeRateType[] = ['mid', 'buy', 'sell', 'custom'];
const SOURCES: ExchangeRateSource[] = ['manual', 'bank', 'central-bank', 'market-provider', 'import', 'custom'];

export function ExchangeRatesPage() {
  const currencies = useCurrencyStore((s) => s.currencies);
  const config = useCurrencyStore((s) => s.getConfig());
  const rates = useExchangeRateStore((s) => s.rates);
  const store = useExchangeRateStore();
  const { notify } = useToast();

  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('EUR');
  const [to, setTo] = useState(config.baseCurrencyCode);
  const [rate, setRate] = useState(1.08);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rateType, setRateType] = useState<ExchangeRateType>('mid');
  const [source, setSource] = useState<ExchangeRateSource>('manual');
  const [pairFilter, setPairFilter] = useState('ALL');

  const rows = useMemo(() => {
    return [...rates]
      .filter((r) => (pairFilter === 'ALL' ? true : `${r.fromCurrencyCode}/${r.toCurrencyCode}` === pairFilter))
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || a.fromCurrencyCode.localeCompare(b.fromCurrencyCode));
  }, [rates, pairFilter]);
  const pairs = useMemo(() => [...new Set(rates.map((r) => `${r.fromCurrencyCode}/${r.toCurrencyCode}`))].sort(), [rates]);

  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };
  const save = (): void => {
    const res = store.createRate({ entityId: config.entityId, fromCurrencyCode: from, toCurrencyCode: to, rate: Number(rate), effectiveDate: date, rateType, source });
    if (res.ok) { notify('Exchange rate added.', 'success'); setOpen(false); }
    else notify(res.error ?? 'Could not add the rate.', 'error');
  };

  return (
    <>
      <PageActions><Button onClick={() => setOpen((o) => !o)}><Plus className="h-4 w-4" /> New rate</Button></PageActions>

      <div className="mb-4"><CurrencyConversionPreview /></div>

      {open && (
        <Card className="mb-4"><CardBody>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <Field label="From"><CurrencySelector value={from} onChange={setFrom} currencies={currencies} includeInactive /></Field>
            <Field label="To"><CurrencySelector value={to} onChange={setTo} currencies={currencies} includeInactive /></Field>
            <Field label="Rate" required><Input type="number" step="0.00000001" value={rate} onChange={(e) => setRate(Number(e.target.value))} className="text-right" /></Field>
            <Field label="Effective date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Type"><Select options={RATE_TYPES.map((t) => ({ value: t, label: t }))} value={rateType} onChange={(e) => setRateType(e.target.value as ExchangeRateType)} /></Field>
            <Field label="Source"><Select options={SOURCES.map((s) => ({ value: s, label: s }))} value={source} onChange={(e) => setSource(e.target.value as ExchangeRateSource)} /></Field>
          </div>
          <p className="mt-2 text-xs text-slate-500">1 {from} = {rate} {to} · inverse {rate ? roundExchangeRate(1 / Number(rate)) : 0}</p>
          <div className="mt-3 flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save}>Add rate</Button></div>
        </CardBody></Card>
      )}

      <div className="mb-3 flex items-center gap-2">
        <Select className="h-9 w-auto" options={[{ value: 'ALL', label: 'All pairs' }, ...pairs.map((p) => ({ value: p, label: p }))]} value={pairFilter} onChange={(e) => setPairFilter(e.target.value)} aria-label="Pair" />
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={ArrowLeftRight} title="No exchange rates" description="Add effective-dated rates so foreign documents can resolve a rate. A missing rate blocks posting — it is never silently defaulted to 1.0." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Effective', 'From', 'To', 'Rate', 'Inverse', 'Type', 'Source', 'Status', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Rate', 'Inverse'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs">{r.effectiveDate}</td>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{r.fromCurrencyCode}</td>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{r.toCurrencyCode}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.rate}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{r.inverseRate}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.rateType}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.source}</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button title="Duplicate" onClick={() => act(() => store.duplicateRate(r.id), 'Rate duplicated.')} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><Copy className="h-4 w-4" /></button>
                      {r.status === 'active' && <button title="Deactivate" onClick={() => act(() => store.deactivateRate(r.id), 'Rate deactivated.')} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><Ban className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}
    </>
  );
}
