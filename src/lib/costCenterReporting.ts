import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { CostCenter } from '@/types/costCenter';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { isProfitOrLossAccount, classifyIncomeStatementSection, normalizeIncomeStatementAmount } from '@/lib/incomeStatementCalculations';
import { getCostCenterDescendants } from '@/lib/costCenterHierarchy';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Cost-center reporting — ALL actuals derive from posted journal lines tagged
 * with a cost-center id (`line.costCenter`). No separate balances. Parent nodes
 * aggregate descendants; posting to a summary node is disallowed so there is no
 * parent/child double counting.
 */

/** The set of cost-center ids to include for a report scope (self + descendants). */
export function costCenterScope(centers: CostCenter[], costCenterId: string, includeDescendants: boolean): Set<string> {
  const ids = new Set<string>([costCenterId]);
  if (includeDescendants) for (const d of getCostCenterDescendants(centers, costCenterId)) ids.add(d);
  return ids;
}

/** Report hierarchy basis: the current tree, or each line's frozen posting-time path. */
export type HierarchyBasis = 'current' | 'historical';

interface CcLine {
  costCenter: string;
  costCenterSnapshot?: { hierarchyPath: string[] };
}

/**
 * Build a line matcher for a target cost center. `current` uses today's tree;
 * `historical` uses each posted line's frozen hierarchy path, so a later rename or
 * move never changes how the historical document rolls up.
 */
export function buildCostCenterMatcher(centers: CostCenter[], targetId: string, includeDescendants: boolean, basis: HierarchyBasis): (line: CcLine) => boolean {
  if (basis === 'historical') {
    return (line) => {
      if (!line.costCenter) return false;
      if (line.costCenter === targetId) return true;
      if (!includeDescendants) return false;
      return !!line.costCenterSnapshot?.hierarchyPath?.includes(targetId);
    };
  }
  const scope = costCenterScope(centers, targetId, includeDescendants);
  return (line) => !!line.costCenter && scope.has(line.costCenter);
}

export interface CostCenterReportFilters {
  costCenterIds?: Set<string>;
  /** Alternative to costCenterIds: an explicit line matcher (used for historical basis). */
  match?: (line: CcLine) => boolean;
  from?: string;
  to?: string;
  base: string;
}

interface AccountActual {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

/** Per-account posted debit/credit (base) for lines tagged with the scoped cost centers. */
export function costCenterActuals(entries: JournalEntry[], accountsById: Map<string, Account>, f: CostCenterReportFilters): Map<string, AccountActual> {
  const map = new Map<string, AccountActual>();
  const inScope = f.match ?? (f.costCenterIds ? (line: CcLine) => !!line.costCenter && f.costCenterIds!.has(line.costCenter) : () => true);
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (!inScope(line)) continue;
    if (f.from && entry.entryDate < f.from) continue;
    if (f.to && entry.entryDate > f.to) continue;
    const acc = accountsById.get(line.accountId);
    if (!acc) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, f.base);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, f.base);
    const existing = map.get(line.accountId);
    if (existing) { existing.debit = roundMoney(existing.debit + debit); existing.credit = roundMoney(existing.credit + credit); }
    else map.set(line.accountId, { accountId: line.accountId, accountCode: acc.code, accountName: acc.name, debit: roundMoney(debit), credit: roundMoney(credit) });
  }
  return map;
}

/* ─────────────────────────── Trial Balance ───────────────────────────────── */

export interface CostCenterTrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface CostCenterTrialBalance {
  rows: CostCenterTrialBalanceRow[];
  totalPeriodDebit: number;
  totalPeriodCredit: number;
  balanced: boolean;
}

/** Trial balance by cost center (§38): opening (before `from`), period, closing. */
export function buildCostCenterTrialBalance(entries: JournalEntry[], accounts: Account[], centers: CostCenter[], costCenterId: string, opts: { from: string; to: string; base: string; includeDescendants?: boolean; includeZero?: boolean; basis?: HierarchyBasis }): CostCenterTrialBalance {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const match = buildCostCenterMatcher(centers, costCenterId, opts.includeDescendants ?? true, opts.basis ?? 'current');
  const opening = costCenterActuals(entries, accountsById, { match, to: dayBefore(opts.from), base: opts.base });
  const period = costCenterActuals(entries, accountsById, { match, from: opts.from, to: opts.to, base: opts.base });
  const closing = costCenterActuals(entries, accountsById, { match, to: opts.to, base: opts.base });

  const accountIds = new Set([...opening.keys(), ...period.keys(), ...closing.keys()]);
  const rows: CostCenterTrialBalanceRow[] = [];
  for (const id of accountIds) {
    const acc = accountsById.get(id)!;
    const o = opening.get(id);
    const p = period.get(id);
    const c = closing.get(id);
    const openNet = roundMoney((o?.debit ?? 0) - (o?.credit ?? 0));
    const closeNet = roundMoney((c?.debit ?? 0) - (c?.credit ?? 0));
    const row: CostCenterTrialBalanceRow = {
      accountId: id, accountCode: acc.code, accountName: acc.name,
      openingDebit: openNet > 0 ? openNet : 0, openingCredit: openNet < 0 ? -openNet : 0,
      periodDebit: p?.debit ?? 0, periodCredit: p?.credit ?? 0,
      closingDebit: closeNet > 0 ? closeNet : 0, closingCredit: closeNet < 0 ? -closeNet : 0,
    };
    if ((opts.includeZero ?? false) || row.periodDebit || row.periodCredit || row.closingDebit || row.closingCredit) rows.push(row);
  }
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  const totalPeriodDebit = roundMoney(rows.reduce((s, r) => s + r.periodDebit, 0));
  const totalPeriodCredit = roundMoney(rows.reduce((s, r) => s + r.periodCredit, 0));
  return { rows, totalPeriodDebit, totalPeriodCredit, balanced: Math.abs(totalPeriodDebit - totalPeriodCredit) < 0.01 };
}

/* ───────────────────────────── Ledger ────────────────────────────────────── */

export interface CostCenterLedgerLine {
  id: string;
  date: string;
  journalNumber: string;
  reference: string;
  accountCode: string;
  accountName: string;
  description: string;
  debit: number;
  credit: number;
  costCenterId: string;
  project?: string;
  entityName?: string;
  journalEntryId: string;
}

/** General ledger by cost center (§39), chronological, drill-down ready. */
export function buildCostCenterLedger(entries: JournalEntry[], accounts: Account[], centers: CostCenter[], costCenterId: string, opts: { from?: string; to?: string; base: string; includeDescendants?: boolean; basis?: HierarchyBasis }): CostCenterLedgerLine[] {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const match = buildCostCenterMatcher(centers, costCenterId, opts.includeDescendants ?? true, opts.basis ?? 'current');
  const out: CostCenterLedgerLine[] = [];
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (!match(line)) continue;
    if (opts.from && entry.entryDate < opts.from) continue;
    if (opts.to && entry.entryDate > opts.to) continue;
    const acc = accountsById.get(line.accountId);
    out.push({
      id: `${entry.id}:${line.id}`, date: entry.entryDate, journalNumber: entry.entryNumber, reference: entry.reference,
      accountCode: acc?.code ?? line.accountCode, accountName: acc?.name ?? line.accountName, description: line.description || entry.description,
      debit: convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, opts.base),
      credit: convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, opts.base),
      costCenterId: line.costCenter, project: line.project || undefined, entityName: line.entityName || undefined, journalEntryId: entry.id,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.journalNumber.localeCompare(b.journalNumber));
}

/* ─────────────────────────── Income Statement ────────────────────────────── */

export interface CostCenterIncomeStatement {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingProfit: number;
  otherNet: number;
  netResult: number;
  bySection: { section: string; amount: number }[];
}

/** Income statement by cost center (§37) from posted P&L lines, base currency. */
export function buildCostCenterIncomeStatement(entries: JournalEntry[], accounts: Account[], centers: CostCenter[], costCenterId: string, opts: { from: string; to: string; base: string; includeDescendants?: boolean; basis?: HierarchyBasis }): CostCenterIncomeStatement {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const match = buildCostCenterMatcher(centers, costCenterId, opts.includeDescendants ?? true, opts.basis ?? 'current');
  const actuals = costCenterActuals(entries, accountsById, { match, from: opts.from, to: opts.to, base: opts.base });

  const sectionTotals = new Map<string, number>();
  for (const a of actuals.values()) {
    const acc = accountsById.get(a.accountId)!;
    if (!isProfitOrLossAccount(acc)) continue;
    const section = classifyIncomeStatementSection(acc);
    const net = roundMoney(a.debit - a.credit);
    const amount = normalizeIncomeStatementAmount(net, section);
    sectionTotals.set(section, roundMoney((sectionTotals.get(section) ?? 0) + amount));
  }
  const g = (s: string) => sectionTotals.get(s) ?? 0;
  const revenue = g('revenue');
  const costOfSales = g('costOfSales');
  const grossProfit = roundMoney(revenue - costOfSales);
  const operatingExpenses = g('operatingExpenses');
  const operatingProfit = roundMoney(grossProfit - operatingExpenses);
  const otherNet = roundMoney(g('otherIncome') - g('otherExpenses') + g('financeIncome') - g('financeCosts') - g('incomeTax'));
  return {
    revenue, costOfSales, grossProfit, operatingExpenses, operatingProfit, otherNet,
    netResult: roundMoney(operatingProfit + otherNet),
    bySection: [...sectionTotals.entries()].map(([section, amount]) => ({ section, amount })),
  };
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
