import type { TaxLineRecord } from '@/types/taxReporting';
import { formatCurrency } from '@/lib/money';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

interface Props {
  records: TaxLineRecord[];
  currency: string;
  onDrillDown?: (record: TaxLineRecord) => void;
}

/** Transaction-level tax detail; each row can drill down to the source journal. */
export function TaxDetailReport({ records, currency, onDrillDown }: Props) {
  const money = (n: number): string => formatCurrency(n, currency);
  if (records.length === 0) {
    return <Card><div className="px-4 py-10 text-center text-sm text-slate-400">No tax transactions in this period.</div></Card>;
  }
  return (
    <Card className="overflow-hidden"><div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
          {['Date', 'Type', 'Document', 'Party', 'Code', 'Taxable', 'Tax', 'Gross', 'Cur.', 'Rate', 'Base tax', 'Journal'].map((h) => (
            <th key={h} className={['Taxable', 'Tax', 'Gross', 'Base tax', 'Rate'].includes(h) ? 'px-3 py-2 text-right font-semibold' : 'px-3 py-2 text-left font-semibold'}>{h}</th>
          ))}
        </tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {records.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/20" onClick={() => onDrillDown?.(r)}>
              <td className="px-3 py-2 text-xs text-slate-500">{r.date}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{r.documentType}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.documentNumber ?? '—'}</td>
              <td className="px-3 py-2 text-xs">{r.partyName ?? '—'}</td>
              <td className="px-3 py-2"><Badge tone="blue">{r.taxCode}</Badge></td>
              <td className="px-3 py-2 text-right font-mono">{money(r.taxableAmount)}</td>
              <td className="px-3 py-2 text-right font-mono">{money(r.taxAmount)}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.grossAmount)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{r.currency}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{r.rate}%</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.baseTaxAmount)}</td>
              <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.journalEntryId ? r.documentNumber : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div></Card>
  );
}
