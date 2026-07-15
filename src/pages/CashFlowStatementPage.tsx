import { useMemo, useState } from 'react';
import { Download, Printer, RefreshCw, ChevronDown, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useLedgerFocus } from '@/store/ledgerFocusStore';
import { useCashFlowPreferences } from '@/store/cashFlowPreferencesStore';
import { buildCashFlowStatement } from '@/lib/cashFlowCalculations';
import { fiscalYearStartDate } from '@/lib/balanceSheetCalculations';
import { escapeCsv } from '@/lib/csv';
import { downloadFile, cn } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { CashFlowToolbar } from '@/components/cash-flow/CashFlowToolbar';
import { CashFlowTable } from '@/components/cash-flow/CashFlowTable';
import { CashReconciliationPanel } from '@/components/cash-flow/CashReconciliationPanel';

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export function CashFlowStatementPage() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useJournalStore((s) => s.entries);
  const entities = useEntityStore((s) => s.entities);
  const requestLedgerFocus = useLedgerFocus((s) => s.requestLedgerFocus);
  const prefs = useCashFlowPreferences();

  const base = settings.baseCurrency;

  const latestPosted = useMemo(() => {
    const dates = entries.filter((e) => e.status === 'posted').map((e) => e.entryDate).sort();
    return dates[dates.length - 1] ?? isoDate(new Date());
  }, [entries]);

  const [periodStart, setPeriodStart] = useState<string>(() => fiscalYearStartDate(latestPosted, settings.fiscalYearStart));
  const [periodEnd, setPeriodEnd] = useState<string>(latestPosted);
  const [comparativeStart, setComparativeStart] = useState('');
  const [comparativeEnd, setComparativeEnd] = useState('');
  const [entityId, setEntityId] = useState('');
  const [generatedAt, setGeneratedAt] = useState<Date>(() => new Date());

  const comparativePeriod = comparativeStart && comparativeEnd ? { start: comparativeStart, end: comparativeEnd } : undefined;

  const statement = useMemo(
    () => buildCashFlowStatement(accounts, entries, { periodStart, periodEnd, comparativePeriod, entityId, base, policy: prefs.policy }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, entries, periodStart, periodEnd, comparativeStart, comparativeEnd, entityId, base, prefs.policy, generatedAt],
  );

  const entityName = entityId ? entities.find((e) => e.id === entityId)?.legalName ?? settings.companyName : settings.companyName;
  const entityOptions = useMemo(
    () => [{ value: '', label: 'All entities (company)' }, ...entities.slice().sort((a, b) => a.legalName.localeCompare(b.legalName)).map((e) => ({ value: e.id, label: e.legalName }))],
    [entities],
  );

  const drill = (accountId: string): void => {
    requestLedgerFocus({ accountId, from: periodStart, to: periodEnd });
    setActiveView('general-ledger');
  };
  const refresh = (): void => setGeneratedAt(new Date());

  const exportCsv = (): void => {
    const s = statement;
    const rows: string[][] = [];
    rows.push([entityName]);
    rows.push(['Statement of Cash Flows (Indirect Method)']);
    rows.push([`Period: ${longDate(periodStart)} to ${longDate(periodEnd)}`, comparativePeriod ? `Comparative: ${longDate(comparativePeriod.start)} to ${longDate(comparativePeriod.end)}` : '', `Currency: ${base}`]);
    rows.push([`Policy — interest paid: ${prefs.policy.interestPaid}; interest received: ${prefs.policy.interestReceived}; dividends paid: ${prefs.policy.dividendsPaid}`]);
    rows.push([`Reconciliation: ${s.isReconciled ? 'Reconciled' : 'Difference'} ${s.reconciliationDifference.toFixed(2)}`, `Generated: ${generatedAt.toISOString()}`]);
    rows.push([]);
    const line = (label: string, amount: number) => rows.push([label, amount.toFixed(2)]);
    rows.push(['CASH FLOWS FROM OPERATING ACTIVITIES']);
    line(s.profitForPeriod < 0 ? 'Net loss for the period' : 'Net profit for the period', s.profitForPeriod);
    s.nonCashAdjustments.forEach((l) => line(`  ${l.label}`, l.amount));
    s.workingCapitalChanges.forEach((l) => line(`  ${l.label}`, l.amount));
    line('Net cash from operating activities', s.netOperatingCashFlow);
    rows.push(['CASH FLOWS FROM INVESTING ACTIVITIES']);
    s.investingActivities.forEach((l) => line(`  ${l.label}`, l.amount));
    line('Net cash from investing activities', s.netInvestingCashFlow);
    rows.push(['CASH FLOWS FROM FINANCING ACTIVITIES']);
    s.financingActivities.forEach((l) => line(`  ${l.label}`, l.amount));
    line('Net cash from financing activities', s.netFinancingCashFlow);
    rows.push([]);
    line('Net change in cash and cash equivalents', s.netChangeInCash);
    line('Cash at beginning of period', s.openingCash);
    line('Cash at end of period (calculated)', s.calculatedClosingCash);
    line('Cash at end of period (Balance Sheet)', s.balanceSheetClosingCash);
    line('Reconciliation difference', s.reconciliationDifference);
    if (s.unclassifiedItems.length) { rows.push([]); rows.push(['Unclassified items']); s.unclassifiedItems.forEach((u) => rows.push([u.message])); }
    downloadFile(`cash-flow-${periodEnd}.csv`, rows.map((r) => r.map((c) => escapeCsv(c)).join(',')).join('\r\n'), 'text/csv');
  };
  const exportJson = (): void => {
    downloadFile(`cash-flow-${periodEnd}.json`, JSON.stringify({ ...statement, entityName, policy: prefs.policy, generatedAt: generatedAt.toISOString() }, null, 2), 'application/json');
  };

  return (
    <>
      <PageActions>
        <div className="flex items-center gap-2 print:hidden">
          <button type="button" onClick={refresh} title="Refresh" className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"><RefreshCw className="h-4 w-4" /></button>
          <button type="button" onClick={() => window.print()} title="Print" className="focus-ring flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><Printer className="h-4 w-4" /> Print</button>
          <Dropdown label="Export" trigger={(o) => (
            <span className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white shadow-sm hover:bg-brand-700', o && 'bg-brand-700')}>
              <Download className="h-4 w-4" /> Export <ChevronDown className="h-3.5 w-3.5" />
            </span>
          )}>
            <MenuItem onClick={exportCsv}>Export CSV</MenuItem>
            <MenuItem onClick={exportJson}>Export JSON</MenuItem>
          </Dropdown>
        </div>
      </PageActions>

      <div className="mb-4">
        <div className="hidden print:block"><p className="text-lg font-bold">{entityName}</p></div>
        <h2 className="text-base font-bold text-slate-900 dark:text-white">Statement of Cash Flows</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">Indirect Method · <span className="font-medium text-slate-700 dark:text-slate-200">{longDate(periodStart)} to {longDate(periodEnd)}</span>{comparativePeriod ? ` (vs ${longDate(comparativePeriod.start)}–${longDate(comparativePeriod.end)})` : ''} · {base}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800"><ShieldCheck className="h-3 w-3" /> Posted entries only</span>
          <span>Generated {generatedAt.toLocaleString()}</span>
        </div>
      </div>

      <div className="space-y-4">
        <CashReconciliationPanel
          netChangeInCash={statement.netChangeInCash}
          openingCash={statement.openingCash}
          calculatedClosingCash={statement.calculatedClosingCash}
          balanceSheetClosingCash={statement.balanceSheetClosingCash}
          reconciliationDifference={statement.reconciliationDifference}
          isReconciled={statement.isReconciled}
          base={base}
          negativeFormat={prefs.negativeFormat}
        />

        <CashFlowToolbar
          entityOptions={entityOptions}
          entityId={entityId}
          onEntityId={setEntityId}
          periodStart={periodStart}
          onPeriodStart={setPeriodStart}
          periodEnd={periodEnd}
          onPeriodEnd={setPeriodEnd}
          comparativeStart={comparativeStart}
          comparativeEnd={comparativeEnd}
          onComparative={(s, e) => { setComparativeStart(s); setComparativeEnd(e); }}
          detail={prefs.detail}
          onDetail={prefs.setDetail}
          negativeFormat={prefs.negativeFormat}
          onNegativeFormat={prefs.setNegativeFormat}
          policy={prefs.policy}
          onPolicy={prefs.setPolicy}
        />

        {prefs.showUnclassified && statement.unclassifiedItems.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs dark:border-amber-500/30 dark:bg-amber-500/10 print:hidden">
            <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200"><AlertTriangle className="h-3.5 w-3.5" /> {statement.unclassifiedItems.length} unclassified cash item{statement.unclassifiedItems.length === 1 ? '' : 's'}</p>
            <ul className="mt-1 space-y-0.5 text-amber-700 dark:text-amber-300">
              {statement.unclassifiedItems.slice(0, 6).map((u) => <li key={u.id}>• {u.message}</li>)}
            </ul>
          </div>
        )}

        <Card className="overflow-hidden">
          <CashFlowTable statement={statement} detail={prefs.detail} negativeFormat={prefs.negativeFormat} onDrill={drill} />
        </Card>
      </div>
    </>
  );
}
