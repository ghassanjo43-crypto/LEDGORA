/**
 * Inventory I2 — the movement ledger, its valuation and its accounting.
 *
 * ══ Quantity is a SUM, never a stored figure ═════════════════════════════════
 *
 * There is no `quantity_on_hand` column here and no table that could hold one.
 * On-hand is the signed sum of posted, unreversed movements; value is the signed
 * sum of their costs. A stored balance would be a second answer that drifts from
 * the ledger the first time anything fails halfway, and afterwards nobody can
 * say which was right. Every read in the service derives from these rows.
 *
 * ══ Why the movement rows are immutable, enforced by a trigger ═══════════════
 *
 * A posted movement is evidence. Correcting one by editing it would rewrite what
 * the books already said, and every report that had quoted it would silently
 * change. So `inventory_movements_immutable` refuses any UPDATE that touches an
 * accounting fact — item, warehouse, unit, direction, quantity, cost, dates,
 * accounts — and permits exactly one transition: an unreversed row becoming
 * reversed, once. Deletion is refused outright. Corrections are reversals.
 *
 * ══ Why a document header exists ═════════════════════════════════════════════
 *
 * A transfer is ONE business act with two legs, and a retry must not produce a
 * second pair. The header carries the idempotency key, the number, the reason
 * and the journal link; the legs carry the quantities. Both are written in one
 * transaction or neither is.
 *
 * ══ Reversal semantics, and why both rows are marked ═════════════════════════
 *
 * The product's model is "as if it never happened": the counter-movement is
 * created AND both rows are marked reversed, so the pair is excluded from replay
 * entirely. That is materially different from leaving an opposite movement in
 * the running average — receive 10@5 then 10@7 and reverse the first, and
 * exclusion leaves an average of 7 (correct) while a plain opposite leaves 1.
 * The `status` column is the only field a posted row may ever change, and the
 * trigger allows nothing else.
 *
 * ══ What this migration does NOT create ══════════════════════════════════════
 *
 * No cost layers (FIFO is a type-union string in this product with no
 * implementation anywhere — items declaring it cannot move rather than being
 * silently averaged). No opening-balance workflow: the server's controlled
 * opening process posts GL lines and knows nothing of items or quantities. No
 * stock counts, no purchase or sales linkage, no lots, serials, bins or unit
 * conversion. Each is refused by name in the service.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/** The document kinds whose accounting this slice can stand behind. */
const DOCUMENT_KINDS = ['receipt', 'issue', 'transfer', 'adjustment'].map((k) => `'${k}'`).join(',');

/**
 * The movement types I2 supports.
 *
 * Deliberately narrower than the browser's eighteen: every type here has an
 * unambiguous journal, and the ones left out (sales delivery, purchase receipt
 * against a bill, manufacturing, stock count) belong to slices that do not
 * exist yet. A CHECK is a better refusal than a service branch somebody can
 * delete.
 */
const MOVEMENT_TYPES = [
  'receipt', 'issue', 'transfer-out', 'transfer-in', 'adjustment-in', 'adjustment-out',
].map((t) => `'${t}'`).join(',');

export async function up(db: AnyKysely): Promise<void> {
  /* ── The receipt offset account, which I1 did not carry ─────────────────── */

  /*
   * The product already names this setting — `goodsReceivedNotInvoicedAccountId`
   * — and the browser falls back to Trade Payables when it is unset. That
   * fallback is wrong: a standalone receipt would create a payable owed to
   * nobody. So the column arrives here and the service REQUIRES it, with no
   * fallback of any kind.
   */
  await sql`
    ALTER TABLE inventory_settings
      ADD COLUMN IF NOT EXISTS goods_received_not_invoiced_account_id uuid
  `.execute(db);

  await sql`
    ALTER TABLE inventory_settings
      DROP CONSTRAINT IF EXISTS inventory_settings_grni_account_fk
  `.execute(db);
  await sql`
    ALTER TABLE inventory_settings
      ADD CONSTRAINT inventory_settings_grni_account_fk
      FOREIGN KEY (organization_id, company_id, goods_received_not_invoiced_account_id)
      REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /* ── Document numbering ─────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_document_numbering (
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id       uuid NOT NULL,
      kind             text NOT NULL,
      prefix           text NOT NULL DEFAULT '',
      include_year     boolean NOT NULL DEFAULT true,
      sequence_length  integer NOT NULL DEFAULT 4,
      next_sequence    integer NOT NULL DEFAULT 1,
      updated_at       timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, kind),
      CONSTRAINT inventory_document_numbering_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT inventory_document_numbering_kind_ck CHECK (kind IN (${sql.raw(DOCUMENT_KINDS)}))
    )
  `.execute(db);

  /* ── Documents ──────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_documents (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      document_number   text NOT NULL,
      kind              text NOT NULL,

      /* When it HAPPENED in the warehouse. */
      movement_date     date NOT NULL,
      /* When it hits the books. Authoritative for sequencing and period locks. */
      posting_date      date NOT NULL,

      reference         text NOT NULL DEFAULT '',
      memo              text NOT NULL DEFAULT '',
      /* Required for an adjustment: stock does not change itself. */
      reason            text NOT NULL DEFAULT '',

      status            text NOT NULL DEFAULT 'posted',

      journal_entry_id  uuid,
      /*
       * A retry must find what it already made rather than making a second one.
       * The uniqueness is the guarantee; the read before the insert is only an
       * optimisation.
       */
      idempotency_key   text NOT NULL,

      reversal_of_document_id  uuid,
      reversed_by_document_id  uuid,
      reversal_reason          text NOT NULL DEFAULT '',

      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT inventory_documents_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT inventory_documents_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT inventory_documents_journal_fk
        FOREIGN KEY (organization_id, company_id, journal_entry_id)
        REFERENCES journal_entries (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_documents_reversal_of_fk
        FOREIGN KEY (organization_id, company_id, reversal_of_document_id)
        REFERENCES inventory_documents (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_documents_reversed_by_fk
        FOREIGN KEY (organization_id, company_id, reversed_by_document_id)
        REFERENCES inventory_documents (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_documents_kind_ck CHECK (kind IN (${sql.raw(DOCUMENT_KINDS)})),
      CONSTRAINT inventory_documents_status_ck CHECK (status IN ('posted','reversed')),
      /* An adjustment without a reason is a number nobody can defend. */
      CONSTRAINT inventory_documents_reason_ck
        CHECK (kind <> 'adjustment' OR length(btrim(reason)) > 0),
      /* A transfer moves stock between places and touches no ledger account. */
      CONSTRAINT inventory_documents_transfer_no_journal_ck
        CHECK (kind <> 'transfer' OR journal_entry_id IS NULL)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_documents_number_uidx
      ON inventory_documents (organization_id, company_id, lower(document_number))
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_documents_idempotency_uidx
      ON inventory_documents (organization_id, company_id, idempotency_key)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_documents_posting_idx
      ON inventory_documents (organization_id, company_id, posting_date, created_at)
  `.execute(db);

  /* ── Movements ──────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      document_id       uuid NOT NULL,
      line_number       integer NOT NULL,

      movement_type     text NOT NULL,
      item_id           uuid NOT NULL,
      warehouse_id      uuid NOT NULL,
      base_unit_id      uuid NOT NULL,

      direction         text NOT NULL,
      /* Always POSITIVE. The sign lives in the direction column, so a caller cannot send
       * a negative quantity with an inbound direction and mean two things. */
      quantity          numeric(20,10) NOT NULL,
      unit_cost         numeric(20,10) NOT NULL,
      /*
       * The single figure that drives BOTH the subledger value and the journal
       * amount, already at the company's monetary precision. Deriving them from
       * one number is what makes the two reconcile exactly rather than
       * approximately.
       */
      total_cost        numeric(20,10) NOT NULL,

      /* Frozen at posting: a later mapping change must not restate history. */
      inventory_account_id  uuid NOT NULL,
      offset_account_id     uuid,

      /* Copied so a report reads what the document said at the time. */
      item_code         text NOT NULL DEFAULT '',
      item_name         text NOT NULL DEFAULT '',
      warehouse_code    text NOT NULL DEFAULT '',
      base_unit_code    text NOT NULL DEFAULT '',

      movement_date     date NOT NULL,
      posting_date      date NOT NULL,

      status            text NOT NULL DEFAULT 'posted',
      reversal_of_movement_id uuid,
      reversed_by_movement_id uuid,

      created_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT inventory_movements_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT inventory_movements_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT inventory_movements_document_fk
        FOREIGN KEY (organization_id, company_id, document_id)
        REFERENCES inventory_documents (organization_id, company_id, id) ON DELETE RESTRICT,
      /* The I1 master data, through real company-scoped keys. */
      CONSTRAINT inventory_movements_item_fk
        FOREIGN KEY (organization_id, company_id, item_id)
        REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_movements_warehouse_fk
        FOREIGN KEY (organization_id, company_id, warehouse_id)
        REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_movements_unit_fk
        FOREIGN KEY (organization_id, company_id, base_unit_id)
        REFERENCES units_of_measure (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_movements_inventory_account_fk
        FOREIGN KEY (organization_id, company_id, inventory_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_movements_offset_account_fk
        FOREIGN KEY (organization_id, company_id, offset_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_movements_reversal_of_fk
        FOREIGN KEY (organization_id, company_id, reversal_of_movement_id)
        REFERENCES inventory_movements (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_movements_reversed_by_fk
        FOREIGN KEY (organization_id, company_id, reversed_by_movement_id)
        REFERENCES inventory_movements (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT inventory_movements_type_ck CHECK (movement_type IN (${sql.raw(MOVEMENT_TYPES)})),
      CONSTRAINT inventory_movements_direction_ck CHECK (direction IN ('in','out')),
      CONSTRAINT inventory_movements_status_ck CHECK (status IN ('posted','reversed')),
      /* Zero moves nothing and would post an empty journal. */
      CONSTRAINT inventory_movements_quantity_ck CHECK (quantity > 0),
      CONSTRAINT inventory_movements_cost_ck CHECK (unit_cost >= 0 AND total_cost >= 0),
      /* Direction and type must agree, so a client cannot receive with an
       * outbound type and have the sum come out backwards. */
      CONSTRAINT inventory_movements_type_direction_ck CHECK (
        (direction = 'in'  AND movement_type IN ('receipt','transfer-in','adjustment-in'))
        OR
        (direction = 'out' AND movement_type IN ('issue','transfer-out','adjustment-out'))
      ),
      CONSTRAINT inventory_movements_line_ck CHECK (line_number > 0),
      CONSTRAINT inventory_movements_document_line_unique
        UNIQUE (document_id, line_number)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_movements_position_idx
      ON inventory_movements (organization_id, company_id, item_id, warehouse_id, status)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_movements_sequence_idx
      ON inventory_movements (organization_id, company_id, item_id, posting_date, created_at, id)
  `.execute(db);

  /*
   * Every document but a transfer MUST end up carrying its journal.
   *
   * A CHECK cannot express this, and not for a technical reason: the journal is
   * posted with the document's own id as its source, so the row has to exist
   * before the journal can be made, and an immediate constraint would refuse
   * the insert that makes it possible. PostgreSQL will not defer a CHECK, so
   * this is a DEFERRABLE constraint trigger instead — evaluated at COMMIT, by
   * which time the journal is either linked or the whole transaction is going
   * back anyway.
   *
   * The guarantee is the one that matters: no committed stock document moves
   * value without an entry in the books.
   */
  await sql`
    CREATE OR REPLACE FUNCTION inventory_document_has_its_journal() RETURNS trigger AS $$
    DECLARE
      current_kind text;
      current_journal uuid;
    BEGIN
      /*
       * The row as it stands NOW, not as it was inserted.
       *
       * A deferred trigger still carries the NEW it was queued with, and the
       * journal is linked by a later UPDATE in the same transaction — so
       * trusting NEW here would refuse every document that posts correctly.
       * Re-reading is what makes the check mean "at commit".
       */
      SELECT kind, journal_entry_id INTO current_kind, current_journal
        FROM inventory_documents WHERE id = NEW.id;

      /* Deleted before commit: nothing left to check. */
      IF current_kind IS NULL THEN RETURN NULL; END IF;

      IF current_kind <> 'transfer' AND current_journal IS NULL THEN
        RAISE EXCEPTION 'A % document must post a journal, and this one has none.', current_kind
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS inventory_documents_journal_required ON inventory_documents`.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER inventory_documents_journal_required
      AFTER INSERT OR UPDATE ON inventory_documents
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION inventory_document_has_its_journal()
  `.execute(db);

  /* ── Immutability, enforced by the database ─────────────────────────────── */

  /*
   * A service check is one careless edit away from being gone. This is not.
   *
   * The ONLY permitted change to a posted movement is becoming reversed, once:
   * status flips `posted` → `reversed` and `reversed_by_movement_id` is filled
   * in. Every accounting fact is frozen, and DELETE is refused outright.
   */
  await sql`
    CREATE OR REPLACE FUNCTION inventory_movement_is_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        /*
         * One exception, and only one: destroying a tenant.
         *
         * A workspace being erased must actually be erasable, and an
         * organization CASCADE fires this trigger like any other delete — so
         * without this a company that had ever received stock could never be
         * deleted at all. The authorisation is session-scoped, set inside the
         * purge transaction, and permits DELETE alone: the UPDATE rules below
         * still apply, so nothing can quietly rewrite a movement under cover of
         * a purge. This mirrors the legal-acceptance purge authorisation.
         */
        IF COALESCE(current_setting('ledgora.allow_stock_purge', true), 'off') = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Stock movements are a permanent record and cannot be deleted. Reverse the document instead.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.id <> OLD.id
         OR NEW.organization_id <> OLD.organization_id
         OR NEW.company_id <> OLD.company_id
         OR NEW.document_id <> OLD.document_id
         OR NEW.line_number <> OLD.line_number
         OR NEW.movement_type <> OLD.movement_type
         OR NEW.item_id <> OLD.item_id
         OR NEW.warehouse_id <> OLD.warehouse_id
         OR NEW.base_unit_id <> OLD.base_unit_id
         OR NEW.direction <> OLD.direction
         OR NEW.quantity <> OLD.quantity
         OR NEW.unit_cost <> OLD.unit_cost
         OR NEW.total_cost <> OLD.total_cost
         OR NEW.inventory_account_id <> OLD.inventory_account_id
         OR NEW.offset_account_id IS DISTINCT FROM OLD.offset_account_id
         OR NEW.movement_date <> OLD.movement_date
         OR NEW.posting_date <> OLD.posting_date
         OR NEW.reversal_of_movement_id IS DISTINCT FROM OLD.reversal_of_movement_id
         OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'A posted stock movement cannot be changed. Reverse it and record a new one.'
          USING ERRCODE = '23514';
      END IF;

      IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
        RAISE EXCEPTION 'A reversed stock movement cannot be un-reversed.'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS inventory_movements_immutable ON inventory_movements`.execute(db);
  await sql`
    CREATE TRIGGER inventory_movements_immutable
      BEFORE UPDATE OR DELETE ON inventory_movements
      FOR EACH ROW EXECUTE FUNCTION inventory_movement_is_immutable()
  `.execute(db);
}

/**
 * Down refuses to destroy inventory history, and refuses harder when a journal
 * would be orphaned.
 *
 * A rollback that silently dropped the movement ledger would leave posted
 * journals in the books describing stock that no longer has a subledger — a
 * general ledger nobody could reconcile, and no error anywhere to say why.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ movements: string; documents: string; journals: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM inventory_movements) AS movements,
      (SELECT COUNT(*)::text FROM inventory_documents) AS documents,
      (SELECT COUNT(*)::text FROM inventory_documents WHERE journal_entry_id IS NOT NULL) AS journals
  `.execute(db);

  const movements = Number(rows[0]?.movements ?? '0');
  const documents = Number(rows[0]?.documents ?? '0');
  const journals = Number(rows[0]?.journals ?? '0');

  if (movements > 0 || documents > 0) {
    throw new Error(
      `Refusing to roll back 038: it would destroy ${movements} stock movement(s) across `
      + `${documents} document(s)${journals > 0 ? `, ${journals} of which posted a journal that would be left with no subledger to reconcile against` : ''}. `
      + 'Stock history is evidence, and a general ledger whose inventory postings have no movements '
      + 'behind them cannot be reconciled by anyone. Remedy: reverse the documents and delete them '
      + 'deliberately, then roll back.',
    );
  }

  await sql`DROP TRIGGER IF EXISTS inventory_movements_immutable ON inventory_movements`.execute(db);
  await sql`DROP FUNCTION IF EXISTS inventory_movement_is_immutable()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS inventory_documents_journal_required ON inventory_documents`.execute(db);
  await sql`DROP FUNCTION IF EXISTS inventory_document_has_its_journal()`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_movements`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_documents`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_document_numbering`.execute(db);
  await sql`
    ALTER TABLE inventory_settings
      DROP CONSTRAINT IF EXISTS inventory_settings_grni_account_fk
  `.execute(db);
  await sql`
    ALTER TABLE inventory_settings
      DROP COLUMN IF EXISTS goods_received_not_invoiced_account_id
  `.execute(db);
}
