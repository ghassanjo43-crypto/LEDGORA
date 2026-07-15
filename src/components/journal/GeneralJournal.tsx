import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Upload, Download, Send, Save, Maximize2, Minimize2, ChevronDown } from 'lucide-react';
import type { Account } from '@/types';
import type { JournalFilters } from '@/types/journal';
import { useJournalStore, entryToFormValues } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalView } from '@/store/journalViewStore';
import { DEFAULT_JOURNAL_FILTERS, filterJournalEntries } from '@/lib/journalSelectors';
import {
  filterByTab,
  tabCounts,
  journalSummary,
  paginate,
  isPendingApproval,
  type JournalTab,
} from '@/lib/journalWorkspace';
import {
  exportJournalToCsv,
  exportJournalToJson,
  importJournalFromCsv,
  importJournalFromJson,
} from '@/lib/journalImportExport';
import { downloadFile } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { DateRangeFilter } from '@/components/ui/DateRangeFilter';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { JournalSummaryCards } from './JournalSummaryCards';
import { JournalStatusTabs } from './JournalStatusTabs';
import { JournalDataTable } from './JournalDataTable';
import { JournalPagination } from './JournalPagination';
import { JournalBulkActions } from './JournalBulkActions';
import { ColumnVisibilityMenu } from './ColumnVisibilityMenu';
import { JournalDetailsPanel } from './JournalDetailsPanel';
import { JournalEntryDrawer, type JournalFormMode } from './JournalEntryDrawer';
import { PostedProtectionDialog } from './PostedProtectionDialog';

type PendingAction =
  | { type: 'post'; id: string }
  | { type: 'void'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'bulk-post' }
  | { type: 'bulk-delete' };

const FY_OPTIONS = [2027, 2026, 2025, 2024];

export function GeneralJournal() {
  const entries = useJournalStore((s) => s.entries);
  const deleteEntry = useJournalStore((s) => s.deleteEntry);
  const duplicateEntry = useJournalStore((s) => s.duplicateEntry);
  const reverseEntry = useJournalStore((s) => s.reverseEntry);
  const postEntry = useJournalStore((s) => s.postEntry);
  const voidEntry = useJournalStore((s) => s.voidEntry);
  const updateEntry = useJournalStore((s) => s.updateEntry);
  const appendEntries = useJournalStore((s) => s.appendEntries);
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const accountsByCode = useMemo(() => new Map(accounts.map((a) => [a.code, a])), [accounts]);
  useEntityStore((s) => s.entities); // subscribe so entity names refresh
  const { notify } = useToast();

  const columns = useJournalView((s) => s.columns);
  const rowsPerPage = useJournalView((s) => s.rowsPerPage);
  const setRowsPerPage = useJournalView((s) => s.setRowsPerPage);
  const focusEntryId = useJournalView((s) => s.focusEntryId);
  const requestFocusEntry = useJournalView((s) => s.requestFocusEntry);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<JournalFilters>(DEFAULT_JOURNAL_FILTERS);
  const [tab, setTab] = useState<JournalTab>('all');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [formMode, setFormMode] = useState<JournalFormMode | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [protectId, setProtectId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const accountsById = useMemo(() => new Map<string, Account>(accounts.map((a) => [a.id, a])), [accounts]);
  const currency = settings.baseCurrency;

  // Search + date/account/entity filters (status handled by the tabs).
  const base = useMemo(
    () => filterJournalEntries(entries, search, { ...filters, status: 'ALL' }),
    [entries, search, filters],
  );
  const summary = useMemo(() => journalSummary(base), [base]);
  const counts = useMemo(() => tabCounts(base, accountsById), [base, accountsById]);
  const tabbed = useMemo(() => filterByTab(base, tab, accountsById), [base, tab, accountsById]);
  const paged = useMemo(() => paginate(tabbed, page, rowsPerPage), [tabbed, page, rowsPerPage]);
  const visibleEntries = paged.items;

  const focusedEntry = focusedId ? entries.find((e) => e.id === focusedId) : undefined;

  const allSelected = visibleEntries.length > 0 && visibleEntries.every((e) => selectedIds.has(e.id));
  const selectedEntries = useMemo(() => entries.filter((e) => selectedIds.has(e.id)), [entries, selectedIds]);
  const canBulkPost = selectedEntries.some((e) => isPendingApproval(e, accountsById));
  const canBulkDelete = selectedEntries.some((e) => e.status === 'draft');

  const searchActive = !!search || tab !== 'all' || filters.dateFrom !== '' || filters.dateTo !== '';

  /* ── Selection ── */
  const toggleSelect = (id: string): void =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (): void =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const every = visibleEntries.every((e) => next.has(e.id));
      for (const e of visibleEntries) {
        if (every) next.delete(e.id);
        else next.add(e.id);
      }
      return next;
    });
  const openEntry = (id: string): void => {
    setFocusedId(id);
    setPanelOpen(true);
  };

  // Honor a drill-down request coming from the General Ledger.
  useEffect(() => {
    if (focusEntryId) {
      openEntry(focusEntryId);
      requestFocusEntry(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEntryId]);

  /* ── Import / export ── */
  const stamp = new Date().toISOString().slice(0, 10);
  const handleExport = (format: 'csv' | 'json', data = entries): void => {
    if (format === 'json') downloadFile(`general-journal-${stamp}.json`, exportJournalToJson(data), 'application/json');
    else downloadFile(`general-journal-${stamp}.csv`, exportJournalToCsv(data), 'text/csv');
    notify(`Exported ${data.length} journal entries as ${format.toUpperCase()}.`, 'success');
  };
  const handleImportFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith('.json');
    const result = isJson ? importJournalFromJson(text) : importJournalFromCsv(text, accountsByCode);
    if (result.entries.length === 0) {
      notify(`Import failed: ${result.issues[0]?.message ?? 'Could not parse the file.'}`, 'error');
      return;
    }
    const outcome = appendEntries(result.entries);
    notify(outcome.ok ? `Imported ${result.entries.length} draft entr${result.entries.length === 1 ? 'y' : 'ies'}.` : outcome.error ?? 'Import failed.', outcome.ok ? 'success' : 'error');
  };
  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) void handleImportFile(file);
    e.target.value = '';
  };

  /* ── Single-entry actions ── */
  const handleDuplicate = (id: string): void => {
    const r = duplicateEntry(id);
    notify(r.ok ? 'Entry duplicated as a new draft.' : r.error ?? 'Could not duplicate.', r.ok ? 'success' : 'error');
    if (r.ok && r.id) openEntry(r.id);
  };
  const handleSaveNotes = (id: string, notes: string): void => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    const r = updateEntry(id, { ...entryToFormValues(entry), notes });
    notify(r.ok ? 'Note saved.' : r.error ?? 'Could not save note.', r.ok ? 'success' : 'error');
  };

  const confirmPending = (): void => {
    if (!pending) return;
    if (pending.type === 'bulk-post') {
      let ok = 0;
      for (const e of selectedEntries) {
        if (isPendingApproval(e, accountsById) && postEntry(e.id).ok) ok += 1;
      }
      notify(`Posted ${ok} entr${ok === 1 ? 'y' : 'ies'}.`, ok > 0 ? 'success' : 'error');
      setSelectedIds(new Set());
    } else if (pending.type === 'bulk-delete') {
      let ok = 0;
      for (const e of selectedEntries) {
        if (e.status === 'draft' && deleteEntry(e.id).ok) ok += 1;
      }
      notify(`Deleted ${ok} draft${ok === 1 ? '' : 's'}.`, ok > 0 ? 'success' : 'error');
      setSelectedIds(new Set());
    } else {
      const fn = pending.type === 'post' ? postEntry : pending.type === 'void' ? voidEntry : deleteEntry;
      const r = fn(pending.id);
      const verb = pending.type === 'post' ? 'posted' : pending.type === 'void' ? 'voided' : 'deleted';
      notify(r.ok ? `Journal entry ${verb}.` : r.error ?? `Could not ${pending.type}.`, r.ok ? 'success' : 'error');
      if (r.ok && pending.type === 'delete' && focusedId === pending.id) setFocusedId(null);
    }
    setPending(null);
  };

  const confirmMeta: Record<PendingAction['type'], { title: string; message: string; confirmLabel: string; destructive: boolean }> = {
    post: { title: 'Post journal entry?', message: 'Posting locks the entry from further editing. Debits and credits must balance.', confirmLabel: 'Post entry', destructive: false },
    void: { title: 'Void posted entry?', message: 'Voiding reverses the entry and records a reversal reference. The original remains for audit.', confirmLabel: 'Void entry', destructive: true },
    delete: { title: 'Delete draft entry?', message: 'Permanently delete this draft? This cannot be undone.', confirmLabel: 'Delete', destructive: true },
    'bulk-post': { title: 'Post selected entries?', message: 'Only balanced, valid drafts will be posted.', confirmLabel: 'Post selected', destructive: false },
    'bulk-delete': { title: 'Delete selected drafts?', message: 'Only draft entries will be deleted. Posted entries are never removed.', confirmLabel: 'Delete drafts', destructive: true },
  };
  const meta = pending ? confirmMeta[pending.type] : null;

  const focusedDraftPostable = !!focusedEntry && isPendingApproval(focusedEntry, accountsById);

  const panelProps = {
    entry: focusedEntry,
    accountsById,
    onEdit: (id: string) => setFormMode({ kind: 'edit', entryId: id }),
    onPost: (id: string) => setPending({ type: 'post', id }),
    onReverse: (id: string) => setProtectId(id),
    onDuplicate: handleDuplicate,
    onDelete: (id: string) => setPending({ type: 'delete', id }),
    onSaveNotes: handleSaveNotes,
  };

  return (
    <>
      <input ref={fileInputRef} type="file" accept=".json,.csv,application/json,text/csv" onChange={onInputChange} className="hidden" />

      {/* Workspace toolbar */}
      <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search journal, ref, account, entity…" className="h-9 pl-9" aria-label="Search journal" />
        </div>
        <DateRangeFilter value={{ dateFrom: filters.dateFrom, dateTo: filters.dateTo }} onChange={(v) => { setFilters((f) => ({ ...f, ...v })); setPage(1); }} />
        <select
          className="focus-ring h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          aria-label="Fiscal year"
          value={filters.dateFrom ? new Date(filters.dateFrom).getFullYear() : ''}
          onChange={(e) => {
            const y = e.target.value;
            if (!y) setFilters((f) => ({ ...f, dateFrom: '', dateTo: '' }));
            else setFilters((f) => ({ ...f, dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` }));
            setPage(1);
          }}
        >
          <option value="">All years</option>
          {FY_OPTIONS.map((y) => <option key={y} value={y}>FY {y}</option>)}
        </select>
        <div className="hidden h-6 w-px bg-slate-200 dark:bg-slate-700 lg:block" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setFormMode({ kind: 'create' })}><Plus className="h-4 w-4" /> Add Entry</Button>
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}><Upload className="h-4 w-4" /> Import</Button>
          <Dropdown label="Export" trigger={(o) => (
            <span className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200', o && 'bg-slate-50 dark:bg-slate-800')}>
              <Download className="h-4 w-4" /> Export <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </span>
          )}>
            <MenuItem onClick={() => handleExport('csv')}>Export CSV</MenuItem>
            <MenuItem onClick={() => handleExport('json')}>Export JSON</MenuItem>
          </Dropdown>
          <Button size="sm" variant="outline" disabled={!focusedDraftPostable} onClick={() => focusedId && setPending({ type: 'post', id: focusedId })}><Send className="h-4 w-4" /> Post</Button>
          <Button size="sm" variant="outline" disabled={!focusedEntry || focusedEntry.status !== 'draft'} onClick={() => focusedId && setFormMode({ kind: 'edit', entryId: focusedId })}><Save className="h-4 w-4" /> Save Draft</Button>
        </div>
      </div>

      <div className="space-y-4">
        {!fullscreen && <JournalSummaryCards summary={summary} currency={currency} />}

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
              <JournalStatusTabs value={tab} counts={counts} onChange={(t) => { setTab(t); setPage(1); }} />
              <div className="flex items-center gap-2 py-2">
                <JournalBulkActions
                  count={selectedIds.size}
                  canPost={canBulkPost}
                  canDelete={canBulkDelete}
                  onPost={() => setPending({ type: 'bulk-post' })}
                  onExport={() => handleExport('json', selectedEntries)}
                  onDuplicate={() => { selectedEntries.forEach((e) => duplicateEntry(e.id)); notify(`Duplicated ${selectedEntries.length}.`, 'success'); }}
                  onDelete={() => setPending({ type: 'bulk-delete' })}
                />
                <ColumnVisibilityMenu />
                <button type="button" onClick={() => setFullscreen((v) => !v)} title={fullscreen ? 'Exit full screen' : 'Full screen table'} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <JournalDataTable
              entries={visibleEntries}
              columns={columns}
              selectedIds={selectedIds}
              focusedId={focusedId}
              allSelected={allSelected}
              onToggleSelect={toggleSelect}
              onToggleAll={toggleAll}
              onOpenEntry={openEntry}
              onAdd={() => setFormMode({ kind: 'create' })}
              searchActive={searchActive}
            />

            <JournalPagination
              page={paged.page}
              totalPages={paged.totalPages}
              from={paged.from}
              to={paged.to}
              total={paged.total}
              rowsPerPage={rowsPerPage}
              onPage={setPage}
              onRowsPerPage={(n) => { setRowsPerPage(n); setPage(1); }}
            />
          </Card>
      </div>

      {/* Details slide-over — opens when a row is selected. */}
      {panelOpen && focusedEntry && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setPanelOpen(false)} />
          <div className="relative h-full w-full max-w-md animate-[slideIn_0.2s_ease-out]">
            <JournalDetailsPanel {...panelProps} onClose={() => setPanelOpen(false)} />
          </div>
        </div>
      )}

      <JournalEntryDrawer open={formMode !== null} mode={formMode} onClose={() => setFormMode(null)} />

      <ConfirmDialog
        open={pending !== null}
        title={meta?.title ?? ''}
        message={meta?.message ?? ''}
        confirmLabel={meta?.confirmLabel}
        destructive={meta?.destructive}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />

      <PostedProtectionDialog
        open={protectId !== null}
        entryNumber={entries.find((e) => e.id === protectId)?.entryNumber ?? ''}
        onReverse={() => {
          if (!protectId) return;
          const r = reverseEntry(protectId);
          if (r.ok) { notify('Reversing draft created. Review and post it.', 'success'); setProtectId(null); if (r.id) openEntry(r.id); }
          else notify(r.error ?? 'Could not reverse.', 'error');
        }}
        onDuplicate={() => {
          if (!protectId) return;
          const r = duplicateEntry(protectId);
          if (r.ok) { notify('Duplicated as a new draft.', 'success'); setProtectId(null); if (r.id) openEntry(r.id); }
          else notify(r.error ?? 'Could not duplicate.', 'error');
        }}
        onCancel={() => setProtectId(null)}
      />
    </>
  );
}
