import type { Account, AccountType } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type {
  TrialBalanceException,
  TrialBalanceFilters,
  TrialBalanceGroup,
  TrialBalancePeriod,
  TrialBalanceReconciliation,
  TrialBalanceRow,
  TrialBalanceTotals,
} from '@/types/trialBalance';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';

export const BALANCE_TOLERANCE = 0.01;

/** Re-exported so the Trial Balance shares the ledger's currency helper. */
export const convertLineToBaseCurrency = convertToBaseCurrency;
export { getPostedJournalLines };

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ─────────────────────────── Per-account figures ─────────────────────────── */

/** Net (base debits − base credits) of posted lines strictly BEFORE `from`. */
export function calculateAccountOpeningNet(accountId: string, entries: JournalEntry[], from: string, base: string): number {
  let net = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.accountId !== accountId || entry.entryDate >= from) continue;
    net += convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    net -= convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
  }
  return round2(net);
}

/** Base debit/credit movement of posted lines WITHIN the period. */
export function calculateAccountPeriodMovement(accountId: string, entries: JournalEntry[], period: TrialBalancePeriod, base: string): { periodDebits: number; periodCredits: number } {
  let periodDebits = 0;
  let periodCredits = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.accountId !== accountId) continue;
    if (entry.entryDate < period.from || entry.entryDate > period.to) continue;
    periodDebits += convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    periodCredits += convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
  }
  return { periodDebits: round2(periodDebits), periodCredits: round2(periodCredits) };
}

export function calculateAccountClosingNet(openingNet: number, periodDebits: number, periodCredits: number): number {
  return round2(openingNet + periodDebits - periodCredits);
}

/** Split a signed net into debit/credit columns by its actual sign. */
export function splitNetIntoDebitCredit(net: number): { debit: number; credit: number } {
  if (Math.abs(net) < 0.005) return { debit: 0, credit: 0 };
  return net > 0 ? { debit: round2(net), credit: 0 } : { debit: 0, credit: round2(-net) };
}

/** Abnormal = closing balance on the opposite side of the account's normal balance. */
export function detectAbnormalBalance(account: Pick<Account, 'normalBalance'>, closingNet: number): { abnormal: boolean; side: '' | 'debit' | 'credit' } {
  if (Math.abs(closingNet) < 0.005) return { abnormal: false, side: '' };
  const side: 'debit' | 'credit' = closingNet > 0 ? 'debit' : 'credit';
  const normalSide = account.normalBalance === 'DEBIT' ? 'debit' : 'credit';
  return { abnormal: side !== normalSide, side };
}

/* ─────────────────────────── Build rows (one pass) ───────────────────────── */

export function buildTrialBalanceRows(accounts: Account[], entries: JournalEntry[], period: TrialBalancePeriod, base: string): TrialBalanceRow[] {
  const agg = new Map<string, { openingNet: number; periodDebits: number; periodCredits: number }>();
  for (const { entry, line } of getPostedJournalLines(entries)) {
    const bd = convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    const bc = convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
    const rec = agg.get(line.accountId) ?? { openingNet: 0, periodDebits: 0, periodCredits: 0 };
    if (entry.entryDate < period.from) rec.openingNet += bd - bc;
    else if (entry.entryDate <= period.to) {
      rec.periodDebits += bd;
      rec.periodCredits += bc;
    }
    agg.set(line.accountId, rec);
  }

  return accounts
    .filter((a) => a.isPostingAccount)
    .map((a) => {
      const rec = agg.get(a.id) ?? { openingNet: 0, periodDebits: 0, periodCredits: 0 };
      const openingNet = round2(rec.openingNet);
      const periodDebits = round2(rec.periodDebits);
      const periodCredits = round2(rec.periodCredits);
      const closingNet = calculateAccountClosingNet(openingNet, periodDebits, periodCredits);
      const opening = splitNetIntoDebitCredit(openingNet);
      const closing = splitNetIntoDebitCredit(closingNet);
      const ab = detectAbnormalBalance(a, closingNet);
      return {
        accountId: a.id,
        accountCode: a.code,
        accountName: a.name,
        accountType: a.type,
        ifrsCategory: a.ifrsCategory,
        parentId: a.parentId,
        isActive: a.isActive,
        normalBalance: a.normalBalance === 'DEBIT' ? 'debit' : 'credit',
        openingDebit: opening.debit,
        openingCredit: opening.credit,
        periodDebits,
        periodCredits,
        closingDebit: closing.debit,
        closingCredit: closing.credit,
        hadPeriodActivity: periodDebits > 0.005 || periodCredits > 0.005,
        isAbnormalBalance: ab.abnormal,
        abnormalSide: ab.side,
      } satisfies TrialBalanceRow;
    });
}

/* ─────────────────────────────── Filtering ──────────────────────────────── */

export function filterTrialBalanceRows(rows: TrialBalanceRow[], f: TrialBalanceFilters): TrialBalanceRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.active === 'active' && !r.isActive) return false;
    if (f.active === 'inactive' && r.isActive) return false;
    if (f.type !== 'ALL' && r.accountType !== f.type) return false;
    if (!f.includeZero) {
      const empty = r.openingDebit === 0 && r.openingCredit === 0 && !r.hadPeriodActivity && r.closingDebit === 0 && r.closingCredit === 0;
      if (empty) return false;
    }
    if (q) {
      const hay = `${r.accountCode} ${r.accountName} ${r.accountType} ${r.ifrsCategory}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ─────────────────────────────── Grouping ───────────────────────────────── */

const GROUP_OF: Record<AccountType, { id: string; label: string; order: number }> = {
  ASSET: { id: 'assets', label: 'Assets', order: 1 },
  LIABILITY: { id: 'liabilities', label: 'Liabilities', order: 2 },
  EQUITY: { id: 'equity', label: 'Equity', order: 3 },
  INCOME: { id: 'income', label: 'Income', order: 4 },
  COST_OF_SALES: { id: 'cost-of-sales', label: 'Cost of Sales', order: 5 },
  OPERATING_EXPENSE: { id: 'operating-expenses', label: 'Operating Expenses', order: 6 },
  OTHER_INCOME_EXPENSE: { id: 'other', label: 'Other Income and Expenses', order: 7 },
  FINANCE: { id: 'other', label: 'Other Income and Expenses', order: 7 },
  DISCONTINUED_OPERATIONS: { id: 'other', label: 'Other Income and Expenses', order: 7 },
  TAX: { id: 'taxation', label: 'Taxation', order: 8 },
  OCI: { id: 'oci', label: 'Other Comprehensive Income', order: 9 },
  CONTROL: { id: 'control', label: 'Control Accounts', order: 10 },
};

export function calculateGroupSubtotals(rows: TrialBalanceRow[]): TrialBalanceTotals {
  return calculateTrialBalanceTotals(rows);
}

/** Group filtered POSTING rows into account families with subtotals (no double count). */
export function groupTrialBalanceRows(rows: TrialBalanceRow[]): TrialBalanceGroup[] {
  const map = new Map<string, TrialBalanceRow[]>();
  for (const r of rows) {
    const g = GROUP_OF[r.accountType];
    map.set(g.id, [...(map.get(g.id) ?? []), r]);
  }
  return [...map.entries()]
    .map(([id, groupRows]) => {
      const meta = Object.values(GROUP_OF).find((g) => g.id === id)!;
      const sorted = [...groupRows].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
      return { id, label: meta.label, order: meta.order, rows: sorted, subtotals: calculateGroupSubtotals(sorted) };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...g }) => g);
}

/* ─────────────────────────────── Totals ─────────────────────────────────── */

export function calculateTrialBalanceTotals(rows: TrialBalanceRow[]): TrialBalanceTotals {
  const t = rows.reduce(
    (acc, r) => {
      acc.openingDebit += r.openingDebit;
      acc.openingCredit += r.openingCredit;
      acc.periodDebits += r.periodDebits;
      acc.periodCredits += r.periodCredits;
      acc.closingDebit += r.closingDebit;
      acc.closingCredit += r.closingCredit;
      return acc;
    },
    { openingDebit: 0, openingCredit: 0, periodDebits: 0, periodCredits: 0, closingDebit: 0, closingCredit: 0 },
  );
  const openingDebit = round2(t.openingDebit);
  const openingCredit = round2(t.openingCredit);
  const periodDebits = round2(t.periodDebits);
  const periodCredits = round2(t.periodCredits);
  const closingDebit = round2(t.closingDebit);
  const closingCredit = round2(t.closingCredit);
  return {
    openingDebit,
    openingCredit,
    openingDifference: round2(openingDebit - openingCredit),
    periodDebits,
    periodCredits,
    periodDifference: round2(periodDebits - periodCredits),
    closingDebit,
    closingCredit,
    closingDifference: round2(closingDebit - closingCredit),
  };
}

export function isTrialBalanceBalanced(totals: TrialBalanceTotals, tolerance = BALANCE_TOLERANCE): boolean {
  return Math.abs(totals.closingDifference) < tolerance;
}

export function trialBalanceReconciliation(rows: TrialBalanceRow[], tolerance = BALANCE_TOLERANCE): TrialBalanceReconciliation {
  const t = calculateTrialBalanceTotals(rows);
  return { balanced: Math.abs(t.closingDifference) < tolerance, totalDebit: t.closingDebit, totalCredit: t.closingCredit, difference: t.closingDifference };
}

/* ─────────────────────────────── Exceptions ─────────────────────────────── */

/** Diagnostics: abnormal balances, imbalance, orphaned accounts, missing FX rates. */
export function buildTrialBalanceExceptions(rows: TrialBalanceRow[], entries: JournalEntry[], accounts: Account[], base: string): TrialBalanceException[] {
  const issues: TrialBalanceException[] = [];
  const totals = calculateTrialBalanceTotals(rows);
  if (Math.abs(totals.closingDifference) >= BALANCE_TOLERANCE) {
    issues.push({ id: 'imbalance', severity: 'error', message: `Trial Balance is out of balance by ${Math.abs(totals.closingDifference).toFixed(2)}.`, reference: 'Totals', action: 'journal' });
  }
  for (const r of rows) {
    if (r.isAbnormalBalance) {
      issues.push({ id: `abn-${r.accountId}`, severity: 'warning', message: `${r.accountCode} — ${r.accountName} has an abnormal ${r.abnormalSide} balance.`, reference: r.accountCode, action: 'general-ledger' });
    }
  }
  const accountIds = new Set(accounts.map((a) => a.id));
  const postingIds = new Set(accounts.filter((a) => a.isPostingAccount).map((a) => a.id));
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (!accountIds.has(line.accountId)) {
      issues.push({ id: `orphan-${entry.id}-${line.id}`, severity: 'error', message: `${entry.entryNumber} posts to a missing account (${line.accountCode || line.accountId}).`, reference: entry.entryNumber, action: 'journal' });
    } else if (!postingIds.has(line.accountId)) {
      issues.push({ id: `header-${entry.id}-${line.id}`, severity: 'error', message: `${entry.entryNumber} posts to a non-posting header account (${line.accountCode}).`, reference: entry.entryNumber, action: 'journal' });
    }
    if (entry.currency !== base && (!entry.exchangeRate || entry.exchangeRate <= 0)) {
      issues.push({ id: `fx-${entry.id}-${line.id}`, severity: 'warning', message: `${entry.entryNumber} has a ${entry.currency} line with no exchange rate.`, reference: entry.entryNumber, action: 'journal' });
    }
  }
  const rank: Record<TrialBalanceException['severity'], number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Development-only reconciliation: global posted base debits == base credits,
 * and total closing debits == total closing credits.
 */
export function reconcileTrialBalance(accounts: Account[], entries: JournalEntry[], period: TrialBalancePeriod, base: string, tolerance = BALANCE_TOLERANCE): { ok: boolean; globalBalanced: boolean; closingBalanced: boolean; issues: string[] } {
  let gd = 0;
  let gc = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    gd += convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    gc += convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
  }
  const globalBalanced = Math.abs(round2(gd) - round2(gc)) < tolerance;
  const totals = calculateTrialBalanceTotals(buildTrialBalanceRows(accounts, entries, period, base));
  const closingBalanced = Math.abs(totals.closingDifference) < tolerance;
  const issues: string[] = [];
  if (!globalBalanced) issues.push(`Global posted debits ${round2(gd)} ≠ credits ${round2(gc)}.`);
  if (!closingBalanced) issues.push(`Closing debits ${totals.closingDebit} ≠ credits ${totals.closingCredit}.`);
  return { ok: issues.length === 0, globalBalanced, closingBalanced, issues };
}
