/**
 * Server-issued subscriber preview sessions.
 *
 * ══ The hole this closes ═════════════════════════════════════════════════════
 *
 * The first attempt let a platform administrator name the subscriber they were
 * previewing in a request header, validated per request. That works, and it is
 * unauditable: an administrator who simply sends the header never calls
 * whatever endpoint would have recorded the access, so the audit trail records
 * only the well-behaved. An audit control that the audited party can decline is
 * not a control.
 *
 * So preview becomes something the SERVER issues. Reads present an opaque
 * credential, not a workspace id — and a credential only exists because a start
 * request was made, which is the same moment the audit row is written. Access
 * and evidence-of-access are now the same event rather than two cooperating
 * ones.
 *
 * ══ Why the token is stored as a hash ════════════════════════════════════════
 *
 * It is bearer-like: whoever holds it can read a subscriber's books. Storing it
 * verbatim would mean a database copy — a backup, a support export, a screen
 * share of a query result — hands over live preview access. The same reasoning
 * the session and invitation tokens already follow here.
 *
 * ══ Expiry, and what it is honest about ══════════════════════════════════════
 *
 * `ended_at` is written by an explicit exit. It cannot be relied upon: a closed
 * laptop, a dropped connection or an expired login all end a preview with no
 * request to record it. `expires_at` is therefore what actually bounds access,
 * and a row with `ended_at IS NULL` past its expiry means "this preview stopped
 * authorising reads", NOT "this administrator is still looking".
 *
 * The start event is the evidence that preview access occurred. The end event
 * is a convenience for reconstructing duration when it happens to exist.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS platform_preview_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      /*
       * The REAL administrator. Preview never changes who the caller is, and
       * every read under this session is attributable to this person.
       */
      admin_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

      /* SHA-256 of the issued credential. The credential itself is never stored. */
      token_hash text NOT NULL UNIQUE,

      started_at timestamptz NOT NULL DEFAULT now(),
      /* What actually bounds access. See the note on ended_at above. */
      expires_at timestamptz NOT NULL,
      /* Written by an explicit exit only, and therefore not guaranteed. */
      ended_at timestamptz,

      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  /* The lookup every previewed read performs: my live sessions. */
  await sql`
    CREATE INDEX IF NOT EXISTS platform_preview_sessions_active_idx
      ON platform_preview_sessions (admin_user_id, expires_at)
      WHERE ended_at IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS platform_preview_sessions_org_idx
      ON platform_preview_sessions (organization_id, started_at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS platform_preview_sessions`.execute(db);
}
