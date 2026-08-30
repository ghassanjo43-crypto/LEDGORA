/**
 * The financial-report surface, as the server returns it.
 *
 * ══ Every amount is a STRING, and stays one ══════════════════════════════════
 *
 * The server aggregates in `numeric` and serialises decimal strings precisely so
 * a figure is not routed through a binary float on its way to a screen. Typing
 * these as `number` here would undo that at the boundary: `Number('0.1')` is not
 * 0.1, and a trial balance that is out by a thousandth is a trial balance a
 * bookkeeper cannot sign.
 *
 * So these types say `string`, the components render them verbatim, and nothing
 * in the browser adds, subtracts or compares them as numbers. Totals are already
 * computed by PostgreSQL, so there is nothing left for a screen to work out.
 *
 * ══ One request, one snapshot ════════════════════════════════════════════════
 *
 * Four statements come back together because they were read inside one
 * REPEATABLE READ transaction. Fetching them separately would give four
 * snapshots, and a posting committed between two of them would appear in the
 * balance sheet but not in the trial balance that supposedly produced it.
 */
import { api } from './client';

/** The presentation classification the SERVER decided. Never derived here. */
export interface ServerAccountAmount {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The ledger type: asset | liability | equity | income | expense. */
  accountType: string;
  accountSubtype: string | null;
  presentationType: string;
  ifrsStatement: string;
  ifrsCategory: string;
  ifrsSubcategory: string;
  cashFlowCategory: string;
  /** none | cash_and_cash_equivalents | restricted_cash | bank_overdraft */
  cashClassification: string;
  parentAccountId: string | null;
  isPostable: boolean;
  /** This account's own amount, as a decimal string. */
  amount: string;
  /** This account plus its descendants, as a decimal string. */
  rollup: string;
}

/**
 * One posting account's ledger summary, computed by the server.
 *
 * These are the figures a COLLAPSED multi-account row shows. They are in the
 * bundle rather than derived here because the alternative — summing the lines
 * the browser happens to hold — makes an opening balance depend on what has
 * been loaded. They are defined identically to the single-account ledger, so a
 * collapsed row and the ledger it opens into cannot disagree.
 */
export interface ServerAccountLedgerSummary {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: string;
  openingBalance: string;
  /** GROSS turnover: a ledger reports both sides of what happened. */
  periodDebit: string;
  periodCredit: string;
  netMovement: string;
  closingBalance: string;
  lineCount: number;
}

export interface ServerTrialBalanceRow extends ServerAccountAmount {
  debit: string;
  credit: string;
  debitRollup: string;
  creditRollup: string;
}

export interface ServerReportParameters {
  asOf: string;
  from: string;
  to: string;
  comparative: { from: string; to: string; asOf: string } | null;
}

/**
 * The cash figures.
 *
 * `cash_accounts_not_configured` is a real answer, not an error. Cash is a
 * CONTROLLED column on the chart, and until an account carries it the server
 * declines to invent a cash figure rather than guessing from an account's name.
 * The screen shows that plainly; the other three statements still arrive.
 */
export type ServerCashFlow =
  | { status: 'cash_accounts_not_configured'; reason: string }
  | { status: 'ok'; openingCash: string; closingCash: string; movement: string };

export interface ServerStatements {
  /** Every posting account, in account-code order. */
  accountLedgers: ServerAccountLedgerSummary[];
  trialBalance: { rows: ServerTrialBalanceRow[]; totalDebit: string; totalCredit: string };
  incomeStatement: { rows: ServerAccountAmount[]; income: string; expense: string; netIncome: string };
  balanceSheet: {
    rows: ServerAccountAmount[];
    assets: string;
    liabilities: string;
    equity: string;
    /** Income less expense not yet closed to equity. */
    unclosedEarnings: string;
    balances: boolean;
  };
  cashFlow: ServerCashFlow;
}

export interface ServerReportBundle extends ServerStatements {
  snapshot: { at: string; currency: string; decimals: number };
  parameters: ServerReportParameters;
  comparative?: ServerStatements | null;
}

export interface ReportBundleQuery {
  asOf: string;
  from: string;
  to: string;
  comparative?: { from: string; to: string; asOf: string } | null;
}

/**
 * A comparative needs all three of its dates or none.
 *
 * The server refuses a half-specified one rather than inventing the third, so
 * sending two would be asking for a 400. Building the query here keeps that
 * rule in one place.
 */
function queryString(query: ReportBundleQuery): string {
  const parts = [`asOf=${query.asOf}`, `from=${query.from}`, `to=${query.to}`];
  if (query.comparative) {
    parts.push(
      `comparativeFrom=${query.comparative.from}`,
      `comparativeTo=${query.comparative.to}`,
      `comparativeAsOf=${query.comparative.asOf}`,
    );
  }
  return parts.join('&');
}

/* ══ The general ledger ═══════════════════════════════════════════════════ */

export interface ServerLedgerLine {
  lineId: string;
  journalId: string;
  journalNumber: string;
  postingDate: string;
  transactionDate: string;
  status: string;
  reference: string;
  description: string;
  memo: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceEvent: string | null;
  debit: string;
  credit: string;
  /** Opening plus every line up to and including this one. */
  runningBalance: string;
  /** Opaque. Produced by the server; never built or parsed here. */
  cursor: string;
}

export interface ServerLedgerPage {
  account: { id: string; code: string; name: string; type: string; normalBalance: string };
  currency: string;
  decimals: number;
  parameters: { accountId: string; from: string; to: string };
  openingBalance: string;
  /** Whole-range figures. NOT the sum of the rows on this page. */
  totals: { debit: string; credit: string; movement: string; closingBalance: string; lineCount: number };
  lines: ServerLedgerLine[];
  nextCursor: string | null;
  /**
   * Changes when the ledger under this query changes.
   *
   * A different value between two pages means somebody posted, backdated or
   * reversed something while they were being read — the one gap keyset paging
   * cannot close — so the reader is told the books moved rather than being
   * handed a mixture.
   */
  watermark: string;
  readAt: string;
}

/**
 * The bound ledger: every account and its lines, from ONE server operation.
 *
 * Deliberately not "fetch each account and staple them together": that is a
 * request per account, each with its own snapshot, producing a book whose
 * accounts were never simultaneously true. This is one request, one snapshot,
 * one ordering.
 */
export interface ServerGroupedLedgerAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: string;
  openingBalance: string;
  totals: { debit: string; credit: string; movement: string; closingBalance: string; lineCount: number };
  lines: ServerLedgerLine[];
}

export interface ServerGroupedLedgerExport {
  snapshot: { at: string; currency: string; decimals: number };
  parameters: { from: string; to: string; includeZero: boolean };
  accounts: ServerGroupedLedgerAccount[];
  totals: { accountCount: number; lineCount: number };
  complete: true;
}

export interface LedgerPageQuery {
  accountId: string;
  from: string;
  to: string;
  cursor?: string | null;
  limit?: number;
}

export const reportsApi = {
  /** Trial balance, income statement, balance sheet and cash, from one snapshot. */
  bundle: async (query: ReportBundleQuery): Promise<ServerReportBundle> =>
    api.get<ServerReportBundle>(`/api/accounting/reports/bundle?${queryString(query)}`),

  /**
   * One account's ledger, one page.
   *
   * Separate from the bundle on purpose: a statement is a few hundred rows and
   * fits in one snapshot, while a busy account's ledger is tens of thousands of
   * lines and must be paged across requests that cannot share a transaction.
   * The totals still come from the server over the whole range, so they do not
   * change as the reader scrolls.
   */
  ledgerPage: async (query: LedgerPageQuery): Promise<ServerLedgerPage> => {
    const parts = [
      `accountId=${encodeURIComponent(query.accountId)}`,
      `from=${query.from}`,
      `to=${query.to}`,
    ];
    if (query.cursor) parts.push(`cursor=${encodeURIComponent(query.cursor)}`);
    if (query.limit) parts.push(`limit=${query.limit}`);
    return api.get<ServerLedgerPage>(`/api/accounting/ledger?${parts.join('&')}`);
  },

  /**
   * The whole bound ledger, in one request.
   *
   * Guarded server-side by `general_ledger.export` — a different act from
   * viewing, and refused to somebody trusted only to read on screen.
   */
  groupedExport: async (query: { from: string; to: string; includeZero?: boolean }): Promise<ServerGroupedLedgerExport> => {
    const parts = [`from=${query.from}`, `to=${query.to}`];
    if (query.includeZero) parts.push('includeZero=true');
    return api.get<ServerGroupedLedgerExport>(`/api/accounting/ledger/export/grouped?${parts.join('&')}`);
  },
};
