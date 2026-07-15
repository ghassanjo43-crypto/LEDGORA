import type { Account } from '@/types';
import type { JournalEntry, JournalLine } from '@/types/journal';
import type {
  AccountLedger,
  BalanceSide,
  GeneralLedgerLine,
  LedgerFilters,
  LedgerPeriod,
  LedgerReconciliation,
  LedgerSort,
} from '@/types/generalLedger';
import { resolveEntryType } from '@/lib/journalMeta';

/* ─────────────────────────────── Currency ───────────────────────────────── */

/** Convert a line amount to the company's base currency using the entry rate. */
export function convertToBaseCurrency(amount: number, currency: string, rate: number, baseCurrency: string): number {
  if (!amount) return 0;
  if (currency.toUpperCase() === baseCurrency.toUpperCase()) return amount;
  return amount * (rate || 1);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ─────────────────────────── Source of truth ─────────────────────────────── */

export interface PostedLine {
  entry: JournalEntry;
  line: JournalLine;
}

function postingDate(entry: JournalEntry): string {
  return entry.postedAt ? entry.postedAt.slice(0, 10) : entry.entryDate;
}

/** All posted journal lines (drafts, voids and deleted entries are excluded). */
export function getPostedJournalLines(entries: JournalEntry[]): PostedLine[] {
  const out: PostedLine[] = [];
  for (const entry of entries) {
    if (entry.status !== 'posted') continue;
    for (const line of entry.lines) out.push({ entry, line });
  }
  return out.sort(sortPosted);
}

function sortPosted(a: PostedLine, b: PostedLine): number {
  return (
    postingDate(a.entry).localeCompare(postingDate(b.entry)) ||
    a.entry.entryNumber.localeCompare(b.entry.entryNumber) ||
    a.line.lineNumber - b.line.lineNumber
  );
}

/* ────────────────────────── Sign handling ───────────────────────────────── */

/** Signed base-currency amount oriented to the account's normal side. */
export function signedAmount(account: Account, baseDebit: number, baseCredit: number): number {
  return account.normalBalance === 'DEBIT' ? baseDebit - baseCredit : baseCredit - baseDebit;
}

/** Which side a normal-oriented signed balance sits on. */
export function getBalanceSide(value: number, normalBalance: Account['normalBalance']): BalanceSide {
  if (Math.abs(value) < 0.005) return 'zero';
  const normalSide: BalanceSide = normalBalance === 'DEBIT' ? 'debit' : 'credit';
  const oppositeSide: BalanceSide = normalSide === 'debit' ? 'credit' : 'debit';
  return value > 0 ? normalSide : oppositeSide;
}

/** Format a normal-oriented signed balance as "1,234.00 Dr". */
export function formatBalanceLabel(value: number): string {
  const abs = Math.abs(value);
  const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs);
  if (abs < 0.005) return `${num}`;
  return `${num} ${value > 0 ? 'Dr' : 'Cr'}`;
}

/**
 * Format a signed balance given the account's normal side, so it reads with the
 * correct Dr/Cr label even when abnormal. Positive `signed` = normal side.
 */
export function formatAccountBalance(signed: number, normalBalance: Account['normalBalance']): string {
  const side = getBalanceSide(signed, normalBalance);
  const abs = Math.abs(signed);
  const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs);
  if (side === 'zero') return num;
  return `${num} ${side === 'debit' ? 'Dr' : 'Cr'}`;
}

/* ─────────────────────────── Ledger line builder ─────────────────────────── */

function baseAmounts(entry: JournalEntry, line: JournalLine, baseCurrency: string): { baseDebit: number; baseCredit: number } {
  return {
    baseDebit: convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, baseCurrency),
    baseCredit: convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, baseCurrency),
  };
}

function toLedgerLine(entry: JournalEntry, line: JournalLine, baseCurrency: string): Omit<GeneralLedgerLine, 'runningBalance' | 'balanceSide' | 'abnormal'> {
  const { baseDebit, baseCredit } = baseAmounts(entry, line, baseCurrency);
  const isReversal = !!entry.reversalReference || !!entry.originalEntryId;
  return {
    id: `${entry.id}:${line.id}`,
    accountId: line.accountId,
    accountCode: line.accountCode,
    accountName: line.accountName,
    journalEntryId: entry.id,
    journalNumber: entry.entryNumber,
    journalLineId: line.id,
    lineNumber: line.lineNumber,
    entryDate: entry.entryDate,
    postingDate: postingDate(entry),
    reference: entry.reference,
    transactionType: isReversal ? 'Reversal' : resolveEntryType(entry).label,
    entityId: line.entityId || undefined,
    entityName: line.entityName || undefined,
    description: line.description || entry.description,
    memo: line.memo || undefined,
    debit: line.debit,
    credit: line.credit,
    baseDebit,
    baseCredit,
    currency: entry.currency,
    exchangeRate: entry.exchangeRate,
    project: line.project || undefined,
    costCenter: line.costCenter || undefined,
    taxCode: line.taxCode || undefined,
    createdBy: entry.createdBy || undefined,
    postedBy: entry.postedBy || entry.approvedBy || undefined,
    reversalReference: entry.reversalReference || undefined,
    originalEntryId: entry.originalEntryId || undefined,
  };
}

/** Posted lines for a single account, in accounting order. */
export function getLedgerLinesForAccount(accountId: string, entries: JournalEntry[]): PostedLine[] {
  return getPostedJournalLines(entries).filter((pl) => pl.line.accountId === accountId);
}

/* ─────────────────────────── Balances & movement ─────────────────────────── */

/** Opening balance (normal-oriented signed) = posted movement strictly before `from`. */
export function calculateOpeningBalance(account: Account, entries: JournalEntry[], from: string, baseCurrency: string): number {
  let total = 0;
  for (const { entry, line } of getLedgerLinesForAccount(account.id, entries)) {
    if (entry.entryDate >= from) continue;
    const { baseDebit, baseCredit } = baseAmounts(entry, line, baseCurrency);
    total += signedAmount(account, baseDebit, baseCredit);
  }
  return round2(total);
}

export function calculatePeriodDebits(lines: GeneralLedgerLine[]): number {
  return round2(lines.reduce((s, l) => s + l.baseDebit, 0));
}

export function calculatePeriodCredits(lines: GeneralLedgerLine[]): number {
  return round2(lines.reduce((s, l) => s + l.baseCredit, 0));
}

export function calculateNetMovement(account: Account, periodDebits: number, periodCredits: number): number {
  return round2(account.normalBalance === 'DEBIT' ? periodDebits - periodCredits : periodCredits - periodDebits);
}

export function calculateClosingBalance(opening: number, netMovement: number): number {
  return round2(opening + netMovement);
}

/** Attach running balances to ordered (oldest-first) lines. */
export function calculateRunningBalances(
  account: Account,
  ordered: Omit<GeneralLedgerLine, 'runningBalance' | 'balanceSide' | 'abnormal'>[],
  opening: number,
): GeneralLedgerLine[] {
  let running = opening;
  const normalSide: BalanceSide = account.normalBalance === 'DEBIT' ? 'debit' : 'credit';
  return ordered.map((l) => {
    running = round2(running + signedAmount(account, l.baseDebit, l.baseCredit));
    const balanceSide = getBalanceSide(running, account.normalBalance);
    return { ...l, runningBalance: running, balanceSide, abnormal: balanceSide !== 'zero' && balanceSide !== normalSide };
  });
}

/* ───────────────────────────── Account ledger ────────────────────────────── */

/** Full ledger for one account over a period, with running balances. */
export function buildAccountLedger(
  account: Account,
  entries: JournalEntry[],
  period: LedgerPeriod,
  baseCurrency: string,
  sort: LedgerSort = 'oldest',
): AccountLedger {
  const opening = calculateOpeningBalance(account, entries, period.from, baseCurrency);
  const periodPosted = getLedgerLinesForAccount(account.id, entries).filter(
    ({ entry }) => entry.entryDate >= period.from && entry.entryDate <= period.to,
  );
  const raw = periodPosted.map(({ entry, line }) => toLedgerLine(entry, line, baseCurrency));
  const withRunning = calculateRunningBalances(account, raw, opening);

  const periodDebits = calculatePeriodDebits(withRunning);
  const periodCredits = calculatePeriodCredits(withRunning);
  const netMovement = calculateNetMovement(account, periodDebits, periodCredits);
  const closingBalance = calculateClosingBalance(opening, netMovement);

  const lines = sort === 'newest' ? [...withRunning].reverse() : withRunning;
  return { account, openingBalance: opening, lines, periodDebits, periodCredits, netMovement, closingBalance, transactionCount: withRunning.length };
}

/** Ledgers for multiple accounts (multi-account grouped view). */
export function groupLedgerLinesByAccount(
  accounts: Account[],
  entries: JournalEntry[],
  period: LedgerPeriod,
  baseCurrency: string,
  opts: { includeZero?: boolean; sort?: LedgerSort } = {},
): AccountLedger[] {
  const postingAccounts = accounts.filter((a) => a.isPostingAccount);
  const ledgers = postingAccounts.map((a) => buildAccountLedger(a, entries, period, baseCurrency, opts.sort));
  return ledgers
    .filter((l) => opts.includeZero || l.transactionCount > 0 || Math.abs(l.openingBalance) >= 0.005)
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
}

/* ─────────────────────────────── Filtering ──────────────────────────────── */

export function filterLedgerLines(lines: GeneralLedgerLine[], filters: LedgerFilters): GeneralLedgerLine[] {
  const q = filters.search.trim().toLowerCase();
  return lines.filter((l) => {
    if (filters.entityId && l.entityId !== filters.entityId) return false;
    if (filters.reference && !l.reference.toLowerCase().includes(filters.reference.toLowerCase())) return false;
    if (filters.journalNumber && !l.journalNumber.toLowerCase().includes(filters.journalNumber.toLowerCase())) return false;
    if (filters.project && (l.project ?? '') !== filters.project) return false;
    if (filters.costCenter && (l.costCenter ?? '') !== filters.costCenter) return false;
    if (q) {
      const hay = `${l.journalNumber} ${l.reference} ${l.accountCode} ${l.accountName} ${l.entityName ?? ''} ${l.description} ${l.memo ?? ''} ${l.project ?? ''} ${l.costCenter ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ─────────────────────────── Reconciliation (dev) ────────────────────────── */

/**
 * Internal consistency check: total base debits == total base credits across
 * all posted lines, and every account's closing == opening + net movement.
 */
export function reconcileLedger(entries: JournalEntry[], accounts: Account[], baseCurrency: string): LedgerReconciliation {
  const posted = getPostedJournalLines(entries);
  let totalDebits = 0;
  let totalCredits = 0;
  for (const { entry, line } of posted) {
    const { baseDebit, baseCredit } = baseAmounts(entry, line, baseCurrency);
    totalDebits += baseDebit;
    totalCredits += baseCredit;
  }
  totalDebits = round2(totalDebits);
  totalCredits = round2(totalCredits);
  const issues: string[] = [];
  const balanced = Math.abs(totalDebits - totalCredits) < 0.01;
  if (!balanced) issues.push(`Global ledger is out of balance: debits ${totalDebits} vs credits ${totalCredits}.`);

  const period: LedgerPeriod = { from: '0000-01-01', to: '9999-12-31' };
  for (const account of accounts.filter((a) => a.isPostingAccount)) {
    const led = buildAccountLedger(account, entries, period, baseCurrency);
    const expected = calculateClosingBalance(led.openingBalance, led.netMovement);
    if (Math.abs(expected - led.closingBalance) >= 0.01) {
      issues.push(`${account.code}: closing ${led.closingBalance} ≠ opening + movement ${expected}.`);
    }
  }
  return { ok: issues.length === 0, totalDebits, totalCredits, balanced, issues };
}
