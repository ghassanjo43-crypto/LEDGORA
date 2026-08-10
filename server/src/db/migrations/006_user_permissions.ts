/**
 * User administration: authority levels and per-user permission overrides.
 *
 * ── Why the role enum widens rather than being replaced ──────────────────────
 * `organization_memberships.role` already carries four levels and every existing
 * row means something. The required authority ladder needs two more rungs —
 * "Organization Admin" and "Manager" — so they are ADDED to the check
 * constraint. No existing row is rewritten, which is the whole point: a
 * migration that reassigned roles would hand out authority nobody granted.
 *
 * `admin` is not invented here. `src/types/roles.ts` on the frontend has declared
 * it since the role model was written, while the database refused it — a live
 * drift where a UI could offer a role the backend would reject with a constraint
 * violation. This closes it.
 *
 * ── Why overrides are a table but role templates are not ─────────────────────
 * A role template is a POLICY: "what does an Accountant do here?" It belongs in
 * reviewed, tested code beside the capability map in `guards/platform.ts`, where
 * it cannot be edited by anyone holding a database connection and where a change
 * to it goes through the same review as any other authorization change.
 *
 * An override is DATA: one administrator's decision about one person, made at a
 * moment, for a reason, and needing to be listed, edited and audited. That needs
 * a row.
 *
 * ── Why an override is organization-scoped ───────────────────────────────────
 * The unique key is (user_id, organization_id, subject, action), not
 * (user_id, subject, action). A person can belong to two tenants, and a grant
 * inside one must never follow them into the other — tenant isolation is a
 * property of the KEY here, not of a filter someone has to remember to write.
 *
 * ── Why nothing is deleted on a downgrade ────────────────────────────────────
 * There is no cleanup here, and none anywhere else, when a subscription loses a
 * module. The override rows stay exactly as configured and the RESOLVER refuses
 * them while the entitlement is missing. That is what makes a downgrade
 * reversible: re-buy the module and the original configuration is simply live
 * again, because it was never destroyed.
 *
 * ── Why the reset-token table grows two columns ──────────────────────────────
 * The table has been serving two different acts — "set your password for the
 * first time" and "reset the password you forgot" — with no way to tell them
 * apart afterwards. `purpose` records which. `revoked_at` distinguishes a token
 * an administrator deliberately withdrew from one the holder used: `used_at`
 * alone cannot express "cancelled before use", so revocation had been
 * masquerading as consumption.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Authority levels ──────────────────────────────────────────────────── */
  await sql`
    ALTER TABLE organization_memberships
      DROP CONSTRAINT IF EXISTS organization_memberships_role_check
  `.execute(db);
  await sql`
    ALTER TABLE organization_memberships
      ADD CONSTRAINT organization_memberships_role_check
      CHECK (role IN ('owner','admin','manager','accountant','member','viewer'))
  `.execute(db);

  /* ── Per-user permission overrides ─────────────────────────────────────── */
  await sql`
    CREATE TABLE user_permission_overrides (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      /* Scoped to ONE tenant. A grant never leaks between organizations. */
      organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      /* A permission subject from the server-side catalogue (e.g. 'general_journal'). */
      subject            text NOT NULL,
      /* An action from the catalogue (e.g. 'post'). */
      action             text NOT NULL,
      /* 'deny' outranks 'grant' in the resolver — see services/permissionService. */
      effect             text NOT NULL CHECK (effect IN ('grant','deny')),
      /* Why the operator made this exception. Shown in the editor and audited. */
      reason             text,
      granted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  /*
   * One decision per person per tenant per permission. This makes a permission
   * write an idempotent upsert instead of a race between two operators editing
   * the same matrix, and makes "grant AND deny simultaneously" unrepresentable
   * rather than something the resolver has to arbitrate.
   */
  await sql`
    CREATE UNIQUE INDEX user_permission_overrides_key
      ON user_permission_overrides (user_id, organization_id, subject, action)
  `.execute(db);
  /* The resolver's read path: every override for one person in one tenant. */
  await sql`
    CREATE INDEX user_permission_overrides_scope_idx
      ON user_permission_overrides (user_id, organization_id)
  `.execute(db);
  /* "Who else has this permission?" — the reverse question, for review. */
  await sql`
    CREATE INDEX user_permission_overrides_subject_idx
      ON user_permission_overrides (organization_id, subject, action)
  `.execute(db);

  /* ── Invitation vs reset, and revocation vs use ────────────────────────── */
  await sql`
    ALTER TABLE password_reset_tokens
      ADD COLUMN purpose text NOT NULL DEFAULT 'reset'
        CHECK (purpose IN ('invitation','reset'))
  `.execute(db);
  await sql`ALTER TABLE password_reset_tokens ADD COLUMN revoked_at timestamptz`.execute(db);

  /*
   * The redemption path's index. It looks a token up by hash and then asks
   * whether it is still live; without this the check is a sequential scan that
   * gets slower for every token ever issued.
   */
  await sql`
    CREATE INDEX password_reset_tokens_live_idx
      ON password_reset_tokens (user_id, expires_at)
      WHERE used_at IS NULL AND revoked_at IS NULL
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS password_reset_tokens_live_idx`.execute(db);
  await sql`ALTER TABLE password_reset_tokens DROP COLUMN IF EXISTS revoked_at`.execute(db);
  await sql`ALTER TABLE password_reset_tokens DROP COLUMN IF EXISTS purpose`.execute(db);
  await sql`DROP TABLE IF EXISTS user_permission_overrides CASCADE`.execute(db);

  /*
   * Restore the original four-role constraint.
   *
   * This deliberately does NOT rewrite `admin`/`manager` rows down to something
   * the old constraint accepts. If any exist, PostgreSQL refuses to add the
   * constraint and the down-migration fails loudly — which is the correct
   * outcome. Silently demoting real people to make a rollback succeed would
   * change who can do what without anyone deciding to.
   */
  await sql`
    ALTER TABLE organization_memberships
      DROP CONSTRAINT IF EXISTS organization_memberships_role_check
  `.execute(db);
  await sql`
    ALTER TABLE organization_memberships
      ADD CONSTRAINT organization_memberships_role_check
      CHECK (role IN ('owner','accountant','member','viewer'))
  `.execute(db);
}
