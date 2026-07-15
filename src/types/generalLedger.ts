import type { Account } from '@/types';

/**
 * A single General Ledger line, DERIVED from a posted General Journal line.
 * The General Ledger is never stored — it is computed from posted journal
 * entries so the journal remains the single source of truth.
 */
export type BalanceSide = 'debit' | 'credit' | 'zero';

export interface GeneralLedgerLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  journalEntryId: string;
  journalNumber: string;
  journalLineId: string;
  lineNumber: number;
  entryDate: string;
  postingDate: string;
  reference: string;
  transactionType: string;
  entityId?: string;
  entityName?: string;
  description: string;
  memo?: string;
  debit: number;
  credit: number;
  baseDebit: number;
  baseCredit: number;
  currency: string;
  exchangeRate: number;
  project?: string;
  costCenter?: string;
  taxCode?: string;
  createdBy?: string;
  postedBy?: string;
  reversalReference?: string;
  originalEntryId?: string;
  /** Running balance in base currency, oriented to the account's normal side
   *  (positive = normal side, negative = abnormal). */
  runningBalance: number;
  balanceSide: BalanceSide;
  /** True when the running balance sits on the account's non-normal side. */
  abnormal: boolean;
}

/** Aggregated ledger for one account over a period. */
export interface AccountLedger {
  account: Account;
  /** Normal-oriented signed balance before the period. */
  openingBalance: number;
  lines: GeneralLedgerLine[];
  periodDebits: number;
  periodCredits: number;
  /** Normal-oriented signed net movement. */
  netMovement: number;
  /** Normal-oriented signed closing balance. */
  closingBalance: number;
  transactionCount: number;
}

export interface LedgerPeriod {
  from: string;
  to: string;
}

export interface LedgerFilters {
  entityId: string;
  reference: string;
  journalNumber: string;
  project: string;
  costCenter: string;
  search: string;
}

export type LedgerSort = 'oldest' | 'newest';

/** Result of the development-only reconciliation check. */
export interface LedgerReconciliation {
  ok: boolean;
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
  issues: string[];
}
