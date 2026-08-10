/**
 * Onboarding applications — the record that makes a registered prospect visible.
 *
 * Before this table the only trace of a new customer was a `users` row. The
 * administrator's roster query started at `subscriptions`, so anyone who had not
 * yet chosen a package could not appear in it at all. This record is created in
 * the same transaction as the registration and carries the applicant through
 * every stage of the funnel.
 *
 * `user_id` is UNIQUE: one application per account, which makes creation
 * idempotent (`ON CONFLICT DO NOTHING`) and the administrator join exactly 1:1.
 */
import { sql, type Kysely } from 'kysely';
import { backfillApplications } from '../applicationsBackfill.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE TABLE subscription_applications (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,
      selected_plan_id    uuid REFERENCES subscription_plans(id) ON DELETE SET NULL,
      subscription_id     uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
      status              text NOT NULL DEFAULT 'registered_no_package'
                            CHECK (status IN ('registered_no_package','package_selected','awaiting_payment',
                                              'pending_verification','active_subscriber','suspended','archived')),
      registered_at       timestamptz NOT NULL DEFAULT now(),
      package_selected_at timestamptz,
      payment_started_at  timestamptz,
      proof_uploaded_at   timestamptz,
      activated_at        timestamptz,
      last_activity_at    timestamptz NOT NULL DEFAULT now(),
      source              text NOT NULL DEFAULT 'self_registration',
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  // One application per account. This is what makes "ensure the record exists"
  // safe to call from anywhere, including a retry after a partial failure.
  await sql`CREATE UNIQUE INDEX subscription_applications_user_key ON subscription_applications (user_id)`.execute(db);
  await sql`CREATE INDEX subscription_applications_status_idx ON subscription_applications (status)`.execute(db);
  await sql`CREATE INDEX subscription_applications_org_idx ON subscription_applications (organization_id)`.execute(db);
  await sql`CREATE INDEX subscription_applications_registered_idx ON subscription_applications (registered_at DESC)`.execute(db);
  await sql`CREATE INDEX subscription_applications_activity_idx ON subscription_applications (last_activity_at DESC)`.execute(db);

  // Existing customers were registered before this table existed. Give every one
  // of them a record, at the stage their current data implies.
  await backfillApplications(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS subscription_applications CASCADE`.execute(db);
}
