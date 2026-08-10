/**
 * Data classification: production, test, or demo.
 *
 * ── Why this is a column and not a convention ────────────────────────────────
 * "Is this real customer data?" is the question every destructive operation
 * turns on, and it must have one authoritative answer stored beside the record.
 * Inferring it from a name containing "test", an `@example.com` address, a trial
 * subscription or a seeded id would make deletion eligibility depend on a string
 * somebody typed — and the failure mode is deleting a real subscriber whose
 * legal name happens to contain the word "Demo".
 *
 * ── Why `production` is the default ──────────────────────────────────────────
 * The default has to be the SAFE answer, because it is what every existing row
 * gets and what every future insert gets if someone forgets to set it. A default
 * of `test` would silently make the entire current dataset permanently
 * deletable; `production` fails closed, and an operator must deliberately mark
 * something as disposable.
 *
 * That includes the development data this feature exists to clean up: those rows
 * become `production` here, and a Super Admin classifies them explicitly through
 * the administrative path. Silently marking every existing row `test` would be
 * indistinguishable, in a real deployment, from arming a delete-everything
 * button.
 *
 * ── Why classification is separate from lifecycle and subscription ───────────
 * Three independent axes, deliberately not conflated:
 *   · classification — production | test | demo   (is this real data?)
 *   · lifecycle      — active | suspended | archived | pending_deletion | closed
 *   · subscription   — trial | active | past_due | cancelled | …
 * A trial subscription is NOT demo data; an archived production tenant is still
 * production. Collapsing any two of these is how a paying customer on a trial
 * gets treated as disposable.
 *
 * ── The one-way rule ─────────────────────────────────────────────────────────
 * `classified_production_at` records when a record became production. A trigger
 * refuses any move away from `production` once it is set, so a tenant cannot be
 * relabelled `test` in order to make it deletable. Test → production is a
 * legitimate promotion (a pilot that became a real customer); the reverse is
 * only ever an attempt to route around retention.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Organizations ─────────────────────────────────────────────────────── */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN data_classification text NOT NULL DEFAULT 'production'
        CHECK (data_classification IN ('production','test','demo'))
  `.execute(db);

  /**
   * Set the moment a record becomes (or is created as) production. Existing rows
   * are production by default, so they are stamped now — which is what makes the
   * one-way rule bite for the current dataset too.
   */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN classified_production_at timestamptz NOT NULL DEFAULT now()
  `.execute(db);

  /** Who last set the classification, and why. Accountability for a retention decision. */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN classified_by uuid REFERENCES users(id) ON DELETE SET NULL
  `.execute(db);
  await sql`ALTER TABLE organizations ADD COLUMN classification_reason text`.execute(db);

  /* The cleanup tool's read path: "which tenants are disposable?" */
  await sql`
    CREATE INDEX organizations_classification_idx
      ON organizations (data_classification)
      WHERE data_classification <> 'production'
  `.execute(db);

  /**
   * The one-way rule, enforced in the DATABASE.
   *
   * Deliberately not only in the service: this is the single guarantee standing
   * between "archive this customer" and "destroy this customer", and a rule that
   * lives only in application code is a rule a future endpoint can forget. A
   * trigger cannot be forgotten.
   */
  await sql`
    CREATE OR REPLACE FUNCTION ledgora_guard_classification() RETURNS trigger AS $$
    BEGIN
      IF OLD.data_classification = 'production'
         AND NEW.data_classification <> 'production'
         /*
          * The ONLY escape hatch: a transaction-scoped setting that the
          * development bootstrap sets with SET LOCAL, so it is gone the moment
          * that transaction ends and can never be left switched on. The service
          * that sets it refuses to run in production and additionally requires
          * an explicit configuration flag - see services/classificationService.
          *
          * A GUC rather than DISABLE TRIGGER: disabling is table-wide and racy,
          * whereas this is scoped to one transaction and leaves the trigger the
          * authority for every other caller running concurrently.
          */
         AND COALESCE(current_setting('ledgora.legacy_classification', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
          'A production subscriber cannot be reclassified as test or demo data.'
          USING ERRCODE = 'check_violation';
      END IF;
      /* Stamp the promotion so the rule above has something to key on. */
      IF NEW.data_classification = 'production'
         AND OLD.data_classification <> 'production' THEN
        NEW.classified_production_at := now();
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER organizations_classification_guard
      BEFORE UPDATE OF data_classification ON organizations
      FOR EACH ROW EXECUTE FUNCTION ledgora_guard_classification()
  `.execute(db);

  /* ── Identities ────────────────────────────────────────────────────────── */
  /**
   * A user identity carries its own classification, NOT its organization's.
   *
   * A person invited into a demo tenant may already be a real Ledgora user with
   * a membership elsewhere; deleting the demo tenant must not make them
   * disposable. So eligibility for identity deletion is decided per identity and
   * defaults to `production` exactly as organizations do.
   */
  await sql`
    ALTER TABLE users
      ADD COLUMN data_classification text NOT NULL DEFAULT 'production'
        CHECK (data_classification IN ('production','test','demo'))
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS organizations_classification_guard ON organizations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledgora_guard_classification()`.execute(db);
  await sql`DROP INDEX IF EXISTS organizations_classification_idx`.execute(db);
  await sql`ALTER TABLE users DROP COLUMN IF EXISTS data_classification`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS classification_reason`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS classified_by`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS classified_production_at`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS data_classification`.execute(db);
}
