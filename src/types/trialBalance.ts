import type { AccountType } from '@/types';

/**
 * A single Trial Balance row, DERIVED from posted journal lines + account
 * metadata. Never stored. Debit/credit columns show the TRUE net position of
 * each account (not forced onto its normal side).
 */
export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  ifrsCategory: string;
  parentId: string | null;
  isActive: boolean;
  normalBalance: 'debit' | 'credit';

  openingDebit: number;
  openingCredit: number;

  periodDebits: number;
  periodCredits: number;

  closingDebit: number;
  closingCredit: number;

  hadPeriodActivity: boolean;
  isAbnormalBalance: boolean;
  /** Side the closing balance actually sits on ('' when zero). */
  abnormalSide: '' | 'debit' | 'credit';
}

export interface TrialBalanceTotals {
  openingDebit: number;
  openingCredit: number;
  openingDifference: number;
  periodDebits: number;
  periodCredits: number;
  periodDifference: number;
  closingDebit: number;
  closingCredit: number;
  closingDifference: number;
}

/** A family group (Assets, Liabilities, …) with its posting rows + subtotals. */
export interface TrialBalanceGroup {
  id: string;
  label: string;
  rows: TrialBalanceRow[];
  subtotals: TrialBalanceTotals;
}

export interface TrialBalancePeriod {
  from: string;
  to: string;
}

export type TbSeverity = 'error' | 'warning' | 'info';

export interface TrialBalanceException {
  id: string;
  severity: TbSeverity;
  message: string;
  reference: string;
  action?: 'journal' | 'general-ledger' | 'tree' | 'mapping';
}

export interface TrialBalanceReconciliation {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  difference: number;
}

export interface TrialBalanceFilters {
  search: string;
  type: AccountType | 'ALL';
  includeZero: boolean;
  active: 'active' | 'all' | 'inactive';
}

export type TrialBalanceViewMode = 'standard' | 'movement';

/** Prepared for a future comparative Trial Balance (not populated yet). */
export interface TrialBalanceComparativeRow extends TrialBalanceRow {
  priorClosingDebit: number;
  priorClosingCredit: number;
  varianceDebit: number;
  varianceCredit: number;
}
