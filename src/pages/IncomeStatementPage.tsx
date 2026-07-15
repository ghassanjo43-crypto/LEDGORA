import { useEffect, useMemo, useState } from 'react';
import { Download, Printer, RefreshCw, ChevronDown, AlertTriangle } from 'lucide-react';
import type { StatementPeriod } from '@/types/incomeStatement';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useLedgerFocus } from '@/store/ledgerFocusStore';
import { useIncomeStatementPreferences } from '@/store/incomeStatementPreferencesStore';
import { buildIncomeStatement, reconcileIncomeStatement, resolveComparativePeriod } from '@/lib/incomeStatementCalculations';
import { escapeCsv } from '@/lib/csv';
import { downloadFile, cn } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { MetricCards } from '@/components/income-statement/MetricCards';
import { IncomeStatementToolbar } from '@/components/income-statement/IncomeStatementToolbar';
import { IncomeStatementTable } from '@/components/income-statement/IncomeStatementTable';
import { IncomeStatementExceptions } from '@/components/income-statement/IncomeStatementExceptions';
import { isAmount } from '@/components/income-statement/isFormat';

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
function defaultFyToDate(fiscalYearStart: string): StatementPeriod {
  const now = new Date();
  const [mm, dd] = fiscalYearStart.split('-').map(Number);
  let start = new Date(now.getFullYear(), (mm || 1) - 1, dd || 1);
  if (start > now) start = new Date(now.getFullYear() - 1, (mm || 1) - 1, dd || 1);
  return { from: isoDate(start), to: isoDate(now) };
}

export function IncomeStatementPage() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useJournalStore((s) => s.entries);
  const requestLedgerFocus = useLedgerFocus((s) => s.requestLedgerFocus);
  const prefs = useIncomeStatementPreferences();

  const base = settings.baseCurrency;
  const [period, setPeriod] = useState<StatementPeriod>(() => defaultFyToDate(settings.fiscalYearStart));
  const [showExceptions, setShowExceptions] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const result = useMemo(
    () => buildIncomeStatement(accounts, entries, period, base, { presentation: prefs.presentation, detail: prefs.detail, comparison: prefs.comparison, includeZero: prefs.includeZero }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, entries, period, base, prefs.presentation, prefs.detail, prefs.comparison, prefs.includeZero, refreshKey],
  );

  const reconciliation = useMemo(() => reconcileIncomeStatement(accounts, entries, period, base), [accounts, entries, period, base]);
  useEffect(() => {
    if (!reconciliation.ok) console.warn('[IncomeStatement] reconciliation failed:', reconciliation);
  }, [reconciliation]);

  const comparativePeriod = resolveComparativePeriod(period, prefs.comparison);

  const drill = (accountId: string): void => {
    requestLedgerFocus({ accountId, from: period.from, to: period.to });
    setActiveView('general-ledger');
  };

  /* ── Export ── */
  const exportCsv = (): void => {
    const rows: string[][] = [];
    rows.push([settings.companyName]);
    rows.push([`Income Statement — ${prefs.presentation === 'IFRS18' ? 'IFRS 18 ready' : 'IAS 1'} (${prefs.detail})`]);
    rows.push([`For the period from ${longDate(period.from)} to ${longDate(period.to)}`]);
    if (comparativePeriod) rows.push([`Comparative: ${longDate(comparativePeriod.from)} to ${longDate(comparativePeriod.to)}`]);
    rows.push([`Base currency: ${base}`, `Generated: ${isoDate(new Date())}`]);
    rows.push([`Trial Balance P&L reconciled: ${reconciliation.ok ? 'Yes' : 'No'}`, `Mapping exceptions: ${result.exceptions.length}`]);
    rows.push([]);
    rows.push(['Line item', 'Current period', 'Comparative', 'Variance', 'Variance %', '% of revenue']);
    for (const l of result.lines) {
      if (l.lineType === 'spacer') { rows.push([]); continue; }
      rows.push([
        l.label,
        l.lineType === 'section' ? '' : String(l.currentAmount),
        l.comparativeAmount === undefined ? '' : String(l.comparativeAmount),
        l.variance === undefined ? '' : String(l.variance),
        l.variancePercent === undefined || l.variancePercent === null ? '' : `${(l.variancePercent * 100).toFixed(1)}%`,
        l.percentageOfRevenue === undefined || l.percentageOfRevenue === null ? '' : `${(l.percentageOfRevenue * 100).toFixed(1)}%`,
      ]);
    }
    const csv = rows.map((r) => r.map((c) => escapeCsv(c)).join(',')).join('\r\n');
    downloadFile(`income-statement-${isoDate(new Date())}.csv`, csv, 'text/csv');
  };
  const exportJson = (): void => {
    downloadFile(
      `income-statement-${isoDate(new Date())}.json`,
      JSON.stringify(
        {
          company: settings.companyName,
          report: 'Income Statement',
          presentation: prefs.presentation,
          detail: prefs.detail,
          baseCurrency: base,
          period,
          comparativePeriod,
          generatedAt: new Date().toISOString(),
          reconciledToTrialBalance: reconciliation.ok,
          totals: result.totals,
          comparativeTotals: result.hasComparative ? result.comparativeTotals : undefined,
          margins: result.margins,
          lines: result.lines,
          exceptions: result.exceptions,
        },
        null,
        2,
      ),
      'application/json',
    );
  };

  return (
    <>
      <PageActions>
        <div className="flex items-center gap-2 print:hidden">
          <button type="button" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh" className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"><RefreshCw className="h-4 w-4" /></button>
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

      {/* Print-only report header */}
      <div className="mb-4 hidden print:block">
        <p className="text-lg font-bold">{settings.companyName}</p>
        <p className="text-sm">Income Statement — Statement of Profit or Loss</p>
        <p className="text-xs text-slate-500">For the period from {longDate(period.from)} to {longDate(period.to)} · Base currency {base}{comparativePeriod ? ` · Comparative ${longDate(comparativePeriod.from)}–${longDate(comparativePeriod.to)}` : ''}</p>
        <p className="text-[10px] text-slate-400">Unaudited · Generated {longDate(isoDate(new Date()))}</p>
      </div>

      <div className="space-y-4">
        {/* Period caption (screen) */}
        <div className="print:hidden">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Statement of Profit or Loss · <span className="font-medium text-slate-700 dark:text-slate-200">For the period from {longDate(period.from)} to {longDate(period.to)}</span> · {base}
          </p>
        </div>

        <MetricCards totals={result.totals} margins={result.margins} comparativeTotals={result.comparativeTotals} hasComparative={result.hasComparative} base={base} />

        <IncomeStatementToolbar
          presentation={prefs.presentation}
          onPresentation={prefs.setPresentation}
          detail={prefs.detail}
          onDetail={prefs.setDetail}
          comparison={prefs.comparison}
          onComparison={prefs.setComparison}
          period={period}
          onPeriod={setPeriod}
          showPercent={prefs.showPercentOfRevenue}
          onShowPercent={prefs.setShowPercentOfRevenue}
          includeZero={prefs.includeZero}
          onIncludeZero={prefs.setIncludeZero}
          negativeFormat={prefs.negativeFormat}
          onNegativeFormat={prefs.setNegativeFormat}
        />

        {/* Status strip */}
        <div className="flex flex-wrap items-center gap-2 text-xs print:hidden">
          {!reconciliation.ok && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Reconciliation difference {isAmount(reconciliation.difference)}
            </span>
          )}
          {result.exceptions.length > 0 && (
            <button type="button" onClick={() => setShowExceptions(true)} className="focus-ring inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> {result.exceptions.length} mapping exception{result.exceptions.length === 1 ? '' : 's'}
            </button>
          )}
          {reconciliation.ok && result.exceptions.length === 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              Reconciled to Trial Balance
            </span>
          )}
        </div>

        <Card className="overflow-hidden">
          <IncomeStatementTable
            lines={result.lines}
            hasComparative={result.hasComparative}
            showPercent={prefs.showPercentOfRevenue}
            negativeFormat={prefs.negativeFormat}
            onDrill={drill}
          />
        </Card>
      </div>

      {showExceptions && (
        <IncomeStatementExceptions
          exceptions={result.exceptions}
          onClose={() => setShowExceptions(false)}
          onReviewAccount={() => { setShowExceptions(false); setActiveView('tree'); }}
        />
      )}
    </>
  );
}
