import { useEffect, useMemo, useState } from 'react';
import { Download, Printer, RefreshCw, ChevronDown, X, ChevronsDownUp, ChevronsUpDown, ListTree } from 'lucide-react';
import type { GeneralLedgerLine, LedgerPeriod, LedgerSort } from '@/types/generalLedger';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import { useJournalView } from '@/store/journalViewStore';
import { useLedgerFocus } from '@/store/ledgerFocusStore';
import {
  buildAccountLedger,
  groupLedgerLinesByAccount,
  filterLedgerLines,
  formatAccountBalance,
} from '@/lib/generalLedgerCalculations';
import { paginate } from '@/lib/journalWorkspace';
import { escapeCsv } from '@/lib/csv';
import { downloadFile, cn } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { JournalPagination } from '@/components/journal/JournalPagination';
import { AccountSummaryCard } from '@/components/general-ledger/AccountSummaryCard';
import { LedgerTable } from '@/components/general-ledger/LedgerTable';
import { MultiAccountLedger } from '@/components/general-ledger/MultiAccountLedger';
import { LedgerDetailsPanel } from '@/components/general-ledger/LedgerDetailsPanel';

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function defaultFyToDate(fiscalYearStart: string): LedgerPeriod {
  const now = new Date();
  const [mm, dd] = fiscalYearStart.split('-').map(Number);
  let start = new Date(now.getFullYear(), (mm || 1) - 1, dd || 1);
  if (start > now) start = new Date(now.getFullYear() - 1, (mm || 1) - 1, dd || 1);
  return { from: isoDate(start), to: isoDate(now) };
}

type Mode = 'detail' | 'multi';

export function GeneralLedgerPage() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const entries = useJournalStore((s) => s.entries);
  const requestFocusEntry = useJournalView((s) => s.requestFocusEntry);
  const ledgerFocus = useLedgerFocus((s) => s.request);
  const clearLedgerFocus = useLedgerFocus((s) => s.clearLedgerFocus);

  const base = settings.baseCurrency;
  const postingAccounts = useMemo(() => accounts.filter((a) => a.isPostingAccount), [accounts]);

  const [mode, setMode] = useState<Mode>('detail');
  const [accountId, setAccountId] = useState<string>('');
  const [period, setPeriod] = useState<LedgerPeriod>(() => defaultFyToDate(settings.fiscalYearStart));
  const [sort, setSort] = useState<LedgerSort>('oldest');
  const [search, setSearch] = useState('');
  const [entityId, setEntityId] = useState('');
  const [includeZero, setIncludeZero] = useState(false);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedLine, setFocusedLine] = useState<GeneralLedgerLine | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Drill-down from the Trial Balance: preselect account + period, then clear.
  useEffect(() => {
    if (!ledgerFocus) return;
    setMode('detail');
    setAccountId(ledgerFocus.accountId);
    setPeriod({ from: ledgerFocus.from, to: ledgerFocus.to });
    setPage(1);
    clearLedgerFocus();
  }, [ledgerFocus, clearLedgerFocus]);

  const account = accountId ? accounts.find((a) => a.id === accountId) : undefined;

  const detailLedger = useMemo(
    () => (account ? buildAccountLedger(account, entries, period, base, sort) : null),
    [account, entries, period, base, sort, refreshKey],
  );
  const detailFiltered = useMemo(
    () => (detailLedger ? filterLedgerLines(detailLedger.lines, { entityId, search, reference: '', journalNumber: '', project: '', costCenter: '' }) : []),
    [detailLedger, entityId, search],
  );
  const paged = useMemo(() => paginate(detailFiltered, page, rowsPerPage), [detailFiltered, page, rowsPerPage]);

  const multiLedgers = useMemo(() => {
    if (mode !== 'multi') return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? postingAccounts.filter((a) => `${a.code} ${a.name} ${a.ifrsCategory}`.toLowerCase().includes(q))
      : postingAccounts;
    return groupLedgerLinesByAccount(filtered, entries, period, base, { includeZero, sort });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, postingAccounts, entries, period, base, includeZero, sort, search, refreshKey]);

  const openJournal = (entryId: string): void => {
    requestFocusEntry(entryId);
    setActiveView('journal');
  };
  const detailAccount = focusedLine ? accounts.find((a) => a.id === focusedLine.accountId) : undefined;

  /* ── Export ── */
  const exportCsv = (): void => {
    const rows: string[][] = [];
    rows.push([settings.companyName]);
    rows.push([`General Ledger${account ? ` — ${account.code} ${account.name}` : ''}`]);
    rows.push([`Period: ${period.from} to ${period.to}`, `Base currency: ${base}`, `Generated: ${isoDate(new Date())}`]);
    rows.push([]);
    const push = (led: NonNullable<typeof detailLedger>) => {
      rows.push([`${led.account.code} — ${led.account.name}`]);
      rows.push(['Date', 'Journal No.', 'Reference', 'Entity', 'Description', 'Debit', 'Credit', 'Balance']);
      rows.push(['', '', '', '', 'Opening Balance', '', '', formatAccountBalance(led.openingBalance, led.account.normalBalance)]);
      for (const l of led.lines) rows.push([l.entryDate, l.journalNumber, l.reference, l.entityName ?? '', l.memo || l.description, String(l.baseDebit || ''), String(l.baseCredit || ''), formatAccountBalance(l.runningBalance, led.account.normalBalance)]);
      rows.push(['', '', '', '', 'Closing Balance', String(led.periodDebits), String(led.periodCredits), formatAccountBalance(led.closingBalance, led.account.normalBalance)]);
      rows.push([]);
    };
    if (mode === 'detail' && detailLedger) push(detailLedger);
    else multiLedgers.forEach(push);
    const csv = rows.map((r) => r.map((c) => escapeCsv(c)).join(',')).join('\r\n');
    downloadFile(`general-ledger-${isoDate(new Date())}.csv`, csv, 'text/csv');
  };
  const exportJson = (): void => {
    const payload = {
      company: settings.companyName,
      report: 'General Ledger',
      baseCurrency: base,
      period,
      generatedAt: new Date().toISOString(),
      accounts: (mode === 'detail' && detailLedger ? [detailLedger] : multiLedgers).map((l) => ({
        code: l.account.code,
        name: l.account.name,
        normalBalance: l.account.normalBalance,
        openingBalance: l.openingBalance,
        periodDebits: l.periodDebits,
        periodCredits: l.periodCredits,
        netMovement: l.netMovement,
        closingBalance: l.closingBalance,
        lines: l.lines,
      })),
    };
    downloadFile(`general-ledger-${isoDate(new Date())}.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const entityOptions = useMemo(
    () => [{ value: '', label: 'All entities' }, ...entities.slice().sort((a, b) => a.legalName.localeCompare(b.legalName)).map((e) => ({ value: e.id, label: e.legalName }))],
    [entities],
  );

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
        <p className="text-sm">General Ledger{account ? ` — ${account.code} ${account.name}` : ''}</p>
        <p className="text-xs text-slate-500">Period {period.from} to {period.to} · Base currency {base}</p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
            {(['detail', 'multi'] as const).map((m) => (
              <button key={m} type="button" onClick={() => { setMode(m); setPage(1); }} className={cn('rounded-md px-3 py-1.5 font-medium transition-colors', mode === m ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200')}>
                {m === 'detail' ? 'Account detail' : 'Multi-account'}
              </button>
            ))}
          </div>
          {mode === 'detail' && (
            <div className="min-w-[16rem] flex-1">
              <AccountSelect value={accountId} accounts={accounts} onChange={(a) => { setAccountId(a.id); setPage(1); }} />
            </div>
          )}
          <DateRangeFilter value={{ dateFrom: period.from, dateTo: period.to }} onChange={(v) => { setPeriod({ from: v.dateFrom || period.from, to: v.dateTo || period.to }); setPage(1); }} />
          <Select className="h-10 w-auto" options={[{ value: 'oldest', label: 'Oldest first' }, { value: 'newest', label: 'Newest first' }]} value={sort} onChange={(e) => setSort(e.target.value as LedgerSort)} aria-label="Sort order" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search journal, ref, entity, description…" className="h-9" aria-label="Search ledger" />
          </div>
          {mode === 'detail' && (
            <Select className="h-9 w-auto max-w-[200px]" options={entityOptions} value={entityId} onChange={(e) => { setEntityId(e.target.value); setPage(1); }} aria-label="Filter by entity" />
          )}
          {mode === 'multi' && (
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
              Include zero-balance
              <Toggle checked={includeZero} onChange={setIncludeZero} label="Include zero-balance accounts" />
            </label>
          )}
          {(search || entityId || accountId) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setEntityId(''); if (mode === 'detail') setAccountId(''); }}>
              <X className="h-4 w-4" /> Reset
            </Button>
          )}
          {mode === 'multi' && (
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set(multiLedgers.map((l) => l.account.id)))}><ChevronsUpDown className="h-4 w-4" /> Expand all</Button>
              <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}><ChevronsDownUp className="h-4 w-4" /> Collapse all</Button>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      {mode === 'detail' ? (
        !detailLedger ? (
          <Card><CardBody><EmptyState icon={ListTree} title="Select an account" description="Choose a posting account above to view its ledger, opening balance and running balances." /></CardBody></Card>
        ) : (
          <div className="space-y-4">
            <AccountSummaryCard ledger={detailLedger} />
            <Card className="overflow-hidden">
              <LedgerTable
                ledger={detailLedger}
                lines={paged.items}
                showOpeningRow={paged.page === 1 && sort === 'oldest'}
                onOpenJournal={openJournal}
                onSelectLine={setFocusedLine}
                focusedLineId={focusedLine?.id ?? null}
              />
              {detailFiltered.length > rowsPerPage && (
                <div className="print:hidden">
                  <JournalPagination page={paged.page} totalPages={paged.totalPages} from={paged.from} to={paged.to} total={paged.total} rowsPerPage={rowsPerPage} onPage={setPage} onRowsPerPage={(n) => { setRowsPerPage(n); setPage(1); }} />
                </div>
              )}
            </Card>
          </div>
        )
      ) : multiLedgers.length === 0 ? (
        <Card><CardBody><EmptyState icon={ListTree} title="No account activity" description="No posting accounts have transactions in the selected period. Enable “Include zero-balance” to list all." /></CardBody></Card>
      ) : (
        <MultiAccountLedger
          ledgers={multiLedgers}
          expanded={expanded}
          onToggle={(id) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
          onOpenJournal={openJournal}
          onSelectLine={setFocusedLine}
          focusedLineId={focusedLine?.id ?? null}
        />
      )}

      {/* Transaction details slide-over */}
      {focusedLine && (
        <div className="fixed inset-0 z-50 flex justify-end print:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setFocusedLine(null)} />
          <div className="relative h-full w-full max-w-md animate-[slideIn_0.2s_ease-out]">
            <LedgerDetailsPanel
              line={focusedLine}
              account={detailAccount}
              onClose={() => setFocusedLine(null)}
              onOpenJournal={(id) => { setFocusedLine(null); openJournal(id); }}
              onViewEntity={() => setActiveView('entities')}
              onViewAccount={() => setActiveView('tree')}
            />
          </div>
        </div>
      )}
    </>
  );
}
