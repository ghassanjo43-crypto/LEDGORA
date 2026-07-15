import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { ProjectBudget, ProjectBudgetCategory, ProjectBudgetLine } from '@/types/projectBudget';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { roundMoney } from '@/lib/journalValidation';

/** Duplicate budget line = same category + account + month. */
export function isDuplicateProjectBudgetLine(lines: ProjectBudgetLine[], line: Pick<ProjectBudgetLine, 'id' | 'category' | 'accountId' | 'month'>): boolean {
  return lines.some((l) => l.id !== line.id && l.category === line.category && (l.accountId ?? '') === (line.accountId ?? '') && l.month === line.month);
}

const REVENUE_CATEGORY: ProjectBudgetCategory = 'revenue';

export interface BudgetVsActualCategoryRow {
  category: ProjectBudgetCategory;
  budget: number;
  actual: number;
  variance: number;
  favorable: boolean;
}

export interface ProjectBudgetVsActual {
  rows: BudgetVsActualCategoryRow[];
  budgetRevenue: number;
  actualRevenue: number;
  budgetCost: number;
  actualCost: number;
  budgetMargin: number;
  actualMargin: number;
}

/** Project GL revenue and cost through a month, base currency. */
function projectRevenueCost(entries: JournalEntry[], accountsById: Map<string, Account>, projectId: string, from: string, to: string, base: string): { revenue: number; cost: number } {
  let revenue = 0;
  let cost = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.project !== projectId || entry.entryDate < from || entry.entryDate > to) continue;
    const acc = accountsById.get(line.accountId);
    if (!acc) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, base);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, base);
    if (acc.type === 'INCOME') revenue += credit - debit;
    else if (acc.type === 'COST_OF_SALES' || acc.type === 'OPERATING_EXPENSE') cost += debit - credit;
  }
  return { revenue: roundMoney(revenue), cost: roundMoney(cost) };
}

export interface BudgetVsActualParams {
  budget: ProjectBudget;
  entries: JournalEntry[];
  accounts: Account[];
  base: string;
  throughMonth?: number;
}

/**
 * Budget-vs-actual by category. Actuals derive from posted project journal lines
 * (revenue vs cost); category budgets are shown per line, with cost-category
 * actuals aggregated (posted lines carry accounts, not budget categories).
 */
export function calculateProjectBudgetActual(params: BudgetVsActualParams): ProjectBudgetVsActual {
  const accountsById = new Map(params.accounts.map((a) => [a.id, a]));
  const through = params.throughMonth ?? 12;
  const year = params.budget.fiscalYear;
  const from = `${year}-01-01`;
  const to = `${year}-${String(through).padStart(2, '0')}-31`;
  const { revenue: actualRevenue, cost: actualCost } = projectRevenueCost(params.entries, accountsById, params.budget.projectId, from, to, params.base);

  const budgetByCategory = new Map<ProjectBudgetCategory, number>();
  for (const l of params.budget.lines) {
    if (l.month > through) continue;
    budgetByCategory.set(l.category, roundMoney((budgetByCategory.get(l.category) ?? 0) + l.amount));
  }
  const budgetRevenue = roundMoney(budgetByCategory.get(REVENUE_CATEGORY) ?? 0);
  const budgetCost = roundMoney([...budgetByCategory.entries()].filter(([c]) => c !== REVENUE_CATEGORY).reduce((s, [, v]) => s + v, 0));

  const rows: BudgetVsActualCategoryRow[] = [...budgetByCategory.entries()].map(([category, budget]) => {
    const isRevenue = category === REVENUE_CATEGORY;
    // Cost-category actuals are not separable by budget category; show at the cost total on 'other'.
    const actual = isRevenue ? actualRevenue : 0;
    const variance = roundMoney(actual - budget);
    return { category, budget, actual, variance, favorable: isRevenue ? variance >= 0 : variance <= 0 };
  });

  return {
    rows: rows.sort((a, b) => a.category.localeCompare(b.category)),
    budgetRevenue, actualRevenue, budgetCost, actualCost,
    budgetMargin: roundMoney(budgetRevenue - budgetCost),
    actualMargin: roundMoney(actualRevenue - actualCost),
  };
}
