/**
 * Language, at the organization rather than the user.
 *
 * ══ Two columns, because they answer different questions ═════════════════════
 *
 * `document_language` is the compliance-relevant one. It decides the language
 * of the invoice a customer receives and of the UBL submitted to an authority.
 * That has to be one answer per organization: a tax document reissued in a
 * different language from the one already cleared is a different document, and
 * an auditor comparing a stored copy against the authority's copy needs them to
 * match. Locked by default.
 *
 * `interface_language` is which language the SCREENS are in. It is stored here
 * so a company gets one consistent default for everybody, but it is a different
 * kind of fact: a bookkeeper who reads only Arabic and an external auditor who
 * reads only English may both need to work in the same books, and forcing one
 * of them out is a usability problem that no compliance rule requires. Whether
 * a member may override it for themselves is therefore a policy the
 * organization sets — see `interface_language_locked`.
 *
 * ══ Why immutability is a service rule, not a trigger ════════════════════════
 *
 * Ownership (migration 017) uses database triggers because reassignment must be
 * impossible even for a direct SQL writer. Language is not in that class:
 * changing it is a legitimate administrative act that simply needs authority
 * and an audit trail. A trigger here would also have to be dropped and
 * recreated every time an operator legitimately corrected a mistyped choice
 * during onboarding, which is exactly when it is most likely to be wrong.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS interface_language text NOT NULL DEFAULT 'en',
      ADD COLUMN IF NOT EXISTS document_language text NOT NULL DEFAULT 'en',
      ADD COLUMN IF NOT EXISTS interface_language_locked boolean NOT NULL DEFAULT true
  `.execute(db);

  /*
   * Constrained to what the application actually ships. An organization set to
   * a language with no translations would show every screen as raw translation
   * keys, which looks like catastrophic data loss to the person seeing it.
   */
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_interface_language_supported
      CHECK (interface_language IN ('en', 'ar'))
  `.execute(db);

  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_document_language_supported
      CHECK (document_language IN ('en', 'ar'))
  `.execute(db);

  /*
   * The audit trail for a change.
   *
   * Separate from `audit_logs` because this is a fact about the organization
   * that has to survive log retention: "which language were documents issued in
   * during 2026" is a question an auditor may ask years later, and the answer
   * cannot be a log line that has since been rotated away.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS organization_language_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
      field text NOT NULL CHECK (field IN ('interface_language', 'document_language')),
      previous_value text NOT NULL,
      new_value text NOT NULL,
      reason text NOT NULL,
      changed_by uuid REFERENCES users (id) ON DELETE SET NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS organization_language_changes_org_idx
      ON organization_language_changes (organization_id, changed_at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS organization_language_changes`.execute(db);
  await sql`
    ALTER TABLE organizations
      DROP CONSTRAINT IF EXISTS organizations_document_language_supported,
      DROP CONSTRAINT IF EXISTS organizations_interface_language_supported,
      DROP COLUMN IF EXISTS interface_language_locked,
      DROP COLUMN IF EXISTS document_language,
      DROP COLUMN IF EXISTS interface_language
  `.execute(db);
}
