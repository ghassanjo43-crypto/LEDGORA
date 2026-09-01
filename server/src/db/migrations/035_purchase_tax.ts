/**
 * Purchase tax: which way a tax code faces, and where input tax is recovered.
 *
 * ══ Why this extends S2c rather than duplicating it ══════════════════════════
 *
 * §3 models direction as a property of ONE tax code — `sales | purchase | both`
 * — not as two parallel code sets. A business that charges 16% and reclaims 16%
 * is looking at one rate under one authority; splitting it into a sales VAT16
 * and a purchase VAT16 would mean two codes, two rate histories and two chances
 * for them to drift apart on the day the rate changes.
 *
 * So this adds `direction` and an input-tax account to the EXISTING tables. The
 * output side is untouched: no S2c column changes meaning, and no issued
 * invoice's frozen snapshot is read or rewritten by this migration.
 *
 * ══ Existing codes are SALES codes, and that is history, not a guess ═════════
 *
 * Every tax code in this database was created by S2c, whose service could only
 * make sales codes: it wrote `output_tax_account_id`, refused anything else, and
 * had no purchase concept at all. Backfilling `direction = 'sales'` therefore
 * RECORDS what those codes already are rather than deciding something new. The
 * alternative — defaulting to `both` — would silently make every existing code
 * selectable on a bill and offer it an input account it has never had.
 *
 * ══ Where input tax is recovered ═════════════════════════════════════════════
 *
 * `input_tax_account_id` on the code, with a per-rate-version override, exactly
 * mirroring the output side (§4, §5). The same reasoning holds: one company-wide
 * default would force two legally distinct taxes into one control account.
 *
 * ══ What is deliberately NOT added ═══════════════════════════════════════════
 *
 * No `recoverability_percent` and no `non_recoverable_account_id`. §11 asks for
 * partial recoverability but describes only a "possible" posting, and that
 * posting contradicts the fields beside it — it capitalises the non-recoverable
 * tax into the expense while also defining a separate account for it. The
 * browser implements no split at all: `billPosting` debits the whole tax to the
 * input account. A column for a treatment nobody has defined is a column a
 * screen will eventually fill in and no journal will honour, so partial
 * recoverability is refused in the service and absent from the schema.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Preconditions ────────────────────────────────────────────────────── */

  /*
   * A tax code whose output account belongs to another company would already be
   * impossible — the composite key forbids it — but a rate version orphaned from
   * its code would break the applicability rules below. Counted first, refused
   * with the numbers, never repaired by guessing which code it belonged to.
   */
  const { rows: orphans } = await sql<{ n: string; sample: string | null }>`
    SELECT COUNT(*)::text AS n, MIN(v.id::text) AS sample
      FROM tax_rate_versions v
      LEFT JOIN tax_codes c
        ON c.id = v.tax_code_id
       AND c.organization_id = v.organization_id
       AND c.company_id = v.company_id
     WHERE c.id IS NULL
  `.execute(db);

  const orphaned = Number(orphans[0]?.n ?? '0');
  if (orphaned > 0) {
    throw new Error(
      `Refusing to add purchase tax: ${orphaned} tax rate version(s) name a tax code that does not `
      + `exist in the same company (for example ${orphans[0]?.sample ?? 'unknown'}). A rate with no `
      + 'code cannot be given a direction or an input account, and choosing a code for it would '
      + 'invent which tax those rates belong to. Remedy: delete the orphaned rate versions, or '
      + 'restore their tax codes, then run this again.',
    );
  }

  /* ── Direction ────────────────────────────────────────────────────────── */

  await sql`
    ALTER TABLE tax_codes
      ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'sales'
  `.execute(db);

  /*
   * Backfilled explicitly as well as defaulted, so a code created between the
   * ADD COLUMN and the CHECK cannot slip through with something else.
   */
  await sql`
    UPDATE tax_codes SET direction = 'sales' WHERE direction IS NULL OR btrim(direction) = ''
  `.execute(db);

  await sql`ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_direction_ck`.execute(db);
  await sql`
    ALTER TABLE tax_codes
      ADD CONSTRAINT tax_codes_direction_ck
      CHECK (direction IN ('sales', 'purchase', 'both'))
  `.execute(db);

  /*
   * Withholding-receivable and withholding-payable are in §3's union and absent
   * here on purpose: withholding is recognised at a payment stage with its own
   * liability account, none of which exists on the server. A direction the
   * server can store but never post is worse than one it refuses.
   */

  /* ── The input-tax account ────────────────────────────────────────────── */

  await sql`
    ALTER TABLE tax_codes
      ADD COLUMN IF NOT EXISTS input_tax_account_id uuid
  `.execute(db);

  await sql`
    ALTER TABLE tax_rate_versions
      ADD COLUMN IF NOT EXISTS input_tax_account_id uuid
  `.execute(db);

  await sql`ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_input_account_fk`.execute(db);
  await sql`
    ALTER TABLE tax_codes
      ADD CONSTRAINT tax_codes_input_account_fk
      FOREIGN KEY (organization_id, company_id, input_tax_account_id)
      REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`
    ALTER TABLE tax_rate_versions DROP CONSTRAINT IF EXISTS tax_rate_versions_input_account_fk
  `.execute(db);
  await sql`
    ALTER TABLE tax_rate_versions
      ADD CONSTRAINT tax_rate_versions_input_account_fk
      FOREIGN KEY (organization_id, company_id, input_tax_account_id)
      REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /*
   * The existing zero-category rule, restated for the input side.
   *
   * Zero-rated, exempt and out-of-scope report a base and post nothing, so an
   * account on either side would imply an entry that must never exist. The
   * output half of this constraint already exists from 032; this replaces it
   * with one covering both, rather than leaving the two halves able to disagree.
   */
  await sql`
    ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_zero_has_no_account_ck
  `.execute(db);
  await sql`
    ALTER TABLE tax_codes
      ADD CONSTRAINT tax_codes_zero_has_no_account_ck
      CHECK (
        category IN ('standard','reduced')
        OR (output_tax_account_id IS NULL AND input_tax_account_id IS NULL)
      )
  `.execute(db);

  /* ── The frozen snapshot, on the bill line ────────────────────────────── */

  /*
   * Denormalised for the reason the invoice snapshot is: `tax_code_id` alone
   * makes a posted bill depend on mutable configuration, so archiving the code
   * or end-dating the rate would change what the document says it was charged.
   *
   * Every column is nullable and every default is zero, so migration 034's
   * EXISTING non-tax bills stay exactly what they are. Nothing here fabricates a
   * zero-tax snapshot for them: a bill posted before purchase tax existed has no
   * tax snapshot, and `tax_snapshot_at` being null is how that is told apart
   * from a bill deliberately posted at zero.
   */
  await sql`
    ALTER TABLE bill_lines
      ADD COLUMN IF NOT EXISTS tax_code_id             uuid,
      ADD COLUMN IF NOT EXISTS tax_rate_version_id     uuid,
      ADD COLUMN IF NOT EXISTS tax_code_code           text,
      ADD COLUMN IF NOT EXISTS tax_code_name           text,
      ADD COLUMN IF NOT EXISTS tax_direction           text,
      ADD COLUMN IF NOT EXISTS tax_category            text,
      ADD COLUMN IF NOT EXISTS tax_calculation_method  text,
      ADD COLUMN IF NOT EXISTS tax_recoverability      text,
      ADD COLUMN IF NOT EXISTS tax_rate                numeric(20,10) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_rate_effective_from date,
      ADD COLUMN IF NOT EXISTS tax_rate_effective_to   date,
      ADD COLUMN IF NOT EXISTS tax_point_date          date,
      /* The amount the line's own account is debited, net of any tax. */
      ADD COLUMN IF NOT EXISTS taxable_amount          numeric(20,10) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_amount              numeric(20,10) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS recoverable_tax_amount  numeric(20,10) NOT NULL DEFAULT 0,
      /* What the supplier is owed for this line: taxable + tax. */
      ADD COLUMN IF NOT EXISTS gross_amount            numeric(20,10) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_account_id          uuid,
      ADD COLUMN IF NOT EXISTS tax_snapshot_at         timestamptz
  `.execute(db);

  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_tax_code_fk`.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_tax_code_fk
      FOREIGN KEY (organization_id, company_id, tax_code_id)
      REFERENCES tax_codes (organization_id, company_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  /*
   * RESTRICT: a tax code named on a posted bill must stay identifiable for as
   * long as the bill does, which is why codes archive rather than delete.
   */

  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_tax_account_fk`.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_tax_account_fk
      FOREIGN KEY (organization_id, company_id, tax_account_id)
      REFERENCES accounts (organization_id, company_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  /* The bill header records the single input account it used, when unambiguous. */
  await sql`
    ALTER TABLE bills
      ADD COLUMN IF NOT EXISTS tax_total       numeric(20,10) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS input_tax_account_id uuid
  `.execute(db);

  await sql`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_input_tax_account_fk`.execute(db);
  await sql`
    ALTER TABLE bills
      ADD CONSTRAINT bills_input_tax_account_fk
      FOREIGN KEY (organization_id, company_id, input_tax_account_id)
      REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bill_lines_tax_code_idx
      ON bill_lines (organization_id, company_id, tax_code_id)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  /*
   * ══ Why this refuses over posted purchase tax ══════════════════════════════
   *
   * Dropping these columns discards the frozen snapshots of every taxed bill
   * while their journals — including the input-tax debits — stay in the ledger.
   * That leaves entries whose source document can no longer say what rate it was
   * charged, which is precisely the history a tax authority asks for.
   *
   * So it rolls back only while no bill line carries a snapshot. That is the
   * case a rollback legitimately needs: the migration was applied and is being
   * undone before anything used it.
   */
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM bill_lines WHERE tax_snapshot_at IS NOT NULL
  `.execute(db);
  const taxed = Number(rows[0]?.n ?? '0');
  if (taxed > 0) {
    throw new Error(
      `Refusing to roll back 035_purchase_tax: ${taxed} posted bill line(s) carry a frozen purchase-tax `
      + 'snapshot. Dropping these columns would destroy the record of what rate each was charged '
      + 'while the input-tax entries remain in the ledger, leaving journals no document explains. '
      + 'Reverse those bills deliberately first if this is really intended.',
    );
  }

  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_tax_code_fk`.execute(db);
  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_tax_account_fk`.execute(db);
  await sql`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_input_tax_account_fk`.execute(db);
  await sql`DROP INDEX IF EXISTS bill_lines_tax_code_idx`.execute(db);

  await sql`
    ALTER TABLE bill_lines
      DROP COLUMN IF EXISTS tax_code_id,
      DROP COLUMN IF EXISTS tax_rate_version_id,
      DROP COLUMN IF EXISTS tax_code_code,
      DROP COLUMN IF EXISTS tax_code_name,
      DROP COLUMN IF EXISTS tax_direction,
      DROP COLUMN IF EXISTS tax_category,
      DROP COLUMN IF EXISTS tax_calculation_method,
      DROP COLUMN IF EXISTS tax_recoverability,
      DROP COLUMN IF EXISTS tax_rate,
      DROP COLUMN IF EXISTS tax_rate_effective_from,
      DROP COLUMN IF EXISTS tax_rate_effective_to,
      DROP COLUMN IF EXISTS tax_point_date,
      DROP COLUMN IF EXISTS taxable_amount,
      DROP COLUMN IF EXISTS tax_amount,
      DROP COLUMN IF EXISTS recoverable_tax_amount,
      DROP COLUMN IF EXISTS gross_amount,
      DROP COLUMN IF EXISTS tax_account_id,
      DROP COLUMN IF EXISTS tax_snapshot_at
  `.execute(db);

  await sql`
    ALTER TABLE bills
      DROP COLUMN IF EXISTS tax_total,
      DROP COLUMN IF EXISTS input_tax_account_id
  `.execute(db);

  /* The output-side constraint is restored exactly as 032 left it, so rolling
   * back purchase tax cannot weaken the sales rule. */
  await sql`
    ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_zero_has_no_account_ck
  `.execute(db);
  await sql`
    ALTER TABLE tax_codes
      ADD CONSTRAINT tax_codes_zero_has_no_account_ck
      CHECK (category IN ('standard','reduced') OR output_tax_account_id IS NULL)
  `.execute(db);

  await sql`ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_input_account_fk`.execute(db);
  await sql`
    ALTER TABLE tax_rate_versions DROP CONSTRAINT IF EXISTS tax_rate_versions_input_account_fk
  `.execute(db);
  await sql`ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_direction_ck`.execute(db);
  await sql`
    ALTER TABLE tax_rate_versions DROP COLUMN IF EXISTS input_tax_account_id
  `.execute(db);
  await sql`
    ALTER TABLE tax_codes
      DROP COLUMN IF EXISTS input_tax_account_id,
      DROP COLUMN IF EXISTS direction
  `.execute(db);
}
