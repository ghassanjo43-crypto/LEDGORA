/**
 * The chart of accounts, complete enough to be authoritative.
 *
 * ══ Two different questions an account answers ═══════════════════════════════
 *
 * `account_type` (asset | liability | equity | income | expense) is the
 * ACCOUNTING type. It decides the sign of a balance and which statement a
 * figure lands in, and every aggregate in `reportService` is driven by it. It
 * has five values because double-entry has five, and it must stay that way.
 *
 * `presentation_type` is the finer IFRS PRESENTATION classification the chart
 * of accounts screen has always used — cost of sales, operating expense,
 * finance, tax, OCI and the rest. Four of those are all `expense` to the
 * ledger, and collapsing them into it would mean an account created as "finance
 * cost" came back from the server as a plain expense. That is not a display
 * detail: it is the difference between a chart a bookkeeper recognises and one
 * that has been quietly flattened.
 *
 * Keeping both is what lets the server hold the WHOLE account rather than the
 * half the ledger happens to need. The browser stops being the only place the
 * full chart exists.
 *
 * ══ Cash, named rather than guessed ══════════════════════════════════════════
 *
 * A cash-flow statement has to know which accounts ARE cash. The browser
 * decided that by matching a regular expression against a free-text
 * subcategory, and `reportService` inherited the same shape by looking for the
 * literal subtype `'cash_and_cash_equivalents'`. Both mean the classification
 * can be changed by renaming a label, and a statement whose meaning turns on
 * spelling is not a statement anyone should sign.
 *
 * `cash_classification` is a controlled column with a CHECK behind it. Three
 * constraints, each closing a way of being wrong:
 *
 *   · the value must be one of the four the domain has;
 *   · cash and restricted cash are ASSETS, an overdraft is a LIABILITY, so a
 *     classification that contradicts the account type cannot be stored;
 *   · only a POSTABLE account may be cash. A header account carries no lines of
 *     its own, and classifying both a parent and its child would count the same
 *     money twice.
 *
 * `restricted_cash` exists precisely so it can be EXCLUDED. IAS 7 counts cash
 * and equivalents, and an overdraft repayable on demand as a negative component
 * of them; cash the entity cannot actually use is neither. Without a separate
 * value the only way to record that distinction would be to leave restricted
 * balances unclassified, which loses the fact that they are cash at all.
 *
 * This makes a cash RECONCILIATION possible — opening, movement and closing
 * that tie to the balance sheet. It does NOT produce a classified operating /
 * investing / financing statement: that needs each posting mapped to an
 * activity, which is a later piece of work and not this column.
 *
 * ══ Ordering ════════════════════════════════════════════════════════════════
 *
 * A chart of accounts has a deliberate order, and it is not always the code
 * order — a bookkeeper who wants "Petty Cash" above "Bank" is not asking for a
 * renumbering. `sort_order` was a browser-only field, which meant the order
 * survived exactly as long as the site data did. Ordering is per parent, so
 * siblings are compared and nothing global has to be renumbered to insert one
 * account.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

/** The controlled cash vocabulary. Widening it is a migration, deliberately. */
const CASH_CLASSIFICATIONS = [
  'none',
  'cash_and_cash_equivalents',
  'restricted_cash',
  'bank_overdraft',
] as const;

const PRESENTATION_TYPES = [
  'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'OPERATING_EXPENSE',
  'OTHER_INCOME_EXPENSE', 'FINANCE', 'TAX', 'DISCONTINUED_OPERATIONS', 'OCI', 'CONTROL',
] as const;

const IFRS_STATEMENTS = [
  'STATEMENT_OF_FINANCIAL_POSITION', 'PROFIT_OR_LOSS', 'OCI',
  'STATEMENT_OF_CHANGES_IN_EQUITY', 'CASH_FLOW', 'NOTES', 'CONTROL',
] as const;

const CASH_FLOW_CATEGORIES = [
  'OPERATING', 'INVESTING', 'FINANCING', 'NON_CASH', 'NOT_APPLICABLE',
] as const;

const PROFIT_OR_LOSS_CATEGORIES = [
  'OPERATING', 'INVESTING', 'FINANCING', 'INCOME_TAXES', 'DISCONTINUED_OPERATIONS', 'NOT_APPLICABLE',
] as const;

/**
 * `('a','b')` — an INLINE list for a CHECK.
 *
 * `sql.lit` rather than an interpolated value, because DDL cannot carry bind
 * parameters: a CHECK is stored as part of the table definition, so there is
 * nothing left to bind them to later and PostgreSQL refuses the statement
 * outright. Every value here comes from a constant in this file, never from a
 * caller.
 */
function values(list: readonly string[]) {
  return sql`(${sql.join(list.map((value) => sql.lit(value)))})`;
}

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS cash_classification text NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS presentation_type text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS ifrs_statement text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS ifrs_category text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS ifrs_subcategory text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS cash_flow_category text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS profit_or_loss_category text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS industry_tag text NOT NULL DEFAULT ''
  `.execute(db);

  /*
   * Carry over whatever the free-text subtype already claimed, ONCE, before the
   * constraint goes on. This is the only moment the guessed classification is
   * trusted, and only for the exact token `reportService` was already matching —
   * a near-miss spelling is left unclassified rather than promoted to
   * authoritative on the strength of a string comparison.
   */
  await sql`
    UPDATE accounts
       SET cash_classification = 'cash_and_cash_equivalents'
     WHERE account_subtype = 'cash_and_cash_equivalents'
       AND account_type = 'asset'
       AND is_postable
       AND cash_classification = 'none'
  `.execute(db);

  /*
   * Anything the backfill could not honour is left as 'none' and the constraint
   * below would refuse it, so clear the contradictory cases explicitly rather
   * than letting `ADD CONSTRAINT` fail on a customer's data. There should be
   * none — the UPDATE above only sets rows that already satisfy the rules — but
   * a subtype set by hand on a header account is exactly the kind of row that
   * makes a migration fail at 3am.
   */
  await sql`
    UPDATE accounts
       SET cash_classification = 'none'
     WHERE cash_classification <> 'none'
       AND NOT (
         (cash_classification IN ('cash_and_cash_equivalents', 'restricted_cash') AND account_type = 'asset')
         OR (cash_classification = 'bank_overdraft' AND account_type = 'liability')
       )
  `.execute(db);

  /* Replay-safe: drop before add, so a re-run does not fail on the name. */
  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_cash_classification_known`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_cash_classification_known
      CHECK (cash_classification IN ${values(CASH_CLASSIFICATIONS)})
  `.execute(db);

  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_cash_classification_type`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_cash_classification_type CHECK (
      cash_classification = 'none'
      OR (cash_classification IN ('cash_and_cash_equivalents', 'restricted_cash') AND account_type = 'asset')
      OR (cash_classification = 'bank_overdraft' AND account_type = 'liability')
    )
  `.execute(db);

  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_cash_classification_postable`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_cash_classification_postable
      CHECK (cash_classification = 'none' OR is_postable)
  `.execute(db);

  /*
   * The presentation vocabulary. `''` is permitted throughout: an account
   * created through the API without a presentation opinion is not invalid, it
   * simply has not expressed one, and refusing it would break every existing
   * caller for the sake of a field they do not know about.
   */
  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_presentation_type_known`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_presentation_type_known
      CHECK (presentation_type = '' OR presentation_type IN ${values(PRESENTATION_TYPES)})
  `.execute(db);

  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_ifrs_statement_known`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_ifrs_statement_known
      CHECK (ifrs_statement = '' OR ifrs_statement IN ${values(IFRS_STATEMENTS)})
  `.execute(db);

  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_cash_flow_category_known`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_cash_flow_category_known
      CHECK (cash_flow_category = '' OR cash_flow_category IN ${values(CASH_FLOW_CATEGORIES)})
  `.execute(db);

  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_profit_or_loss_category_known`.execute(db);
  await sql`
    ALTER TABLE accounts ADD CONSTRAINT accounts_profit_or_loss_category_known
      CHECK (profit_or_loss_category = '' OR profit_or_loss_category IN ${values(PROFIT_OR_LOSS_CATEGORIES)})
  `.execute(db);

  /*
   * The cash accounts of one company, which is exactly the set the cash-flow
   * section reads. Partial, because they are a handful of rows in a chart of
   * hundreds and the index should be the size of the answer, not the table.
   */
  await sql`
    CREATE INDEX IF NOT EXISTS accounts_cash_classified_idx
      ON accounts (organization_id, company_id)
      WHERE cash_classification <> 'none'
  `.execute(db);

  /* Sibling ordering is always read within one parent. */
  await sql`
    CREATE INDEX IF NOT EXISTS accounts_sibling_order_idx
      ON accounts (organization_id, company_id, parent_account_id, sort_order)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS accounts_sibling_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS accounts_cash_classified_idx`.execute(db);
  for (const name of [
    'accounts_cash_classification_known',
    'accounts_cash_classification_type',
    'accounts_cash_classification_postable',
    'accounts_presentation_type_known',
    'accounts_ifrs_statement_known',
    'accounts_cash_flow_category_known',
    'accounts_profit_or_loss_category_known',
  ]) {
    await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ${sql.raw(name)}`.execute(db);
  }
  await sql`
    ALTER TABLE accounts
      DROP COLUMN IF EXISTS cash_classification,
      DROP COLUMN IF EXISTS sort_order,
      DROP COLUMN IF EXISTS presentation_type,
      DROP COLUMN IF EXISTS ifrs_statement,
      DROP COLUMN IF EXISTS ifrs_category,
      DROP COLUMN IF EXISTS ifrs_subcategory,
      DROP COLUMN IF EXISTS cash_flow_category,
      DROP COLUMN IF EXISTS profit_or_loss_category,
      DROP COLUMN IF EXISTS description,
      DROP COLUMN IF EXISTS industry_tag
  `.execute(db);
}
