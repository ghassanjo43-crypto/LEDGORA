/**
 * Applicants — every registered customer, at whatever stage of onboarding.
 *
 * The defect this module exists to fix: the administrator's roster used to start
 * at `subscriptions`, so a customer who had created an account but not yet
 * chosen a package could not appear in it at all. There was no row to join to.
 *
 * Two independent guarantees replace that:
 *
 *  1. `ensureApplication` writes a `subscription_applications` record in the
 *     SAME transaction as the registration, so a prospect exists as an applicant
 *     from the instant the account does.
 *  2. The roster query below is based on `users` and LEFT JOINs everything else.
 *     A missing application, organization, plan, subscription, invoice or proof
 *     changes the *stage* that is reported — it can never remove the person from
 *     the result. Even if (1) somehow failed, the applicant is still visible.
 *
 * Stage is therefore derived, not merely stored: the subscription is the
 * authority for stages 2–5 and the application record is the authority for
 * stage 1 and for the administrator-applied `suspended` / `archived` states.
 * The two are kept in step by the lifecycle helpers, but the read path does not
 * depend on that being true.
 *
 * Dormancy is an overlay, never a stored stage — an applicant who goes quiet is
 * *shown* as dormant without losing the stage they actually reached, and stops
 * being dormant the moment they sign in again. Nothing is ever deleted.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ApplicationStatus, Database } from '../db/schema.js';
import { backfillApplications } from '../db/applicationsBackfill.js';
import { writeAuditLog, type AuditAction, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

export type Executor = Kysely<Database> | Transaction<Database>;

/** What the administrator sees — the stored stages plus the dormancy overlay. */
export type ApplicantStage = ApplicationStatus | 'dormant_applicant';

/** Tabs in the administrator UI, in funnel order. */
export const APPLICANT_STAGES = [
  'registered_no_package',
  'package_selected',
  'awaiting_payment',
  'pending_verification',
  'active_subscriber',
  'dormant_applicant',
  'suspended',
  'archived',
] as const;

export const APPLICANT_SORT_FIELDS = [
  'registered_at',
  'last_activity_at',
  'full_name',
  'email',
  'organization_name',
  'stage',
] as const;

export type ApplicantSortField = (typeof APPLICANT_SORT_FIELDS)[number];

export const DEFAULT_DORMANT_DAYS = 30;

/* ── Lifecycle writes ─────────────────────────────────────────────────────── */

/**
 * Create the applicant record if it is missing. Idempotent by the UNIQUE index
 * on `user_id`, so it is safe to call from a retry, a backfill or a repair.
 *
 * Platform operators are never applicants — a LEDGORA employee has no funnel.
 */
export async function ensureApplication(
  db: Executor,
  userId: string,
  options: { source?: string; organizationId?: string | null } = {},
): Promise<void> {
  const platformRole = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (platformRole) return;

  await db
    .insertInto('subscription_applications')
    .values({
      user_id: userId,
      organization_id: options.organizationId ?? null,
      status: 'registered_no_package',
      source: options.source ?? 'self_registration',
    })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();
}

export interface ApplicationAdvance {
  status?: ApplicationStatus;
  organizationId?: string;
  selectedPlanId?: string | null;
  subscriptionId?: string;
  packageSelectedAt?: Date;
  paymentStartedAt?: Date;
  proofUploadedAt?: Date;
  activatedAt?: Date;
}

function toPatch(advance: ApplicationAdvance): Record<string, unknown> {
  const now = new Date();
  const patch: Record<string, unknown> = { updated_at: now, last_activity_at: now };
  if (advance.status !== undefined) patch.status = advance.status;
  if (advance.organizationId !== undefined) patch.organization_id = advance.organizationId;
  if (advance.selectedPlanId !== undefined) patch.selected_plan_id = advance.selectedPlanId;
  if (advance.subscriptionId !== undefined) patch.subscription_id = advance.subscriptionId;
  if (advance.packageSelectedAt !== undefined) patch.package_selected_at = advance.packageSelectedAt;
  if (advance.paymentStartedAt !== undefined) patch.payment_started_at = advance.paymentStartedAt;
  if (advance.proofUploadedAt !== undefined) patch.proof_uploaded_at = advance.proofUploadedAt;
  if (advance.activatedAt !== undefined) patch.activated_at = advance.activatedAt;
  return patch;
}

/**
 * Move the applicant on. Archived applications are left alone — an archived
 * record is an administrator decision and customer activity must not undo it.
 *
 * A no-op when the record is missing: the read path derives the same stage from
 * the subscription, so a failed update degrades to "still correct", never to
 * "invisible".
 */
export async function advanceApplicationForUser(
  db: Executor,
  userId: string,
  advance: ApplicationAdvance,
): Promise<void> {
  await db
    .updateTable('subscription_applications')
    .set(toPatch(advance) as never)
    .where('user_id', '=', userId)
    .where('status', '!=', 'archived')
    .execute();
}

/** As above, keyed by organization — the administrator paths know the tenant, not the user. */
export async function advanceApplicationForOrganization(
  db: Executor,
  organizationId: string,
  advance: ApplicationAdvance,
): Promise<void> {
  await db
    .updateTable('subscription_applications')
    .set(toPatch(advance) as never)
    .where('organization_id', '=', organizationId)
    .where('status', '!=', 'archived')
    .execute();
}

/** Keep the dormancy clock honest without touching the applicant's stage. */
export async function touchApplicationActivity(db: Executor, userId: string): Promise<void> {
  await db
    .updateTable('subscription_applications')
    .set({ last_activity_at: new Date() })
    .where('user_id', '=', userId)
    .execute();
}

/**
 * Create the application records that are missing. Idempotent — safe on every
 * boot, and exposed as `npm run db:reconcile-applicants` for an operator.
 */
export async function reconcileApplications(db: Kysely<Database>): Promise<{ created: number }> {
  return { created: await backfillApplications(db) };
}

/* ── Roster ───────────────────────────────────────────────────────────────── */

export interface ApplicantView {
  userId: string;
  applicationId: string | null;
  fullName: string;
  email: string;
  accountStatus: string;
  emailVerified: boolean;
  registeredAt: string;
  lastLoginAt: string | null;
  lastActivityAt: string;
  /** Stage including the dormancy overlay — what the roster displays. */
  stage: ApplicantStage;
  /** Stage the applicant actually reached, ignoring dormancy. */
  funnelStage: ApplicationStatus;
  dormant: boolean;
  source: string | null;
  organizationId: string | null;
  organizationName: string | null;
  organizationCountry: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  planCurrency: string | null;
  planMonthlyPrice: number | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  billingCycle: string | null;
  subscriptionExpiresAt: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceTotal: number | null;
  paymentReference: string | null;
  proofId: string | null;
  proofStatus: string | null;
  packageSelectedAt: string | null;
  paymentStartedAt: string | null;
  proofUploadedAt: string | null;
  activatedAt: string | null;
}

export interface ListApplicantsOptions {
  stage?: ApplicantStage | 'all';
  search?: string;
  sort?: ApplicantSortField;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  dormantDays?: number;
}

export interface ApplicantListResult {
  applicants: ApplicantView[];
  pagination: { limit: number; offset: number; count: number; total: number };
  /** Row count per tab, computed over the whole (searched) population. */
  stageCounts: Record<string, number>;
  dormantDays: number;
}

interface ApplicantRow {
  user_id: string;
  application_id: string | null;
  full_name: string;
  email: string;
  account_status: string;
  email_verified: boolean;
  registered_at: Date;
  last_login_at: Date | null;
  last_activity_at: Date;
  effective_stage: ApplicationStatus;
  display_stage: ApplicantStage;
  source: string | null;
  organization_id: string | null;
  organization_name: string | null;
  organization_country: string | null;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  plan_currency: string | null;
  plan_monthly_price: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  billing_cycle: string | null;
  subscription_expires_at: Date | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  invoice_total: string | null;
  payment_reference: string | null;
  proof_id: string | null;
  proof_status: string | null;
  package_selected_at: Date | null;
  payment_started_at: Date | null;
  proof_uploaded_at: Date | null;
  activated_at: Date | null;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);
const num = (value: string | null): number | null => (value === null ? null : Number(value));

function toApplicantView(row: ApplicantRow): ApplicantView {
  return {
    userId: row.user_id,
    applicationId: row.application_id,
    fullName: row.full_name,
    email: row.email,
    accountStatus: row.account_status,
    emailVerified: Boolean(row.email_verified),
    registeredAt: new Date(row.registered_at).toISOString(),
    lastLoginAt: iso(row.last_login_at),
    lastActivityAt: new Date(row.last_activity_at).toISOString(),
    stage: row.display_stage,
    funnelStage: row.effective_stage,
    dormant: row.display_stage === 'dormant_applicant',
    source: row.source,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationCountry: row.organization_country,
    planId: row.plan_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    planCurrency: row.plan_currency,
    planMonthlyPrice: num(row.plan_monthly_price),
    subscriptionId: row.subscription_id,
    subscriptionStatus: row.subscription_status,
    billingCycle: row.billing_cycle,
    subscriptionExpiresAt: iso(row.subscription_expires_at),
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    invoiceStatus: row.invoice_status,
    invoiceTotal: num(row.invoice_total),
    paymentReference: row.payment_reference,
    proofId: row.proof_id,
    proofStatus: row.proof_status,
    packageSelectedAt: iso(row.package_selected_at),
    paymentStartedAt: iso(row.payment_started_at),
    proofUploadedAt: iso(row.proof_uploaded_at),
    activatedAt: iso(row.activated_at),
  };
}

/**
 * The applicant projection, as a reusable CTE.
 *
 * Base population is `users`. Every other table is LEFT JOINed, and the
 * correlated joins are LATERAL … LIMIT 1 so no join can ever multiply a user
 * into several roster rows. Platform operators are excluded here, at the
 * source, so no caller can accidentally list one as a customer.
 *
 * Columns are an explicit allow-list. `password_hash`, session rows, tokens and
 * every other authentication artefact are deliberately absent.
 */
function applicantCte(dormantCutoff: Date) {
  return sql`
    WITH applicant AS (
      SELECT
        u.id                             AS user_id,
        u.full_name                      AS full_name,
        u.email                          AS email,
        u.status                         AS account_status,
        (u.email_verified_at IS NOT NULL) AS email_verified,
        u.created_at                     AS registered_at,
        u.last_login_at                  AS last_login_at,
        a.id                             AS application_id,
        a.source                         AS source,
        a.package_selected_at            AS package_selected_at,
        a.payment_started_at             AS payment_started_at,
        a.proof_uploaded_at              AS proof_uploaded_at,
        a.activated_at                   AS activated_at,
        GREATEST(
          COALESCE(a.last_activity_at, u.created_at),
          COALESCE(u.last_login_at, u.created_at),
          u.created_at
        )                                AS last_activity_at,
        o.id                             AS organization_id,
        o.legal_name                     AS organization_name,
        o.country                        AS organization_country,
        sub.id                           AS subscription_id,
        sub.status                       AS subscription_status,
        sub.billing_cycle                AS billing_cycle,
        sub.expires_at                   AS subscription_expires_at,
        pl.id                            AS plan_id,
        pl.code                          AS plan_code,
        pl.name                          AS plan_name,
        pl.currency                      AS plan_currency,
        pl.monthly_price                 AS plan_monthly_price,
        inv.id                           AS invoice_id,
        inv.invoice_number               AS invoice_number,
        inv.status                       AS invoice_status,
        inv.total                        AS invoice_total,
        inv.payment_reference            AS payment_reference,
        pr.id                            AS proof_id,
        pr.status                        AS proof_status,
        CASE
          -- Administrator decisions outrank anything the funnel says.
          WHEN a.status IN ('suspended', 'archived')                     THEN a.status
          WHEN sub.status = 'active'                                     THEN 'active_subscriber'
          WHEN sub.status = 'pending_verification'                       THEN 'pending_verification'
          WHEN sub.status IN ('pending_payment', 'rejected', 'past_due') THEN 'awaiting_payment'
          -- Holds a package but has not started paying. Lapsed subscriptions
          -- (suspended/cancelled/expired) land here too; the raw subscription
          -- status is reported alongside so nothing is hidden from the reviewer.
          WHEN COALESCE(sub.plan_id, a.selected_plan_id) IS NOT NULL     THEN 'package_selected'
          -- No application record at all still yields a visible applicant.
          ELSE COALESCE(a.status, 'registered_no_package')
        END                              AS effective_stage
      FROM users u
      LEFT JOIN subscription_applications a ON a.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT om.organization_id
        FROM organization_memberships om
        WHERE om.user_id = u.id AND om.status = 'active'
        ORDER BY om.created_at ASC
        LIMIT 1
      ) m ON true
      LEFT JOIN organizations o ON o.id = COALESCE(a.organization_id, m.organization_id)
      LEFT JOIN LATERAL (
        SELECT s.*
        FROM subscriptions s
        WHERE s.organization_id = o.id
        ORDER BY (s.status = 'active') DESC, s.created_at DESC
        LIMIT 1
      ) sub ON true
      LEFT JOIN subscription_plans pl ON pl.id = COALESCE(sub.plan_id, a.selected_plan_id)
      LEFT JOIN LATERAL (
        SELECT i.*
        FROM subscription_invoices i
        WHERE i.subscription_id = sub.id AND i.status <> 'cancelled'
        ORDER BY i.created_at DESC
        LIMIT 1
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT p.id, p.status
        FROM payment_proofs p
        WHERE p.invoice_id = inv.id
        ORDER BY p.created_at DESC
        LIMIT 1
      ) pr ON true
      -- Platform operators are staff, never applicants.
      WHERE NOT EXISTS (SELECT 1 FROM platform_user_roles r WHERE r.user_id = u.id)
    ),
    applicant_display AS (
      SELECT
        applicant.*,
        CASE
          -- Paying and administratively-closed accounts are never "dormant".
          WHEN effective_stage IN ('active_subscriber', 'suspended', 'archived') THEN effective_stage
          WHEN last_activity_at < ${dormantCutoff}                               THEN 'dormant_applicant'
          ELSE effective_stage
        END AS display_stage
      FROM applicant
    )
  `;
}

/**
 * Filter predicate shared by the page query and the counts, so a total can never
 * disagree with the rows it is counting.
 *
 * A stage tab filters on the stage actually reached, so a quiet prospect still
 * appears under "Package not selected" as well as under "Dormant"; the Dormant
 * tab filters on the displayed stage.
 */
function applicantPredicate(options: { stage?: ApplicantStage | 'all'; search?: string }) {
  const clauses = [sql`1 = 1`];

  if (options.stage && options.stage !== 'all') {
    clauses.push(
      options.stage === 'dormant_applicant'
        ? sql`display_stage = ${options.stage}`
        : sql`effective_stage = ${options.stage}`,
    );
  }

  if (options.search) {
    // Parameterised — the pattern is a bound value, never interpolated SQL.
    const pattern = `%${options.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(sql`(
      full_name ILIKE ${pattern} ESCAPE '\\'
      OR email ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(organization_name, '') ILIKE ${pattern} ESCAPE '\\'
    )`);
  }

  return sql.join(clauses, sql` AND `);
}

/** Whitelisted ORDER BY. Nothing from the request ever reaches `sql.raw`. */
const SORT_COLUMN: Record<ApplicantSortField, string> = {
  registered_at: 'registered_at',
  last_activity_at: 'last_activity_at',
  full_name: 'full_name',
  email: 'email',
  organization_name: 'organization_name',
  stage: 'display_stage',
};

export async function listApplicants(
  db: Kysely<Database>,
  options: ListApplicantsOptions = {},
): Promise<ApplicantListResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const dormantDays = Math.max(options.dormantDays ?? DEFAULT_DORMANT_DAYS, 1);
  const cutoff = new Date(Date.now() - dormantDays * 86_400_000);
  const search = options.search?.trim() || undefined;

  const cte = applicantCte(cutoff);
  const where = applicantPredicate({ stage: options.stage, search });
  const sortField: ApplicantSortField = options.sort ?? 'registered_at';
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
  // Both parts come from a whitelist, never from the raw request value.
  const orderBy = sql.raw(`${SORT_COLUMN[sortField]} ${direction}, user_id ASC`);

  const rows = await sql<ApplicantRow>`
    ${cte}
    SELECT * FROM applicant_display
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `.execute(db);

  const totals = await sql<{ total: number }>`
    ${cte}
    SELECT COUNT(*)::int AS total FROM applicant_display WHERE ${where}
  `.execute(db);

  // Counts ignore the stage filter (they drive the tab badges) but respect the
  // search, so the numbers always match what the operator is looking at.
  const counts = await sql<{ display_stage: string; effective_stage: string; total: number }>`
    ${cte}
    SELECT display_stage, effective_stage, COUNT(*)::int AS total
    FROM applicant_display
    WHERE ${applicantPredicate({ search })}
    GROUP BY display_stage, effective_stage
  `.execute(db);

  const stageCounts: Record<string, number> = { all: 0 };
  for (const stage of APPLICANT_STAGES) stageCounts[stage] = 0;
  for (const row of counts.rows) {
    stageCounts.all = (stageCounts.all ?? 0) + row.total;
    stageCounts[row.effective_stage] = (stageCounts[row.effective_stage] ?? 0) + row.total;
    if (row.display_stage === 'dormant_applicant') {
      stageCounts.dormant_applicant = (stageCounts.dormant_applicant ?? 0) + row.total;
    }
  }

  return {
    applicants: rows.rows.map(toApplicantView),
    pagination: { limit, offset, count: rows.rows.length, total: totals.rows[0]?.total ?? 0 },
    stageCounts,
    dormantDays,
  };
}

/** One applicant, keyed by the user id — the identity that always exists. */
export async function getApplicant(
  db: Kysely<Database>,
  userId: string,
  options: { dormantDays?: number } = {},
): Promise<ApplicantView> {
  const dormantDays = Math.max(options.dormantDays ?? DEFAULT_DORMANT_DAYS, 1);
  const cutoff = new Date(Date.now() - dormantDays * 86_400_000);

  const result = await sql<ApplicantRow>`
    ${applicantCte(cutoff)}
    SELECT * FROM applicant_display WHERE user_id = ${userId}
  `.execute(db);

  const row = result.rows[0];
  if (!row) throw errors.notFound('Applicant');
  return toApplicantView(row);
}

/* ── Administrator actions ────────────────────────────────────────────────── */

export interface ApplicantAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

export type ApplicantAdminAction = 'suspend' | 'archive' | 'restore';

const ACTION_STATUS: Record<ApplicantAdminAction, ApplicationStatus> = {
  suspend: 'suspended',
  archive: 'archived',
  // Restore hands the applicant back to the funnel: reset to the base stage and
  // the read path immediately re-derives the truth from their subscription.
  restore: 'registered_no_package',
};

const ACTION_AUDIT: Record<ApplicantAdminAction, AuditAction> = {
  suspend: 'applicant.suspended',
  archive: 'applicant.archived',
  restore: 'applicant.restored',
};

/**
 * Suspend, archive or restore an applicant. None of these delete anything — the
 * account and its history stay intact, which is the whole point of tracking a
 * dormant prospect rather than removing them.
 */
export async function setApplicantAdminState(
  db: Kysely<Database>,
  userId: string,
  action: ApplicantAdminAction,
  reason: string,
  context: ApplicantAdminContext,
): Promise<ApplicantView> {
  if (!reason.trim()) throw errors.validation('A reason is required and is recorded in the audit trail.');

  const user = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
  if (!user) throw errors.notFound('Applicant');

  const platformRole = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (platformRole) throw errors.validation('Platform operators are not applicants.');

  // The record may not exist yet (a pre-backfill account); create it first so
  // the administrator's decision always has somewhere to live.
  await ensureApplication(db, userId, { source: 'admin_action' });

  await db
    .updateTable('subscription_applications')
    .set({ status: ACTION_STATUS[action], updated_at: new Date() })
    .where('user_id', '=', userId)
    .execute();

  await writeAuditLog(db, {
    ...context,
    action: ACTION_AUDIT[action],
    targetType: 'applicant',
    targetId: userId,
    metadata: { reason: reason.trim(), action },
  });

  return getApplicant(db, userId);
}

/**
 * Record that a package-selection reminder was requested.
 *
 * BACKEND SEAM: delivery needs the transactional mail service, which is not
 * configured in this deployment (the same seam as password reset). The request
 * is audited so the operator has a record of who was chased and when, and the
 * response says plainly that nothing was sent.
 */
export async function recordPackageReminder(
  db: Kysely<Database>,
  userId: string,
  context: ApplicantAdminContext,
): Promise<{ applicant: ApplicantView; delivered: boolean; message: string }> {
  const applicant = await getApplicant(db, userId);

  await writeAuditLog(db, {
    ...context,
    action: 'applicant.reminder_requested',
    targetType: 'applicant',
    targetId: userId,
    metadata: { stage: applicant.stage, delivered: false },
  });

  return {
    applicant,
    delivered: false,
    message: 'Reminder recorded. Email delivery is not configured in this deployment, so no message was sent.',
  };
}
