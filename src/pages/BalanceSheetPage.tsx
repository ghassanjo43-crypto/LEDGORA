import { useMemo, useState } from 'react';
import { Download, Printer, RefreshCw, ChevronDown, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useLedgerFocus } from '@/store/ledgerFocusStore';
import { useBalanceSheetPreferences } from '@/store/balanceSheetPreferencesStore';
import { buildBalanceSheet } from '@/lib/balanceSheetCalculations';
import { escapeCsv } from '@/lib/csv';
import { downloadFile, cn } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { BalanceSheetToolbar } from '@/components/balance-sheet/BalanceSheetToolbar';
import { BalanceSheetTable } from '@/components/balance-sheet/BalanceSheetTable';
import { BalanceCheckPanel } from '@/components/balance-sheet/BalanceCheckPanel';

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export function BalanceSheetPage() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useJournalStore((s) => s.entries);
  const entities = useEntityStore((s) => s.entities);
  const requestLedgerFocus = useLedgerFocus((s) => s.requestLedgerFocus);
  const prefs = useBalanceSheetPreferences();

  const base = settings.baseCurrency;

  // Default "as at" = latest posted activity (so the demo shows a complete sheet), else today.
  const latestPosted = useMemo(() => {
    const dates = entries.filter((e) => e.status === 'posted').map((e) => e.entryDate).sort();
    return dates[dates.length - 1] ?? isoDate(new Date());
  }, [entries]);

  const [asOfDate, setAsOfDate] = useState<string>(latestPosted);
  const [comparativeDate, setComparativeDate] = useState<string>('');
  const [entityId, setEntityId] = useState<string>('');
  const [generatedAt, setGeneratedAt] = useState<Date>(() => new Date());

  const report = useMemo(
    () => buildBalanceSheet(accounts, entries, {
      asOfDate,
      comparativeDate: comparativeDate || undefined,
      entityId,
      base,
      fiscalYearStart: settings.fiscalYearStart,
      detail: prefs.detail,
      includeZero: prefs.includeZero,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, entries, asOfDate, comparativeDate, entityId, base, settings.fiscalYearStart, prefs.detail, prefs.includeZero, generatedAt],
  );

  const entityName = entityId ? entities.find((e) => e.id === entityId)?.legalName ?? settings.companyName : settings.companyName;
  const entityOptions = useMemo(
    () => [{ value: '', label: 'All entities (company)' }, ...entities.slice().sort((a, b) => a.legalName.localeCompare(b.legalName)).map((e) => ({ value: e.id, label: e.legalName }))],
    [entities],
  );

  const drill = (accountId: string): void => {
    requestLedgerFocus({ accountId, from: settings.booksStartDate || '2000-01-01', to: asOfDate });
    setActiveView('general-ledger');
  };

  /* ── Export ── */
  const exportCsv = (): void => {
    const rows: string[][] = [];
    rows.push([entityName]);
    rows.push(['Statement of Financial Position (Balance Sheet)']);
    rows.push([`As at: ${longDate(asOfDate)}`, comparativeDate ? `Comparative: ${longDate(comparativeDate)}` : '', `Currency: ${base}`, `Generated: ${generatedAt.toISOString()}`]);
    rows.push([`Balance check: ${report.isBalanced ? 'Balanced' : 'Out of balance'}`, `Difference: ${report.difference.toFixed(2)}`, 'Posted entries only']);
    rows.push([]);
    rows.push(report.hasComparative ? ['Account / description', 'Current', 'Comparative', 'Variance'] : ['Account / description', 'Current']);
    for (const l of report.lines) {
      if (l.lineType === 'spacer') { rows.push([]); continue; }
      const amount = (l.lineType === 'section' || (l.lineType === 'total' && l.currentAmount === 0)) ? '' : String(l.currentAmount);
      const indent = '  '.repeat(l.level);
      rows.push(report.hasComparative
        ? [`${indent}${l.label}`, amount, l.comparativeAmount === undefined ? '' : String(l.comparativeAmount), l.variance === undefined ? '' : String(l.variance)]
        : [`${indent}${l.label}`, amount]);
    }
    rows.push([]);
    rows.push(['TOTAL ASSETS', String(report.totalAssets)]);
    rows.push(['TOTAL EQUITY AND LIABILITIES', String(report.totalEquityAndLiabilities)]);
    rows.push(['DIFFERENCE', String(report.difference)]);
    const csv = rows.map((r) => r.map((c) => escapeCsv(c)).join(',')).join('\r\n');
    downloadFile(`balance-sheet-${asOfDate}.csv`, csv, 'text/csv');
  };
  const exportJson = (): void => {
    downloadFile(`balance-sheet-${asOfDate}.json`, JSON.stringify({ ...report, entityName, generatedAt: generatedAt.toISOString() }, null, 2), 'application/json');
  };

  const refresh = (): void => setGeneratedAt(new Date());

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

      {/* Report header (screen + print) */}
      <div className="mb-4">
        <div className="hidden print:block">
          <p className="text-lg font-bold">{entityName}</p>
        </div>
        <h2 className="text-base font-bold text-slate-900 dark:text-white">Statement of Financial Position</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">Balance Sheet · <span className="font-medium text-slate-700 dark:text-slate-200">As at {longDate(asOfDate)}</span>{comparativeDate ? ` (compared with ${longDate(comparativeDate)})` : ''} · {base}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800"><ShieldCheck className="h-3 w-3" /> Posted entries only</span>
          <span>Generated {generatedAt.toLocaleString()}</span>
        </div>
      </div>

      <div className="space-y-4">
        <BalanceCheckPanel
          totalAssets={report.totalAssets}
          totalEquityAndLiabilities={report.totalEquityAndLiabilities}
          difference={report.difference}
          isBalanced={report.isBalanced}
          base={base}
          negativeFormat={prefs.negativeFormat}
        />

        <BalanceSheetToolbar
          entityOptions={entityOptions}
          entityId={entityId}
          onEntityId={setEntityId}
          asOfDate={asOfDate}
          onAsOfDate={setAsOfDate}
          comparativeDate={comparativeDate}
          onComparativeDate={setComparativeDate}
          detail={prefs.detail}
          onDetail={prefs.setDetail}
          includeZero={prefs.includeZero}
          onIncludeZero={prefs.setIncludeZero}
          negativeFormat={prefs.negativeFormat}
          onNegativeFormat={prefs.setNegativeFormat}
        />

        {report.warnings.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs dark:border-amber-500/30 dark:bg-amber-500/10 print:hidden">
            <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200"><AlertTriangle className="h-3.5 w-3.5" /> {report.warnings.length} item{report.warnings.length === 1 ? '' : 's'} to review</p>
            <ul className="mt-1 space-y-0.5 text-amber-700 dark:text-amber-300">
              {report.warnings.slice(0, 6).map((w) => <li key={w.id}>• {w.message}</li>)}
              {report.warnings.length > 6 && <li>… and {report.warnings.length - 6} more.</li>}
            </ul>
          </div>
        )}

        <Card className="overflow-hidden">
          <BalanceSheetTable lines={report.lines} hasComparative={report.hasComparative} negativeFormat={prefs.negativeFormat} onDrill={drill} />
        </Card>
      </div>
    </>
  );
}
