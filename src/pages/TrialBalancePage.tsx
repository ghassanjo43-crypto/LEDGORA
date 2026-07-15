import { useMemo, useState } from 'react';
import { Download, Printer, RefreshCw, ChevronDown, Scale } from 'lucide-react';
import type { TrialBalanceException, TrialBalanceFilters, TrialBalancePeriod, TrialBalanceRow } from '@/types/trialBalance';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useLedgerFocus } from '@/store/ledgerFocusStore';
import { useTrialBalancePreferences } from '@/store/trialBalancePreferencesStore';
import {
  buildTrialBalanceRows,
  filterTrialBalanceRows,
  groupTrialBalanceRows,
  calculateTrialBalanceTotals,
  trialBalanceReconciliation,
  buildTrialBalanceExceptions,
} from '@/lib/trialBalanceCalculations';
import { paginate } from '@/lib/journalWorkspace';
import { escapeCsv } from '@/lib/csv';
import { downloadFile, cn } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { JournalPagination } from '@/components/journal/JournalPagination';
import { TrialBalanceToolbar } from '@/components/trial-balance/TrialBalanceToolbar';
import { TrialBalanceTable, type TrialBalanceSection } from '@/components/trial-balance/TrialBalanceTable';
import { ReconciliationBanner } from '@/components/trial-balance/ReconciliationBanner';
import { ExceptionPanel } from '@/components/trial-balance/ExceptionPanel';
import { tbAmountAlways } from '@/components/trial-balance/tbFormat';
import type { ViewKey } from '@/types';

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function defaultFyToDate(fiscalYearStart: string): TrialBalancePeriod {
  const now = new Date();
  const [mm, dd] = fiscalYearStart.split('-').map(Number);
  let start = new Date(now.getFullYear(), (mm || 1) - 1, dd || 1);
  if (start > now) start = new Date(now.getFullYear() - 1, (mm || 1) - 1, dd || 1);
  return { from: isoDate(start), to: isoDate(now) };
}

export function TrialBalancePage() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useJournalStore((s) => s.entries);
  const requestLedgerFocus = useLedgerFocus((s) => s.requestLedgerFocus);

  const prefs = useTrialBalancePreferences();
  const base = settings.baseCurrency;

  const [period, setPeriod] = useState<TrialBalancePeriod>(() => defaultFyToDate(settings.fiscalYearStart));
  const [search, setSearch] = useState('');
  const [type, setType] = useState<TrialBalanceFilters['type']>('ALL');
  const [page, setPage] = useState(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showExceptions, setShowExceptions] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const filters: TrialBalanceFilters = { search, type, includeZero: prefs.includeZero, active: prefs.active };

  // Full trial balance (all posting accounts) — the source for reconciliation.
  const allRows = useMemo(
    () => buildTrialBalanceRows(accounts, entries, period, base),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, entries, period, base, refreshKey],
  );
  const reconciliation = useMemo(() => trialBalanceReconciliation(allRows), [allRows]);
  const exceptions = useMemo(() => buildTrialBalanceExceptions(allRows, entries, accounts, base), [allRows, entries, accounts, base]);

  // Rows actually shown (after filters) + their visible totals. Depend on the
  // primitive filter fields so the memo actually caches between renders.
  const displayRows = useMemo(
    () => filterTrialBalanceRows(allRows, { search, type, includeZero: prefs.includeZero, active: prefs.active }),
    [allRows, search, type, prefs.includeZero, prefs.active],
  );
  const displayTotals = useMemo(() => calculateTrialBalanceTotals(displayRows), [displayRows]);

  const groups = useMemo(() => (prefs.grouped ? groupTrialBalanceRows(displayRows) : []), [prefs.grouped, displayRows]);
  const paged = useMemo(() => paginate(displayRows, page, prefs.rowsPerPage), [displayRows, page, prefs.rowsPerPage]);

  const sections: TrialBalanceSection[] = prefs.grouped
    ? groups.map((g) => ({ id: g.id, label: g.label, rows: g.rows, subtotals: g.subtotals }))
    : [{ id: 'flat', rows: paged.items }];

  const drill = (row: TrialBalanceRow): void => {
    requestLedgerFocus({ accountId: row.accountId, from: period.from, to: period.to });
    setActiveView('general-ledger');
  };

  const onException = (ex: TrialBalanceException): void => {
    setShowExceptions(false);
    const target: Record<NonNullable<TrialBalanceException['action']>, ViewKey> = {
      journal: 'journal', 'general-ledger': 'general-ledger', tree: 'tree', mapping: 'mapping',
    };
    if (ex.action) setActiveView(target[ex.action]);
  };

  const resetFilters = (): void => {
    setSearch('');
    setType('ALL');
    prefs.setIncludeZero(false);
    prefs.setActive('active');
    setPage(1);
  };

  /* ── Export ── */
  const exportCsv = (): void => {
    const rows: string[][] = [];
    rows.push([settings.companyName]);
    rows.push([`Trial Balance (${prefs.viewMode === 'movement' ? 'Movement' : 'Standard'})`]);
    rows.push([`Period: ${period.from} to ${period.to}`, `As of: ${period.to}`, `Base currency: ${base}`, `Generated: ${isoDate(new Date())}`]);
    rows.push([`Status: ${reconciliation.balanced ? 'Balanced' : 'Out of balance'}`, `Difference: ${tbAmountAlways(reconciliation.difference)}`]);
    rows.push([]);
    const header = prefs.viewMode === 'movement'
      ? ['Code', 'Account', 'Type', 'Opening Dr', 'Opening Cr', 'Period Dr', 'Period Cr', 'Closing Dr', 'Closing Cr']
      : ['Code', 'Account', 'Type', 'Debit', 'Credit'];
    rows.push(header);
    const rowCells = (r: TrialBalanceRow): string[] => prefs.viewMode === 'movement'
      ? [r.accountCode, r.accountName, r.accountType, String(r.openingDebit), String(r.openingCredit), String(r.periodDebits), String(r.periodCredits), String(r.closingDebit), String(r.closingCredit)]
      : [r.accountCode, r.accountName, r.accountType, String(r.closingDebit), String(r.closingCredit)];
    if (prefs.grouped) {
      for (const g of groups) {
        rows.push([g.label]);
        g.rows.forEach((r) => rows.push(rowCells(r)));
        const s = g.subtotals;
        rows.push(prefs.viewMode === 'movement'
          ? ['', `${g.label} subtotal`, '', String(s.openingDebit), String(s.openingCredit), String(s.periodDebits), String(s.periodCredits), String(s.closingDebit), String(s.closingCredit)]
          : ['', `${g.label} subtotal`, '', String(s.closingDebit), String(s.closingCredit)]);
      }
    } else {
      displayRows.forEach((r) => rows.push(rowCells(r)));
    }
    const t = displayTotals;
    rows.push(prefs.viewMode === 'movement'
      ? ['', 'GRAND TOTAL', '', String(t.openingDebit), String(t.openingCredit), String(t.periodDebits), String(t.periodCredits), String(t.closingDebit), String(t.closingCredit)]
      : ['', 'GRAND TOTAL', '', String(t.closingDebit), String(t.closingCredit)]);
    const csv = rows.map((r) => r.map((c) => escapeCsv(c)).join(',')).join('\r\n');
    downloadFile(`trial-balance-${isoDate(new Date())}.csv`, csv, 'text/csv');
  };
  const exportJson = (): void => {
    downloadFile(
      `trial-balance-${isoDate(new Date())}.json`,
      JSON.stringify(
        {
          company: settings.companyName,
          report: 'Trial Balance',
          viewMode: prefs.viewMode,
          baseCurrency: base,
          period,
          asOf: period.to,
          generatedAt: new Date().toISOString(),
          balanced: reconciliation.balanced,
          totals: displayTotals,
          rows: displayRows,
        },
        null,
        2,
      ),
      'application/json',
    );
  };

  const groupIds = groups.map((g) => g.id);

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
        <p className="text-sm">Trial Balance — {prefs.viewMode === 'movement' ? 'Movement' : 'Standard'}</p>
        <p className="text-xs text-slate-500">Period {period.from} to {period.to} · As of {period.to} · Base currency {base}</p>
      </div>

      <div className="space-y-4">
        <ReconciliationBanner reconciliation={reconciliation} base={base} exceptionCount={exceptions.length} onReviewDifference={() => setShowExceptions(true)} />

        <TrialBalanceToolbar
          viewMode={prefs.viewMode}
          onViewMode={prefs.setViewMode}
          grouped={prefs.grouped}
          onGrouped={prefs.setGrouped}
          period={period}
          onPeriod={(p) => { setPeriod(p); setPage(1); }}
          filters={filters}
          onFilters={(patch) => {
            if (patch.search !== undefined) setSearch(patch.search);
            if (patch.type !== undefined) setType(patch.type);
            if (patch.includeZero !== undefined) prefs.setIncludeZero(patch.includeZero);
            if (patch.active !== undefined) prefs.setActive(patch.active);
            setPage(1);
          }}
          onReset={resetFilters}
          onExpandAll={() => setCollapsed(new Set())}
          onCollapseAll={() => setCollapsed(new Set(groupIds))}
        />

        {displayRows.length === 0 ? (
          <Card><CardBody><EmptyState icon={Scale} title="No accounts to display" description="No posting accounts match the current filters. Enable “Zero-balance” or widen the period to see more." /></CardBody></Card>
        ) : (
          <Card className="overflow-hidden">
            <TrialBalanceTable
              viewMode={prefs.viewMode}
              sections={sections}
              totals={displayTotals}
              onDrill={drill}
              collapsed={collapsed}
              onToggleGroup={(id) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
            />
            {!prefs.grouped && displayRows.length > prefs.rowsPerPage && (
              <div className="print:hidden">
                <JournalPagination page={paged.page} totalPages={paged.totalPages} from={paged.from} to={paged.to} total={paged.total} rowsPerPage={prefs.rowsPerPage} onPage={setPage} onRowsPerPage={(n) => { prefs.setRowsPerPage(n); setPage(1); }} />
              </div>
            )}
          </Card>
        )}
      </div>

      {showExceptions && (
        <ExceptionPanel exceptions={exceptions} onClose={() => setShowExceptions(false)} onAction={onException} />
      )}
    </>
  );
}
