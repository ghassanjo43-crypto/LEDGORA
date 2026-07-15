/**
 * Customer Statement of Account — a purely DERIVED report. Nothing here is
 * persisted as a duplicated balance; every figure is computed live from the
 * existing source records (invoices, credit notes, receipts, posted journals).
 */

export type StatementType = 'balance-forward' | 'open-item' | 'activity-only';
export type StatementBasis = 'document' | 'posting';
export type StatementCurrencyMode = 'single-currency' | 'base-currency' | 'multi-currency';

export type StatementLineType =
  | 'opening-balance'
  | 'invoice'
  | 'credit-note'
  | 'receipt'
  | 'customer-advance'
  | 'refund'
  | 'journal-adjustment'
  | 'reversal';

export interface StatementLine {
  id: string;
  type: StatementLineType;
  date: string;
  postingDate?: string;
  dueDate?: string;
  documentNumber?: string;
  reference?: string;
  description: string;
  /** Increases what the customer owes (customer-receivable perspective). */
  debit: number;
  /** Reduces what the customer owes. */
  credit: number;
  runningBalance: number;
  currency: string;
  baseCurrencyAmount?: number;
  invoiceId?: string;
  creditNoteId?: string;
  receiptId?: string;
  journalEntryId?: string;
  status?: string;
  isOverdue?: boolean;
  daysOverdue?: number;
  /** Informational sub-rows (e.g. receipt allocations) — never affect the running balance. */
  allocations?: StatementLineAllocation[];
}

export interface StatementLineAllocation {
  label: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount: number;
}

export type AgingBucketId = 'current' | '1-30' | '31-60' | '61-90' | '91-120' | '120-plus';

export interface AgingBucket {
  id: AgingBucketId;
  label: string;
  amount: number;
  invoiceIds: string[];
}

export interface AgingSummary {
  asOfDate: string;
  buckets: AgingBucket[];
  total: number;
}

export interface OutstandingInvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  originalTotal: number;
  creditNotesApplied: number;
  receiptsApplied: number;
  outstandingBalance: number;
  daysOverdue: number;
  agingBucket: AgingBucketId;
  status: string;
  currency: string;
}

export interface StatementOfAccount {
  entityId: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  billingAddress?: string;
  taxNumber?: string;

  statementType: StatementType;
  statementBasis: StatementBasis;
  periodStart: string;
  periodEnd: string;
  asOfDate: string;

  currencyMode: StatementCurrencyMode;
  currency: string;
  baseCurrency: string;

  openingBalance: number;
  periodDebits: number;
  periodCredits: number;
  closingBalance: number;

  unappliedReceipts: number;
  customerAdvances: number;
  availableCredit: number;
  overdueAmount: number;

  lines: StatementLine[];
  aging: AgingSummary;
  outstandingInvoices: OutstandingInvoiceSummary[];

  /** Calculated closing − subledger closing (should be ~0). */
  subledgerBalance: number;
  reconciliationDifference: number;
  isReconciled: boolean;

  warnings: string[];
  generatedAt: string;
}

/** UI-selectable options that drive statement generation. */
export interface StatementOptions {
  statementType: StatementType;
  statementBasis: StatementBasis;
  periodStart: string;
  periodEnd: string;
  asOfDate: string;
  currencyMode: StatementCurrencyMode;
  currency: string;
  includeSettledInvoices: boolean;
  includeUnappliedReceipts: boolean;
  includeAllocationDetails: boolean;
  includeAging: boolean;
  includeOutstandingSchedule: boolean;
  includeZeroValueActivity: boolean;
}
