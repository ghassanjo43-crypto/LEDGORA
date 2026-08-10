/**
 * Super Admin console: subscriber creation, member administration, package
 * assignment and secure password reset.
 *
 * Four ideas need storage that the schema did not have:
 *
 *  1. `password_reset_tokens` — a single-use, expiring reset link. Only the
 *     SHA-256 hash of the token is stored, exactly as `auth_sessions` does, so a
 *     database disclosure yields nothing usable. The raw token exists only in the
 *     response that created it.
 *  2. `users.password_expires_at` — a temporary password is a *credential with a
 *     deadline*. Without this column "expires after a configurable period" would
 *     be a promise the login path could not keep.
 *  3. `organization_entitlements` — the RESOLVED entitlement for a tenant: one
 *     row per organization, recomputed from its subscription and plan. This is
 *     the "entitlement record" the create-subscriber transaction writes and the
 *     cache that a package change invalidates. It is derived state, never a
 *     second source of truth: `recalculateEntitlements` can rebuild any row from
 *     the subscription alone.
 *  4. `subscription_package_changes` — the package history. A subscription row
 *     holds only its CURRENT plan, so recording "moved from Core to Enterprise on
 *     this date, by this operator, for this reason" needs its own append-only
 *     table. Downgrades in particular must be reconstructable long afterwards.
 *
 * Plus the per-tenant overrides an operator needs when a negotiated deal does not
 * match any catalogue plan (`subscriptions.storage_limit`, `extra_modules`) and a
 * place for the internal notes the creation form collects.
 *
 * Nothing here is destructive: every change is an added table or a nullable
 * column with a default.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── A temporary password is a credential with a deadline ──────────────── */
  await sql`ALTER TABLE users ADD COLUMN password_expires_at timestamptz`.execute(db);

  /* ── Operator notes about a subscriber account ────────────────────────── */
  await sql`ALTER TABLE organizations ADD COLUMN internal_notes text`.execute(db);

  /* ── Per-tenant overrides for a negotiated deal ───────────────────────── */
  await sql`ALTER TABLE subscriptions ADD COLUMN storage_limit bigint`.execute(db);
  // Optional modules bought on top of the base package. The plan's own module
  // list stays untouched — this is additive, per tenant.
  await sql`
    ALTER TABLE subscriptions
      ADD COLUMN extra_modules jsonb NOT NULL DEFAULT '[]'::jsonb
  `.execute(db);

  /* ── Password reset: single-use, expiring, hash-only ──────────────────── */
  await sql`
    CREATE TABLE password_reset_tokens (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      /* SHA-256 of the token. The raw value is returned once and never stored. */
      token_hash         text NOT NULL,
      expires_at         timestamptz NOT NULL,
      used_at            timestamptz,
      /* The operator who issued it, when an administrator did. */
      issued_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX password_reset_tokens_hash_key ON password_reset_tokens (token_hash)`.execute(db);
  await sql`CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id)`.execute(db);

  /* ── Resolved entitlement, one row per organization ───────────────────── */
  await sql`
    CREATE TABLE organization_entitlements (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
      plan_id         uuid REFERENCES subscription_plans(id) ON DELETE SET NULL,
      plan_code       text,
      edition         text,
      /* Resolved module list: the plan's modules plus per-tenant extras. */
      modules         jsonb NOT NULL DEFAULT '[]'::jsonb,
      user_limit      integer,
      entity_limit    integer,
      storage_limit   bigint,
      /* Mirrors the subscription status the entitlement was resolved from. */
      status          text NOT NULL DEFAULT 'none',
      /* True only while a live subscription backs it. */
      active          boolean NOT NULL DEFAULT false,
      starts_at       timestamptz,
      expires_at      timestamptz,
      computed_at     timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // One entitlement per tenant — this is what makes recalculation an idempotent
  // upsert rather than a race between concurrent operators.
  await sql`
    CREATE UNIQUE INDEX organization_entitlements_org_key
      ON organization_entitlements (organization_id)
  `.execute(db);

  /* ── Package history (append-only) ────────────────────────────────────── */
  await sql`
    CREATE TABLE subscription_package_changes (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      subscription_id     uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
      previous_plan_id    uuid REFERENCES subscription_plans(id) ON DELETE SET NULL,
      new_plan_id         uuid REFERENCES subscription_plans(id) ON DELETE SET NULL,
      previous_plan_code  text,
      new_plan_code       text,
      previous_status     text,
      new_status          text,
      previous_modules    jsonb NOT NULL DEFAULT '[]'::jsonb,
      new_modules         jsonb NOT NULL DEFAULT '[]'::jsonb,
      previous_user_limit integer,
      new_user_limit      integer,
      /* One of: upgrade, downgrade, lateral, initial. */
      direction           text NOT NULL DEFAULT 'lateral',
      effective_at        timestamptz NOT NULL DEFAULT now(),
      /* Required for a manual change — the accountability record. */
      reason              text NOT NULL,
      changed_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at          timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX subscription_package_changes_org_idx
      ON subscription_package_changes (organization_id, created_at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS subscription_package_changes CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS organization_entitlements CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS password_reset_tokens CASCADE`.execute(db);
  await sql`ALTER TABLE subscriptions DROP COLUMN IF EXISTS extra_modules`.execute(db);
  await sql`ALTER TABLE subscriptions DROP COLUMN IF EXISTS storage_limit`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS internal_notes`.execute(db);
  await sql`ALTER TABLE users DROP COLUMN IF EXISTS password_expires_at`.execute(db);
}
