/**
 * Fixed Assets F1 — the asset register and its accounting CONFIGURATION.
 *
 * ══ What this migration deliberately does NOT create ═════════════════════════
 *
 * No acquisition cost. No accumulated depreciation. No carrying amount. No
 * depreciation schedule, run, or line. No impairment, revaluation, disposal or
 * transfer. There is no column here that could hold any of them, and that is
 * the point: every one of those figures is the RESULT of a posted journal, and
 * a column holding it would be a second answer that drifts from the ledger the
 * first time anything fails halfway. Afterwards nobody can say which was right.
 *
 * The register names an asset and records the POLICY that will one day be
 * applied to it. Capitalisation, depreciation and disposal are F2/F3, and
 * nothing here implies they exist.
 *
 * ══ Why there is no `acquisition_cost`, when the browser has `originalCost` ═══
 *
 * Because the product has already decided, and decided the other way. The
 * browser's `createAsset` writes `originalCost: 0` unconditionally — with the
 * comment "Register balances always start empty — they are built by postings" —
 * and the New-asset drawer offers no cost field at all. Cost is first typed
 * into the PURCHASE form, which posts a voucher.
 *
 * So a cost column here would not be carrying an established field forward; it
 * would be creating a figure the product has never had, in the one place a
 * reader would reasonably mistake for the general ledger. `acquisition_cost`
 * arrives with the capitalisation that gives it a meaning.
 *
 * ══ Why only straight line, and why `none` is not a third method ═════════════
 *
 * `straight_line` is complete: monthly charge is (cost − residual) ÷ life in
 * months, and `monthsInclusive` fixes the convention as whole calendar months
 * counted from the start month inclusive.
 *
 * `reducing_balance` is NOT complete. The annual rate lives only on the asset —
 * `AssetCategory` has no default rate to copy onto one — so a category typed
 * "reducing balance" cannot state the policy it claims to. `units_of_production`
 * needs units consumed in the period, and this product has no usage source
 * anywhere. Both are refused by name rather than stored as a policy nothing can
 * evaluate.
 *
 * `none` is not a method with an unestablished formula; it is the ABSENCE of
 * depreciation, which land genuinely has and the shipped LAND category already
 * uses. It carries no life and no convention, so there is nothing about it to
 * get wrong.
 *
 * ══ Why the convention column has exactly one permitted value ════════════════
 *
 * `monthsInclusive(from, to)` is the whole of the product's proration policy:
 * whole calendar months, the start month counted in full, the end month counted
 * in full. There is no daily, half-month, mid-quarter or actual-days code
 * anywhere. Recording that as a CHECK with one value states the convention that
 * IS established and makes widening it a migration somebody has to write —
 * rather than a free-text column into which a client could put a word the
 * engine does not implement.
 *
 * ══ Accumulated depreciation, and the contra-asset question ══════════════════
 *
 * The chart of accounts DOES have an authoritative contra-asset representation,
 * and it is not a guess: `normal_balance` is NOT NULL and CHECK-constrained to
 * ('debit','credit'), and the shipped chart models "Accumulated depreciation —
 * PP&E" as `type ASSET, normalBalance CREDIT`. An asset account whose normal
 * balance is a credit is a contra-asset in this model, so that is the rule the
 * service enforces, and no arbitrary account is accepted in its place.
 *
 * What the chart does NOT have is a controlled non-current marker: `ifrs_category`
 * and `ifrs_subcategory` are free text. So the cost account is required to be an
 * ASSET with a DEBIT normal balance and not cash — every part of that is a
 * controlled column — and "non-current" is left to the chart's own structure
 * rather than asserted from a string comparison nobody could rely on.
 *
 * ══ Existing rows: nothing to map, and nothing invented ══════════════════════
 *
 * `bill_lines` has no capital-asset column: `billService` refuses a
 * `capitalAssetId` before anything is written, so there is no stored reference
 * that could be pointed at a register this migration creates. Browser asset
 * records are not imported — their category ids, account ids and costs came
 * from a workspace this database never held, and every mapping would be a
 * guess about somebody's fixed assets.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/**
 * The depreciation methods F1 can actually evaluate.
 *
 * Widening this list is a migration, deliberately: a method is a formula plus a
 * convention plus the inputs to state both, and adding a name without them
 * gives a client a policy the engine cannot honour.
 */
const METHODS = ['straight_line', 'none'] as const;

/** The one established proration convention. See the header. */
const CONVENTIONS = ['full_month'] as const;

/**
 * The pre-accounting lifecycle.
 *
 * `draft` — registered, configured, and carrying no accounting whatsoever.
 * `archived` — out of the pickers, still searchable, still auditable.
 *
 * Every other status the browser union carries — active, fully_depreciated,
 * impaired, held_for_sale, disposed — asserts that a posting happened. None can
 * be reached until the transition that earns it exists, so none is storable.
 */
const STATUSES = ['draft', 'archived'] as const;

const CATEGORY_STATUSES = ['active', 'archived'] as const;

function values(list: readonly string[]) {
  return sql`(${sql.join(list.map((value) => sql.lit(value)))})`;
}

export async function up(db: AnyKysely): Promise<void> {
  /* ── Categories ─────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS fixed_asset_categories (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      code              text NOT NULL,
      name              text NOT NULL,
      description       text NOT NULL DEFAULT '',

      /* Policy DEFAULTS a draft asset copies. Never read back by an asset that
       * has already copied them — see the service. */
      default_method            text NOT NULL DEFAULT 'straight_line',
      default_useful_life_months integer,
      /*
       * Residual as a PERCENTAGE, because that is what the product's category
       * has always held (defaultResidualRatePercent), while the ASSET holds an
       * amount. The two are not the same field and are not silently converted:
       * converting needs a cost, and F1 has none.
       */
      default_residual_percent  numeric(9,6) NOT NULL DEFAULT 0,
      depreciation_convention   text NOT NULL DEFAULT 'full_month',

      /*
       * The three mappings F1 can validate. Nullable, exactly as an item's
       * account overrides are: a category may be created before the chart has
       * the account it needs, and the configuration report names what is
       * missing. What is NOT permitted is an unsuitable account — see the
       * service, which refuses by reason.
       *
       * Impairment, revaluation, disposal gain/loss, proceeds and AUC accounts
       * are absent. Each belongs to a posting F1 does not perform, and their
       * eligibility rules are part of the decision that posting has not made.
       */
      asset_cost_account_id                 uuid,
      accumulated_depreciation_account_id   uuid,
      depreciation_expense_account_id       uuid,

      status            text NOT NULL DEFAULT 'active',
      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      updated_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT fixed_asset_categories_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      /* The target an asset's scoped FK points at: same organization, same company. */
      CONSTRAINT fixed_asset_categories_scoped_key UNIQUE (organization_id, company_id, id),

      /*
       * Composite account keys, so an account belonging to another company is
       * not merely refused by a service — it is unrepresentable. A service
       * check can be edited away; this cannot.
       */
      CONSTRAINT fixed_asset_categories_cost_account_fk
        FOREIGN KEY (organization_id, company_id, asset_cost_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT fixed_asset_categories_accum_account_fk
        FOREIGN KEY (organization_id, company_id, accumulated_depreciation_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT fixed_asset_categories_expense_account_fk
        FOREIGN KEY (organization_id, company_id, depreciation_expense_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT fixed_asset_categories_method_ck
        CHECK (default_method IN ${values(METHODS)}),
      CONSTRAINT fixed_asset_categories_convention_ck
        CHECK (depreciation_convention IN ${values(CONVENTIONS)}),
      CONSTRAINT fixed_asset_categories_status_ck
        CHECK (status IN ${values(CATEGORY_STATUSES)}),
      /*
       * A life belongs to a method that consumes one. Straight line must have a
       * positive life; 'none' must have none at all, because a life on an asset
       * that never depreciates is a number nothing will ever read.
       */
      CONSTRAINT fixed_asset_categories_life_ck CHECK (
        (default_method = 'none' AND default_useful_life_months IS NULL)
        OR (default_method <> 'none'
            AND default_useful_life_months IS NOT NULL
            AND default_useful_life_months BETWEEN 1 AND 1200)
      ),
      CONSTRAINT fixed_asset_categories_residual_ck
        CHECK (default_residual_percent >= 0 AND default_residual_percent <= 100),
      /*
       * One account cannot be two sides of the same voucher. Depreciation is
       * Dr expense / Cr accumulated depreciation against a cost account that is
       * touched by neither; collapsing any pair would make the entry F2 posts
       * meaningless before it was ever written.
       */
      CONSTRAINT fixed_asset_categories_distinct_accounts_ck CHECK (
        (asset_cost_account_id IS NULL
          OR accumulated_depreciation_account_id IS NULL
          OR asset_cost_account_id <> accumulated_depreciation_account_id)
        AND (asset_cost_account_id IS NULL
          OR depreciation_expense_account_id IS NULL
          OR asset_cost_account_id <> depreciation_expense_account_id)
        AND (accumulated_depreciation_account_id IS NULL
          OR depreciation_expense_account_id IS NULL
          OR accumulated_depreciation_account_id <> depreciation_expense_account_id)
      ),
      CONSTRAINT fixed_asset_categories_code_ck CHECK (length(btrim(code)) > 0),
      CONSTRAINT fixed_asset_categories_name_ck CHECK (length(btrim(name)) > 0)
    )
  `.execute(db);

  /*
   * Case-insensitive, per company. "MACH" and "mach" are one category code to
   * everybody who reads a register, and two rows would be two policies wearing
   * the same name. Read-before-write cannot close the race; this can.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS fixed_asset_categories_code_uidx
      ON fixed_asset_categories (organization_id, company_id, lower(code))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS fixed_asset_categories_company_idx
      ON fixed_asset_categories (organization_id, company_id, status)
  `.execute(db);

  /* ── The register ───────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      asset_code        text NOT NULL,
      name              text NOT NULL,
      description       text NOT NULL DEFAULT '',
      category_id       uuid NOT NULL,

      /*
       * When the business acquired the thing. A register fact, and the only
       * date F1 can honestly hold beside the policy one below.
       *
       * The capitalization_date column is absent on purpose. In this product it is
       * written BY the acquisition posting, and a column a client could fill in
       * would let somebody claim an asset was capitalised on a date no voucher
       * supports. It arrives with the posting that sets it.
       */
      acquisition_date          date NOT NULL,
      /*
       * A POLICY input: the month from which depreciation is intended to run.
       * Optional, because the product's own fallback chain is start date, then
       * capitalisation date, then acquisition date — and only the first and the
       * last exist here.
       */
      depreciation_start_date   date,

      /*
       * Policy the asset FROZE from its category at creation. Stored on the row
       * rather than read through the category, so editing a category default
       * cannot silently re-price an asset somebody already configured.
       */
      depreciation_method       text NOT NULL DEFAULT 'straight_line',
      useful_life_months        integer,
      depreciation_convention   text NOT NULL DEFAULT 'full_month',
      /*
       * Residual as an AMOUNT, matching the product's asset-level field, at the
       * exact scale the accounting engine uses everywhere. Never a float.
       *
       * It cannot be checked against a cost, because F1 holds no cost. That
       * check belongs to the capitalisation that first states one.
       */
      residual_value            numeric(28,10) NOT NULL DEFAULT 0,

      /*
       * How many identical units this ONE record represents. The product has
       * always allowed it — partial disposal by units depends on it — so it is
       * carried rather than reinvented later. It is not a quantity on hand and
       * nothing values it.
       */
      quantity                  integer NOT NULL DEFAULT 1,

      /* Descriptive, exactly as the product holds them. Not entities: there is
       * no location register and no custodian register to point at, and
       * inventing either would make a free-text note into a master record. */
      location          text NOT NULL DEFAULT '',
      custodian         text NOT NULL DEFAULT '',
      branch            text NOT NULL DEFAULT '',
      department        text NOT NULL DEFAULT '',

      /*
       * Where it came from, as SOURCE INFORMATION and nothing else. A supplier
       * here creates no bill, settles nothing, and is not a capitalisation
       * route: billService goes on refusing a capital-asset line, and this
       * column gives it no reason to stop.
       */
      supplier_party_id         uuid,
      purchase_reference        text NOT NULL DEFAULT '',

      notes             text NOT NULL DEFAULT '',

      status            text NOT NULL DEFAULT 'draft',
      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      updated_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT fixed_assets_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT fixed_assets_scoped_key UNIQUE (organization_id, company_id, id),

      /* A category from another company is not a category this asset may name. */
      CONSTRAINT fixed_assets_category_fk
        FOREIGN KEY (organization_id, company_id, category_id)
        REFERENCES fixed_asset_categories (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT fixed_assets_supplier_fk
        FOREIGN KEY (organization_id, company_id, supplier_party_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT fixed_assets_method_ck
        CHECK (depreciation_method IN ${values(METHODS)}),
      CONSTRAINT fixed_assets_convention_ck
        CHECK (depreciation_convention IN ${values(CONVENTIONS)}),
      CONSTRAINT fixed_assets_status_ck CHECK (status IN ${values(STATUSES)}),
      CONSTRAINT fixed_assets_life_ck CHECK (
        (depreciation_method = 'none' AND useful_life_months IS NULL)
        OR (depreciation_method <> 'none'
            AND useful_life_months IS NOT NULL
            AND useful_life_months BETWEEN 1 AND 1200)
      ),
      CONSTRAINT fixed_assets_residual_ck CHECK (residual_value >= 0),
      CONSTRAINT fixed_assets_quantity_ck CHECK (quantity >= 1),
      CONSTRAINT fixed_assets_code_ck CHECK (length(btrim(asset_code)) > 0),
      CONSTRAINT fixed_assets_name_ck CHECK (length(btrim(name)) > 0),
      /*
       * Depreciation cannot be intended to start before the business owned the
       * thing. The one relationship between the two dates that holds whatever
       * the later posting decides.
       */
      CONSTRAINT fixed_assets_start_after_acquisition_ck
        CHECK (depreciation_start_date IS NULL OR depreciation_start_date >= acquisition_date)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_code_uidx
      ON fixed_assets (organization_id, company_id, lower(asset_code))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS fixed_assets_company_idx
      ON fixed_assets (organization_id, company_id, status)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS fixed_assets_category_idx
      ON fixed_assets (organization_id, company_id, category_id)
  `.execute(db);

  /* ── Held numbering ─────────────────────────────────────────────────────── */

  /*
   * The sequence is HELD, never derived from a MAX over the register. Counting
   * rows reuses a code after an archive-and-replace, and two assets that have
   * ever shared a code cannot be told apart in a history afterwards.
   *
   * Shaped exactly like `purchasing_document_numbering`, minus the year: the
   * product's own generator produces AST-0001, with no year in it.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS fixed_asset_numbering (
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id       uuid NOT NULL,
      kind             text NOT NULL,
      prefix           text NOT NULL DEFAULT 'AST-',
      sequence_length  integer NOT NULL DEFAULT 4,
      next_sequence    integer NOT NULL DEFAULT 1,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, kind),
      CONSTRAINT fixed_asset_numbering_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT fixed_asset_numbering_kind_ck CHECK (kind IN ('asset')),
      CONSTRAINT fixed_asset_numbering_length_ck CHECK (sequence_length BETWEEN 1 AND 12),
      CONSTRAINT fixed_asset_numbering_next_ck CHECK (next_sequence >= 1)
    )
  `.execute(db);

  /* ── Audit ──────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS fixed_asset_audit_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      /* 'category' | 'asset' */
      subject_type      text NOT NULL,
      subject_id        uuid,
      action            text NOT NULL,
      previous_version  integer,
      resulting_version integer,
      reason            text NOT NULL DEFAULT '',
      /* Before/after facts, as the service saw them. */
      detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
      actor_user_id     uuid,
      actor_name        text NOT NULL DEFAULT '',
      request_id        text NOT NULL DEFAULT '',
      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT fixed_asset_audit_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT fixed_asset_audit_subject_ck
        CHECK (subject_type IN ('category','asset'))
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS fixed_asset_audit_subject_idx
      ON fixed_asset_audit_events (organization_id, company_id, subject_type, subject_id, created_at DESC)
  `.execute(db);

  /*
   * ══ The trail is append-only ═════════════════════════════════════════════
   *
   * A history that can be edited is not a history. UPDATE is refused outright —
   * there is no legitimate reason to restate who did what, and no purge
   * authorisation lifts it.
   *
   * DELETE has exactly one exception, and it is the same one the stock ledger
   * and the legal acceptances have: a workspace being destroyed must actually
   * be destroyable, and an `organizations` CASCADE fires this trigger like any
   * other delete. The authorisation is session-scoped, set inside the purge
   * transaction, and permits DELETE alone — so nothing can rewrite a trail
   * under cover of a purge.
   */
  await sql`
    CREATE OR REPLACE FUNCTION fixed_asset_audit_is_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF COALESCE(current_setting('ledgora.allow_fixed_asset_purge', true), 'off') = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION
          'Fixed-asset history is a permanent record and cannot be deleted.'
          USING ERRCODE = '23514';
      END IF;

      RAISE EXCEPTION
        'Fixed-asset history cannot be edited. Record what actually happened next instead.'
        USING ERRCODE = '23514';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS fixed_asset_audit_append_only ON fixed_asset_audit_events
  `.execute(db);
  await sql`
    CREATE TRIGGER fixed_asset_audit_append_only
      BEFORE UPDATE OR DELETE ON fixed_asset_audit_events
      FOR EACH ROW EXECUTE FUNCTION fixed_asset_audit_is_append_only()
  `.execute(db);
}

/**
 * Down refuses to destroy a real register.
 *
 * A rollback that silently dropped an asset register somebody had spent a week
 * typing would be indistinguishable, afterwards, from a bug — and the audit
 * trail that would have explained it goes with it. Empty registers roll back
 * freely, which is the case a failed deploy actually needs.
 *
 * The trigger is dropped BEFORE the table, because dropping the table fires
 * nothing but leaving the function behind would collide with a re-run.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ assets: string; categories: string; events: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM fixed_assets)             AS assets,
      (SELECT COUNT(*)::text FROM fixed_asset_categories)   AS categories,
      (SELECT COUNT(*)::text FROM fixed_asset_audit_events) AS events
  `.execute(db);

  const assets = Number(rows[0]?.assets ?? '0');
  const categories = Number(rows[0]?.categories ?? '0');
  const events = Number(rows[0]?.events ?? '0');

  if (assets > 0 || categories > 0 || events > 0) {
    throw new Error(
      `Refusing to roll back 044: it would destroy ${assets} fixed asset(s), ${categories} asset `
      + `categor(y/ies) and ${events} audit event(s) of durable master data. None of it can be `
      + 'recovered from anywhere else — the browser copies these records nowhere. Remedy: export '
      + 'or delete the register deliberately, then roll back.',
    );
  }

  await sql`DROP TRIGGER IF EXISTS fixed_asset_audit_append_only ON fixed_asset_audit_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS fixed_asset_audit_is_append_only()`.execute(db);
  await sql`DROP TABLE IF EXISTS fixed_asset_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS fixed_asset_numbering`.execute(db);
  await sql`DROP TABLE IF EXISTS fixed_assets`.execute(db);
  await sql`DROP TABLE IF EXISTS fixed_asset_categories`.execute(db);
}
