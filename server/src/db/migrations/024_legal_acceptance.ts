/**
 * The organization's registered legal country, and the record of who accepted
 * which legal documents.
 *
 * ══ Why `legal_country` is separate from `country` ═══════════════════════════
 *
 * `organizations.country` already exists (migration 001). It is free text with
 * no constraint, it was collected during onboarding as a descriptive field, and
 * nothing has ever validated it. Reusing it to decide which Country Addendum
 * governs a contract would mean a legal determination resting on a value that
 * may hold "UAE", "united arab emirates", "Dubai" or a typo — and silently
 * changing the applicable contract the day somebody tidied it up.
 *
 * `legal_country` is a different fact with a different job: the country the
 * organization is legally REGISTERED in, constrained to the three Ledgora is
 * offered in, selected deliberately by the owner, and audited when it changes.
 * It is nullable because it cannot be back-filled — no existing organization
 * has ever been asked the question, and inferring it from the free-text field
 * would be exactly the silent inference the requirement forbids.
 *
 * ══ Why acceptances are append-only ══════════════════════════════════════════
 *
 * An acceptance is evidence of what a person agreed to at a moment in time. It
 * is never updated and never deleted: a new version produces a NEW row, and the
 * previous row remains as the record of what was true before. Supersession is
 * therefore derived (a later row for the same user, organization and document
 * id), not stored as a mutable flag that could be flipped.
 *
 * There IS a unique key, but on the whole fact — organization, user, scope,
 * document, version and hash together — so a retried or double-clicked
 * submission converges on one row while a genuine re-acceptance at a new
 * version still adds one.
 *
 * ══ Why the hash is stored ═══════════════════════════════════════════════════
 *
 * `content_hash` is the SHA-256 of the canonical text the person was actually
 * shown. Storing the version alone would prove which version they clicked past;
 * storing the hash lets a third party take the published text and satisfy
 * themselves it is byte-for-byte what was agreed, without trusting us. A
 * version number can be reused by mistake; a hash cannot.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── The registered legal country ──────────────────────────────────────── */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS legal_country text
        CHECK (legal_country IS NULL OR legal_country IN ('AE','JO','SA'))
  `.execute(db);

  /* ── Acceptances ───────────────────────────────────────────────────────── */
  await sql`
    CREATE TABLE IF NOT EXISTS legal_acceptances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

      /*
       * The legal country AS IT WAS when this acceptance was given. Copied, not
       * joined: if the organization later changes country, this row must still
       * say which country's addendum this person actually accepted under.
       */
      legal_country text NOT NULL CHECK (legal_country IN ('AE','JO','SA')),

      /*
       * WHAT this acceptance is.
       *
       *   organization — this person bound the ORGANIZATION to the document.
       *                  Only the Primary Owner, or someone explicitly granted
       *                  legal_terms:accept, may create one.
       *   individual   — this person acknowledged the document FOR THEMSELVES.
       *                  Every user must, and it binds nobody but them.
       *
       * Two rows, not one with a flag, because they are different legal acts by
       * different authorities. Collapsing them would make an invited bookkeeper's
       * personal acknowledgement indistinguishable from the company agreeing —
       * which is the specific confusion this column exists to prevent.
       */
      scope text NOT NULL CHECK (scope IN ('organization','individual')),

      /* Which document, which version, and a fingerprint of the exact text. */
      document_id   text NOT NULL CHECK (document_id IN ('master-terms','addendum-ae','addendum-jo','addendum-sa')),
      version       text NOT NULL,
      content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),

      /*
       * The person's own assertion that they may bind the organization. Stored
       * as given rather than inferred from their role: the question asked was
       * "do you have authority", and the answer to that question is the
       * evidence, not our later opinion about their job title.
       */
      binding_authority_confirmed boolean NOT NULL DEFAULT false,
      /** The role they held at the moment of acceptance, for context. */
      accepted_as_role text,

      /*
       * SERVER time. Never a client-supplied timestamp: the one thing an
       * acceptance record must not accept from the party it is evidence
       * against is when it happened.
       */
      accepted_at timestamptz NOT NULL DEFAULT now(),

      /* Diagnostic context. Never used to DECIDE anything — see the note on
         country resolution in lib/legalDocuments. */
      user_agent text,

      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS legal_acceptances_user_org_idx
      ON legal_acceptances (user_id, organization_id, document_id, scope, accepted_at DESC)
  `.execute(db);

  /*
   * Idempotency, enforced by the database.
   *
   * The same person accepting the same version of the same document at the same
   * hash, in the same scope, is ONE fact however many times the button is
   * pressed or the request is retried. A double-click, a retried POST after a
   * timeout, or two tabs submitting together must converge on a single row
   * rather than producing duplicate evidence that later has to be reconciled.
   *
   * Deliberately NOT unique on (user, org, document) alone: re-acceptance after
   * a version change or a text change must be able to add a row, because that
   * is a new fact and the old one is still true.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_idempotent_key
      ON legal_acceptances (organization_id, user_id, scope, document_id, version, content_hash)
  `.execute(db);

  /*
   * Append-only, enforced rather than promised.
   *
   * A rule that lives only in the service is a rule that holds until somebody
   * writes a second service. Evidence of consent is exactly the kind of record
   * that must not be quietly editable by whoever holds a database connection,
   * so UPDATE and DELETE are refused at the table.
   */
  /*
   * Two different prohibitions, deliberately not the same strength.
   *
   *   UPDATE — never, under any circumstance. Editing evidence of consent is
   *            never a legitimate act: if the facts change, a NEW row records
   *            the new fact and the old one remains true of the moment it
   *            describes.
   *
   *   DELETE — refused, EXCEPT while an authorised purge is in progress. The
   *            rows carry ON DELETE CASCADE from users and organizations, so
   *            erasing an account or resetting a development database has to be
   *            able to take them with it; a trigger that refused would not
   *            protect the evidence, it would make the account undeletable and
   *            leave the customer unable to be forgotten.
   *
   * The purge flag is session-scoped and set inside the erasing transaction,
   * following the `ledgora.legacy_classification` precedent in migration 008.
   * It is not a way to edit a record — only to remove one along with the
   * identity it belongs to.
   */
  await sql`
    CREATE OR REPLACE FUNCTION legal_acceptances_are_append_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE'
         AND COALESCE(current_setting('ledgora.allow_legal_purge', true), 'off') = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'legal_acceptances is append-only: an acceptance record is evidence of what a person agreed to and cannot be %.', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS legal_acceptances_no_update ON legal_acceptances
  `.execute(db);
  await sql`
    CREATE TRIGGER legal_acceptances_no_update
      BEFORE UPDATE OR DELETE ON legal_acceptances
      FOR EACH ROW EXECUTE FUNCTION legal_acceptances_are_append_only()
  `.execute(db);

  /* ══ Legal-country changes ═══════════════════════════════════════════════
   *
   * Its own table rather than a generic audit row, because a country change has
   * a specific consequence the trail must make provable: it INVALIDATES the
   * previous country-addendum acceptance and requires a new one. A reader has to
   * be able to see the old value, the new value, who did it and when, without
   * reconstructing it from free-text metadata.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS organization_legal_country_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      /** Null on the first selection — there was no previous value. */
      previous_country text CHECK (previous_country IS NULL OR previous_country IN ('AE','JO','SA')),
      new_country text NOT NULL CHECK (new_country IN ('AE','JO','SA')),
      changed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      /** The role the actor held, and the permission that let them do it. */
      changed_by_role text,
      authority text NOT NULL,
      reason text,
      changed_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS organization_legal_country_changes_org_idx
      ON organization_legal_country_changes (organization_id, changed_at DESC)
  `.execute(db);

  /* The same append-only guarantee: a change record is evidence too. */
  await sql`
    DROP TRIGGER IF EXISTS organization_legal_country_changes_no_update
      ON organization_legal_country_changes
  `.execute(db);
  await sql`
    CREATE TRIGGER organization_legal_country_changes_no_update
      BEFORE UPDATE OR DELETE ON organization_legal_country_changes
      FOR EACH ROW EXECUTE FUNCTION legal_acceptances_are_append_only()
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS organization_legal_country_changes_no_update ON organization_legal_country_changes`.execute(db);
  await sql`DROP TABLE IF EXISTS organization_legal_country_changes`.execute(db);
  await sql`DROP TRIGGER IF EXISTS legal_acceptances_no_update ON legal_acceptances`.execute(db);
  await sql`DROP FUNCTION IF EXISTS legal_acceptances_are_append_only()`.execute(db);
  await sql`DROP TABLE IF EXISTS legal_acceptances`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS legal_country`.execute(db);
}
