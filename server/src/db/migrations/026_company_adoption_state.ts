/**
 * Company adoption state — one real set of books, exactly one company row.
 *
 * ══ The defect this closes ═══════════════════════════════════════════════════
 *
 * An organization is created with a first company, because accounting records
 * are company-scoped and a subscriber with nowhere to post is a broken
 * subscriber. Separately, the browser mints its own identifier for the same
 * books (`co_lx8f2a…`, see `store/companyStore`) and later registers it.
 *
 * Those two acts describe ONE legal entity. Until now they produced TWO rows,
 * because registration matched only on `client_reference` and the automatic
 * row's reference was never anything a browser would send. The consequences
 * were not cosmetic:
 *
 *   · a Core subscriber, whose plan allows one entity, silently held two;
 *   · journals posted before the browser registered landed in the automatic
 *     company, and journals posted after landed in the other — one legal
 *     entity, two ledgers, and reports that showed whichever half the selector
 *     happened to name;
 *   · migration 025's backfill treats "several companies" as ambiguous and
 *     refuses, so ordinary onboarding manufactured the exact ambiguity that
 *     migration exists to protect against.
 *
 * ══ Why adoption state is a COLUMN and not an inferred sentinel ══════════════
 *
 * The provisional row could be recognised by `client_reference = organization_id`,
 * and that is how the rows this migration inherits are identified. But an
 * inferred sentinel is a rule living in whichever queries remember it, and it
 * cannot be constrained: there is no index that says "at most one unadopted
 * company", because "unadopted" would not be a value.
 *
 * `adopted_at` makes the state explicit, indexable and constrainable. The
 * partial unique index below then enforces the invariant in the database — at
 * most one provisional company per organization — so a concurrent pair of
 * registrations cannot leave two behind, whatever the service does.
 *
 * ══ Classification of existing rows ══════════════════════════════════════════
 *
 * Two populations, distinguished without guessing:
 *
 *   provisional   `client_reference` equals the organization id (or the
 *                 `provisional:` form). Only the automatic creation writes
 *                 those — a browser reference is always `co_…`. Keeps
 *                 `adopted_at` NULL, so the first registration adopts it.
 *
 *   adopted       anything else. These were registered deliberately by a
 *                 client, so they are already somebody's real books.
 *                 `adopted_at` is set from `created_at` — the honest answer,
 *                 since the true adoption moment was not recorded and inventing
 *                 `now()` would date every historical company to deployment day.
 *                 `adopted_by` stays NULL rather than naming a user who may not
 *                 have been the one who did it.
 *
 * Nothing is converted silently: a row is provisional only when its reference
 * is one the automatic path is known to write, and the classification is
 * asserted by `companyAdoption.test.ts`.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS adopted_at timestamptz,
      ADD COLUMN IF NOT EXISTS adopted_by uuid REFERENCES users (id) ON DELETE SET NULL
  `.execute(db);

  /*
   * Adopted: registered by a real client, so its reference is the client's own.
   * Dated from `created_at`, which is the only true thing available.
   */
  await sql`
    UPDATE companies
       SET adopted_at = created_at
     WHERE adopted_at IS NULL
       AND client_reference <> organization_id::text
       AND client_reference <> ('provisional:' || organization_id::text)
  `.execute(db);

  /*
   * At most one provisional company per organization.
   *
   * This is the invariant, in the one place that can actually promise it. The
   * service adopts under an advisory lock and an `adopted_at IS NULL` guard, but
   * a service rule holds only for callers who go through it; this holds for
   * everyone, including a direct INSERT.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS companies_one_provisional
      ON companies (organization_id)
      WHERE adopted_at IS NULL
  `.execute(db);

  /*
   * Adoption is a pair: a moment and, where known, the person.
   *
   * Dropped first because `ADD CONSTRAINT` has no `IF NOT EXISTS` form, and
   * this migration must survive a replay — `deletionTombstoneRepair.test.ts`
   * un-records the migration tail and runs it again to reproduce a legacy
   * database, which is exactly the situation a real repair would face. Every
   * other statement here is already idempotent; this one has to be made so.
   */
  await sql`ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_adoption_complete`.execute(db);
  await sql`
    ALTER TABLE companies
      ADD CONSTRAINT companies_adoption_complete
      CHECK (adopted_by IS NULL OR adopted_at IS NOT NULL)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS companies_provisional_idx
      ON companies (organization_id) WHERE adopted_at IS NULL
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS companies_provisional_idx`.execute(db);
  await sql`ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_adoption_complete`.execute(db);
  await sql`DROP INDEX IF EXISTS companies_one_provisional`.execute(db);
  await sql`
    ALTER TABLE companies
      DROP COLUMN IF EXISTS adopted_by,
      DROP COLUMN IF EXISTS adopted_at
  `.execute(db);
}
