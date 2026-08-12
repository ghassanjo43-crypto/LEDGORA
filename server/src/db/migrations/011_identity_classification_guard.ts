/**
 * The one-way rule for IDENTITIES.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * Migration `008` added `data_classification` to both `organizations` and
 * `users`, but guarded only the first. So `production -> test|demo` was
 * impossible for a tenant and trivially possible for a person, directly in SQL:
 *
 *     UPDATE users SET data_classification = 'demo' WHERE id = ...;
 *
 * Nothing in the application does that, and no endpoint exposes it — but "no
 * caller currently does the dangerous thing" is exactly the guarantee that
 * decays. The organization rule was put in the database precisely so no future
 * endpoint could forget it, and the identity rule deserves the same footing: a
 * person recorded as real must not become deletable because some later code
 * path found it convenient.
 *
 * ── Why identities matter as much as tenants ─────────────────────────────────
 * A disposable identity can be destroyed outright by a tenant purge. Being able
 * to relabel a real person as disposable is therefore a two-step route to
 * deleting a real person's account — the same laundering the organization
 * trigger exists to prevent, one table across.
 *
 * ── The escape hatch, and why it is the same one ─────────────────────────────
 * The transaction-scoped GUC `ledgora.legacy_classification`, set only by the
 * development-only CLI in `services/classificationService`. Reusing it keeps
 * "route around retention" to exactly ONE mechanism, gated on a flag that
 * `env.ts` refuses to boot with in production. A second, differently-named
 * hatch would be a second thing to audit.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION ledgora_guard_identity_classification() RETURNS trigger AS $$
    BEGIN
      IF OLD.data_classification = 'production'
         AND NEW.data_classification <> 'production'
         AND COALESCE(current_setting('ledgora.legacy_classification', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
          'Identity % is production-classified and cannot be reclassified as % . A person recorded as real is never made disposable.',
          OLD.id, NEW.data_classification
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER users_classification_guard
      BEFORE UPDATE OF data_classification ON users
      FOR EACH ROW EXECUTE FUNCTION ledgora_guard_identity_classification()
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS users_classification_guard ON users`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledgora_guard_identity_classification()`.execute(db);
}
