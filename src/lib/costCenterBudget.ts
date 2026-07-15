import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { CostCenterBudget, CostCenterBudgetLine } from '@/types/costCenterBudget';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { isProfitOrLossAccount, classifyIncomeStatementSection, normalizeIncomeStatementAmount } from '@/lib/incomeStatementCalculations';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Cost-center budgets vs posted actuals (§36). Budgets are management data (never
 * posted). Variance = Actual − Budget, interpreted favorable/unfavorable by
 * account type (an expense over budget is unfavorable; revenue over budget is
 * favorable).
 */

/** Duplicate budget line = same cost center + account + month. */
export function isDuplicateBudgetLine(lines: CostCenterBudgetLine[], line: Pick<CostCenterBudgetLine, 'id' | 'costCenterId' | 'accountId' | 'month'>): boolean {
  return lines.some((l) => l.id !== line.id && l.costCenterId === line.costCenterId && l.accountId === line.accountId && l.month === line.month);
}

export interface BudgetActualRow {
  costCenterId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  favorable: boolean;
  isRevenue: boolean;
}

export interface BudgetVsActual {
  rows: BudgetActualRow[];
  totalBudget: number;
  totalActual: number;
  totalVariance: number;
}

export interface BudgetVsActualParams {
  budget: CostCenterBudget;
  entries: JournalEntry[];
  accounts: Account[];
  base: string;
  /** Inclusive last month for YTD (1–12). Defaults to 12 (full year). */
  throughMonth?: number;
}

/** Normalised actual (expense positive, revenue positive) per cost center + account for the fiscal year up to `throughMonth`. */
function actualsByCcAccount(params: BudgetVsActualParams, accountsById: Map<string, Account>): Map<string, number> {
  const year = params.budget.fiscalYear;
  const through = params.throughMonth ?? 12;
  const from = `${year}-01-01`;
  const to = `${year}-${String(through).padStart(2, '0')}-31`;
  const map = new Map<string, number>();
  for (const { entry, line } of getPostedJournalLines(params.entries)) {
    if (!line.costCenter) continue;
    if (entry.entryDate < from || entry.entryDate > to) continue;
    const acc = accountsById.get(line.accountId);
    if (!acc || !isProfitOrLossAccount(acc)) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, params.base);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, params.base);
    const section = classifyIncomeStatementSection(acc);
    const amount = normalizeIncomeStatementAmount(roundMoney(debit - credit), section);
    const key = `${line.costCenter}|${line.accountId}`;
    map.set(key, roundMoney((map.get(key) ?? 0) + amount));
  }
  return map;
}

/** Build the budget-vs-actual report for a budget through a given month. */
export function calculateCostCenterBudgetActual(params: BudgetVsActualParams): BudgetVsActual {
  const accountsById = new Map(params.accounts.map((a) => [a.id, a]));
  const through = params.throughMonth ?? 12;
  const actuals = actualsByCcAccount(params, accountsById);

  // Budget YTD by cost center + account (sum of months ≤ throughMonth).
  const budgetMap = new Map<string, number>();
  for (const l of params.budget.lines) {
    if (l.month > through) continue;
    const key = `${l.costCenterId}|${l.accountId}`;
    budgetMap.set(key, roundMoney((budgetMap.get(key) ?? 0) + l.amount));
  }

  const keys = new Set([...budgetMap.keys(), ...actuals.keys()]);
  const rows: BudgetActualRow[] = [];
  for (const key of keys) {
    const [costCenterId, accountId] = key.split('|');
    const acc = accountsById.get(accountId!);
    if (!acc) continue;
    const isRevenue = classifyIncomeStatementSection(acc) === 'revenue' || acc.type === 'INCOME';
    const budget = roundMoney(budgetMap.get(key) ?? 0);
    const actual = roundMoney(actuals.get(key) ?? 0);
    const variance = roundMoney(actual - budget);
    // Expense: favorable when actual < budget; Revenue: favorable when actual > budget.
    const favorable = isRevenue ? variance >= 0 : variance <= 0;
    rows.push({
      costCenterId: costCenterId!, accountId: accountId!, accountCode: acc.code, accountName: acc.name,
      budget, actual, variance, variancePercent: budget === 0 ? null : roundMoney((variance / Math.abs(budget)) * 100), favorable, isRevenue,
    });
  }
  rows.sort((a, b) => a.costCenterId.localeCompare(b.costCenterId) || a.accountCode.localeCompare(b.accountCode));
  return {
    rows,
    totalBudget: roundMoney(rows.reduce((s, r) => s + r.budget, 0)),
    totalActual: roundMoney(rows.reduce((s, r) => s + r.actual, 0)),
    totalVariance: roundMoney(rows.reduce((s, r) => s + r.variance, 0)),
  };
}
