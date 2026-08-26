/**
 * The company registry — server authority for a set of books.
 *
 * ══ Why this table has to exist ══════════════════════════════════════════════
 *
 * Until now a "company" existed only in browser localStorage. That is workable
 * for books a subscriber reads back themselves, and unworkable for a fact that
 * must bind everyone: a bookkeeping language chosen once and never changed.
 *
 * Three things were impossible without a server record, and all three were
 * asked for:
 *
 *   · Immutability that survives a determined user. localStorage is editable
 *     from the console by anyone who opens devtools.
 *   · Agreement between colleagues. Each browser held its own private copy of
 *     the company, so "everyone in this company sees the same language" had no
 *     mechanism behind it.
 *   · An audit answer. "What language were these books kept in, and who
 *     decided" cannot be answered by a value in somebody's browser.
 *
 * ══ Why the client's own id is kept alongside a server id ════════════════════
 *
 * Existing companies carry ids like `co_lx8f2a_9d4kz1` — generated in the
 * browser, not UUIDs, and already referenced by books that exist. Re-keying
 * them would mean rewriting the very records this feature must not touch.
 *
 * So the server mints its own `id`, and `client_reference` records the local
 * one. An existing company is adopted by registering its reference; nothing in
 * its books changes.
 *
 * ══ Why immutability is a TRIGGER here, unlike migration 021 ═════════════════
 *
 * 021 made the organization's language a service rule, because changing it is a
 * legitimate administrative act needing authority and a trail. This is the
 * opposite case: the requirement is that NO role can change it — not the
 * subscriber, not a tenant administrator, not the platform Super Admin, and not
 * a direct SQL writer. A service rule cannot promise that. A trigger can.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS companies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

      /*
       * The browser-side identifier for the same books. Text, not uuid: these
       * were minted client-side long before this table existed.
       */
      client_reference text NOT NULL,
      legal_name text NOT NULL DEFAULT '',

      /*
       * NULL until chosen. Deliberately nullable rather than defaulted: a
       * default is indistinguishable from a decision, and the whole point of
       * the setup step is that somebody with authority chose deliberately.
       */
      bookkeeping_language text,
      language_locked_at timestamptz,
      language_selected_by uuid REFERENCES users (id) ON DELETE SET NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT companies_language_supported
        CHECK (bookkeeping_language IS NULL OR bookkeeping_language IN ('en', 'ar')),
      /* A lock with nothing locked is a state no code should be able to reach. */
      CONSTRAINT companies_lock_requires_language
        CHECK (language_locked_at IS NULL OR bookkeeping_language IS NOT NULL),

      /* One registry row per set of books, per tenant. */
      CONSTRAINT companies_client_reference_unique UNIQUE (organization_id, client_reference),
      /* Composite key, so a child row cannot point at another tenant company. */
      CONSTRAINT companies_org_id_unique UNIQUE (organization_id, id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS companies_organization_idx ON companies (organization_id)
  `.execute(db);

  /*
   * The guard the whole feature rests on.
   *
   * Once `language_locked_at` is set, neither the language nor the lock may
   * change — by any role, through any route, or by a direct UPDATE. Clearing
   * the lock is refused too: otherwise "unlock, change, relock" is a two-step
   * override, which is the same override wearing a hat.
   *
   * Everything else about the row stays editable; this constrains exactly the
   * two columns that must never move.
   */
  await sql`
    CREATE OR REPLACE FUNCTION companies_language_is_immutable()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.language_locked_at IS NOT NULL THEN
        IF NEW.bookkeeping_language IS DISTINCT FROM OLD.bookkeeping_language THEN
          RAISE EXCEPTION
            'The bookkeeping language of company % was locked at % and cannot be changed.',
            OLD.id, OLD.language_locked_at
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.language_locked_at IS DISTINCT FROM OLD.language_locked_at THEN
          RAISE EXCEPTION
            'The bookkeeping language lock on company % cannot be moved or removed.',
            OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS companies_language_immutable ON companies`.execute(db);
  await sql`
    CREATE TRIGGER companies_language_immutable
      BEFORE UPDATE ON companies
      FOR EACH ROW EXECUTE FUNCTION companies_language_is_immutable()
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS companies_language_immutable ON companies`.execute(db);
  await sql`DROP FUNCTION IF EXISTS companies_language_is_immutable()`.execute(db);
  await sql`DROP TABLE IF EXISTS companies`.execute(db);
}
