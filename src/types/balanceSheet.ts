import type { AccountType, NormalBalance } from '@/types';

export type BalanceSheetSide = 'asset' | 'liability' | 'equity';

export type BsLineType = 'section' | 'group' | 'account' | 'subtotal' | 'total' | 'grand-total' | 'spacer';
export type BsEmphasis = 'normal' | 'strong' | 'final';

export interface BalanceSheetLine {
  id: string;
  label: string;
  level: number;
  lineType: BsLineType;
  currentAmount: number;
  comparativeAmount?: number;
  variance?: number;
  variancePercent?: number | null;
  accountIds?: string[];
  emphasis?: BsEmphasis;
  isContra?: boolean;
  isAbnormal?: boolean;
  abnormalSide?: '' | 'debit' | 'credit';
  isSynthetic?: boolean;
}

/** A leaf balance-sheet account with its as-at balance (display-normalised). */
export interface BalanceSheetAccountLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  side: BalanceSheetSide;
  isContra: boolean;
  /** Signed base balance (debits − credits) as at the reporting date. */
  signed: number;
  /** Display amount: assets use signed, liabilities/equity use −signed. */
  currentAmount: number;
  comparativeAmount: number;
  isAbnormal: boolean;
  abnormalSide: '' | 'debit' | 'credit';
}

export interface BalanceSheetGroup {
  id: string;
  label: string;
  accounts: BalanceSheetAccountLine[];
  subtotal: number;
  comparativeSubtotal: number;
}

export interface BalanceSheetSection {
  id: string;
  title: string;
  groups: BalanceSheetGroup[];
  total: number;
  comparativeTotal: number;
}

export type ReportWarningSeverity = 'error' | 'warning';
export interface ReportWarning {
  id: string;
  severity: ReportWarningSeverity;
  message: string;
  accountCode?: string;
}

export interface BalanceSheetReport {
  entityId: string;
  asOfDate: string;
  comparativeDate?: string;
  currency: string;
  assets: BalanceSheetSection[];
  equity: BalanceSheetSection[];
  liabilities: BalanceSheetSection[];
  totalAssets: number;
  totalEquity: number;
  totalLiabilities: number;
  totalEquityAndLiabilities: number;
  difference: number;
  isBalanced: boolean;
  currentPeriodProfit: number;
  retainedEarningsBroughtForward: number;
  /** Comparative counterparts (present only when a comparative date is selected). */
  comparativeTotals?: {
    totalAssets: number;
    totalEquity: number;
    totalLiabilities: number;
    totalEquityAndLiabilities: number;
    difference: number;
    currentPeriodProfit: number;
    retainedEarningsBroughtForward: number;
  };
  hasComparative: boolean;
  warnings: ReportWarning[];
  /** Flat lines for rendering the statement. */
  lines: BalanceSheetLine[];
}

export interface BalanceSheetOptions {
  asOfDate: string;
  comparativeDate?: string;
  entityId: string;
  base: string;
  fiscalYearStart: string; // "MM-DD"
  detail: boolean; // show individual accounts vs. group subtotals only
  includeZero: boolean;
}

/** Account types that belong on the statement of financial position. */
export const BALANCE_SHEET_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'OCI', 'CONTROL'];
