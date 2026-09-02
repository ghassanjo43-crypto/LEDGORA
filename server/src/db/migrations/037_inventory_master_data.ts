/**
 * Inventory I1 — master data only: items, units, warehouses and the accounting
 * profile a later slice will post through.
 *
 * ══ What this migration deliberately does NOT create ═════════════════════════
 *
 * No quantity, no value, no movement, no valuation layer, no cost. There is no
 * `quantity_on_hand` column here and no table that could hold one. That is the
 * point: an item is a NAME for something the books may later track, and a
 * balance is the sum of posted movements. A stored on-hand column would be a
 * second answer that drifts from the ledger the first time anything fails
 * halfway, and no amount of care afterwards can say which one was right.
 *
 * Stock movements, receipts, issues, transfers, adjustments and cost of sales
 * are I2. Nothing here implies they exist.
 *
 * ══ Why units carry no conversion ════════════════════════════════════════════
 *
 * The product's unit model is code, name, symbol, category and decimal places —
 * and nothing else. There is no conversion factor anywhere in it, and no
 * function that converts. Inventing one would mean deciding, unilaterally, how
 * many of something is in a box, which is a question only the business it
 * belongs to can answer. So an item names ONE base unit, and conversion is
 * deferred with the rest of the movement machinery.
 *
 * ══ Why item categories are absent ═══════════════════════════════════════════
 *
 * The browser has them, and they carry account defaults that sit between the
 * item and company settings in the resolution chain. They are omitted here
 * because I1 posts nothing, so the middle of a precedence chain has nothing to
 * resolve yet; adding the table now would ship a mapping layer no code reads.
 * `category_id` returns with the movements that need it.
 *
 * ══ Existing rows: halt, never invent ════════════════════════════════════════
 *
 * `invoice_lines` has carried a bare `item_id` — and an `inventory_item_id`
 * beside it — since before the server held items. Any value in either came from
 * a browser catalogue this database never saw, so no mapping exists that this
 * migration could apply without inventing which product an issued invoice sold.
 * It therefore REFUSES rather than guessing, exactly as 031 does for customers
 * and 032 for tax codes.
 *
 * `bill_lines` is not checked because it has no item column at all: the bill
 * service refuses a stocked line before anything is written, so there is no
 * column in which a stale reference could be hiding.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/** The 11 established item types. Meaning is preserved, not reinterpreted. */
const ITEM_TYPES = [
  'inventory', 'non-inventory', 'service', 'raw-material', 'component',
  'subassembly', 'finished-good', 'packaging', 'consumable', 'spare-part', 'scrap',
].map((t) => `'${t}'`).join(',');

/** The 10 established warehouse types. */
const WAREHOUSE_TYPES = [
  'main', 'raw-material', 'wip', 'finished-goods', 'returns',
  'quarantine', 'scrap', 'site', 'transit', 'virtual',
].map((t) => `'${t}'`).join(',');

const UNIT_CATEGORIES = [
  'quantity', 'weight', 'volume', 'length', 'area', 'time', 'custom',
].map((t) => `'${t}'`).join(',');

/**
 * The two types that can never be stock, whatever a client claims.
 *
 * Expressed as a CHECK rather than a service branch because a service branch is
 * one careless edit away from being deleted, and this is the constraint that
 * stops a caller marking a tracked good "service" to slip past the subledger
 * that has not been built yet.
 */
const NEVER_TRACKED = `'service','non-inventory'`;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Preconditions: refuse rather than invent a mapping ─────────────────── */

  for (const column of ['item_id', 'inventory_item_id'] as const) {
    const { rows } = await sql<{ n: string; sample: string | null }>`
      SELECT COUNT(*)::text AS n, MIN(i.invoice_number) AS sample
        FROM invoice_lines l
        JOIN invoices i ON i.id = l.invoice_id
       WHERE l.${sql.raw(column)} IS NOT NULL
    `.execute(db);
    const count = Number(rows[0]?.n ?? '0');
    if (count > 0) {
      throw new Error(
        `Refusing to create the item register: ${count} invoice line(s) already name an item in `
        + `${column} (for example invoice ${rows[0]?.sample ?? 'unknown'}), and no server item `
        + 'exists yet. Those ids came from a browser catalogue the server never held, so there is '
        + 'no mapping this migration could apply without inventing which product an issued invoice '
        + 'sold. Remedy: create the matching items through /api/inventory/items and repoint the '
        + 'lines, or — if the invoices are disposable development data — delete them, then run '
        + 'this again.',
      );
    }
  }

  /* ── Units of measure ───────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS units_of_measure (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      code              text NOT NULL,
      name              text NOT NULL,
      symbol            text NOT NULL DEFAULT '',
      category          text NOT NULL,
      /*
       * Quantity precision, and deliberately NOT currency precision. A kilogram
       * is weighed to three places in books that round money to two, and tying
       * the two together would silently re-round every weight the day a company
       * changed its currency.
       */
      decimal_places    integer NOT NULL DEFAULT 0,
      status            text NOT NULL DEFAULT 'active',
      /** Seeded reference data, protected from archival while items exist. */
      is_system         boolean NOT NULL DEFAULT false,
      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      updated_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT units_of_measure_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT units_of_measure_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT units_of_measure_category_ck CHECK (category IN (${sql.raw(UNIT_CATEGORIES)})),
      CONSTRAINT units_of_measure_status_ck CHECK (status IN ('active','inactive','archived')),
      CONSTRAINT units_of_measure_dp_ck CHECK (decimal_places BETWEEN 0 AND 6)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS units_of_measure_code_uidx
      ON units_of_measure (organization_id, company_id, lower(code))
  `.execute(db);

  /* ── Warehouses ─────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS warehouses (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      code              text NOT NULL,
      name              text NOT NULL,
      description       text NOT NULL DEFAULT '',
      warehouse_type    text NOT NULL DEFAULT 'main',
      location          text NOT NULL DEFAULT '',
      status            text NOT NULL DEFAULT 'active',
      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      updated_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT warehouses_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT warehouses_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT warehouses_type_ck CHECK (warehouse_type IN (${sql.raw(WAREHOUSE_TYPES)})),
      CONSTRAINT warehouses_status_ck CHECK (status IN ('active','inactive','archived'))
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS warehouses_code_uidx
      ON warehouses (organization_id, company_id, lower(code))
  `.execute(db);

  /* ── Items ──────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id            uuid NOT NULL,

      /*
       * One identifier, called both things. The product's own form labels this
       * field "Item code / SKU"; there is no second column, and adding one
       * would invent a distinction the business has never made.
       */
      item_code             text NOT NULL,
      barcode               text,
      name                  text NOT NULL,
      name_secondary        text NOT NULL DEFAULT '',
      description           text NOT NULL DEFAULT '',

      item_type             text NOT NULL,
      is_inventory_tracked  boolean NOT NULL DEFAULT false,
      is_purchasable        boolean NOT NULL DEFAULT true,
      is_sellable           boolean NOT NULL DEFAULT true,
      tracking_mode         text NOT NULL DEFAULT 'none',
      valuation_method      text NOT NULL DEFAULT 'weighted-average',

      base_unit_id          uuid NOT NULL,

      /*
       * Defaults a form copies onto a line, and nothing more. Invoice and bill
       * totals are computed by their own services from what was actually sent;
       * a price here has never overridden a posted figure and must not start.
       */
      default_selling_price   numeric(20,10),
      default_purchase_price  numeric(20,10),
      standard_cost           numeric(20,10),
      sales_description       text NOT NULL DEFAULT '',
      purchase_description    text NOT NULL DEFAULT '',

      sales_tax_code_id     uuid,
      purchase_tax_code_id  uuid,

      /* Item-level account overrides. Company settings sit behind them. */
      inventory_account_id             uuid,
      cogs_account_id                  uuid,
      sales_account_id                 uuid,
      purchase_account_id              uuid,
      inventory_adjustment_account_id  uuid,

      status                text NOT NULL DEFAULT 'active',
      version               integer NOT NULL DEFAULT 1,
      created_by            uuid,
      updated_by            uuid,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT inventory_items_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT inventory_items_scoped_key UNIQUE (organization_id, company_id, id),

      /* A unit from another company is not a unit this item may name. */
      CONSTRAINT inventory_items_base_unit_fk
        FOREIGN KEY (organization_id, company_id, base_unit_id)
        REFERENCES units_of_measure (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_sales_tax_fk
        FOREIGN KEY (organization_id, company_id, sales_tax_code_id)
        REFERENCES tax_codes (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_purchase_tax_fk
        FOREIGN KEY (organization_id, company_id, purchase_tax_code_id)
        REFERENCES tax_codes (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_inventory_account_fk
        FOREIGN KEY (organization_id, company_id, inventory_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_cogs_account_fk
        FOREIGN KEY (organization_id, company_id, cogs_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_sales_account_fk
        FOREIGN KEY (organization_id, company_id, sales_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_purchase_account_fk
        FOREIGN KEY (organization_id, company_id, purchase_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_items_adjustment_account_fk
        FOREIGN KEY (organization_id, company_id, inventory_adjustment_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT inventory_items_type_ck CHECK (item_type IN (${sql.raw(ITEM_TYPES)})),
      CONSTRAINT inventory_items_tracking_ck CHECK (tracking_mode IN ('none','lot','serial')),
      CONSTRAINT inventory_items_valuation_ck
        CHECK (valuation_method IN ('weighted-average','standard','fifo')),
      CONSTRAINT inventory_items_status_ck CHECK (status IN ('active','inactive','archived')),

      /* A service is not stock. Enforced here so no service branch can drop it. */
      CONSTRAINT inventory_items_service_not_tracked_ck
        CHECK (item_type NOT IN (${sql.raw(NEVER_TRACKED)}) OR is_inventory_tracked = false),
      /* Something nobody may buy and nobody may sell is not a catalogue entry. */
      CONSTRAINT inventory_items_usable_ck
        CHECK (is_sellable OR is_purchasable),
      /* Money defaults are amounts, never negative ones. */
      CONSTRAINT inventory_items_prices_ck CHECK (
        coalesce(default_selling_price, 0) >= 0
        AND coalesce(default_purchase_price, 0) >= 0
        AND coalesce(standard_cost, 0) >= 0
      ),
      /* An empty barcode is no barcode; NULL keeps the partial index honest. */
      CONSTRAINT inventory_items_barcode_ck CHECK (barcode IS NULL OR length(btrim(barcode)) > 0)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_code_uidx
      ON inventory_items (organization_id, company_id, lower(item_code))
  `.execute(db);

  /*
   * Barcodes are unique where present. A partial index rather than a plain one:
   * most catalogues have a handful of scanned goods among many that are not,
   * and NULLs must not collide with each other.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_barcode_uidx
      ON inventory_items (organization_id, company_id, lower(barcode))
      WHERE barcode IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_items_company_idx
      ON inventory_items (organization_id, company_id, status)
  `.execute(db);

  /* ── The company's inventory accounting profile ──────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_settings (
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      default_valuation_method  text NOT NULL DEFAULT 'weighted-average',
      default_warehouse_id      uuid,

      default_inventory_account_id   uuid,
      default_cogs_account_id        uuid,
      default_sales_account_id       uuid,
      /* Where a NON-STOCK item's purchase goes: an expense, not an asset. */
      default_purchase_account_id    uuid,
      inventory_gain_account_id      uuid,
      inventory_loss_account_id      uuid,
      stock_in_transit_account_id    uuid,

      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      updated_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id),
      CONSTRAINT inventory_settings_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT inventory_settings_warehouse_fk
        FOREIGN KEY (organization_id, company_id, default_warehouse_id)
        REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_inventory_account_fk
        FOREIGN KEY (organization_id, company_id, default_inventory_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_cogs_account_fk
        FOREIGN KEY (organization_id, company_id, default_cogs_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_sales_account_fk
        FOREIGN KEY (organization_id, company_id, default_sales_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_purchase_account_fk
        FOREIGN KEY (organization_id, company_id, default_purchase_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_gain_account_fk
        FOREIGN KEY (organization_id, company_id, inventory_gain_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_loss_account_fk
        FOREIGN KEY (organization_id, company_id, inventory_loss_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_transit_account_fk
        FOREIGN KEY (organization_id, company_id, stock_in_transit_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT inventory_settings_valuation_ck
        CHECK (default_valuation_method IN ('weighted-average','standard'))
    )
  `.execute(db);

  /* ── Audit ──────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_audit_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      /* 'item' | 'warehouse' | 'unit' | 'settings' */
      subject_type      text NOT NULL,
      subject_id        uuid,
      action            text NOT NULL,
      resulting_version integer,
      detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
      actor_user_id     uuid,
      actor_name        text NOT NULL DEFAULT '',
      request_id        text NOT NULL DEFAULT '',
      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT inventory_audit_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT inventory_audit_subject_ck
        CHECK (subject_type IN ('item','warehouse','unit','settings'))
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_audit_subject_idx
      ON inventory_audit_events (organization_id, company_id, subject_type, subject_id, created_at DESC)
  `.execute(db);
}

/**
 * Down refuses to destroy real master data.
 *
 * A rollback that silently dropped a catalogue somebody had spent a week typing
 * would be indistinguishable, afterwards, from a bug. Empty registers roll back
 * freely — that is the case a failed deploy actually needs.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ items: string; warehouses: string; units: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM inventory_items)  AS items,
      (SELECT COUNT(*)::text FROM warehouses)       AS warehouses,
      (SELECT COUNT(*)::text FROM units_of_measure WHERE is_system = false) AS units
  `.execute(db);

  const items = Number(rows[0]?.items ?? '0');
  const warehouses = Number(rows[0]?.warehouses ?? '0');
  const units = Number(rows[0]?.units ?? '0');

  if (items > 0 || warehouses > 0 || units > 0) {
    throw new Error(
      `Refusing to roll back 037: it would destroy ${items} item(s), ${warehouses} warehouse(s) `
      + `and ${units} user-defined unit(s) of durable master data. Seeded units are not counted — `
      + 'they are reference data this migration created. Remedy: export or delete the catalogue '
      + 'deliberately, then roll back.',
    );
  }

  await sql`DROP TABLE IF EXISTS inventory_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_settings`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_items`.execute(db);
  await sql`DROP TABLE IF EXISTS warehouses`.execute(db);
  await sql`DROP TABLE IF EXISTS units_of_measure`.execute(db);
}
