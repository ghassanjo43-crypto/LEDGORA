/**
 * Types for the Ledgerly financial dashboard. All figures are DERIVED from the
 * existing journal + chart-of-accounts data; nothing here changes accounting
 * logic or stores. Financial results use POSTED entries only.
 */

/** Named reporting periods for period-sensitive figures (income, expenses…). */
export type ReportingPeriodId =
  | 'today'
  | 'this-week'
  | 'this-month'
  | 'this-quarter'
  | 'this-year'
  | 'prev-month'
  | 'prev-quarter'
  | 'prev-year'
  | 'custom';

export interface ReportingPeriod {
  id: ReportingPeriodId;
  label: string;
  /** Inclusive ISO start date (yyyy-mm-dd). */
  from: string;
  /** Inclusive ISO end date (yyyy-mm-dd). */
  to: string;
}

/**
 * Availability of a derived figure so the UI can distinguish a real zero from
 * data that simply cannot be computed yet (e.g. aging before invoicing).
 */
export type DataAvailability = 'available' | 'no-transactions' | 'not-implemented';

/* ── Financial summary results ────────────────────────────────────────────── */

export interface ReceivablesSummary {
  total: number;
  current: number;
  overdue: number;
  customerCount: number;
  /** Aging is provisional until invoices/due-dates exist. */
  agingAvailable: boolean;
  topBalances: { entityId: string; name: string; amount: number }[];
}

export interface PayablesSummary {
  total: number;
  current: number;
  overdue: number;
  supplierCount: number;
  agingAvailable: boolean;
  topBalances: { entityId: string; name: string; amount: number }[];
}

export interface CashAccountBalance {
  accountId: string;
  code: string;
  name: string;
  balance: number;
  lastActivity: string;
}

export interface CashAndBankSummary {
  total: number;
  bank: number;
  cashOnHand: number;
  accountCount: number;
  accounts: CashAccountBalance[];
}

export interface NetIncomeSummary {
  income: number;
  expenses: number;
  net: number;
  marginPct: number;
  /** Previous equivalent period net, when enough data exists. */
  previousNet: number | null;
}

export interface TopExpenseItem {
  accountId: string;
  code: string;
  name: string;
  amount: number;
  pctOfTotal: number;
  /** True for the aggregated "Other" bucket. */
  isOther?: boolean;
}

export interface CashMovementPoint {
  label: string;
  from: string;
  to: string;
  inflow: number;
  outflow: number;
  net: number;
}

export interface CashMovementSeries {
  points: CashMovementPoint[];
  openingBalance: number;
  totalInflow: number;
  totalOutflow: number;
  closingBalance: number;
}

export interface IncomeExpensePoint {
  label: string;
  from: string;
  to: string;
  income: number;
  expenses: number;
  net: number;
}

export type ActivityKind =
  | 'created'
  | 'edited'
  | 'posted'
  | 'voided'
  | 'customer'
  | 'supplier'
  | 'account';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  at: string;
  actor: string;
  /** Optional deep-link target. */
  entryId?: string;
}

export type AttentionSeverity = 'error' | 'warning' | 'info';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  message: string;
  record: string;
  /** View to open when the user acts on it. */
  action?: 'journal' | 'tree' | 'mapping';
}

/* ── Dashboard customization ──────────────────────────────────────────────── */

export type DashboardWidgetId =
  | 'financial-summary'
  | 'operational-status'
  | 'cash-flow'
  | 'income-expense'
  | 'receivables'
  | 'payables'
  | 'top-expenses'
  | 'bank-accounts'
  | 'attention-required'
  | 'recent-activity'
  | 'business-overview';

export interface DashboardWidgetPreference {
  id: DashboardWidgetId;
  visible: boolean;
  order: number;
}

export type DashboardDensity = 'comfortable' | 'compact';
