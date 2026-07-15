import type { Account, ProfitOrLossCategory } from '@/types';

export type PresentationMode = 'IAS1' | 'IFRS18';
export type DetailLevel = 'summary' | 'standard' | 'detailed';
export type ComparisonMode =
  | 'none'
  | 'previous-period'
  | 'previous-month'
  | 'previous-quarter'
  | 'previous-year'
  | 'previous-ytd';
export type NegativeFormat = 'parentheses' | 'minus';

export interface StatementPeriod {
  from: string;
  to: string;
}

/** Which profit-or-loss section an account belongs to (IAS 1 view). */
export type IncomeStatementSection =
  | 'revenue'
  | 'costOfSales'
  | 'operatingExpenses'
  | 'otherIncome'
  | 'otherExpenses'
  | 'financeIncome'
  | 'financeCosts'
  | 'incomeTax'
  | 'discontinued';

/** Per-account, period-only figures already converted to the base currency. */
export interface IncomeStatementAccountAmount {
  accountId: string;
  accountCode: string;
  accountName: string;
  ifrsCategory: string;
  ifrsSubcategory: string;
  profitOrLossCategory: ProfitOrLossCategory;
  section: IncomeStatementSection;
  /** period debits − credits (base). */
  net: number;
  /** credits − debits (base): the account's contribution to net profit. */
  contribution: number;
  /** Magnitude shown in its section (income side = credits−debits, expense side = debits−credits). */
  currentAmount: number;
  comparativeAmount: number;
}

export type IncomeStatementLineType = 'section' | 'category' | 'account' | 'subtotal' | 'metric' | 'spacer';
export type LineEmphasis = 'normal' | 'strong' | 'final';

export interface IncomeStatementLine {
  id: string;
  label: string;
  level: number;
  lineType: IncomeStatementLineType;
  currentAmount: number;
  comparativeAmount?: number;
  variance?: number;
  variancePercent?: number | null;
  percentageOfRevenue?: number | null;
  accountIds?: string[];
  emphasis?: LineEmphasis;
}

export interface IncomeStatementTotals {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingProfit: number;
  otherIncome: number;
  otherExpenses: number;
  financeIncome: number;
  financeCosts: number;
  profitBeforeTax: number;
  incomeTax: number;
  profitFromContinuing: number;
  discontinued: number;
  netProfit: number;
}

export interface IncomeStatementMargins {
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
}

export type IsExceptionSeverity = 'error' | 'warning';

export interface IncomeStatementException {
  id: string;
  severity: IsExceptionSeverity;
  message: string;
  accountCode: string;
  accountName: string;
  amount: number;
  missing: string;
}

export interface IncomeStatementResult {
  lines: IncomeStatementLine[];
  totals: IncomeStatementTotals;
  comparativeTotals: IncomeStatementTotals;
  margins: IncomeStatementMargins;
  comparativeMargins: IncomeStatementMargins;
  amounts: IncomeStatementAccountAmount[];
  exceptions: IncomeStatementException[];
  hasComparative: boolean;
}

/** Account types presented in the (primary) statement of profit or loss. */
export const PROFIT_OR_LOSS_TYPES: Account['type'][] = [
  'INCOME',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_INCOME_EXPENSE',
  'FINANCE',
  'TAX',
  'DISCONTINUED_OPERATIONS',
];
