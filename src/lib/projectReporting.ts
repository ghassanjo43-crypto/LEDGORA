import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { Project } from '@/types/project';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { isProfitOrLossAccount, classifyIncomeStatementSection, normalizeIncomeStatementAmount } from '@/lib/incomeStatementCalculations';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Project reporting — ALL actuals derive from posted journal lines tagged with a
 * project id (`line.project`). No separate balances. Projects are a flat
 * dimension (no descendant aggregation).
 */

export interface ProjectReportOptions {
  from?: string;
  to?: string;
  base: string;
}

interface AccountActual { accountId: string; accountCode: string; accountName: string; debit: number; credit: number; }

function actuals(entries: JournalEntry[], accountsById: Map<string, Account>, projectId: string, opts: ProjectReportOptions): Map<string, AccountActual> {
  const map = new Map<string, AccountActual>();
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.project !== projectId) continue;
    if (opts.from && entry.entryDate < opts.from) continue;
    if (opts.to && entry.entryDate > opts.to) continue;
    const acc = accountsById.get(line.accountId);
    if (!acc) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, opts.base);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, opts.base);
    const existing = map.get(line.accountId);
    if (existing) { existing.debit = roundMoney(existing.debit + debit); existing.credit = roundMoney(existing.credit + credit); }
    else map.set(line.accountId, { accountId: line.accountId, accountCode: acc.code, accountName: acc.name, debit: roundMoney(debit), credit: roundMoney(credit) });
  }
  return map;
}

/* ─────────────────────────── Income statement ────────────────────────────── */

export interface ProjectIncomeStatement {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingProfit: number;
  netResult: number;
}

/** Income statement by project from posted P&L lines, base currency. */
export function buildProjectIncomeStatement(entries: JournalEntry[], accounts: Account[], projectId: string, opts: ProjectReportOptions): ProjectIncomeStatement {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const bySection = new Map<string, number>();
  for (const a of actuals(entries, accountsById, projectId, opts).values()) {
    const acc = accountsById.get(a.accountId)!;
    if (!isProfitOrLossAccount(acc)) continue;
    const section = classifyIncomeStatementSection(acc);
    const amount = normalizeIncomeStatementAmount(roundMoney(a.debit - a.credit), section);
    bySection.set(section, roundMoney((bySection.get(section) ?? 0) + amount));
  }
  const g = (s: string) => bySection.get(s) ?? 0;
  const revenue = g('revenue');
  const costOfSales = g('costOfSales');
  const grossProfit = roundMoney(revenue - costOfSales);
  const operatingExpenses = g('operatingExpenses');
  const operatingProfit = roundMoney(grossProfit - operatingExpenses);
  const other = roundMoney(g('otherIncome') - g('otherExpenses') + g('financeIncome') - g('financeCosts') - g('incomeTax'));
  return { revenue, costOfSales, grossProfit, operatingExpenses, operatingProfit, netResult: roundMoney(operatingProfit + other) };
}

/* ────────────────────────────── Ledger ───────────────────────────────────── */

export interface ProjectLedgerLine {
  id: string;
  date: string;
  journalNumber: string;
  accountCode: string;
  accountName: string;
  description: string;
  debit: number;
  credit: number;
  costCenterId?: string;
  journalEntryId: string;
}

/** General ledger by project, chronological, drill-down ready. */
export function buildProjectLedger(entries: JournalEntry[], accounts: Account[], projectId: string, opts: ProjectReportOptions): ProjectLedgerLine[] {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const out: ProjectLedgerLine[] = [];
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.project !== projectId) continue;
    if (opts.from && entry.entryDate < opts.from) continue;
    if (opts.to && entry.entryDate > opts.to) continue;
    const acc = accountsById.get(line.accountId);
    out.push({
      id: `${entry.id}:${line.id}`, date: entry.entryDate, journalNumber: entry.entryNumber,
      accountCode: acc?.code ?? line.accountCode, accountName: acc?.name ?? line.accountName, description: line.description || entry.description,
      debit: convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, opts.base),
      credit: convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, opts.base),
      costCenterId: line.costCenter || undefined, journalEntryId: entry.id,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.journalNumber.localeCompare(b.journalNumber));
}

/* ────────────────────────────── Summary ──────────────────────────────────── */

export interface ProjectSummaryRow {
  projectId: string;
  code: string;
  name: string;
  status: Project['status'];
  revenue: number;
  cost: number;
  margin: number;
  marginPercent: number | null;
  budget: number;
  budgetVariance: number;
}

/** Revenue / cost / margin per project across all posted activity, vs budget. */
export function buildProjectSummary(entries: JournalEntry[], accounts: Account[], projects: Project[], opts: ProjectReportOptions): ProjectSummaryRow[] {
  return projects.map((p) => {
    const is = buildProjectIncomeStatement(entries, accounts, p.id, opts);
    const cost = roundMoney(is.costOfSales + is.operatingExpenses);
    const margin = roundMoney(is.revenue - cost);
    const budget = roundMoney(p.budgetAmount ?? 0);
    return {
      projectId: p.id, code: p.code, name: p.name, status: p.status,
      revenue: is.revenue, cost, margin,
      marginPercent: is.revenue === 0 ? null : roundMoney((margin / is.revenue) * 100),
      budget, budgetVariance: roundMoney(cost - budget),
    };
  });
}
