import type { TaxReconciliationResult } from '@/types/taxReporting';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

interface Props {
  result: TaxReconciliationResult;
  currency: string;
}

/** Report totals vs GL tax control-account balances, plus unmapped items (§25). */
export function TaxReconciliationView({ result, currency }: Props) {
  const money = (n: number): string => formatCurrency(n, currency);
  return (
    <div className="space-y-4">
      <Card><CardBody className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{result.isReconciled ? 'Tax report reconciles to the General Ledger' : 'Reconciliation differences found'}</p>
          <p className="text-xs text-slate-500">Compares tax report totals against the tax control-account balances. No balancing entries are created automatically.</p>
        </div>
        <Badge tone={result.isReconciled ? 'green' : 'red'}>{result.isReconciled ? 'Reconciled' : 'Review'}</Badge>
      </CardBody></Card>

      <Card className="overflow-hidden"><div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
            <th className="px-3 py-2 text-left font-semibold">Measure</th>
            <th className="px-3 py-2 text-right font-semibold">Report total</th>
            <th className="px-3 py-2 text-right font-semibold">GL balance</th>
            <th className="px-3 py-2 text-right font-semibold">Difference</th>
            <th className="px-3 py-2 text-left font-semibold">Status</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {result.lines.map((l) => (
              <tr key={l.key}>
                <td className="px-3 py-2">{l.label}</td>
                <td className="px-3 py-2 text-right font-mono">{money(l.reportTotal)}</td>
                <td className="px-3 py-2 text-right font-mono">{money(l.glBalance)}</td>
                <td className={cx('px-3 py-2 text-right font-mono', Math.abs(l.difference) > 0.01 ? 'font-semibold text-red-600' : 'text-slate-500')}>{money(l.difference)}</td>
                <td className="px-3 py-2"><Badge tone={l.reconciled ? 'green' : 'red'}>{l.reconciled ? 'OK' : 'Diff'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></Card>

      {result.unmappedTaxJournalLines.length > 0 && (
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-600">Tax-account journal lines without tax metadata</h3>
          <table className="min-w-full text-xs">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {result.unmappedTaxJournalLines.map((u, i) => (
                <tr key={`${u.journalEntryId}-${i}`}>
                  <td className="py-1.5 pr-3 font-mono">{u.entryNumber}</td>
                  <td className="py-1.5 pr-3 text-slate-500">{u.date}</td>
                  <td className="py-1.5 pr-3 font-mono">{u.accountCode}</td>
                  <td className="py-1.5 text-right font-mono">{money(u.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody></Card>
      )}

      {result.unmappedTaxRecords.length > 0 && (
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-600">Tax records with an unmapped tax code</h3>
          <ul className="list-disc pl-5 text-xs text-slate-500">
            {result.unmappedTaxRecords.map((u) => <li key={u.id}>{u.documentNumber ?? u.id} — {u.taxCode}</li>)}
          </ul>
        </CardBody></Card>
      )}
    </div>
  );
}
