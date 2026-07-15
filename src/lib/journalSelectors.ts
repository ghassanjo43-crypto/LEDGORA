import type { Account } from '@/types';
import type { JournalEntry, JournalFilters } from '@/types/journal';

export const DEFAULT_JOURNAL_FILTERS: JournalFilters = {
  status: 'ALL',
  dateFrom: '',
  dateTo: '',
  accountId: '',
  entityId: '',
};

export interface JournalStats {
  totalEntries: number;
  draftEntries: number;
  postedEntries: number;
  voidEntries: number;
  totalDebits: number;
  totalCredits: number;
  unbalancedDrafts: number;
}

/**
 * Aggregate KPIs for the dashboard. Only POSTED entries contribute to the
 * total debit/credit money figures — drafts and voids are excluded from the
 * "books" totals but still counted by status.
 */
export function computeJournalStats(entries: JournalEntry[]): JournalStats {
  let draftEntries = 0;
  let postedEntries = 0;
  let voidEntries = 0;
  let totalDebits = 0;
  let totalCredits = 0;
  let unbalancedDrafts = 0;

  for (const entry of entries) {
    if (entry.status === 'draft') {
      draftEntries += 1;
      if (Math.abs(entry.difference) >= 0.005) unbalancedDrafts += 1;
    } else if (entry.status === 'posted') {
      postedEntries += 1;
      totalDebits += entry.totalDebit;
      totalCredits += entry.totalCredit;
    } else {
      voidEntries += 1;
    }
  }

  return {
    totalEntries: entries.length,
    draftEntries,
    postedEntries,
    voidEntries,
    totalDebits: Math.round((totalDebits + Number.EPSILON) * 100) / 100,
    totalCredits: Math.round((totalCredits + Number.EPSILON) * 100) / 100,
    unbalancedDrafts,
  };
}

/** Format a monetary amount with grouping and exactly two decimals. */
export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value || 0);
}

/** Format an amount for a debit/credit cell — blank when zero for readability. */
export function formatAmountCell(value: number): string {
  return value ? formatMoney(value) : '';
}

function matchesJournalSearch(entry: JournalEntry, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (
    entry.entryNumber.toLowerCase().includes(q) ||
    entry.reference.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q) ||
    entry.notes.toLowerCase().includes(q)
  ) {
    return true;
  }
  return entry.lines.some(
    (line) =>
      line.accountCode.toLowerCase().includes(q) ||
      line.accountName.toLowerCase().includes(q) ||
      line.entityName.toLowerCase().includes(q) ||
      line.memo.toLowerCase().includes(q) ||
      line.description.toLowerCase().includes(q),
  );
}

function matchesJournalFilters(entry: JournalEntry, f: JournalFilters): boolean {
  if (f.status !== 'ALL' && entry.status !== f.status) return false;
  if (f.dateFrom && entry.entryDate < f.dateFrom) return false;
  if (f.dateTo && entry.entryDate > f.dateTo) return false;
  if (f.accountId && !entry.lines.some((l) => l.accountId === f.accountId)) return false;
  if (f.entityId && !entry.lines.some((l) => l.entityId === f.entityId)) return false;
  return true;
}

/** Apply free-text search + structured filters, newest entry date first. */
export function filterJournalEntries(
  entries: JournalEntry[],
  query: string,
  filters: JournalFilters,
): JournalEntry[] {
  return entries
    .filter((e) => matchesJournalSearch(e, query) && matchesJournalFilters(e, filters))
    .sort(
      (a, b) =>
        b.entryDate.localeCompare(a.entryDate) ||
        b.entryNumber.localeCompare(a.entryNumber),
    );
}

/** Distinct accounts referenced by any journal line, for the filter dropdown. */
export function referencedAccounts(
  entries: JournalEntry[],
  accountsById: Map<string, Account>,
): { id: string; code: string; name: string }[] {
  const seen = new Map<string, { id: string; code: string; name: string }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!line.accountId || seen.has(line.accountId)) continue;
      const account = accountsById.get(line.accountId);
      seen.set(line.accountId, {
        id: line.accountId,
        code: account?.code ?? line.accountCode,
        name: account?.name ?? line.accountName,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Distinct entities referenced by any journal line, for the filter dropdown. */
export function referencedEntities(
  entries: JournalEntry[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.entityId && !seen.has(line.entityId)) {
        seen.set(line.entityId, line.entityName);
      }
    }
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
