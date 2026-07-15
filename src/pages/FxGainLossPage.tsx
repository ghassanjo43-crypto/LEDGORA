import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useCurrencyStore } from '@/store/currencyStore';
import { useExchangeRateStore } from '@/store/exchangeRateStore';
import { buildFxGainLossReport, buildCurrencyExposureReport } from '@/lib/currencyReporting';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';

export function FxGainLossPage() {
  const accounts = useStore((s) => s.accounts);
  const entries = useJournalStore((s) => s.entries);
  const currencies = useCurrencyStore((s) => s.currencies);
  const config = useCurrencyStore((s) => s.getConfig());
  const rates = useExchangeRateStore((s) => s.rates);

  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');

  const curMap = useMemo(() => new Map(currencies.map((c) => [c.code, c])), [currencies]);
  const baseCur = curMap.get(config.baseCurrencyCode);
  const baseMoney = (n: number): string => formatCurrencyAmount(n, baseCur);

  const report = useMemo(() => buildFxGainLossReport({ entries, config, baseCurrency: config.baseCurrencyCode, from, to }), [entries, config, from, to]);
  const exposure = useMemo(() => buildCurrencyExposureReport({ entries, accounts, rates, config, baseCurrency: config.baseCurrencyCode, asOfDate: to }), [entries, accounts, rates, config, to]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9" /></label>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="Realized gain" value={baseMoney(report.realizedGain)} />
        <Metric label="Realized loss" value={baseMoney(report.realizedLoss)} />
        <Metric label="Unrealized gain" value={baseMoney(report.unrealizedGain)} />
        <Metric label="Unrealized loss" value={baseMoney(report.unrealizedLoss)} />
        <Metric label={report.netFx >= 0 ? 'Net FX gain' : 'Net FX loss'} value={baseMoney(Math.abs(report.netFx))} strong />
      </div>

      <Card className="mb-4 overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">FX by currency</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Currency', 'Realized gain', 'Realized loss', 'Unrealized gain', 'Unrealized loss', 'Net'].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Currency' ? 'text-left' : 'text-right')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {report.byCurrency.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No FX gains or losses in this period.</td></tr>
              ) : report.byCurrency.map((c) => (
                <tr key={c.currency}>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{c.currency}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{baseMoney(c.realizedGain)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{baseMoney(c.realizedLoss)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{baseMoney(c.unrealizedGain)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{baseMoney(c.unrealizedLoss)}</td>
                  <td className={cx('px-3 py-2 text-right font-mono font-semibold', c.net > 0 ? 'text-green-600' : c.net < 0 ? 'text-red-600' : '')}>{baseMoney(c.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 dark:border-slate-800">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Currency exposure</span>
          <Badge tone="slate">Analytical — not booked</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Currency', 'Receivables', 'Payables', 'Bank', 'Net foreign', 'Rate', 'Base equiv.', '±1%'].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Currency' ? 'text-left' : 'text-right')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {exposure.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No open foreign-currency positions.</td></tr>
              ) : exposure.map((e) => (
                <tr key={e.currency}>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{e.currency}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatCurrencyAmount(e.receivables, curMap.get(e.currency))}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatCurrencyAmount(e.payables, curMap.get(e.currency))}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatCurrencyAmount(e.bank, curMap.get(e.currency))}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">{formatCurrencyAmount(e.netForeign, curMap.get(e.currency))}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{e.currentRate}</td>
                  <td className="px-3 py-2 text-right font-mono">{baseMoney(e.baseEquivalent)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{baseMoney(e.sensitivity1pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Card><CardBody>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={strong ? 'font-mono text-lg font-bold text-slate-900 dark:text-slate-100' : 'font-mono text-lg text-slate-700 dark:text-slate-200'}>{value}</p>
    </CardBody></Card>
  );
}
