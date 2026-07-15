import type { TaxBoxTotal, TaxSummaryReport as SummaryData } from '@/types/taxReporting';
import { formatCurrency } from '@/lib/money';
import { Card, CardBody } from '@/components/ui/Card';

interface Props {
  summary: SummaryData;
  boxTotals: TaxBoxTotal[];
  currency: string;
}

/** Presentational tax summary: per-code rows, totals and reporting-box breakdown. */
export function TaxSummaryReport({ summary, boxTotals, currency }: Props) {
  const money = (n: number): string => formatCurrency(n, currency);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Taxable base" value={money(summary.taxableBaseTotal)} />
        <Metric label="Output tax" value={money(summary.outputTaxTotal)} />
        <Metric label="Input tax" value={money(summary.inputTaxTotal)} />
        <Metric label={summary.netPayable >= 0 ? 'Net payable' : 'Net refundable'} value={money(Math.abs(summary.netPayable))} strong />
      </div>

      <Card className="overflow-hidden"><div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
            {['Code', 'Name', 'Category', 'Dir.', 'Rate', 'Taxable base', 'Tax', 'Recoverable', 'Non-recov.', 'Output', 'Input', 'Docs'].map((h) => (
              <th key={h} className={['Taxable base', 'Tax', 'Recoverable', 'Non-recov.', 'Output', 'Input', 'Rate', 'Docs'].includes(h) ? 'px-3 py-2 text-right font-semibold' : 'px-3 py-2 text-left font-semibold'}>{h}</th>
            ))}
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {summary.rows.length === 0 ? (
              <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-400">No tax activity in this period.</td></tr>
            ) : summary.rows.map((r) => (
              <tr key={r.taxCodeId} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                <td className="px-3 py-2 font-mono text-xs font-semibold">{r.taxCode}</td>
                <td className="px-3 py-2 text-xs">{r.taxName}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.category}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.direction}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{r.rate}%</td>
                <td className="px-3 py-2 text-right font-mono">{money(r.taxableBase)}</td>
                <td className="px-3 py-2 text-right font-mono">{money(r.taxAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.recoverableAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.nonRecoverableAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.outputTax)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.inputTax)}</td>
                <td className="px-3 py-2 text-right text-xs text-slate-500">{r.documentCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></Card>

      {boxTotals.some((b) => Math.abs(b.amount) > 0.005) && (
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Reporting boxes</h3>
          <table className="min-w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {boxTotals.filter((b) => Math.abs(b.amount) > 0.005).map((b) => (
                <tr key={b.boxId}>
                  <td className="py-1.5 pr-3 font-mono text-xs font-semibold">{b.boxCode}</td>
                  <td className="py-1.5 pr-3">{b.boxName}</td>
                  <td className="py-1.5 pr-3 text-xs text-slate-500">{b.amountBasis}</td>
                  <td className="py-1.5 text-right font-mono">{money(b.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody></Card>
      )}
    </div>
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
