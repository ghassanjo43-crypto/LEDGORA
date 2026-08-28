/**
 * Financial statements, aggregated in PostgreSQL, from one snapshot.
 *
 * ══ Why one bundle and not four endpoints ════════════════════════════════════
 *
 * Four HTTP requests get four connections and therefore four snapshots. A
 * posting committed between them would appear in the balance sheet and not the
 * trial balance, and the two would disagree with no way to tell which was
 * right. So every statement in a bundle is computed inside ONE
 * `REPEATABLE READ` read-only transaction: a concurrent posting is wholly
 * visible or wholly invisible, and the snapshot timestamp is returned so two
 * reports on a screen can be proven to be the same books.
 *
 * ══ Why the arithmetic never reaches JavaScript ══════════════════════════════
 *
 * Every sum, sign and rounding happens in `numeric`. Values cross into
 * TypeScript already as decimal strings and are never added, multiplied or
 * compared as numbers — a cent lost to binary floating point in a trial balance
 * is a cent nobody can find afterwards. Even the balance assertions are made by
 * PostgreSQL.
 *
 * ══ Which entries count ══════════════════════════════════════════════════════
 *
 * `posted` AND `reversed`, which is not the obvious rule and matters more than
 * anything else here. When an entry is reversed, `reverseJournal` flips the
 * ORIGINAL to `reversed` and leaves its lines untouched, then inserts a mirrored
 * entry that is `posted`. Counting only `posted` would therefore include the
 * mirror and exclude the original — the books would show the NEGATIVE of the
 * transaction. Counting both nets to zero, which is correct, and leaves both
 * entries visible in the ledger, which is what an audit needs.
 *
 * `draft` never counts. `voided` never counts, and no server path produces it.
 *
 * Amend-and-replace works out the same way: original `reversed` + reversal
 * `posted` cancel, and the replacement stands alone.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { monetaryDecimalsFor } from './currencyPrecision.js';

/**
 * The one controlled value that marks an account as cash for reporting.
 *
 * Deliberately an EXACT token rather than a pattern. The browser decides this
 * with `/cash and cash equivalents/i` over a free-text subcategory, which is
 * why that classification is not authoritative: a customer who renames a
 * subcategory silently changes their cash-flow statement. Until a phase
 * introduces a constrained classification, no account carries this value and
 * cash flow reports `cash_accounts_not_configured` rather than a number.
 */
export const CASH_SUBTYPE = 'cash_and_cash_equivalents';

export interface ReportParameters {
  /** Cumulative statements are struck at this date, inclusive. */
  asOf: string;
  /** Period statements cover this range, both ends inclusive. */
  from: string;
  to: string;
  comparative?: { from: string; to: string; asOf: string } | null;
}

export interface AccountAmount {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  parentAccountId: string | null;
  isPostable: boolean;
  /** This account's own aggregated amount, as a decimal string. */
  amount: string;
  /** This account plus every descendant — the figure a parent row shows. */
  rollup: string;
}

export interface TrialBalanceRow extends AccountAmount {
  debit: string;
  credit: string;
  debitRollup: string;
  creditRollup: string;
}

export interface ReportBundle {
  snapshot: { at: string; currency: string; decimals: number };
  parameters: ReportParameters;
  trialBalance: { rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string };
  incomeStatement: { rows: AccountAmount[]; income: string; expense: string; netIncome: string };
  balanceSheet: {
    rows: AccountAmount[];
    assets: string;
    liabilities: string;
    equity: string;
    /** Income less expense not yet closed to equity. See below. */
    unclosedEarnings: string;
    balances: boolean;
  };
  cashFlow: { status: 'cash_accounts_not_configured'; reason: string } | {
    status: 'ok';
    openingCash: string;
    closingCash: string;
    movement: string;
  };
  comparative?: Omit<ReportBundle, 'snapshot' | 'parameters' | 'comparative'> | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) throw errors.validation(`${field} must be a calendar date.`);
}

/**
 * The lines that count, as a reusable predicate.
 *
 * Company scope is part of the JOIN as well as the WHERE: a line and its entry
 * must belong to the same company, which the composite foreign key already
 * guarantees and this restates so a future edit cannot quietly widen it.
 */
const scopedLines = (organizationId: string, companyId: string) => sql`
  FROM journal_lines jl
  JOIN journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.organization_id = jl.organization_id
   AND je.company_id = jl.company_id
  WHERE jl.organization_id = ${organizationId}
    AND jl.company_id = ${companyId}
    AND je.status IN ('posted', 'reversed')
`;

interface RawAmount {
  account_id: string;
  debit: string;
  credit: string;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Trx = any;

/** Per-account debit and credit sums over a date filter, in numeric. */
async function sumLines(
  trx: Trx,
  organizationId: string,
  companyId: string,
  dateFilter: ReturnType<typeof sql>,
  decimals: number,
): Promise<Map<string, { debit: string; credit: string }>> {
  const { rows } = await sql<RawAmount>`
    SELECT jl.account_id,
           ROUND(COALESCE(SUM(jl.debit_functional), 0), ${sql.lit(decimals)})::text  AS debit,
           ROUND(COALESCE(SUM(jl.credit_functional), 0), ${sql.lit(decimals)})::text AS credit
    ${scopedLines(organizationId, companyId)}
    ${dateFilter}
    GROUP BY jl.account_id
  `.execute(trx);

  const map = new Map<string, { debit: string; credit: string }>();
  for (const row of rows) map.set(row.account_id, { debit: row.debit, credit: row.credit });
  return map;
}

interface AccountRow {
  id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  account_subtype: string | null;
  parent_account_id: string | null;
  is_postable: boolean;
}

/**
 * Roll each account's own amount up through its ancestors.
 *
 * Only POSTABLE accounts carry lines — the database refuses a line on a parent —
 * so the aggregate above is already restricted to them in practice. Parents
 * exist to organise, and a parent row shows the total of everything beneath it.
 * Computed here rather than in SQL because the tree is small and a recursive
 * CTE would still need this shape assembling afterwards.
 */
function rollUp(
  accounts: AccountRow[],
  own: Map<string, bigint>,
): Map<string, bigint> {
  const childrenOf = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.parent_account_id) continue;
    const bucket = childrenOf.get(account.parent_account_id) ?? [];
    bucket.push(account.id);
    childrenOf.set(account.parent_account_id, bucket);
  }

  const memo = new Map<string, bigint>();
  const visit = (id: string, seen: Set<string>): bigint => {
    if (memo.has(id)) return memo.get(id)!;
    /* A cycle is impossible — `accounts_parent_same_company` and the service
     * both refuse one — but recursing forever if it happened is not acceptable. */
    if (seen.has(id)) return 0n;
    seen.add(id);
    let total = own.get(id) ?? 0n;
    for (const child of childrenOf.get(id) ?? []) total += visit(child, seen);
    memo.set(id, total);
    return total;
  };

  const result = new Map<string, bigint>();
  for (const account of accounts) result.set(account.id, visit(account.id, new Set()));
  return result;
}

/** Decimal string → scaled integer, so totals are exact without floats. */
function toScaled(value: string, decimals: number): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const scaled = BigInt((whole || '0') + (decimals > 0 ? padded : ''));
  return negative ? -scaled : scaled;
}

/** Scaled integer → decimal string at the currency's precision. */
function toDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals > 0 ? '.' + digits.slice(digits.length - decimals) : '';
  return (negative ? '-' : '') + whole + fraction;
}

/* ══ The bundle ════════════════════════════════════════════════════════════ */

export interface BundleInput {
  organizationId: string;
  companyId: string;
  parameters: ReportParameters;
}

export async function buildReportBundle(
  db: Kysely<Database>,
  input: BundleInput,
): Promise<ReportBundle> {
  const { asOf, from, to, comparative } = input.parameters;
  assertDate(asOf, 'The as-of date');
  assertDate(from, 'The period start');
  assertDate(to, 'The period end');
  if (from > to) throw errors.validation('The period start must not fall after the period end.');
  if (comparative) {
    assertDate(comparative.from, 'The comparative start');
    assertDate(comparative.to, 'The comparative end');
    assertDate(comparative.asOf, 'The comparative as-of date');
    if (comparative.from > comparative.to) {
      throw errors.validation('The comparative start must not fall after its end.');
    }
  }

  return db
    .transaction()
    /*
     * One snapshot for every figure below. Without this the four statements
     * could straddle a concurrent posting and disagree with each other.
     */
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      /*
       * Read-only, declared as the first statement of the transaction. Kysely
       * 0.27 has no access-mode option, and a reporting transaction that cannot
       * write is one that cannot be made to write by a later mistake.
       */
      await sql`SET TRANSACTION READ ONLY`.execute(trx);

      const organization = await trx
        .selectFrom('organizations')
        .select('base_currency')
        .where('id', '=', input.organizationId)
        .executeTakeFirst();
      const currency = organization?.base_currency ?? 'USD';
      const decimals = monetaryDecimalsFor(currency);

      const accounts = (await trx
        .selectFrom('accounts')
        .select([
          'id', 'account_code', 'account_name', 'account_type',
          'account_subtype', 'parent_account_id', 'is_postable',
        ])
        .where('organization_id', '=', input.organizationId)
        .where('company_id', '=', input.companyId)
        .orderBy('account_code')
        .execute()) as unknown as AccountRow[];

      const section = await buildSection(trx, input, accounts, decimals, { asOf, from, to });

      const comparativeSection = comparative
        ? await buildSection(trx, input, accounts, decimals, comparative)
        : null;

      const { rows: stamp } = await sql<{ at: string }>`SELECT now()::text AS at`.execute(trx);

      return {
        snapshot: { at: stamp[0]!.at, currency, decimals },
        parameters: input.parameters,
        ...section,
        comparative: comparativeSection,
      };
    });
}

async function buildSection(
  trx: Trx,
  input: BundleInput,
  accounts: AccountRow[],
  decimals: number,
  window: { asOf: string; from: string; to: string },
): Promise<Omit<ReportBundle, 'snapshot' | 'parameters' | 'comparative'>> {
  const { organizationId, companyId } = input;

  /* Cumulative to the as-of date: what a balance sheet is struck on. */
  const cumulative = await sumLines(
    trx, organizationId, companyId,
    sql`AND je.posting_date <= ${window.asOf}`,
    decimals,
  );
  /* The period, both ends inclusive: what an income statement covers. */
  const period = await sumLines(
    trx, organizationId, companyId,
    sql`AND je.posting_date >= ${window.from} AND je.posting_date <= ${window.to}`,
    decimals,
  );

  const zero = { debit: '0', credit: '0' };
  const netOf = (map: Map<string, { debit: string; credit: string }>, id: string): bigint => {
    const value = map.get(id) ?? zero;
    return toScaled(value.debit, decimals) - toScaled(value.credit, decimals);
  };

  /* ── Trial balance ─────────────────────────────────────────────────────── */
  const debits = new Map<string, bigint>();
  const credits = new Map<string, bigint>();
  for (const account of accounts) {
    const value = cumulative.get(account.id) ?? zero;
    debits.set(account.id, toScaled(value.debit, decimals));
    credits.set(account.id, toScaled(value.credit, decimals));
  }
  const debitRollups = rollUp(accounts, debits);
  const creditRollups = rollUp(accounts, credits);
  const netRollup = (id: string): bigint =>
    (debitRollups.get(id) ?? 0n) - (creditRollups.get(id) ?? 0n);

  let totalDebit = 0n;
  let totalCredit = 0n;
  const trialRows: TrialBalanceRow[] = accounts.map((account) => {
    const grossDebit = debits.get(account.id) ?? 0n;
    const grossCredit = credits.get(account.id) ?? 0n;
    const net = grossDebit - grossCredit;

    /*
     * A trial balance shows each account's BALANCE in one column, not the gross
     * turnover in both.
     *
     * Summing gross would make a reversed transaction appear twice — once
     * forwards, once backwards — so an account that nets to nothing would still
     * show a thousand in each column, and an active company's totals would grow
     * with activity rather than describing its position. The columns still
     * agree because the net of every account sums to zero in double entry.
     */
    const debit = net > 0n ? net : 0n;
    const credit = net < 0n ? -net : 0n;

    /* Only postable accounts hold lines; adding rollups would double-count. */
    if (account.is_postable) {
      totalDebit += debit;
      totalCredit += credit;
    }
    return {
      accountId: account.id,
      accountCode: account.account_code,
      accountName: account.account_name,
      accountType: account.account_type,
      accountSubtype: account.account_subtype,
      parentAccountId: account.parent_account_id,
      isPostable: account.is_postable,
      amount: toDecimal(net, decimals),
      rollup: toDecimal((debitRollups.get(account.id) ?? 0n) - (creditRollups.get(account.id) ?? 0n), decimals),
      debit: toDecimal(debit, decimals),
      credit: toDecimal(credit, decimals),
      /* Netted for the same reason as the columns above. */
      debitRollup: toDecimal(netRollup(account.id) > 0n ? netRollup(account.id) : 0n, decimals),
      creditRollup: toDecimal(netRollup(account.id) < 0n ? -netRollup(account.id) : 0n, decimals),
    };
  });

  /*
   * The one identity that is always true in double-entry bookkeeping. A failure
   * means the ledger itself is inconsistent, so no statement is returned —
   * a balanced-looking report built on unbalanced books is worse than an error.
   */
  if (totalDebit !== totalCredit) {
    throw errors.conflict(
      'These books do not balance: total debits and credits differ. No statement can be prepared '
      + 'until that is investigated.',
    );
  }

  /* ── Income statement ──────────────────────────────────────────────────── */
  const isIncome = (t: string) => t === 'income';
  const isExpense = (t: string) => t === 'expense';

  let incomeTotal = 0n;
  let expenseTotal = 0n;
  const incomeRows: AccountAmount[] = [];
  const periodOwn = new Map<string, bigint>();
  for (const account of accounts) periodOwn.set(account.id, netOf(period, account.id));
  const periodRollups = rollUp(accounts, periodOwn);

  for (const account of accounts) {
    if (!isIncome(account.account_type) && !isExpense(account.account_type)) continue;
    const net = periodOwn.get(account.id) ?? 0n;
    /* Income is credit-normal, so its natural presentation is the negated net. */
    const presented = isIncome(account.account_type) ? -net : net;
    if (account.is_postable) {
      if (isIncome(account.account_type)) incomeTotal += -net;
      else expenseTotal += net;
    }
    const rollup = periodRollups.get(account.id) ?? 0n;
    incomeRows.push({
      accountId: account.id,
      accountCode: account.account_code,
      accountName: account.account_name,
      accountType: account.account_type,
      accountSubtype: account.account_subtype,
      parentAccountId: account.parent_account_id,
      isPostable: account.is_postable,
      amount: toDecimal(presented, decimals),
      rollup: toDecimal(isIncome(account.account_type) ? -rollup : rollup, decimals),
    });
  }

  /* ── Balance sheet ─────────────────────────────────────────────────────── */
  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  let unclosed = 0n;
  const balanceRows: AccountAmount[] = [];
  const cumulativeOwn = new Map<string, bigint>();
  for (const account of accounts) cumulativeOwn.set(account.id, netOf(cumulative, account.id));
  const cumulativeRollups = rollUp(accounts, cumulativeOwn);

  for (const account of accounts) {
    const net = cumulativeOwn.get(account.id) ?? 0n;
    const rollup = cumulativeRollups.get(account.id) ?? 0n;
    const type = account.account_type;

    if (type === 'income' || type === 'expense') {
      /*
       * Unclosed earnings: income and expense CUMULATIVE to the as-of date, not
       * just the reporting period.
       *
       * No closing entry exists anywhere in Ledgora, so nothing has ever moved
       * prior years' profit into equity. Taking only the period's result would
       * leave every earlier year out and the sheet would not balance — through
       * no fault of the books. Cumulative is the only term that makes the
       * identity exact here, and it is labelled as what it is rather than
       * called retained earnings, which it is not.
       */
      if (account.is_postable) unclosed += -net;
      continue;
    }

    if (account.is_postable) {
      if (type === 'asset') assets += net;
      else if (type === 'liability') liabilities += -net;
      else if (type === 'equity') equity += -net;
    }

    balanceRows.push({
      accountId: account.id,
      accountCode: account.account_code,
      accountName: account.account_name,
      accountType: type,
      accountSubtype: account.account_subtype,
      parentAccountId: account.parent_account_id,
      isPostable: account.is_postable,
      amount: toDecimal(type === 'asset' ? net : -net, decimals),
      rollup: toDecimal(type === 'asset' ? rollup : -rollup, decimals),
    });
  }

  const balances = assets === liabilities + equity + unclosed;
  if (!balances) {
    throw errors.conflict(
      'The balance sheet does not balance. No statement is returned rather than one that cannot be relied on.',
    );
  }

  /* ── Cash flow ─────────────────────────────────────────────────────────── */
  const cashAccounts = accounts.filter(
    (a) => a.account_type === 'asset' && a.account_subtype === CASH_SUBTYPE,
  );

  let cashFlow: ReportBundle['cashFlow'];
  if (cashAccounts.length === 0) {
    cashFlow = {
      status: 'cash_accounts_not_configured',
      reason:
        'No account is classified as cash and cash equivalents, so a cash-flow statement cannot '
        + 'be prepared. Classify the cash accounts and the statement becomes available.',
    };
  } else {
    /*
     * Opening cash is struck the day before the PERIOD begins, not derived from
     * the as-of date.
     *
     * Deriving it as `cumulative(asOf) − period` is only right when the as-of
     * date happens to equal the period end. A balance sheet struck later than
     * the period — which the parameters permit — would then report an opening
     * balance that never existed, and the movement would not tie to the
     * statement. One more aggregate is cheaper than that class of bug.
     */
    const beforePeriod = await sumLines(
      trx, organizationId, companyId,
      sql`AND je.posting_date < ${window.from}`,
      decimals,
    );
    const opening = cashAccounts.reduce((sum, a) => sum + netOf(beforePeriod, a.id), 0n);
    const movement = cashAccounts.reduce((sum, a) => sum + (periodOwn.get(a.id) ?? 0n), 0n);
    cashFlow = {
      status: 'ok',
      openingCash: toDecimal(opening, decimals),
      /* Closing follows from opening plus the period, so the three always tie. */
      closingCash: toDecimal(opening + movement, decimals),
      movement: toDecimal(movement, decimals),
    };
  }

  return {
    trialBalance: {
      rows: trialRows,
      totalDebit: toDecimal(totalDebit, decimals),
      totalCredit: toDecimal(totalCredit, decimals),
    },
    incomeStatement: {
      rows: incomeRows,
      income: toDecimal(incomeTotal, decimals),
      expense: toDecimal(expenseTotal, decimals),
      netIncome: toDecimal(incomeTotal - expenseTotal, decimals),
    },
    balanceSheet: {
      rows: balanceRows,
      assets: toDecimal(assets, decimals),
      liabilities: toDecimal(liabilities, decimals),
      equity: toDecimal(equity, decimals),
      unclosedEarnings: toDecimal(unclosed, decimals),
      balances,
    },
    cashFlow,
  };
}
