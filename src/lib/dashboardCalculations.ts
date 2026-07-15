import type { Account, BusinessEntity } from '@/types';
import type { JournalEntry, JournalLine } from '@/types/journal';
import type {
  ActivityItem,
  AttentionItem,
  CashAndBankSummary,
  CashAccountBalance,
  CashMovementSeries,
  IncomeExpensePoint,
  NetIncomeSummary,
  PayablesSummary,
  ReceivablesSummary,
  ReportingPeriod,
  ReportingPeriodId,
  TopExpenseItem,
} from '@/types/dashboard';
import { validateChart } from '@/lib/validation';
import { getWarnings } from '@/lib/journalValidation';
import { timeAgo, formatDate } from '@/lib/utils';

/* ─────────────────────────────── Currency ───────────────────────────────── */

/**
 * Convert a line amount to the organisation's base currency. Foreign amounts
 * are multiplied by the entry's saved exchange rate. Never sum unconverted
 * amounts across currencies — always route through this helper.
 */
export function convertToBase(
  amount: number,
  currency: string,
  rate: number,
  baseCurrency: string,
): number {
  if (!amount) return 0;
  if (currency.toUpperCase() === baseCurrency.toUpperCase()) return amount;
  return amount * (rate || 1);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ───────────────────────────── Period helpers ───────────────────────────── */

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PERIOD_LABELS: Record<ReportingPeriodId, string> = {
  today: 'Today',
  'this-week': 'This week',
  'this-month': 'This month',
  'this-quarter': 'This quarter',
  'this-year': 'This year',
  'prev-month': 'Previous month',
  'prev-quarter': 'Previous quarter',
  'prev-year': 'Previous year',
  custom: 'Custom range',
};

/** Resolve a named period into concrete inclusive ISO dates. */
export function resolvePeriod(
  id: ReportingPeriodId,
  refDate: Date = new Date(),
  custom?: { from: string; to: string },
): ReportingPeriod {
  const y = refDate.getFullYear();
  const m = refDate.getMonth();
  const label = PERIOD_LABELS[id];
  const make = (from: Date, to: Date): ReportingPeriod => ({ id, label, from: iso(from), to: iso(to) });

  switch (id) {
    case 'today':
      return make(refDate, refDate);
    case 'this-week': {
      const day = (refDate.getDay() + 6) % 7; // Monday = 0
      const start = new Date(y, m, refDate.getDate() - day);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      return make(start, end);
    }
    case 'this-month':
      return make(new Date(y, m, 1), new Date(y, m + 1, 0));
    case 'this-quarter': {
      const q = Math.floor(m / 3);
      return make(new Date(y, q * 3, 1), new Date(y, q * 3 + 3, 0));
    }
    case 'this-year':
      return make(new Date(y, 0, 1), new Date(y, 11, 31));
    case 'prev-month':
      return make(new Date(y, m - 1, 1), new Date(y, m, 0));
    case 'prev-quarter': {
      const q = Math.floor(m / 3) - 1;
      return make(new Date(y, q * 3, 1), new Date(y, q * 3 + 3, 0));
    }
    case 'prev-year':
      return make(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31));
    case 'custom':
      return { id, label, from: custom?.from ?? iso(new Date(y, m, 1)), to: custom?.to ?? iso(refDate) };
    default:
      return make(new Date(y, 0, 1), new Date(y, 11, 31));
  }
}

/** The natural preceding period for comparison, or null when not applicable. */
export function previousPeriodOf(period: ReportingPeriod, refDate: Date = new Date()): ReportingPeriod | null {
  const y = refDate.getFullYear();
  const m = refDate.getMonth();
  switch (period.id) {
    case 'this-month':
      return resolvePeriod('prev-month', refDate);
    case 'this-quarter':
      return resolvePeriod('prev-quarter', refDate);
    case 'this-year':
      return resolvePeriod('prev-year', refDate);
    case 'prev-month':
      return resolvePeriod('this-month', new Date(y, m - 1, 1));
    default:
      return null;
  }
}

/* ─────────────────────── Account classification helpers ──────────────────── */

export function isCashAccount(a: Account): boolean {
  return (
    a.isPostingAccount &&
    a.type === 'ASSET' &&
    a.ifrsSubcategory.toLowerCase().includes('cash and cash equivalents')
  );
}

export function isCashOnHand(a: Account): boolean {
  const n = a.name.toLowerCase();
  return n.includes('cash on hand') || n.includes('petty cash');
}

export function isReceivableAccount(a: Account): boolean {
  const hay = `${a.ifrsSubcategory} ${a.name}`.toLowerCase();
  return a.isPostingAccount && hay.includes('trade receivable') && !hay.includes('allowance');
}

export function isPayableAccount(a: Account): boolean {
  const hay = `${a.ifrsSubcategory} ${a.name}`.toLowerCase();
  return a.isPostingAccount && hay.includes('trade payable');
}

export function isIncomeAccount(a: Account): boolean {
  return a.isPostingAccount && a.type === 'INCOME';
}

export function isExpenseAccount(a: Account): boolean {
  if (!a.isPostingAccount) return false;
  if (a.type === 'COST_OF_SALES' || a.type === 'OPERATING_EXPENSE' || a.type === 'TAX') return true;
  if ((a.type === 'FINANCE' || a.type === 'OTHER_INCOME_EXPENSE') && a.normalBalance === 'DEBIT') return true;
  return false;
}

/* ────────────────────────── Core sign handling ───────────────────────────── */

/** Only posted entries contribute to financial results. */
export function postedEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((e) => e.status === 'posted');
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

/**
 * Signed base-currency movement a line represents for its own account, using
 * the account's normal balance:
 *   debit-normal  → debit − credit
 *   credit-normal → credit − debit
 * This keeps revenue positive and expenses positive in summaries.
 */
export function signedLineAmount(
  account: Account,
  line: Pick<JournalLine, 'debit' | 'credit'>,
  currency: string,
  rate: number,
  baseCurrency: string,
): number {
  const bd = convertToBase(line.debit, currency, rate, baseCurrency);
  const bc = convertToBase(line.credit, currency, rate, baseCurrency);
  return account.normalBalance === 'DEBIT' ? bd - bc : bc - bd;
}

/** Signed posted balance of a single account (point-in-time, all posted). */
export function calculateAccountBalance(
  accountId: string,
  entries: JournalEntry[],
  accountsById: Map<string, Account>,
  baseCurrency: string,
): number {
  const account = accountsById.get(accountId);
  if (!account) return 0;
  let total = 0;
  for (const entry of postedEntries(entries)) {
    for (const line of entry.lines) {
      if (line.accountId === accountId) {
        total += signedLineAmount(account, line, entry.currency, entry.exchangeRate, baseCurrency);
      }
    }
  }
  return round2(total);
}

/** Sum signed line amounts across accounts matching a predicate, over a set of entries. */
function sumSignedByPredicate(
  entries: JournalEntry[],
  accountsById: Map<string, Account>,
  baseCurrency: string,
  predicate: (a: Account) => boolean,
): number {
  let total = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      const account = accountsById.get(line.accountId);
      if (account && predicate(account)) {
        total += signedLineAmount(account, line, entry.currency, entry.exchangeRate, baseCurrency);
      }
    }
  }
  return round2(total);
}

/* ─────────────────────────── Cash & bank (as-of) ─────────────────────────── */

export function calculateCashAndBankBalance(
  entries: JournalEntry[],
  accounts: Account[],
  baseCurrency: string,
): CashAndBankSummary {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const cashAccounts = accounts.filter((a) => a.isActive && isCashAccount(a));
  const posted = postedEntries(entries);

  const rows: CashAccountBalance[] = cashAccounts.map((a) => {
    let last = '';
    for (const entry of posted) {
      if (entry.lines.some((l) => l.accountId === a.id) && entry.entryDate > last) last = entry.entryDate;
    }
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      balance: calculateAccountBalance(a.id, entries, accountsById, baseCurrency),
      lastActivity: last,
    };
  });

  let bank = 0;
  let cashOnHand = 0;
  for (const a of cashAccounts) {
    const row = rows.find((r) => r.accountId === a.id);
    if (!row) continue;
    if (isCashOnHand(a)) cashOnHand += row.balance;
    else bank += row.balance;
  }

  return {
    total: round2(bank + cashOnHand),
    bank: round2(bank),
    cashOnHand: round2(cashOnHand),
    accountCount: cashAccounts.length,
    accounts: rows.sort((a, b) => b.balance - a.balance),
  };
}

/* ────────────────────────── Income / expenses ────────────────────────────── */

export function calculatePeriodIncome(
  entries: JournalEntry[],
  accounts: Account[],
  period: ReportingPeriod,
  baseCurrency: string,
): number {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const scoped = postedEntries(entries).filter((e) => inRange(e.entryDate, period.from, period.to));
  return sumSignedByPredicate(scoped, accountsById, baseCurrency, isIncomeAccount);
}

export function calculatePeriodExpenses(
  entries: JournalEntry[],
  accounts: Account[],
  period: ReportingPeriod,
  baseCurrency: string,
): number {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const scoped = postedEntries(entries).filter((e) => inRange(e.entryDate, period.from, period.to));
  return sumSignedByPredicate(scoped, accountsById, baseCurrency, isExpenseAccount);
}

export function calculateNetIncome(
  entries: JournalEntry[],
  accounts: Account[],
  period: ReportingPeriod,
  baseCurrency: string,
  refDate: Date = new Date(),
): NetIncomeSummary {
  const income = calculatePeriodIncome(entries, accounts, period, baseCurrency);
  const expenses = calculatePeriodExpenses(entries, accounts, period, baseCurrency);
  const net = round2(income - expenses);
  const marginPct = income > 0 ? round2((net / income) * 100) : 0;

  let previousNet: number | null = null;
  const prev = previousPeriodOf(period, refDate);
  if (prev) {
    const scoped = postedEntries(entries).filter((e) => inRange(e.entryDate, prev.from, prev.to));
    if (scoped.length > 0) {
      previousNet = round2(
        calculatePeriodIncome(entries, accounts, prev, baseCurrency) -
          calculatePeriodExpenses(entries, accounts, prev, baseCurrency),
      );
    }
  }

  return { income, expenses, net, marginPct, previousNet };
}

/* ───────────────────────── Receivables / payables ────────────────────────── */

function balancesByEntity(
  entries: JournalEntry[],
  accounts: Account[],
  entities: BusinessEntity[],
  baseCurrency: string,
  predicate: (a: Account) => boolean,
): { total: number; byEntity: Map<string, number> } {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const byEntity = new Map<string, number>();
  let total = 0;
  for (const entry of postedEntries(entries)) {
    for (const line of entry.lines) {
      const account = accountsById.get(line.accountId);
      if (!account || !predicate(account)) continue;
      const amt = signedLineAmount(account, line, entry.currency, entry.exchangeRate, baseCurrency);
      total += amt;
      const key = line.entityId || '__none__';
      byEntity.set(key, (byEntity.get(key) ?? 0) + amt);
    }
  }
  void entities;
  return { total: round2(total), byEntity };
}

export function calculateReceivablesBalance(
  entries: JournalEntry[],
  accounts: Account[],
  entities: BusinessEntity[],
  baseCurrency: string,
): ReceivablesSummary {
  const { total, byEntity } = balancesByEntity(entries, accounts, entities, baseCurrency, isReceivableAccount);
  const entityName = new Map(entities.map((e) => [e.id, e.legalName]));
  const top = [...byEntity.entries()]
    .filter(([id, amt]) => id !== '__none__' && amt > 0.005)
    .map(([id, amount]) => ({ entityId: id, name: entityName.get(id) ?? 'Unknown', amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount);
  return {
    total,
    current: round2(total), // no due-dates yet → treat all as current
    overdue: 0,
    customerCount: top.length,
    agingAvailable: false,
    topBalances: top.slice(0, 5),
  };
}

export function calculatePayablesBalance(
  entries: JournalEntry[],
  accounts: Account[],
  entities: BusinessEntity[],
  baseCurrency: string,
): PayablesSummary {
  const { total, byEntity } = balancesByEntity(entries, accounts, entities, baseCurrency, isPayableAccount);
  const entityName = new Map(entities.map((e) => [e.id, e.legalName]));
  const top = [...byEntity.entries()]
    .filter(([id, amt]) => id !== '__none__' && amt > 0.005)
    .map(([id, amount]) => ({ entityId: id, name: entityName.get(id) ?? 'Unknown', amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount);
  return {
    total,
    current: round2(total),
    overdue: 0,
    supplierCount: top.length,
    agingAvailable: false,
    topBalances: top.slice(0, 5),
  };
}

/* ───────────────────────────── Top expenses ─────────────────────────────── */

export function calculateTopExpenses(
  entries: JournalEntry[],
  accounts: Account[],
  period: ReportingPeriod,
  baseCurrency: string,
  topN = 5,
): TopExpenseItem[] {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const scoped = postedEntries(entries).filter((e) => inRange(e.entryDate, period.from, period.to));
  const byAccount = new Map<string, number>();
  for (const entry of scoped) {
    for (const line of entry.lines) {
      const account = accountsById.get(line.accountId);
      if (!account || !isExpenseAccount(account)) continue;
      const amt = signedLineAmount(account, line, entry.currency, entry.exchangeRate, baseCurrency);
      byAccount.set(line.accountId, (byAccount.get(line.accountId) ?? 0) + amt);
    }
  }
  const ranked = [...byAccount.entries()]
    .map(([accountId, amount]) => ({ accountId, amount: round2(amount) }))
    .filter((r) => r.amount > 0.005)
    .sort((a, b) => b.amount - a.amount);

  const total = round2(ranked.reduce((s, r) => s + r.amount, 0));
  if (total <= 0) return [];

  const top: TopExpenseItem[] = ranked.slice(0, topN).map((r) => {
    const account = accountsById.get(r.accountId);
    return {
      accountId: r.accountId,
      code: account?.code ?? '',
      name: account?.name ?? 'Unknown',
      amount: r.amount,
      pctOfTotal: round2((r.amount / total) * 100),
    };
  });
  const rest = ranked.slice(topN);
  if (rest.length > 0) {
    const otherAmt = round2(rest.reduce((s, r) => s + r.amount, 0));
    top.push({
      accountId: '__other__',
      code: '',
      name: `Other (${rest.length})`,
      amount: otherAmt,
      pctOfTotal: round2((otherAmt / total) * 100),
      isOther: true,
    });
  }
  return top;
}

/* ─────────────────────────── Cash movements ─────────────────────────────── */

function monthBuckets(from: string, to: string): { label: string; from: string; to: string }[] {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const buckets: { label: string; from: string; to: string }[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  let guard = 0;
  while (cur <= end && guard < 60) {
    const bFrom = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const bTo = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    buckets.push({
      label: bFrom.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      from: iso(bFrom < start ? start : bFrom),
      to: iso(bTo > end ? end : bTo),
    });
    cur.setMonth(cur.getMonth() + 1);
    guard += 1;
  }
  return buckets;
}

export function calculateCashMovements(
  entries: JournalEntry[],
  accounts: Account[],
  period: ReportingPeriod,
  baseCurrency: string,
): CashMovementSeries {
  const cashIds = new Set(accounts.filter(isCashAccount).map((a) => a.id));
  const posted = postedEntries(entries);

  // Opening = net cash movement strictly before the period.
  let opening = 0;
  for (const entry of posted) {
    if (entry.entryDate >= period.from) continue;
    for (const line of entry.lines) {
      if (!cashIds.has(line.accountId)) continue;
      opening += convertToBase(line.debit, entry.currency, entry.exchangeRate, baseCurrency);
      opening -= convertToBase(line.credit, entry.currency, entry.exchangeRate, baseCurrency);
    }
  }

  const buckets = monthBuckets(period.from, period.to);
  const points = buckets.map((b) => {
    let inflow = 0;
    let outflow = 0;
    for (const entry of posted) {
      if (!inRange(entry.entryDate, b.from, b.to)) continue;
      for (const line of entry.lines) {
        if (!cashIds.has(line.accountId)) continue;
        inflow += convertToBase(line.debit, entry.currency, entry.exchangeRate, baseCurrency);
        outflow += convertToBase(line.credit, entry.currency, entry.exchangeRate, baseCurrency);
      }
    }
    return { label: b.label, from: b.from, to: b.to, inflow: round2(inflow), outflow: round2(outflow), net: round2(inflow - outflow) };
  });

  const totalInflow = round2(points.reduce((s, p) => s + p.inflow, 0));
  const totalOutflow = round2(points.reduce((s, p) => s + p.outflow, 0));
  return {
    points,
    openingBalance: round2(opening),
    totalInflow,
    totalOutflow,
    closingBalance: round2(opening + totalInflow - totalOutflow),
  };
}

export function calculateIncomeExpenseSeries(
  entries: JournalEntry[],
  accounts: Account[],
  period: ReportingPeriod,
  baseCurrency: string,
): IncomeExpensePoint[] {
  const buckets = monthBuckets(period.from, period.to);
  return buckets.map((b) => {
    const p: ReportingPeriod = { id: 'custom', label: b.label, from: b.from, to: b.to };
    const income = calculatePeriodIncome(entries, accounts, p, baseCurrency);
    const expenses = calculatePeriodExpenses(entries, accounts, p, baseCurrency);
    return { label: b.label, from: b.from, to: b.to, income, expenses, net: round2(income - expenses) };
  });
}

/* ────────────────────────── Activity & attention ─────────────────────────── */

export function getRecentAccountingActivity(
  entries: JournalEntry[],
  entities: BusinessEntity[],
  accounts: Account[],
  limit = 8,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const e of entries) {
    const at = (e.status === 'posted' && e.postedAt) || (e.status === 'void' && e.voidedAt) || e.updatedAt;
    const kind = e.status === 'posted' ? 'posted' : e.status === 'void' ? 'voided' : e.updatedAt !== e.createdAt ? 'edited' : 'created';
    const actor = (e.status === 'posted' && (e.postedBy || e.approvedBy)) || e.updatedBy || e.createdBy || 'System';
    items.push({
      id: `je-${e.id}`,
      kind,
      title: `${e.entryNumber} ${kind === 'posted' ? 'posted' : kind === 'voided' ? 'voided' : kind === 'edited' ? 'edited' : 'created'}`,
      detail: e.description,
      at,
      actor,
      entryId: e.id,
    });
  }
  for (const en of entities) {
    items.push({
      id: `ent-${en.id}`,
      kind: en.entityType === 'supplier' ? 'supplier' : 'customer',
      title: `${en.entityType === 'supplier' ? 'Supplier' : 'Customer'} added`,
      detail: en.legalName,
      at: en.createdAt,
      actor: 'System',
    });
  }
  for (const a of accounts) {
    if (a.updatedAt !== a.createdAt) {
      items.push({
        id: `acc-${a.id}`,
        kind: 'account',
        title: `Account ${a.code} updated`,
        detail: a.name,
        at: a.updatedAt,
        actor: 'System',
      });
    }
  }

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export function getDashboardAttentionItems(
  entries: JournalEntry[],
  accounts: Account[],
  entities: BusinessEntity[],
  staleDays = 14,
  refDate: Date = new Date(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const entitiesById = new Map(entities.map((e) => [e.id, e]));
  const drafts = entries.filter((e) => e.status === 'draft');

  for (const d of drafts) {
    if (Math.abs(d.difference) >= 0.005) {
      items.push({
        id: `unbal-${d.id}`,
        severity: 'error',
        message: `${d.entryNumber} is unbalanced by ${Math.abs(d.difference).toFixed(2)}`,
        record: d.entryNumber,
        action: 'journal',
      });
    }
    const ageDays = (refDate.getTime() - new Date(d.createdAt).getTime()) / 86_400_000;
    if (ageDays > staleDays) {
      items.push({
        id: `stale-${d.id}`,
        severity: 'warning',
        message: `${d.entryNumber} has been a draft for ${Math.round(ageDays)} days`,
        record: d.entryNumber,
        action: 'journal',
      });
    }
    for (const line of d.lines) {
      const account = line.accountId ? accountsById.get(line.accountId) : undefined;
      if (account && !account.isActive) {
        items.push({
          id: `inactive-${d.id}-${line.id}`,
          severity: 'warning',
          message: `${d.entryNumber} uses inactive account ${account.code} — ${account.name}`,
          record: d.entryNumber,
          action: 'journal',
        });
      }
      if (account && (isReceivableAccount(account) || isPayableAccount(account)) && !line.entityId) {
        items.push({
          id: `noentity-${d.id}-${line.id}`,
          severity: 'info',
          message: `${d.entryNumber} posts to ${account.name} without a customer/supplier`,
          record: d.entryNumber,
          action: 'journal',
        });
      }
      if (line.entityId) {
        const ent = entitiesById.get(line.entityId);
        if (ent && !ent.isActive) {
          items.push({
            id: `inactent-${d.id}-${line.id}`,
            severity: 'info',
            message: `${d.entryNumber} references inactive entity ${ent.legalName}`,
            record: d.entryNumber,
            action: 'journal',
          });
        }
      }
    }
  }

  // Chart-of-accounts validation.
  const issues = validateChart(accounts);
  const coaErrors = issues.filter((i) => i.severity === 'error').length;
  const coaWarnings = issues.filter((i) => i.severity === 'warning').length;
  if (coaErrors > 0) {
    items.push({ id: 'coa-err', severity: 'error', message: `${coaErrors} chart of accounts validation error(s)`, record: 'Chart of Accounts', action: 'mapping' });
  }
  if (coaWarnings > 0) {
    items.push({ id: 'coa-warn', severity: 'info', message: `${coaWarnings} chart of accounts warning(s)`, record: 'Chart of Accounts', action: 'mapping' });
  }

  // Unusual normal-balance activity across all entries.
  let unusual = 0;
  for (const e of entries) {
    unusual += getWarnings(e, accountsById, entitiesById).filter((w) => w.rule.startsWith('unusual')).length;
  }
  if (unusual > 0) {
    items.push({ id: 'unusual', severity: 'info', message: `${unusual} line(s) move an account against its normal balance`, record: 'Journal', action: 'journal' });
  }

  const rank: Record<AttentionItem['severity'], number> = { error: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Convenience re-exports for widgets. */
export { timeAgo, formatDate };
