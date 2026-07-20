/**
 * Initial LEDGORA backend schema.
 *
 * Written as raw SQL rather than the Kysely schema builder so the DDL is
 * reviewable exactly as PostgreSQL will execute it — important for the
 * constraints that carry security meaning (case-insensitive email uniqueness,
 * unique invoice numbers and payment references).
 *
 * `down` is provided for local development only. Production migrations run
 * forward-only; nothing here is destructive on `up`.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  // `gen_random_uuid()` is part of core PostgreSQL from 13 onwards, so no
  // pgcrypto extension is required. Render provisions PostgreSQL 14+.

  /* ── Users ────────────────────────────────────────────────────────────── */
  await sql`
    CREATE TABLE users (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                text        NOT NULL,
      normalized_email     text        NOT NULL,
      password_hash        text        NOT NULL,
      full_name            text        NOT NULL,
      email_verified_at    timestamptz,
      status               text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','disabled','locked','pending_verification')),
      must_change_password boolean     NOT NULL DEFAULT false,
      failed_login_count   integer     NOT NULL DEFAULT 0,
      locked_until         timestamptz,
      last_login_at        timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // Case-insensitive identity: 'A@b.com' and 'a@B.COM' are the same account.
  await sql`CREATE UNIQUE INDEX users_normalized_email_key ON users (normalized_email)`.execute(db);

  /* ── Platform roles (LEDGORA operators — NOT organization membership) ─── */
  await sql`
    CREATE TABLE platform_user_roles (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       text NOT NULL CHECK (role IN ('super_admin','billing_admin','support')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX platform_user_roles_user_role_key ON platform_user_roles (user_id, role)`.execute(db);

  /* ── Organizations & membership ───────────────────────────────────────── */
  await sql`
    CREATE TABLE organizations (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_name          text NOT NULL,
      trading_name        text,
      country             text NOT NULL,
      registration_number text,
      tax_number          text,
      industry            text,
      base_currency       text NOT NULL DEFAULT 'USD',
      fiscal_year_start   text NOT NULL DEFAULT '01-01',
      books_start_date    date,
      status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE organization_memberships (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            text NOT NULL CHECK (role IN ('owner','accountant','member','viewer')),
      status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX organization_memberships_org_user_key ON organization_memberships (organization_id, user_id)`.execute(db);
  await sql`CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id)`.execute(db);

  /* ── Plans ────────────────────────────────────────────────────────────── */
  await sql`
    CREATE TABLE subscription_plans (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code                text NOT NULL,
      name                text NOT NULL,
      description         text,
      edition             text NOT NULL,
      currency            text NOT NULL DEFAULT 'USD',
      monthly_price       numeric(12,2) NOT NULL,
      annual_price        numeric(12,2),
      user_limit          integer NOT NULL DEFAULT 1,
      entity_limit        integer NOT NULL DEFAULT 1,
      storage_limit       bigint,
      bandwidth_limit     bigint,
      module_entitlements jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_public           boolean NOT NULL DEFAULT true,
      is_active           boolean NOT NULL DEFAULT true,
      sort_order          integer NOT NULL DEFAULT 0,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX subscription_plans_code_key ON subscription_plans (code)`.execute(db);

  /* ── Subscriptions ────────────────────────────────────────────────────── */
  await sql`
    CREATE TABLE subscriptions (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      plan_id           uuid REFERENCES subscription_plans(id) ON DELETE RESTRICT,
      status            text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','pending_payment','pending_verification','active',
                                            'past_due','suspended','cancelled','expired','rejected')),
      billing_cycle     text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','annual')),
      starts_at         timestamptz,
      expires_at        timestamptz,
      grace_ends_at     timestamptz,
      user_limit        integer,
      entity_limit      integer,
      payment_reference text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX subscriptions_org_idx ON subscriptions (organization_id)`.execute(db);
  await sql`CREATE INDEX subscriptions_status_idx ON subscriptions (status)`.execute(db);

  /* ── Invoices ─────────────────────────────────────────────────────────── */
  await sql`
    CREATE TABLE subscription_invoices (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_number    text NOT NULL,
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      subscription_id   uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      currency          text NOT NULL DEFAULT 'USD',
      subtotal          numeric(12,2) NOT NULL,
      tax               numeric(12,2) NOT NULL DEFAULT 0,
      total             numeric(12,2) NOT NULL,
      status            text NOT NULL DEFAULT 'issued'
                          CHECK (status IN ('issued','proof_submitted','paid','rejected','cancelled')),
      payment_reference text NOT NULL,
      issued_at         timestamptz NOT NULL DEFAULT now(),
      due_at            timestamptz NOT NULL,
      paid_at           timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // Both identifiers are unique by database constraint — this is what actually
  // guarantees a payment reference can identify exactly one incoming transfer.
  await sql`CREATE UNIQUE INDEX subscription_invoices_number_key ON subscription_invoices (invoice_number)`.execute(db);
  await sql`CREATE UNIQUE INDEX subscription_invoices_payment_reference_key ON subscription_invoices (payment_reference)`.execute(db);
  await sql`CREATE INDEX subscription_invoices_org_idx ON subscription_invoices (organization_id)`.execute(db);

  /* ── Payment proofs (file bytes live in object storage, never here) ───── */
  await sql`
    CREATE TABLE payment_proofs (
      id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id                 uuid NOT NULL REFERENCES subscription_invoices(id) ON DELETE CASCADE,
      uploaded_by_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      file_name                  text NOT NULL,
      storage_key                text NOT NULL,
      mime_type                  text NOT NULL,
      file_size                  integer NOT NULL,
      bank_transaction_reference text,
      ledgora_payment_reference  text NOT NULL,
      amount                     numeric(12,2) NOT NULL,
      paid_at                    timestamptz NOT NULL,
      note                       text,
      status                     text NOT NULL DEFAULT 'submitted'
                                   CHECK (status IN ('submitted','approved','rejected','more_information_required')),
      reviewed_by_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at                timestamptz,
      rejection_reason           text,
      information_request        text,
      created_at                 timestamptz NOT NULL DEFAULT now(),
      updated_at                 timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX payment_proofs_invoice_idx ON payment_proofs (invoice_id)`.execute(db);
  await sql`CREATE INDEX payment_proofs_status_idx ON payment_proofs (status)`.execute(db);
  // At most one proof may be awaiting review per invoice — blocks double review.
  await sql`
    CREATE UNIQUE INDEX payment_proofs_one_open_per_invoice
      ON payment_proofs (invoice_id) WHERE status = 'submitted'
  `.execute(db);

  /* ── Billing configuration ────────────────────────────────────────────── */
  await sql`
    CREATE TABLE billing_settings (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      currency         text NOT NULL DEFAULT 'USD',
      payment_due_days integer NOT NULL DEFAULT 7,
      grace_days       integer NOT NULL DEFAULT 7,
      term_months      integer NOT NULL DEFAULT 1,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE bank_details (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bank_name      text NOT NULL,
      account_name   text NOT NULL,
      account_number text NOT NULL,
      iban           text,
      swift          text,
      branch         text,
      instructions   text,
      is_placeholder boolean NOT NULL DEFAULT true,
      updated_at     timestamptz NOT NULL DEFAULT now(),
      updated_by     uuid REFERENCES users(id) ON DELETE SET NULL
    )
  `.execute(db);

  /* ── Sessions (only a hash of the token is ever stored) ───────────────── */
  await sql`
    CREATE TABLE auth_sessions (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   text NOT NULL,
      expires_at   timestamptz NOT NULL,
      last_used_at timestamptz NOT NULL DEFAULT now(),
      revoked_at   timestamptz,
      ip_address   text,
      user_agent   text,
      created_at   timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX auth_sessions_token_hash_key ON auth_sessions (token_hash)`.execute(db);
  await sql`CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id)`.execute(db);

  /* ── Audit log (append-only by convention; no UPDATE/DELETE paths) ────── */
  await sql`
    CREATE TABLE audit_logs (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_platform_role text,
      action              text NOT NULL,
      target_type         text,
      target_id           text,
      organization_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,
      metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
      ip_address          text,
      user_agent          text,
      created_at          timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX audit_logs_action_idx ON audit_logs (action)`.execute(db);
  await sql`CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id)`.execute(db);
  await sql`CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC)`.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  for (const table of [
    'audit_logs',
    'auth_sessions',
    'bank_details',
    'billing_settings',
    'payment_proofs',
    'subscription_invoices',
    'subscriptions',
    'subscription_plans',
    'organization_memberships',
    'organizations',
    'platform_user_roles',
    'users',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(table)} CASCADE`.execute(db);
  }
}
