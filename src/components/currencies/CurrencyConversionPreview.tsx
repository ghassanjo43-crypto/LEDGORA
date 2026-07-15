import { useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useCurrencyStore } from '@/store/currencyStore';
import { useExchangeRateStore } from '@/store/exchangeRateStore';
import { convertCurrency } from '@/lib/currencyConversion';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { Card, CardBody } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { CurrencySelector } from './CurrencySelector';

/** Non-posting currency converter (§48). Clearly labelled preview-only. */
export function CurrencyConversionPreview() {
  const currencies = useCurrencyStore((s) => s.currencies);
  const config = useCurrencyStore((s) => s.getConfig());
  const resolve = useExchangeRateStore((s) => s.resolve);
  const curMap = useMemo(() => new Map(currencies.map((c) => [c.code, c])), [currencies]);

  const [from, setFrom] = useState('USD');
  const [to, setTo] = useState(config.baseCurrencyCode);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(1000);

  const res = useMemo(
    () => resolve({ entityId: config.entityId, fromCurrencyCode: from, toCurrencyCode: to, transactionDate: date, baseCurrencyCode: config.baseCurrencyCode }),
    [resolve, config.entityId, config.baseCurrencyCode, from, to, date],
  );
  const toPrecision = curMap.get(to)?.decimalPlaces ?? 2;
  const converted = res.ok && res.rate !== undefined ? convertCurrency(amount, res.rate, { precision: toPrecision }) : undefined;

  return (
    <Card><CardBody>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Currency converter</h3>
        <Badge tone="slate">Preview only — no accounting entry created</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Amount<Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="mt-1 h-9 text-right" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<div className="mt-1"><CurrencySelector value={from} onChange={setFrom} currencies={currencies} includeInactive /></div></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<div className="mt-1"><CurrencySelector value={to} onChange={setTo} currencies={currencies} includeInactive /></div></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Date<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-9" /></label>
        <div className="flex items-end"><ArrowLeftRight className="mb-2 h-4 w-4 text-slate-400" /></div>
      </div>
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-800/40">
        {res.ok && converted !== undefined ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="font-mono text-lg font-bold">{formatCurrencyAmount(converted, curMap.get(to))}</span>
            <span className="text-xs text-slate-500">Rate: 1 {from} = {res.rate} {to} · inverse {res.inverseRate}</span>
            <span className="text-xs text-slate-500">Source: {res.source} · {res.method} · {res.effectiveDate}</span>
          </div>
        ) : (
          <p className="text-xs text-red-600">{res.error ?? 'No rate available for this pair/date.'}</p>
        )}
      </div>
    </CardBody></Card>
  );
}
