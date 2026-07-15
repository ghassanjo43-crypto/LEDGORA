import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { buildCostCenterIncomeStatement, buildCostCenterTrialBalance, buildCostCenterLedger } from '@/lib/costCenterReporting';
import { flattenCostCenterTree, buildCostCenterTree } from '@/lib/costCenterHierarchy';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

type ReportType = 'income-statement' | 'trial-balance' | 'ledger';

export function CostCenterReportsPage() {
  const accounts = useStore((s) => s.accounts);
  const base = useStore((s) => s.settings.baseCurrency);
  const entries = useJournalStore((s) => s.entries);
  const centers = useCostCenterStore((s) => s.costCenters);

  const ordered = useMemo(() => flattenCostCenterTree(buildCostCenterTree(centers)), [centers]);
  const [ccId, setCcId] = useState(ordered[0]?.id ?? '');
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');
  const [report, setReport] = useState<ReportType>('income-statement');
  const [includeDesc, setIncludeDesc] = useState(true);
  const [basis, setBasis] = useState<'current' | 'historical'>('current');

  const money = (n: number): string => formatCurrency(n, base);
  const opts = { from, to, base, includeDescendants: includeDesc, basis };

  const is = useMemo(() => (report === 'income-statement' && ccId ? buildCostCenterIncomeStatement(entries, accounts, centers, ccId, opts) : null), [report, ccId, entries, accounts, centers, from, to, includeDesc, base, basis]);
  const tb = useMemo(() => (report === 'trial-balance' && ccId ? buildCostCenterTrialBalance(entries, accounts, centers, ccId, opts) : null), [report, ccId, entries, accounts, centers, from, to, includeDesc, base, basis]);
  const ledger = useMemo(() => (report === 'ledger' && ccId ? buildCostCenterLedger(entries, accounts, centers, ccId, { from, to, base, includeDescendants: includeDesc, basis }) : null), [report, ccId, entries, accounts, centers, from, to, includeDesc, base, basis]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Cost center<Select className="mt-1 h-9 w-auto" options={ordered.map((c) => ({ value: c.id, label: `${'· '.repeat(c.level)}${c.code} · ${c.name}` }))} value={ccId} onChange={(e) => setCcId(e.target.value)} /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Report<Select className="mt-1 h-9 w-auto" options={[{ value: 'income-statement', label: 'Income Statement' }, { value: 'trial-balance', label: 'Trial Balance' }, { value: 'ledger', label: 'General Ledger' }]} value={report} onChange={(e) => setReport(e.target.value as ReportType)} /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400" title="Current uses today's tree; Historical uses each posted line's frozen hierarchy">Hierarchy<Select className="mt-1 h-9 w-auto" options={[{ value: 'current', label: 'Current' }, { value: 'historical', label: 'Historical (as posted)' }]} value={basis} onChange={(e) => setBasis(e.target.value as 'current' | 'historical')} /></label>
        <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"><input type="checkbox" checked={includeDesc} onChange={(e) => setIncludeDesc(e.target.checked)} /> Include descendants</label>
      </div>

      {is && (
        <Card><CardBody>
          <table className="min-w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Revenue" value={money(is.revenue)} />
              <Row label="Cost of sales" value={money(is.costOfSales)} />
              <Row label="Gross profit" value={money(is.grossProfit)} strong />
              <Row label="Operating expenses" value={money(is.operatingExpenses)} />
              <Row label="Operating profit" value={money(is.operatingProfit)} strong />
              <Row label="Other / finance / tax (net)" value={money(is.otherNet)} />
              <Row label="Net result" value={money(is.netResult)} strong />
            </tbody>
          </table>
        </CardBody></Card>
      )}

      {tb && (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Account', 'Opening Dr', 'Opening Cr', 'Period Dr', 'Period Cr', 'Closing Dr', 'Closing Cr'].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Account' ? 'text-left' : 'text-right')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {tb.rows.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No activity for this cost center in the period.</td></tr> : tb.rows.map((r) => (
                <tr key={r.accountId}>
                  <td className="px-3 py-2"><span className="font-mono text-xs font-semibold">{r.accountCode}</span> {r.accountName}</td>
                  {[r.openingDebit, r.openingCredit, r.periodDebit, r.periodCredit, r.closingDebit, r.closingCredit].map((v, i) => <td key={i} className="px-3 py-2 text-right font-mono text-slate-600">{v ? money(v) : '—'}</td>)}
                </tr>
              ))}
            </tbody>
            {tb.rows.length > 0 && <tfoot><tr className="border-t-2 border-slate-200 font-semibold dark:border-slate-700"><td className="px-3 py-2">Period totals {tb.balanced ? '✓' : '✗'}</td><td colSpan={2} /><td className="px-3 py-2 text-right font-mono">{money(tb.totalPeriodDebit)}</td><td className="px-3 py-2 text-right font-mono">{money(tb.totalPeriodCredit)}</td><td colSpan={2} /></tr></tfoot>}
          </table>
        </div></Card>
      )}

      {ledger && (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Date', 'Journal', 'Account', 'Description', 'Debit', 'Credit'].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Debit', 'Credit'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {ledger.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No ledger lines tagged to this cost center.</td></tr> : ledger.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 text-xs text-slate-500">{l.date}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.journalNumber}</td>
                  <td className="px-3 py-2"><span className="font-mono text-xs font-semibold">{l.accountCode}</span> {l.accountName}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{l.description}</td>
                  <td className="px-3 py-2 text-right font-mono">{l.debit ? money(l.debit) : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{l.credit ? money(l.credit) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <tr className={strong ? 'font-semibold' : ''}><td className="px-3 py-2">{label}</td><td className="px-3 py-2 text-right font-mono">{value}</td></tr>;
}
