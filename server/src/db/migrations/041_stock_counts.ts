/**
 * Inventory I5 — physical stock counts.
 *
 * ══ Why a count has no open window ═══════════════════════════════════════════
 *
 * A count here is captured and posted in ONE call, in one transaction, under
 * the same item locks the rest of the stock ledger takes. The expected quantity
 * is summed from posted movements at that instant, the variance is measured
 * against it, and the adjustment settles it — so there is no interval during
 * which a movement could arrive and make the two disagree.
 *
 * That is not a simplification, it is the only boundary this product actually
 * determines. `StockCountStatus` declares draft, counting and reviewed;
 * `freezeAt` and `reviewedBy` sit beside them — and every one of those has zero
 * consumers anywhere in the repository. The real implementation is a single
 * screen that snapshots balances into memory and posts the variance in the same
 * interaction, so freeze and post are the same instant and no window has ever
 * existed.
 *
 * The moment a count becomes a durable multi-session document, that window
 * becomes real and something must say what happens to movements inside it —
 * either the warehouse is frozen, or the adjustment is rolled forward. This
 * product says neither. Inventing one would be inventing warehouse-control
 * policy: freezing a warehouse would make posted bills and issued invoices fail
 * for reasons no rule here states, and rolling forward would silently choose an
 * arithmetic nobody wrote down. So the window is not created in the first
 * place, and the count that IS established is made server-authoritative.
 *
 * Multi-session counting, approval, recount and tolerance are therefore
 * deferred rather than approximated. Adding them later needs this table and a
 * cutoff policy — not a rewrite of what is here.
 *
 * ══ Why the count posts through the I2 adjustment engine ═════════════════════
 *
 * A count variance IS an inventory adjustment, and I2 already decides every
 * question one raises: gain account for a positive, loss account for a
 * negative, both resolved from the company profile and re-checked at posting;
 * an inbound costed at the item's current average unless a validated cost is
 * supplied; an outbound costed by the weighted average; one balanced journal;
 * period locks; backdating refused behind an item's last movement.
 *
 * So this table records the OBSERVATION — what was expected, what was counted,
 * what the difference was — and points at the adjustment document that settled
 * it. There is one movement engine and one costing rule. A second would be a
 * second answer, and the two would diverge the first time either changed.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/** The states a count can actually reach. There are two. */
const COUNT_STATUSES = ['posted', 'reversed'].map((s) => `'${s}'`).join(',');

export async function up(db: AnyKysely): Promise<void> {
  /* ── The count ──────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS stock_counts (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id            uuid NOT NULL,
      count_number          text NOT NULL,
      warehouse_id          uuid NOT NULL,
      /* The day the shelves were walked, and the day the books take it. */
      count_date            date NOT NULL,
      posting_date          date NOT NULL,
      status                text NOT NULL DEFAULT 'posted',
      memo                  text NOT NULL DEFAULT '',
      /*
       * The adjustment this count produced, and through it the journal. A count
       * whose every line agreed with the books moves nothing and posts nothing,
       * so both are nullable — and that is a real outcome worth recording,
       * not an absence.
       */
      adjustment_document_id uuid,
      /* A retry finds what it already made instead of making a second one. */
      idempotency_key       text NOT NULL,
      reversal_of_count_id  uuid,
      reversed_by_count_id  uuid,
      reversal_reason       text NOT NULL DEFAULT '',
      version               integer NOT NULL DEFAULT 1,
      counted_by            uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT stock_counts_company_unique UNIQUE (organization_id, company_id, id),
      CONSTRAINT stock_counts_number_unique
        UNIQUE (organization_id, company_id, count_number),
      CONSTRAINT stock_counts_key_unique
        UNIQUE (organization_id, company_id, idempotency_key),
      CONSTRAINT stock_counts_status_ck CHECK (status IN (${sql.raw(COUNT_STATUSES)})),
      CONSTRAINT stock_counts_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT stock_counts_warehouse_fk
        FOREIGN KEY (organization_id, company_id, warehouse_id)
        REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT stock_counts_adjustment_fk
        FOREIGN KEY (organization_id, company_id, adjustment_document_id)
        REFERENCES inventory_documents (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT stock_counts_reversal_of_fk
        FOREIGN KEY (organization_id, company_id, reversal_of_count_id)
        REFERENCES stock_counts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT stock_counts_reversed_by_fk
        FOREIGN KEY (organization_id, company_id, reversed_by_count_id)
        REFERENCES stock_counts (organization_id, company_id, id) ON DELETE RESTRICT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS stock_counts_warehouse_idx
      ON stock_counts (organization_id, company_id, warehouse_id, posting_date)
  `.execute(db);

  /* ── What was expected, what was found, and the difference ──────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS stock_count_lines (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      count_id          uuid NOT NULL,
      line_number       integer NOT NULL,
      item_id           uuid NOT NULL,
      base_unit_id      uuid NOT NULL,
      /*
       * All three are stored, and the third is not derivable from a later read
       * of the other two: the expected quantity is what the books said at the
       * moment of posting, and re-deriving it next year would answer a
       * different question.
       */
      expected_quantity numeric(28,10) NOT NULL,
      counted_quantity  numeric(28,10) NOT NULL,
      variance_quantity numeric(28,10) NOT NULL,
      /* What the variance was costed at, and what it came to. Zero-variance
       * lines carry zero, because nothing moved. */
      unit_cost         numeric(28,10) NOT NULL DEFAULT 0,
      variance_value    numeric(28,10) NOT NULL DEFAULT 0,
      /* Frozen identity, so a renamed or archived item still reads correctly. */
      item_code         text NOT NULL,
      item_name         text NOT NULL,
      base_unit_code    text NOT NULL,
      note              text NOT NULL DEFAULT '',
      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT stock_count_lines_company_unique UNIQUE (organization_id, company_id, id),
      /* One observation per item. The same shelf cannot be counted twice into
       * one document and produce two different truths. */
      CONSTRAINT stock_count_lines_item_unique UNIQUE (count_id, item_id),
      CONSTRAINT stock_count_lines_line_unique UNIQUE (count_id, line_number),
      /* Counted is a physical observation. There is no negative shelf. */
      CONSTRAINT stock_count_lines_counted_ck CHECK (counted_quantity >= 0),
      /* The server computes this; the constraint means a client cannot send a
       * variance that disagrees with the two quantities beside it. */
      CONSTRAINT stock_count_lines_variance_ck
        CHECK (variance_quantity = counted_quantity - expected_quantity),
      CONSTRAINT stock_count_lines_count_fk
        FOREIGN KEY (organization_id, company_id, count_id)
        REFERENCES stock_counts (organization_id, company_id, id) ON DELETE CASCADE,
      CONSTRAINT stock_count_lines_item_fk
        FOREIGN KEY (organization_id, company_id, item_id)
        REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT stock_count_lines_unit_fk
        FOREIGN KEY (organization_id, company_id, base_unit_id)
        REFERENCES units_of_measure (organization_id, company_id, id) ON DELETE RESTRICT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS stock_count_lines_count_idx
      ON stock_count_lines (organization_id, company_id, count_id, line_number)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS stock_count_lines_item_idx
      ON stock_count_lines (organization_id, company_id, item_id)
  `.execute(db);

  /* ── Counting numbering, alongside the document numbering it mirrors ────── */

  await sql`
    CREATE TABLE IF NOT EXISTS stock_count_numbering (
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      prefix            text NOT NULL DEFAULT 'SC-',
      include_year      boolean NOT NULL DEFAULT true,
      sequence_length   integer NOT NULL DEFAULT 4,
      next_sequence     integer NOT NULL DEFAULT 1,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id),
      CONSTRAINT stock_count_numbering_sequence_ck CHECK (next_sequence > 0),
      CONSTRAINT stock_count_numbering_length_ck
        CHECK (sequence_length BETWEEN 1 AND 12)
    )
  `.execute(db);

  /* ── A posted count is a fact ────────────────────────────────────────────── */

  /*
   * The same shape the movement ledger uses, and for the same reason: every
   * figure a reader could rely on is frozen, and the only permitted transition
   * is becoming reversed, once. DELETE is permitted solely inside a sanctioned
   * purge, which is what keeps a company that has counted its stock deletable.
   */
  await sql`
    CREATE OR REPLACE FUNCTION stock_count_is_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION
          'A posted stock count cannot be deleted. Reverse it instead: the count, its adjustment '
          'and its journal are the record of what was on the shelves that day.';
      END IF;

      /*
       * Everything is frozen EXCEPT the withdrawal itself.
       *
       * Stated as an allow-list rather than a list of protected columns: a
       * deny-list silently permits whatever it forgets, and the column it
       * forgets is the one somebody edits. Only the transition to reversed and
       * the fields that record it may move.
       */
      IF ROW(NEW.count_number, NEW.warehouse_id, NEW.count_date, NEW.posting_date,
             NEW.memo, NEW.adjustment_document_id, NEW.idempotency_key,
             NEW.reversal_of_count_id, NEW.counted_by, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.count_number, OLD.warehouse_id, OLD.count_date, OLD.posting_date,
             OLD.memo, OLD.adjustment_document_id, OLD.idempotency_key,
             OLD.reversal_of_count_id, OLD.counted_by, OLD.created_at) THEN
        RAISE EXCEPTION
          'A posted stock count cannot be edited. What was counted on a date does not change; '
          'record a later count, or reverse this one.';
      END IF;

      /* The only permitted transition, and only once. */
      IF NEW.status IS DISTINCT FROM OLD.status
         AND NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
        RAISE EXCEPTION
          'A stock count moves from posted to reversed, once, and nowhere else.';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS stock_count_immutable ON stock_counts`.execute(db);
  await sql`
    CREATE TRIGGER stock_count_immutable
      BEFORE UPDATE OR DELETE ON stock_counts
      FOR EACH ROW EXECUTE FUNCTION stock_count_is_immutable()
  `.execute(db);

  /* A line never changes at all: it has no state to move through. */
  await sql`
    CREATE OR REPLACE FUNCTION stock_count_line_is_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'A counted line cannot be deleted. Reverse the count instead.';
      END IF;
      RAISE EXCEPTION
        'A counted line cannot be edited. What somebody counted is an observation, not a figure '
        'to be revised.';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS stock_count_line_immutable ON stock_count_lines`.execute(db);
  await sql`
    CREATE TRIGGER stock_count_line_immutable
      BEFORE UPDATE OR DELETE ON stock_count_lines
      FOR EACH ROW EXECUTE FUNCTION stock_count_line_is_immutable()
  `.execute(db);
}

/**
 * Down refuses to destroy what was on the shelves.
 *
 * A posted count is the evidence behind an adjustment that is still in the
 * ledger. Dropping it would leave the movement and the journal standing with
 * nothing saying why the quantity changed.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ counts: string }>`
    SELECT COUNT(*)::text AS counts FROM stock_counts
  `.execute(db);
  const counts = Number(rows[0]?.counts ?? '0');
  if (counts > 0) {
    throw new Error(
      `Refusing to roll back 041: ${counts} stock count(s) have been posted. Their adjustments and `
      + 'journals remain in the ledger, and dropping the counts would leave a quantity change with '
      + 'nothing behind it saying what was on the shelves. Remedy: reverse those counts and delete '
      + 'them deliberately, then roll back.',
    );
  }

  await sql`DROP TRIGGER IF EXISTS stock_count_line_immutable ON stock_count_lines`.execute(db);
  await sql`DROP FUNCTION IF EXISTS stock_count_line_is_immutable()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS stock_count_immutable ON stock_counts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS stock_count_is_immutable()`.execute(db);
  await sql`DROP TABLE IF EXISTS stock_count_numbering`.execute(db);
  await sql`DROP TABLE IF EXISTS stock_count_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS stock_counts`.execute(db);
}
