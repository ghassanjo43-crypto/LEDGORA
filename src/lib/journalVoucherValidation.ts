/**
 * Universal Journal Voucher — pure validation, totals, allocation and rounding.
 *
 * Store-free so the same rules power the editor grid, the journal preview and
 * the posting guard identically. Posting itself additionally re-validates in
 * the store (client checks are never the sole boundary — see the backend note
 * in `store/journalVoucherStore.ts`).
 */
import type { Account } from '@/types';
import type {
  JournalVoucher,
  JournalVoucherLine,
  JournalVoucherSettings,
  VoucherTypeConfig,
} from '@/types/journalVoucher';
import { roundTo } from '@/lib/currencyConversion';

/** Legacy 2-dp rounding — kept for base-currency-only callers (fixed assets). */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/* ── Totals ───────────────────────────────────────────────────────────────── */

export interface VoucherTotals {
  debit: number;
  credit: number;
  difference: number;
  baseDebit: number;
  baseCredit: number;
  baseDifference: number;
}

/** Precision of the voucher's transaction and base currencies (never assumed 2 —
 *  2 is only the compatibility default for callers that predate the master). */
export interface VoucherPrecision {
  currencyDecimals?: number;
  baseCurrencyDecimals?: number;
}

/** Half the smallest representable unit at a precision — the imbalance tolerance. */
export function balanceToleranceAt(decimals: number): number {
  return 0.4 / 10 ** decimals;
}

/** Lines that carry any amount (blank grid rows are ignored). */
export function activeLines(lines: JournalVoucherLine[]): JournalVoucherLine[] {
  return lines.filter((l) => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
}

export function computeVoucherTotals(
  lines: JournalVoucherLine[],
  exchangeRate: number,
  precision: VoucherPrecision = {},
): VoucherTotals {
  const dp = precision.currencyDecimals ?? 2;
  const baseDp = precision.baseCurrencyDecimals ?? 2;
  let debit = 0;
  let credit = 0;
  let baseDebit = 0;
  let baseCredit = 0;
  for (const l of activeLines(lines)) {
    debit += Number(l.debit) || 0;
    credit += Number(l.credit) || 0;
    // Base amounts are rounded PER LINE — exactly how they will present in the
    // ledger — so a per-line rounding drift is caught here, not discovered later.
    baseDebit += roundTo((Number(l.debit) || 0) * exchangeRate, baseDp);
    baseCredit += roundTo((Number(l.credit) || 0) * exchangeRate, baseDp);
  }
  return {
    debit: roundTo(debit, dp),
    credit: roundTo(credit, dp),
    difference: roundTo(debit - credit, dp),
    baseDebit: roundTo(baseDebit, baseDp),
    baseCredit: roundTo(baseCredit, baseDp),
    baseDifference: roundTo(baseDebit - baseCredit, baseDp),
  };
}

/* ── Line helpers (grid) ──────────────────────────────────────────────────── */

/** A line must never hold both sides: entering one side clears the other. */
export function withDebit(line: JournalVoucherLine, debit: number): JournalVoucherLine {
  return { ...line, debit: round2(Math.max(0, debit)), credit: 0 };
}
export function withCredit(line: JournalVoucherLine, credit: number): JournalVoucherLine {
  return { ...line, credit: round2(Math.max(0, credit)), debit: 0 };
}

export function renumber(lines: JournalVoucherLine[]): JournalVoucherLine[] {
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}

/* ── Allocation ───────────────────────────────────────────────────────────── */

export interface AllocationTarget {
  /** Dimension patch applied to the allocated line. */
  patch: Partial<Pick<JournalVoucherLine, 'costCenterId' | 'projectId' | 'department' | 'branch' | 'profitCenter' | 'location' | 'description'>>;
  /** Exactly one of the two. */
  percent?: number;
  amount?: number;
}

export interface AllocationResult {
  ok: boolean;
  error?: string;
  amounts: number[];
}

/**
 * Split one amount across dimension targets by percentage (must total exactly
 * 100%) or fixed amounts (must total exactly the amount). The last percentage
 * share absorbs the rounding remainder so the split always reconciles.
 */
export function allocateAmount(total: number, targets: AllocationTarget[]): AllocationResult {
  if (targets.length === 0) return { ok: false, error: 'Add at least one allocation target.', amounts: [] };
  const byPercent = targets.every((t) => t.percent !== undefined);
  const byAmount = targets.every((t) => t.amount !== undefined);
  if (!byPercent && !byAmount) return { ok: false, error: 'Allocate either by percentage or by fixed amount — not a mix.', amounts: [] };

  if (byPercent) {
    const sum = round2(targets.reduce((s, t) => s + (t.percent ?? 0), 0));
    if (Math.abs(sum - 100) > 0.001) {
      return { ok: false, error: `Allocation percentages must total 100% (currently ${sum}%).`, amounts: [] };
    }
    const amounts = targets.map((t) => round2((total * (t.percent ?? 0)) / 100));
    const drift = round2(total - amounts.reduce((s, a) => s + a, 0));
    amounts[amounts.length - 1] = round2(amounts[amounts.length - 1]! + drift);
    return { ok: true, amounts };
  }
  const sum = round2(targets.reduce((s, t) => s + (t.amount ?? 0), 0));
  if (Math.abs(sum - total) > 0.004) {
    return { ok: false, error: `Fixed allocation amounts must total ${total} (currently ${sum}).`, amounts: [] };
  }
  return { ok: true, amounts: targets.map((t) => round2(t.amount ?? 0)) };
}

/** Expand one line into allocated copies (used by the editor's allocate tool). */
export function expandLineAllocation(
  line: JournalVoucherLine,
  targets: AllocationTarget[],
  makeId: () => string,
): { ok: boolean; error?: string; lines: JournalVoucherLine[] } {
  const side = line.debit > 0 ? 'debit' : 'credit';
  const total = side === 'debit' ? line.debit : line.credit;
  const res = allocateAmount(total, targets);
  if (!res.ok) return { ok: false, error: res.error, lines: [] };
  return {
    ok: true,
    lines: targets.map((t, i) => ({
      ...line,
      ...t.patch,
      id: makeId(),
      debit: side === 'debit' ? res.amounts[i]! : 0,
      credit: side === 'credit' ? res.amounts[i]! : 0,
    })),
  };
}

/* ── Validation (§28) ─────────────────────────────────────────────────────── */

export interface VoucherValidationContext {
  accounts: Account[];
  baseCurrency: string;
  /** Configured decimal places of the voucher and base currencies (default 2). */
  precision?: VoucherPrecision;
  costCenterIds: Set<string>;
  projectIds: Set<string>;
  postingLockDate: string;
  /** Posted source keys already consumed (idempotency / duplicate protection). */
  postedSourceKeys: Set<string>;
  settings: JournalVoucherSettings;
  type: VoucherTypeConfig | undefined;
}

export interface VoucherValidationIssue {
  code: string;
  message: string;
}

export function sourceKeyOf(v: Pick<JournalVoucher, 'sourceModule' | 'sourceTransactionId'>): string {
  return v.sourceModule && v.sourceTransactionId ? `${v.sourceModule}:${v.sourceTransactionId}` : '';
}

/** All §28 posting rules. Empty result = the voucher may post. */
export function validateVoucherForPosting(
  voucher: JournalVoucher,
  ctx: VoucherValidationContext,
): VoucherValidationIssue[] {
  const issues: VoucherValidationIssue[] = [];
  const add = (code: string, message: string): void => void issues.push({ code, message });
  const lines = activeLines(voucher.lines);
  const accountById = new Map(ctx.accounts.map((a) => [a.id, a]));

  if (!voucher.companyId && !voucher.organizationId) add('company-missing', 'A legal entity/company is required.');
  if (voucher.status === 'posted') add('already-posted', `${voucher.number} has already been posted.`);
  if (voucher.status === 'cancelled' || voucher.status === 'reversed') add('not-postable', `A ${voucher.status} voucher cannot be posted.`);
  if (lines.length < 2) add('too-few-lines', 'A voucher needs at least two lines with amounts.');

  // Period control.
  if (!voucher.postingDate || Number.isNaN(Date.parse(voucher.postingDate))) {
    add('bad-date', 'A valid posting date is required.');
  } else if (ctx.postingLockDate && voucher.postingDate <= ctx.postingLockDate) {
    add('closed-period', `The accounting period through ${ctx.postingLockDate} is closed.`);
  }

  // Currency.
  const foreign = voucher.currency.toUpperCase() !== ctx.baseCurrency.toUpperCase();
  if (!voucher.currency) add('currency-missing', 'A transaction currency is required.');
  if (foreign && (!voucher.exchangeRate || voucher.exchangeRate <= 0)) {
    add('rate-missing', `An exchange rate is required for ${voucher.currency} → ${ctx.baseCurrency}.`);
  }

  // Lines.
  for (const l of lines) {
    const label = `Line ${l.lineNumber}`;
    if ((Number(l.debit) || 0) > 0 && (Number(l.credit) || 0) > 0) add('both-sides', `${label}: a line cannot carry both a debit and a credit.`);
    if ((Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0) add('negative', `${label}: amounts must be positive.`);
    const account = l.accountId ? accountById.get(l.accountId) : undefined;
    if (!account) add('account-missing', `${label}: select an account from the chart.`);
    else {
      if (!account.isActive) add('account-inactive', `${label}: account ${account.code} — ${account.name} is inactive.`);
      if (!account.isPostingAccount) add('account-header', `${label}: account ${account.code} is a header and cannot receive postings.`);
    }
    if (l.costCenterId && !ctx.costCenterIds.has(l.costCenterId)) add('dimension-foreign', `${label}: the cost center does not belong to this organization.`);
    if (l.projectId && !ctx.projectIds.has(l.projectId)) add('dimension-foreign', `${label}: the project does not belong to this organization.`);
    for (const dim of ctx.type?.requiredDimensions ?? []) {
      if (dim === 'costCenter' && !l.costCenterId) add('dimension-required', `${label}: a cost center is required for ${ctx.type?.name} vouchers.`);
      if (dim === 'project' && !l.projectId) add('dimension-required', `${label}: a project is required for ${ctx.type?.name} vouchers.`);
    }
    if (!ctx.type?.allowTaxCodes && (l.taxCode || l.taxAmount)) {
      add('tax-not-allowed', `${label}: tax codes are not permitted on ${ctx.type?.name ?? 'this'} vouchers.`);
    }
  }

  // Balance — transaction currency is hard; base currency allows only an
  // explained (configured) rounding difference within tolerance. Tolerances
  // derive from each currency's configured precision (a 0-dp JPY voucher and an
  // 8-dp BTC voucher have very different smallest units).
  const totals = computeVoucherTotals(voucher.lines, foreign ? voucher.exchangeRate : 1, ctx.precision);
  const txnTolerance = balanceToleranceAt(ctx.precision?.currencyDecimals ?? 2);
  const baseTolerance = balanceToleranceAt(ctx.precision?.baseCurrencyDecimals ?? 2);
  if (Math.abs(totals.difference) > txnTolerance) {
    add('unbalanced', `Total debits (${totals.debit}) must equal total credits (${totals.credit}).`);
  } else if (Math.abs(totals.baseDifference) > baseTolerance) {
    const tolerable = Math.abs(totals.baseDifference) <= ctx.settings.roundingTolerance;
    if (!tolerable || !ctx.settings.roundingAccountId) {
      add('base-imbalance', `Base-currency totals differ by ${totals.baseDifference} — configure a rounding account (tolerance ${ctx.settings.roundingTolerance}) or adjust the lines.`);
    }
  }

  // Duplicate source-document protection.
  const key = sourceKeyOf(voucher);
  if (key && ctx.postedSourceKeys.has(key)) {
    add('duplicate-source', `The source transaction ${key} has already generated a journal — duplicate accounting is not allowed.`);
  }

  // Type-specific structural rules.
  if (ctx.type?.kind === 'bank_transfer') {
    const debits = lines.filter((l) => l.debit > 0);
    const credits = lines.filter((l) => l.credit > 0);
    if (credits.length !== 1) add('transfer-shape', 'A transfer credits exactly one source account.');
    const src = credits[0]?.accountId;
    if (src && debits.some((l) => l.accountId === src)) add('transfer-same-account', 'Source and destination accounts must be different.');
    if (debits.length < 1) add('transfer-shape', 'A transfer debits at least the destination account.');
  }
  if (ctx.type?.kind === 'intercompany' && !voucher.intercompanyRef) {
    add('intercompany-incomplete', 'Intercompany vouchers must carry the common intercompany reference and be posted as a balanced pair — one journal per legal entity.');
  }

  return issues;
}

/*
 * NOTE on currency rounding: journal entries store amounts in the TRANSACTION
 * currency with one entry-level rate; base amounts are derived per line by the
 * ledger. A per-line base rounding drift therefore cannot be "fixed" with a
 * transaction-currency line (that would unbalance the hard txn-currency rule).
 * Policy implemented in `validateVoucherForPosting`: an unexplained base
 * imbalance rejects; a drift within `settings.roundingTolerance` is accepted
 * ONLY when a rounding account is configured (the drift is an artifact of
 * per-line conversion, and the configured account documents where a backend
 * with stored per-line base amounts must post it — see the store's backend
 * persistence note).
 */
