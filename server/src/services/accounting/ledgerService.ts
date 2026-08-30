/**
 * The general ledger: one account's postings, in accounting order.
 *
 * ══ Why this is NOT part of the report bundle ════════════════════════════════
 *
 * The bundle is four statements from one snapshot, and it can be because a
 * statement is a few hundred rows. A ledger is detail — a busy bank account is
 * tens of thousands of lines in a year — so it is paged, and paging happens
 * across separate requests over minutes.
 *
 * ══ What consistency this actually gives, stated honestly ════════════════════
 *
 * Separate HTTP requests cannot share a PostgreSQL transaction, and holding one
 * open while somebody reads a page would pin a connection for as long as they
 * cared to look at it. So there is NO snapshot across pages, and this file does
 * not pretend otherwise.
 *
 * What keyset pagination over `(posting_date, journal_number, line_number, id)`
 * does guarantee, given that posted entries are never deleted:
 *
 *   · NO DUPLICATES. Each page asks for rows strictly after the last one
 *     returned, so a row cannot appear twice however much is inserted between
 *     requests. Offset pagination has exactly the opposite property — one
 *     insert before the offset repeats a row, and one deletion skips one.
 *   · NO OMISSION of rows that existed when the cursor was made and sort after
 *     it. They are still there and still sort the same way.
 *   · A BACKDATED entry inserted mid-browse sorts before the cursor and is
 *     therefore not seen for the rest of the run. This is the one real gap, and
 *     it is why the response carries a watermark: the client can notice the
 *     books moved and offer to reload, instead of quietly showing a mixture.
 *
 * A materialized ledger run would close that gap and was deliberately not
 * built: it means a second stored copy of a tenant's figures, with its own
 * retention window and its own access-control surface, to buy consistency for a
 * browsing session. Detecting the change and saying so is the smaller promise
 * and the one that can be kept.
 *
 * ══ Totals are never the sum of what was fetched ═════════════════════════════
 *
 * Opening balance, period totals and closing balance are aggregated by
 * PostgreSQL over the WHOLE range on every request. A closing balance computed
 * from the pages a browser happened to load would change as somebody scrolled,
 * which is the most quietly wrong thing a ledger could do.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { monetaryDecimalsFor } from './currencyPrecision.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A database handle or a transaction: both execute the same statements. */
type Executor = Kysely<Database> | Transaction<Database>;

/** The most rows one page may carry, whatever the caller asks for. */
const MAX_PAGE = 500;
const DEFAULT_PAGE = 100;

export interface LedgerQuery {
  accountId: string;
  from: string;
  to: string;
  /** Opaque; produced by this service. Never parsed or built by a client. */
  cursor?: string | null;
  limit?: number;
}

export interface LedgerLine {
  lineId: string;
  journalId: string;
  journalNumber: string;
  postingDate: string;
  transactionDate: string;
  status: string;
  reference: string;
  description: string;
  memo: string;
  /** Where this posting came from, for the drill-down. */
  sourceType: string | null;
  sourceId: string | null;
  sourceEvent: string | null;
  debit: string;
  credit: string;
  /** Opening plus every line up to and including this one. */
  runningBalance: string;
  /** The cursor to pass to fetch the page AFTER this row. */
  cursor: string;
}

export interface LedgerPage {
  account: { id: string; code: string; name: string; type: string; normalBalance: string };
  currency: string;
  decimals: number;
  parameters: { accountId: string; from: string; to: string };
  /** Struck the day before `from`, by PostgreSQL, over every earlier posting. */
  openingBalance: string;
  /** Whole-range figures. NOT the sum of the rows on this page. */
  totals: { debit: string; credit: string; movement: string; closingBalance: string; lineCount: number };
  lines: LedgerLine[];
  nextCursor: string | null;
  /**
   * Changes when the ledger under this query changes.
   *
   * Compared by the client between pages. A different value means somebody
   * posted, backdated or reversed something while these pages were being read,
   * and the run is no longer a single picture of the books — which the reader
   * is told, rather than left to discover.
   */
  watermark: string;
  /** Read at the start of THIS request. Not a snapshot across pages. */
  readAt: string;
}

/**
 * The lines that count.
 *
 * `posted` AND `reversed`, exactly as the report bundle counts them: a reversal
 * leaves the original in place with its lines untouched and posts a mirror, so
 * excluding the original would show the negative of the transaction. Drafts and
 * voided entries never appear. A ledger that disagreed with the trial balance
 * about which entries exist would be worse than no ledger.
 */
const COUNTED = sql`je.status IN ('posted', 'reversed')`;

/**
 * The cursor's field separator.
 *
 * NUL, because it is the one byte that cannot occur in any of the four
 * fields — a date, a journal number, an integer and a uuid — so no value can
 * split into the wrong number of parts. Written as an ESCAPE rather than as a
 * literal byte in this file: a raw NUL makes git treat the source as binary,
 * which costs the diff every reviewer of a paging cursor would want.
 */
const SEP = '\u0000';

interface CursorParts { postingDate: string; journalNumber: string; lineNumber: number; lineId: string }

function encodeCursor(parts: CursorParts): string {
  return Buffer.from(
    `${parts.postingDate}${SEP}${parts.journalNumber}${SEP}${parts.lineNumber}${SEP}${parts.lineId}`,
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): CursorParts {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw errors.validation('That ledger page reference is not valid. Reload the ledger.');
  }
  const [postingDate, journalNumber, lineNumber, lineId] = raw.split(SEP);
  if (!postingDate || !journalNumber || !lineNumber || !lineId || !ISO_DATE.test(postingDate)) {
    throw errors.validation('That ledger page reference is not valid. Reload the ledger.');
  }
  return { postingDate, journalNumber, lineNumber: Number(lineNumber), lineId };
}

interface RawLine {
  line_id: string;
  journal_id: string;
  journal_number: string;
  posting_date: string;
  transaction_date: string;
  status: string;
  reference: string;
  description: string;
  memo: string;
  source_type: string | null;
  source_id: string | null;
  source_event: string | null;
  line_number: number;
  debit: string;
  credit: string;
  running: string;
}

/**
 * One account's ledger, one page.
 *
 * Three statements, each scoped to the organization AND the company: the
 * account, the whole-range aggregate, and the page itself. No connection is
 * held between calls.
 */
export async function readLedgerPage(
  db: Kysely<Database>,
  scope: { organizationId: string; companyId: string },
  query: LedgerQuery,
): Promise<LedgerPage> {
  if (!ISO_DATE.test(query.from) || !ISO_DATE.test(query.to)) {
    throw errors.validation('Ledger dates must be calendar dates (yyyy-mm-dd).');
  }
  if (query.to < query.from) throw errors.validation('A ledger period cannot end before it starts.');

  const account = await db
    .selectFrom('accounts')
    .select(['id', 'account_code', 'account_name', 'account_type', 'normal_balance'])
    .where('organization_id', '=', scope.organizationId)
    .where('company_id', '=', scope.companyId)
    .where('id', '=', query.accountId)
    .executeTakeFirst();
  /* Another company's account does not resolve, which is the honest answer:
   * there is no such account in THESE books. */
  if (!account) throw errors.notFound('Account');

  const organization = await db
    .selectFrom('organizations')
    .select('base_currency')
    .where('id', '=', scope.organizationId)
    .executeTakeFirst();
  const currency = organization?.base_currency ?? 'USD';
  const decimals = monetaryDecimalsFor(currency);

  const scoped = sql`
    FROM journal_lines jl
    JOIN journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.organization_id = jl.organization_id
     AND je.company_id = jl.company_id
    WHERE jl.organization_id = ${scope.organizationId}
      AND jl.company_id = ${scope.companyId}
      AND jl.account_id = ${query.accountId}
      AND ${COUNTED}
  `;

  /*
   * Opening, period totals, closing and the watermark in ONE statement.
   *
   * Opening is struck strictly BEFORE `from` rather than derived by subtracting
   * the period from a cumulative figure — the subtraction is only right when
   * the range ends where the cumulative was taken, and the caller chooses both.
   */
  const { rows: aggregates } = await sql<{
    opening: string; debit: string; credit: string; line_count: string; watermark: string;
  }>`
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN je.posting_date < ${query.from}
              THEN jl.debit_functional - jl.credit_functional ELSE 0 END), 0), ${sql.lit(decimals)})::text AS opening,
      ROUND(COALESCE(SUM(CASE WHEN je.posting_date BETWEEN ${query.from} AND ${query.to}
              THEN jl.debit_functional ELSE 0 END), 0), ${sql.lit(decimals)})::text AS debit,
      ROUND(COALESCE(SUM(CASE WHEN je.posting_date BETWEEN ${query.from} AND ${query.to}
              THEN jl.credit_functional ELSE 0 END), 0), ${sql.lit(decimals)})::text AS credit,
      COUNT(*) FILTER (WHERE je.posting_date BETWEEN ${query.from} AND ${query.to})::text AS line_count,
      COALESCE(MAX(je.updated_at)::text, '') || ':' || COUNT(*)::text AS watermark
    ${scoped}
  `.execute(db);

  const totals = aggregates[0]!;
  const opening = totals.opening;
  const movement = await scaledDifference(db, totals.debit, totals.credit, decimals);
  const closing = await scaledSum(db, opening, movement, decimals);

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const after = query.cursor ? decodeCursor(query.cursor) : null;

  /*
   * The page. `running` is a window function over the WHOLE range ordered the
   * same way, so a row's running balance is the same figure whichever page it
   * arrives on — computing it from the rows in hand would restart it at every
   * page boundary.
   */
  const { rows } = await sql<RawLine>`
    WITH ordered AS (
      SELECT
        jl.id                AS line_id,
        je.id                AS journal_id,
        je.journal_number,
        je.posting_date::text,
        je.transaction_date::text,
        je.status,
        je.reference,
        je.description,
        jl.memo,
        je.source_type,
        je.source_id,
        je.source_event,
        jl.line_number,
        ROUND(jl.debit_functional, ${sql.lit(decimals)})::text  AS debit,
        ROUND(jl.credit_functional, ${sql.lit(decimals)})::text AS credit,
        ROUND(${opening}::numeric + SUM(jl.debit_functional - jl.credit_functional) OVER (
          ORDER BY je.posting_date, je.journal_number, jl.line_number, jl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ), ${sql.lit(decimals)})::text AS running
      ${scoped}
        AND je.posting_date BETWEEN ${query.from} AND ${query.to}
    )
    SELECT * FROM ordered
    ${after
      ? sql`WHERE (posting_date, journal_number, line_number, line_id)
              > (${after.postingDate}, ${after.journalNumber}, ${after.lineNumber}, ${after.lineId})`
      : sql``}
    ORDER BY posting_date, journal_number, line_number, line_id
    LIMIT ${sql.lit(limit + 1)}
  `.execute(db);

  /* One extra row was asked for purely to learn whether another page exists,
   * without a second COUNT over the range. */
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const lines: LedgerLine[] = page.map((row) => ({
    lineId: row.line_id,
    journalId: row.journal_id,
    journalNumber: row.journal_number,
    postingDate: row.posting_date,
    transactionDate: row.transaction_date,
    status: row.status,
    reference: row.reference,
    description: row.description,
    memo: row.memo,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceEvent: row.source_event,
    debit: row.debit,
    credit: row.credit,
    runningBalance: row.running,
    cursor: encodeCursor({
      postingDate: row.posting_date,
      journalNumber: row.journal_number,
      lineNumber: row.line_number,
      lineId: row.line_id,
    }),
  }));

  return {
    account: {
      id: account.id,
      code: account.account_code,
      name: account.account_name,
      type: account.account_type,
      normalBalance: account.normal_balance,
    },
    currency,
    decimals,
    parameters: { accountId: query.accountId, from: query.from, to: query.to },
    openingBalance: opening,
    totals: {
      debit: totals.debit,
      credit: totals.credit,
      movement,
      closingBalance: closing,
      lineCount: Number(totals.line_count),
    },
    lines,
    nextCursor: hasMore ? (lines[lines.length - 1]?.cursor ?? null) : null,
    watermark: totals.watermark,
    readAt: new Date().toISOString(),
  };
}

/**
 * `a - b` and `a + b` in PostgreSQL, not in JavaScript.
 *
 * Two decimal strings could be subtracted here by parsing them, and that is
 * exactly the float that every other figure in this file is routed around. It
 * is one extra round trip to keep the promise.
 */
async function scaledDifference(
  db: Executor, a: string, b: string, decimals: number,
): Promise<string> {
  const { rows } = await sql<{ value: string }>`
    SELECT ROUND(${a}::numeric - ${b}::numeric, ${sql.lit(decimals)})::text AS value
  `.execute(db);
  return rows[0]!.value;
}

async function scaledSum(
  db: Executor, a: string, b: string, decimals: number,
): Promise<string> {
  const { rows } = await sql<{ value: string }>`
    SELECT ROUND(${a}::numeric + ${b}::numeric, ${sql.lit(decimals)})::text AS value
  `.execute(db);
  return rows[0]!.value;
}

/* ══ The bound ledger: every account, one operation ═══════════════════════ */

/**
 * The whole bound ledger for a period, in ONE server operation.
 *
 * ══ Why not a loop over accounts ═════════════════════════════════════════════
 *
 * The obvious implementation is to call `readLedgerPage` once per account. On a
 * real chart that is hundreds of requests, each with its own snapshot, so the
 * "book" they assemble into is a set of pages that were never simultaneously
 * true — an audit export whose accounts disagree about when they were read is
 * not an audit export. This reads every account inside ONE read-only
 * REPEATABLE READ transaction, so the whole file describes one instant, and it
 * returns that instant so the file can say which one.
 *
 * ══ Ordering is the server's, and it is total ════════════════════════════════
 *
 * Accounts by code, then lines by `(posting_date, journal_number, line_number,
 * id)` — the same ordering the paged ledger walks. Every component is needed: a
 * date is not unique, one entry can touch an account on several lines, and the
 * id is the tie-break that makes two exports of unchanged books identical. A
 * bound ledger that reshuffled between exports could not be diffed, which is
 * most of what anybody does with one.
 *
 * ══ Bounded, and honest about it ═════════════════════════════════════════════
 *
 * The size is measured BEFORE any line is materialised, and a period too large
 * is refused with the figure that was measured. Truncating silently would
 * produce a file that looks complete and is not, which is the worst possible
 * outcome for a document whose whole purpose is completeness.
 */
export interface GroupedLedgerAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: string;
  openingBalance: string;
  totals: { debit: string; credit: string; movement: string; closingBalance: string; lineCount: number };
  lines: LedgerLine[];
}

export interface GroupedLedgerExport {
  /** The single instant every account below was read at. */
  snapshot: { at: string; currency: string; decimals: number };
  parameters: { from: string; to: string; includeZero: boolean };
  accounts: GroupedLedgerAccount[];
  totals: { accountCount: number; lineCount: number };
  /** Always true: a partial export is refused rather than returned. */
  complete: true;
}

/**
 * The most lines one bound-ledger export may carry.
 *
 * Sized for an ordinary full-chart audit export rather than for the server's
 * comfort: a small company posts a few thousand lines a year and an active one
 * tens of thousands, so a year that cannot be exported in one file is a year
 * that cannot be audited from this screen. Past this the caller is told the
 * measured count and asked to narrow the period — never handed a short book.
 */
export const GROUPED_EXPORT_MAX_LINES = 250_000;

export async function exportGroupedLedger(
  db: Kysely<Database>,
  scope: { organizationId: string; companyId: string },
  query: { from: string; to: string; includeZero?: boolean },
): Promise<GroupedLedgerExport> {
  if (!ISO_DATE.test(query.from) || !ISO_DATE.test(query.to)) {
    throw errors.validation('Ledger dates must be calendar dates (yyyy-mm-dd).');
  }
  if (query.to < query.from) throw errors.validation('A ledger period cannot end before it starts.');
  const includeZero = query.includeZero ?? false;

  return db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
    /* Reading only. A reporting transaction that cannot write is one that
     * cannot be made to write by a later mistake. */
    await sql`SET TRANSACTION READ ONLY`.execute(trx);

    const organization = await trx
      .selectFrom('organizations')
      .select('base_currency')
      .where('id', '=', scope.organizationId)
      .executeTakeFirst();
    const currency = organization?.base_currency ?? 'USD';
    const decimals = monetaryDecimalsFor(currency);

    /* ── Measure first, materialise second ───────────────────────────────── */
    const { rows: measured } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n
        FROM journal_lines jl
        JOIN journal_entries je
          ON je.id = jl.journal_entry_id
         AND je.organization_id = jl.organization_id
         AND je.company_id = jl.company_id
       WHERE jl.organization_id = ${scope.organizationId}
         AND jl.company_id = ${scope.companyId}
         AND ${COUNTED}
         AND je.posting_date BETWEEN ${query.from} AND ${query.to}
    `.execute(trx);

    const lineCount = Number(measured[0]!.n);
    if (lineCount > GROUPED_EXPORT_MAX_LINES) {
      throw errors.validation(
        `This period holds ${lineCount} ledger lines, more than the `
        + `${GROUPED_EXPORT_MAX_LINES} a single bound-ledger export carries. `
        + 'Export a shorter period. Nothing has been truncated.',
      );
    }

    const accounts = await trx
      .selectFrom('accounts')
      .select(['id', 'account_code', 'account_name', 'account_type', 'normal_balance'])
      .where('organization_id', '=', scope.organizationId)
      .where('company_id', '=', scope.companyId)
      .where('is_postable', '=', true)
      .orderBy('account_code')
      .execute();

    /* Opening balance and whole-period totals for every account, in one pass. */
    const { rows: sums } = await sql<{
      account_id: string; opening: string; debit: string; credit: string; n: string;
    }>`
      SELECT jl.account_id,
             ROUND(COALESCE(SUM(CASE WHEN je.posting_date < ${query.from}
                     THEN jl.debit_functional - jl.credit_functional ELSE 0 END), 0), ${sql.lit(decimals)})::text AS opening,
             ROUND(COALESCE(SUM(CASE WHEN je.posting_date BETWEEN ${query.from} AND ${query.to}
                     THEN jl.debit_functional ELSE 0 END), 0), ${sql.lit(decimals)})::text AS debit,
             ROUND(COALESCE(SUM(CASE WHEN je.posting_date BETWEEN ${query.from} AND ${query.to}
                     THEN jl.credit_functional ELSE 0 END), 0), ${sql.lit(decimals)})::text AS credit,
             COUNT(*) FILTER (WHERE je.posting_date BETWEEN ${query.from} AND ${query.to})::text AS n
        FROM journal_lines jl
        JOIN journal_entries je
          ON je.id = jl.journal_entry_id
         AND je.organization_id = jl.organization_id
         AND je.company_id = jl.company_id
       WHERE jl.organization_id = ${scope.organizationId}
         AND jl.company_id = ${scope.companyId}
         AND ${COUNTED}
       GROUP BY jl.account_id
    `.execute(trx);

    const sumOf = new Map(sums.map((row) => [row.account_id, row]));

    /*
     * Every line, in the total ordering, with each account's running balance
     * carried from its own opening.
     *
     * The window is PARTITIONed by account: a running balance that continued
     * across an account boundary would be an arithmetic accident rather than a
     * ledger.
     */
    const { rows: lineRows } = await sql<RawLine & { account_id: string }>`
      WITH openings AS (
        SELECT jl.account_id,
               COALESCE(SUM(jl.debit_functional - jl.credit_functional), 0) AS opening
          FROM journal_lines jl
          JOIN journal_entries je
            ON je.id = jl.journal_entry_id
           AND je.organization_id = jl.organization_id
           AND je.company_id = jl.company_id
         WHERE jl.organization_id = ${scope.organizationId}
           AND jl.company_id = ${scope.companyId}
           AND ${COUNTED}
           AND je.posting_date < ${query.from}
         GROUP BY jl.account_id
      )
      SELECT
        jl.account_id,
        jl.id                AS line_id,
        je.id                AS journal_id,
        je.journal_number,
        je.posting_date::text,
        je.transaction_date::text,
        je.status,
        je.reference,
        je.description,
        jl.memo,
        je.source_type,
        je.source_id,
        je.source_event,
        jl.line_number,
        ROUND(jl.debit_functional, ${sql.lit(decimals)})::text  AS debit,
        ROUND(jl.credit_functional, ${sql.lit(decimals)})::text AS credit,
        ROUND(COALESCE(o.opening, 0) + SUM(jl.debit_functional - jl.credit_functional) OVER (
          PARTITION BY jl.account_id
          ORDER BY je.posting_date, je.journal_number, jl.line_number, jl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ), ${sql.lit(decimals)})::text AS running
      FROM journal_lines jl
      JOIN journal_entries je
        ON je.id = jl.journal_entry_id
       AND je.organization_id = jl.organization_id
       AND je.company_id = jl.company_id
      JOIN accounts a
        ON a.id = jl.account_id
       AND a.organization_id = jl.organization_id
       AND a.company_id = jl.company_id
      LEFT JOIN openings o ON o.account_id = jl.account_id
      WHERE jl.organization_id = ${scope.organizationId}
        AND jl.company_id = ${scope.companyId}
        AND ${COUNTED}
        AND je.posting_date BETWEEN ${query.from} AND ${query.to}
      ORDER BY a.account_code, je.posting_date, je.journal_number, jl.line_number, jl.id
    `.execute(trx);

    const byAccount = new Map<string, LedgerLine[]>();
    for (const row of lineRows) {
      const list = byAccount.get(row.account_id) ?? [];
      list.push({
        lineId: row.line_id,
        journalId: row.journal_id,
        journalNumber: row.journal_number,
        postingDate: row.posting_date,
        transactionDate: row.transaction_date,
        status: row.status,
        reference: row.reference,
        description: row.description,
        memo: row.memo,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sourceEvent: row.source_event,
        debit: row.debit,
        credit: row.credit,
        runningBalance: row.running,
        cursor: encodeCursor({
          postingDate: row.posting_date,
          journalNumber: row.journal_number,
          lineNumber: row.line_number,
          lineId: row.line_id,
        }),
      });
      byAccount.set(row.account_id, list);
    }

    const noSums = { opening: '0', debit: '0', credit: '0', n: '0' };
    const grouped: GroupedLedgerAccount[] = [];
    for (const account of accounts) {
      const sum = sumOf.get(account.id) ?? noSums;
      const lines = byAccount.get(account.id) ?? [];

      /*
       * An account with no activity and no opening balance is omitted unless
       * asked for. A bound ledger that lists every unused account in the chart
       * buries the ones that were actually posted to.
       */
      const dormant = lines.length === 0 && !/[1-9]/.test(sum.opening);
      if (dormant && !includeZero) continue;

      const movement = await scaledDifference(trx, sum.debit, sum.credit, decimals);
      const closing = await scaledSum(trx, sum.opening, movement, decimals);

      grouped.push({
        accountId: account.id,
        accountCode: account.account_code,
        accountName: account.account_name,
        accountType: account.account_type,
        normalBalance: account.normal_balance,
        openingBalance: sum.opening,
        totals: {
          debit: sum.debit,
          credit: sum.credit,
          movement,
          closingBalance: closing,
          lineCount: Number(sum.n),
        },
        lines,
      });
    }

    const { rows: stamp } = await sql<{ at: string }>`SELECT now()::text AS at`.execute(trx);

    return {
      snapshot: { at: stamp[0]!.at, currency, decimals },
      parameters: { from: query.from, to: query.to, includeZero },
      accounts: grouped,
      totals: { accountCount: grouped.length, lineCount },
      complete: true as const,
    };
  });
}
