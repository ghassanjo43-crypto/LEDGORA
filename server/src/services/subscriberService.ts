/**
 * Subscribers — the operator's view of a customer ACCOUNT (an organization).
 *
 * ── The distinction the whole module rests on ────────────────────────────────
 *   subscriber = an organization, with a package and a subscription;
 *   member     = a user who belongs to one, one of whom holds the `owner` role.
 * So `createSubscriber` creates a person AND a tenant AND the membership that
 * links them, and every subscription concept below hangs off the organization.
 *
 * ── Why creation is one transaction ──────────────────────────────────────────
 * Seven records have to exist together for a subscriber to be usable: the user,
 * the organization, the owner membership, the applicant record, the subscription,
 * its entitlement, and the audit entry. Any subset of those is worse than
 * nothing:
 *   · user without organization  → they sign in to an empty funnel;
 *   · organization without owner → nobody can administer it, ever;
 *   · subscription without entitlement → they are billed and locked out;
 *   · anything without the audit entry → an account nobody can account for.
 * They are therefore written in a single `db.transaction()`. The Argon2 hash for
 * the initial credential is computed BEFORE the transaction opens, so an
 * expensive KDF never holds a database connection.
 *
 * ── Onboarding without mail ──────────────────────────────────────────────────
 * Two honest options, chosen by the administrator:
 *   `invite`    — mint a single-use reset link. Reports whether delivery actually
 *                 happened, and in this deployment it has not, so it says so.
 *   `temporary` — generate a password, show it once, hash it immediately.
 * Neither ever stores or logs a raw credential. See `lib/credentials`.
 */
import { sql, type Kysely } from 'kysely';
import type {
  BillingCycle,
  Database,
  OrganizationStatus,
  SubscriptionStatus,
} from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { generateResetToken, generateTemporaryPassword } from '../lib/credentials.js';
import { insertUser, normaliseEmail } from './userService.js';
import {
  getEntitlements,
  recalculateEntitlements,
  toModuleList,
  type EntitlementView,
} from './entitlementService.js';
import { listPackageHistory, type PackageHistoryEntry } from './packageAssignmentService.js';

export interface SubscriberAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

/* ── Creation ─────────────────────────────────────────────────────────────── */

export type OnboardingMethod = 'invite' | 'temporary';

export interface CreateSubscriberInput {
  fullName: string;
  email: string;
  organizationLegalName: string;
  tradingName?: string;
  country: string;
  baseCurrency?: string;
  /**
   * Is this real customer data?
   *
   * Defaults to `production` — the safe answer — so a caller that omits it can
   * never accidentally create a permanently-deletable tenant. Only a Super Admin
   * may choose otherwise, and the choice is irreversible in one direction.
   */
  dataClassification?: 'production' | 'test' | 'demo';
  /** The base package. Required — a subscriber without one is just an applicant. */
  planId: string;
  /** Optional modules on top of the base package. */
  modules?: string[];
  /** Account/subscription status to start in. */
  subscriptionStatus?: SubscriptionStatus;
  organizationStatus?: OrganizationStatus;
  startDate?: Date;
  billingCycle?: BillingCycle;
  seatAllowance?: number | null;
  entityAllowance?: number | null;
  storageAllowance?: number | null;
  /** True when money has already been received outside the portal. */
  paymentConfirmed?: boolean;
  internalNotes?: string;
  onboarding: OnboardingMethod;
  /** Minutes a generated temporary password stays valid. */
  temporaryPasswordTtlMinutes?: number;
  /** Minutes an invitation/reset link stays valid. */
  resetLinkTtlMinutes?: number;
}

/**
 * Whether a credential actually reached the recipient.
 *
 * `unavailable` is not a failure — it is "there is no mail service configured in
 * this deployment, so nothing was attempted". Distinguishing it from `failed`
 * matters: one means the operator must hand the credential over themselves, the
 * other means delivery was tried and broke.
 */
export type CredentialDeliveryStatus = 'sent' | 'unavailable' | 'failed';

/**
 * A one-time credential.
 *
 * ── The contract this type exists to make explicit ───────────────────────────
 * `temporaryPassword` and `invitationToken` appear in the response that GENERATED
 * them and nowhere else in the system. They are not stored (only an Argon2id or
 * SHA-256 digest is), not logged, not written to audit metadata, and no GET
 * endpoint can return them. A client that loses this response cannot recover the
 * value — it must issue a new one.
 *
 * `type` is the discriminant the client switches on, so "was a credential
 * returned at all?" is answerable without inspecting optional fields.
 */
export interface OneTimeCredential {
  type: 'temporary_password' | 'invitation';
  /** Present only when `type` is `temporary_password`. Shown once. */
  temporaryPassword?: string;
  /** Present only when `type` is `invitation`. Shown once. */
  invitationToken?: string;
  expiresAt: string;
  /** The truth about delivery, not a reassuring guess. */
  deliveryStatus: CredentialDeliveryStatus;
  /** True when the holder must replace this credential at first sign-in. */
  mustChangePassword: boolean;
  /** Sessions ended by issuing it, when issuing it ended any. */
  revokedSessions?: number;
  message: string;
}

export interface CreatedSubscriber {
  subscriber: {
    userId: string;
    organizationId: string;
    email: string;
    fullName: string;
    subscriptionId: string;
    membershipId: string;
    applicationId: string | null;
    subscriptionStatus: SubscriptionStatus;
  };
  entitlements: EntitlementView;
  /** The one-time credential. Always present on a successful creation. */
  credential: OneTimeCredential;
}

/**
 * Statuses that mean "this tenant is entitled now". A manually created subscriber
 * whose payment is already confirmed lands here; everyone else waits.
 */
function resolveInitialStatus(input: CreateSubscriberInput): SubscriptionStatus {
  if (input.subscriptionStatus) return input.subscriptionStatus;
  return input.paymentConfirmed ? 'active' : 'pending_payment';
}

function addMonths(from: Date, months: number): Date {
  const date = new Date(from);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

export async function createSubscriber(
  db: Kysely<Database>,
  input: CreateSubscriberInput,
  context: SubscriberAdminContext,
): Promise<CreatedSubscriber> {
  const email = input.email.trim();
  const normalised = normaliseEmail(email);

  // Fail before doing any expensive work, and with a field-level message the
  // creation form can attach to the offending input.
  const clash = await db
    .selectFrom('users')
    .select('id')
    .where('normalized_email', '=', normalised)
    .executeTakeFirst();
  if (clash) {
    throw errors.conflict('An account with this email already exists.');
  }

  const plan = await db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('id', '=', input.planId)
    .executeTakeFirst();
  if (!plan) {
    throw errors.validation('Choose a base package for this subscriber.', {
      fieldErrors: { planId: 'That package does not exist.' },
    });
  }

  const status = resolveInitialStatus(input);
  const entitling = status === 'active' || status === 'past_due';
  const startDate = input.startDate ?? new Date();
  const billingCycle: BillingCycle = input.billingCycle ?? 'monthly';
  const extras = [...new Set(input.modules ?? [])].sort();

  /*
   * The initial credential is minted and hashed OUTSIDE the transaction:
   * Argon2id is deliberately expensive and must never hold a connection open.
   * The raw value stays in this local scope and reaches exactly one place — the
   * response — before going out of scope.
   */
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const usingTemporary = input.onboarding === 'temporary';
  const passwordTtl = Math.max(input.temporaryPasswordTtlMinutes ?? 60 * 24, 5);
  const passwordExpiresAt = usingTemporary ? new Date(Date.now() + passwordTtl * 60_000) : null;
  const resetLink = generateResetToken(input.resetLinkTtlMinutes ?? 60 * 24 * 3);

  const created = await db.transaction().execute(async (trx) => {
    const settings = await trx.selectFrom('billing_settings').selectAll().executeTakeFirst();
    const termMonths = settings?.term_months ?? 1;
    const graceDays = settings?.grace_days ?? 7;

    /* 1 ── the person */
    const user = await insertUser(trx, {
      email,
      fullName: input.fullName,
      passwordHash,
      status: 'active',
      // An administrator creating the account has verified the customer by other
      // means; the address itself is only trusted once they use the link.
      emailVerified: false,
      // Both onboarding routes end in the customer choosing their own password.
      mustChangePassword: true,
    });

    if (passwordExpiresAt) {
      await trx
        .updateTable('users')
        .set({ password_expires_at: passwordExpiresAt })
        .where('id', '=', user.id)
        .execute();
    }

    /* 2 ── the tenant */
    const organization = await trx
      .insertInto('organizations')
      .values({
        legal_name: input.organizationLegalName.trim(),
        trading_name: input.tradingName?.trim() || null,
        country: input.country,
        base_currency: input.baseCurrency ?? 'USD',
        data_classification: input.dataClassification ?? 'production',
        classified_by: context.actorUserId,
        /*
         * Created through the console, where an operator picked the type on the
         * form — so this is a reviewed decision from birth and must not show up
         * in the reconciliation queue alongside rows the 008 migration
         * defaulted. Self-service registrations get no such stamp, because
         * nobody reviewed those.
         */
        classification_reviewed_at: new Date(),
        classification_reviewed_by: context.actorUserId,
        fiscal_year_start: '01-01',
        status: input.organizationStatus ?? 'active',
        internal_notes: input.internalNotes?.trim() || null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    /* 3 ── the owner membership: this is what makes them the owner */
    const membership = await trx
      .insertInto('organization_memberships')
      .values({
        organization_id: organization.id,
        user_id: user.id,
        role: 'owner',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    /* 4 ── the subscription, with any negotiated overrides */
    const expiresAt = entitling
      ? addMonths(startDate, billingCycle === 'annual' ? termMonths * 12 : termMonths)
      : null;
    const subscription = await trx
      .insertInto('subscriptions')
      .values({
        organization_id: organization.id,
        plan_id: plan.id,
        status,
        billing_cycle: billingCycle,
        user_limit: input.seatAllowance ?? plan.user_limit,
        entity_limit: input.entityAllowance ?? plan.entity_limit,
        storage_limit: input.storageAllowance ?? plan.storage_limit ?? null,
        extra_modules: JSON.stringify(extras),
        starts_at: entitling ? startDate : null,
        expires_at: expiresAt,
        grace_ends_at: expiresAt ? new Date(expiresAt.getTime() + graceDays * 86_400_000) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    /*
     * 5 ── the applicant record. Written directly rather than via
     * `ensureApplication`, because the administrator already knows the stage and
     * an operator-created subscriber must not start at "registered, no package".
     */
    const application = await trx
      .insertInto('subscription_applications')
      .values({
        user_id: user.id,
        organization_id: organization.id,
        selected_plan_id: plan.id,
        subscription_id: subscription.id,
        status: entitling ? 'active_subscriber' : 'awaiting_payment',
        source: 'admin_created',
        ...(entitling ? { activated_at: startDate } : {}),
        package_selected_at: new Date(),
        payment_started_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    /* 6 ── the package history opener, so the tenant has a first data point */
    await trx
      .insertInto('subscription_package_changes')
      .values({
        organization_id: organization.id,
        subscription_id: subscription.id,
        previous_plan_id: null,
        new_plan_id: plan.id,
        previous_plan_code: null,
        new_plan_code: plan.code,
        previous_status: null,
        new_status: status,
        previous_modules: JSON.stringify([]),
        new_modules: JSON.stringify(
          [...new Set([...toModuleList(plan.module_entitlements), ...extras])].sort(),
        ),
        previous_user_limit: null,
        new_user_limit: input.seatAllowance ?? plan.user_limit,
        direction: 'initial',
        effective_at: startDate,
        reason: 'Subscriber created by platform administrator.',
        changed_by_user_id: context.actorUserId,
      })
      .execute();

    /* 7 ── the invitation link, hash-only (minted for both methods so the
       administrator can fall back to it without a second round trip) */
    await trx
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: resetLink.tokenHash,
        expires_at: resetLink.expiresAt,
        issued_by_user_id: context.actorUserId,
      })
      .execute();

    /* 8 ── the entitlement record */
    const entitlements = await recalculateEntitlements(trx, organization.id);

    /* 9 ── the audit trail. Metadata carries no credential — only WHICH method
       was used, which is exactly what an auditor needs to know. */
    await writeAuditLog(trx, {
      ...context,
      organizationId: organization.id,
      action: 'subscriber.created',
      targetType: 'organization',
      targetId: organization.id,
      metadata: {
        organizationLegalName: input.organizationLegalName.trim(),
        country: input.country,
        // Recorded at creation: the retention decision must be reconstructable.
        dataClassification: input.dataClassification ?? 'production',
        ownerUserId: user.id,
        ownerEmail: email,
        planCode: plan.code,
        optionalModules: extras,
        subscriptionStatus: status,
        billingCycle,
        paymentConfirmed: Boolean(input.paymentConfirmed),
        seatAllowance: input.seatAllowance ?? plan.user_limit,
        onboardingMethod: input.onboarding,
        mustChangePassword: true,
        hasInternalNotes: Boolean(input.internalNotes?.trim()),
      },
    });

    return {
      userId: user.id,
      organizationId: organization.id,
      subscriptionId: subscription.id,
      membershipId: membership.id,
      applicationId: application.id,
      entitlements,
    };
  });

  return {
    subscriber: {
      userId: created.userId,
      organizationId: created.organizationId,
      email,
      fullName: input.fullName.trim(),
      subscriptionId: created.subscriptionId,
      membershipId: created.membershipId,
      applicationId: created.applicationId,
      subscriptionStatus: status,
    },
    entitlements: created.entitlements,
    /*
     * The one-time credential. This is the only place either raw value is ever
     * readable; both are already hashed in the database by the time we get here.
     */
    credential: usingTemporary
      ? {
          type: 'temporary_password' as const,
          temporaryPassword,
          expiresAt: passwordExpiresAt!.toISOString(),
          // Nothing was emailed; the administrator is the delivery channel.
          deliveryStatus: 'unavailable' as const,
          mustChangePassword: true,
          message: `Temporary password generated. Show it to ${input.fullName.trim()} once — it cannot be retrieved again, and it must be changed at first sign-in.`,
        }
      : {
          type: 'invitation' as const,
          invitationToken: resetLink.token,
          expiresAt: resetLink.expiresAt.toISOString(),
          deliveryStatus: 'unavailable' as const,
          // The invitee chooses their own password through the link, so there is
          // no interim credential for them to be forced to replace.
          mustChangePassword: false,
          message:
            'Invitation link could not be sent because email delivery is not configured. Copy the link below and pass it to the customer through a channel you trust.',
        },
  };
}

/* ── Roster ───────────────────────────────────────────────────────────────── */

export const SUBSCRIBER_SORT_FIELDS = [
  'created_at',
  'legal_name',
  'status',
  'plan_code',
  'subscription_status',
  'renews_at',
  'seats_used',
] as const;
export type SubscriberSortField = (typeof SUBSCRIBER_SORT_FIELDS)[number];

export interface SubscriberRow {
  organizationId: string;
  legalName: string;
  tradingName: string | null;
  country: string;
  organizationStatus: string;
  /**
   * production | test | demo. Drives whether the console may offer permanent
   * deletion at all — the server enforces it regardless, but an operator should
   * not be shown a button that will always be refused.
   */
  dataClassification: string;
  /**
   * When a human confirmed the classification, or null when the 008 migration
   * default is the only thing that ever set it. Null is "nobody has reviewed
   * this", never "not production".
   */
  classificationReviewedAt: string | null;
  legalHold: boolean;
  createdAt: string;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  edition: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  billingCycle: string | null;
  startsAt: string | null;
  /** Renewal date for a live subscription, activation date otherwise. */
  renewsAt: string | null;
  seatsUsed: number;
  seatLimit: number | null;
  entityLimit: number | null;
  modules: string[];
  entitlementActive: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  memberCount: number;
  openInvoiceId: string | null;
  openInvoiceStatus: string | null;
  pendingProofId: string | null;
}

export interface ListSubscribersOptions {
  status?: string;
  /** `production | test | demo`, or `all`/absent for every classification. */
  classification?: string;
  subscriptionStatus?: string;
  planId?: string;
  search?: string;
  sort?: SubscriberSortField;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SubscriberListResult {
  subscribers: SubscriberRow[];
  pagination: { limit: number; offset: number; count: number; total: number };
  statusCounts: Record<string, number>;
}

/**
 * The roster projection.
 *
 * Base population is `organizations`, everything else LEFT JOINed through
 * LATERAL … LIMIT 1 so no join can multiply one tenant into several rows — the
 * same discipline the applicant roster uses, and for the same reason.
 *
 * Columns are an explicit allow-list. `internal_notes` is excluded from the LIST
 * deliberately: notes belong on the detail view an operator opens on purpose, not
 * in a table that might be exported or screen-shared.
 */
function subscriberCte() {
  return sql`
    WITH subscriber AS (
      SELECT
        o.id                                  AS organization_id,
        o.legal_name                          AS legal_name,
        o.trading_name                        AS trading_name,
        o.country                             AS country,
        o.status                              AS organization_status,
        o.data_classification                 AS data_classification,
        o.classification_reviewed_at          AS classification_reviewed_at,
        o.legal_hold                          AS legal_hold,
        o.created_at                          AS created_at,
        sub.id                                AS subscription_id,
        sub.status                            AS subscription_status,
        sub.billing_cycle                     AS billing_cycle,
        sub.starts_at                         AS starts_at,
        COALESCE(sub.expires_at, sub.starts_at) AS renews_at,
        sub.user_limit                        AS subscription_user_limit,
        sub.entity_limit                      AS subscription_entity_limit,
        pl.id                                 AS plan_id,
        pl.code                               AS plan_code,
        pl.name                               AS plan_name,
        pl.edition                            AS edition,
        pl.user_limit                         AS plan_user_limit,
        pl.entity_limit                       AS plan_entity_limit,
        ent.modules                           AS entitlement_modules,
        ent.active                            AS entitlement_active,
        owner.user_id                         AS owner_user_id,
        owner.full_name                       AS owner_name,
        owner.email                           AS owner_email,
        seats.seats_used                      AS seats_used,
        seats.member_count                    AS member_count,
        inv.id                                AS open_invoice_id,
        inv.status                            AS open_invoice_status,
        pr.id                                 AS pending_proof_id
      FROM organizations o
      LEFT JOIN LATERAL (
        SELECT s.*
        FROM subscriptions s
        WHERE s.organization_id = o.id
        ORDER BY (s.status = 'active') DESC, s.created_at DESC
        LIMIT 1
      ) sub ON true
      LEFT JOIN subscription_plans pl ON pl.id = sub.plan_id
      LEFT JOIN organization_entitlements ent ON ent.organization_id = o.id
      LEFT JOIN LATERAL (
        SELECT om.user_id, u.full_name, u.email
        FROM organization_memberships om
        JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = o.id AND om.role = 'owner'
        ORDER BY (om.status = 'active') DESC, om.created_at ASC
        LIMIT 1
      ) owner ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE om.status <> 'suspended')::int AS seats_used,
          COUNT(*)::int                                          AS member_count
        FROM organization_memberships om
        WHERE om.organization_id = o.id
      ) seats ON true
      LEFT JOIN LATERAL (
        SELECT i.id, i.status
        FROM subscription_invoices i
        WHERE i.organization_id = o.id AND i.status IN ('issued', 'proof_submitted')
        ORDER BY i.created_at DESC
        LIMIT 1
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT p.id
        FROM payment_proofs p
        JOIN subscription_invoices i2 ON i2.id = p.invoice_id
        WHERE i2.organization_id = o.id AND p.status = 'submitted'
        ORDER BY p.created_at DESC
        LIMIT 1
      ) pr ON true
    )
  `;
}

function subscriberPredicate(options: ListSubscribersOptions) {
  const clauses = [sql`1 = 1`];

  if (options.status && options.status !== 'all') {
    clauses.push(sql`organization_status = ${options.status}`);
  }
  if (options.subscriptionStatus && options.subscriptionStatus !== 'all') {
    clauses.push(
      options.subscriptionStatus === 'none'
        ? sql`subscription_status IS NULL`
        : sql`subscription_status = ${options.subscriptionStatus}`,
    );
  }
  if (options.planId) {
    clauses.push(sql`plan_id = ${options.planId}::uuid`);
  }
  /*
   * Filtered in SQL rather than in the browser: a roster page is a window over
   * the whole table, so filtering the loaded page would silently show "the
   * demo tenants on page 1" and let an operator conclude there are no others.
   */
  if (options.classification && options.classification !== 'all') {
    clauses.push(sql`data_classification = ${options.classification}`);
  }
  if (options.search) {
    // Parameterised — the pattern is a bound value, never interpolated SQL.
    const pattern = `%${options.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(sql`(
      legal_name ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(trading_name, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(owner_name, '')  ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(owner_email, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(plan_code, '')   ILIKE ${pattern} ESCAPE '\\'
    )`);
  }

  return sql.join(clauses, sql` AND `);
}

/** Whitelisted ORDER BY. Nothing from the request ever reaches `sql.raw`. */
const SUBSCRIBER_SORT_COLUMN: Record<SubscriberSortField, string> = {
  created_at: 'created_at',
  legal_name: 'legal_name',
  status: 'organization_status',
  plan_code: 'plan_code',
  subscription_status: 'subscription_status',
  renews_at: 'renews_at',
  seats_used: 'seats_used',
};

interface SubscriberQueryRow {
  organization_id: string;
  legal_name: string;
  trading_name: string | null;
  country: string;
  organization_status: string;
  data_classification: string;
  classification_reviewed_at: Date | null;
  legal_hold: boolean;
  created_at: Date;
  subscription_id: string | null;
  subscription_status: string | null;
  billing_cycle: string | null;
  starts_at: Date | null;
  renews_at: Date | null;
  subscription_user_limit: number | null;
  subscription_entity_limit: number | null;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  edition: string | null;
  plan_user_limit: number | null;
  plan_entity_limit: number | null;
  entitlement_modules: unknown;
  entitlement_active: boolean | null;
  owner_user_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  seats_used: number | null;
  member_count: number | null;
  open_invoice_id: string | null;
  open_invoice_status: string | null;
  pending_proof_id: string | null;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

function toSubscriberRow(row: SubscriberQueryRow): SubscriberRow {
  return {
    organizationId: row.organization_id,
    legalName: row.legal_name,
    tradingName: row.trading_name,
    country: row.country,
    organizationStatus: row.organization_status,
    dataClassification: row.data_classification,
    /* Null means the 008 migration default is the only thing that ever set it. */
    classificationReviewedAt: row.classification_reviewed_at
      ? new Date(row.classification_reviewed_at).toISOString()
      : null,
    legalHold: Boolean(row.legal_hold),
    createdAt: new Date(row.created_at).toISOString(),
    planId: row.plan_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    edition: row.edition,
    subscriptionId: row.subscription_id,
    subscriptionStatus: row.subscription_status,
    billingCycle: row.billing_cycle,
    startsAt: iso(row.starts_at),
    renewsAt: iso(row.renews_at),
    seatsUsed: row.seats_used ?? 0,
    seatLimit: row.subscription_user_limit ?? row.plan_user_limit ?? null,
    entityLimit: row.subscription_entity_limit ?? row.plan_entity_limit ?? null,
    modules: toModuleList(row.entitlement_modules),
    entitlementActive: Boolean(row.entitlement_active),
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    memberCount: row.member_count ?? 0,
    openInvoiceId: row.open_invoice_id,
    openInvoiceStatus: row.open_invoice_status,
    pendingProofId: row.pending_proof_id,
  };
}

export async function listSubscribers(
  db: Kysely<Database>,
  options: ListSubscribersOptions = {},
): Promise<SubscriberListResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const search = options.search?.trim() || undefined;

  const cte = subscriberCte();
  const where = subscriberPredicate({ ...options, search });
  const sortField: SubscriberSortField = options.sort ?? 'created_at';
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
  // Both halves come from a whitelist, never from the raw request value.
  const orderBy = sql.raw(`${SUBSCRIBER_SORT_COLUMN[sortField]} ${direction} NULLS LAST, organization_id ASC`);

  const rows = await sql<SubscriberQueryRow>`
    ${cte}
    SELECT * FROM subscriber WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `.execute(db);

  const totals = await sql<{ total: number }>`
    ${cte}
    SELECT COUNT(*)::int AS total FROM subscriber WHERE ${where}
  `.execute(db);

  // Counts respect the search but ignore the status filter — they drive the tab
  // badges, so they must describe the population the operator is filtering.
  const counts = await sql<{ organization_status: string; subscription_status: string | null; total: number }>`
    ${cte}
    SELECT organization_status, subscription_status, COUNT(*)::int AS total
    FROM subscriber
    WHERE ${subscriberPredicate({ search, planId: options.planId })}
    GROUP BY organization_status, subscription_status
  `.execute(db);

  const statusCounts: Record<string, number> = { all: 0 };
  for (const row of counts.rows) {
    statusCounts.all = (statusCounts.all ?? 0) + row.total;
    statusCounts[row.organization_status] = (statusCounts[row.organization_status] ?? 0) + row.total;
    const key = `subscription:${row.subscription_status ?? 'none'}`;
    statusCounts[key] = (statusCounts[key] ?? 0) + row.total;
  }

  return {
    subscribers: rows.rows.map(toSubscriberRow),
    pagination: { limit, offset, count: rows.rows.length, total: totals.rows[0]?.total ?? 0 },
    statusCounts,
  };
}

/* ── Detail ───────────────────────────────────────────────────────────────── */

export interface SubscriberInvoiceView {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  total: number;
  paymentReference: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  proofStatus: string | null;
  proofId: string | null;
}

export interface SubscriberDetail {
  subscriber: SubscriberRow;
  /** Operator-only. Absent from every customer-facing response. */
  internalNotes: string | null;
  entitlements: EntitlementView;
  members: Array<{
    userId: string;
    fullName: string;
    email: string;
    role: string;
    membershipStatus: string;
    accountStatus: string;
    emailVerified: boolean;
    lastLoginAt: string | null;
    joinedAt: string;
  }>;
  invoices: SubscriberInvoiceView[];
  packageHistory: PackageHistoryEntry[];
}

export async function getSubscriber(db: Kysely<Database>, organizationId: string): Promise<SubscriberDetail> {
  const result = await sql<SubscriberQueryRow>`
    ${subscriberCte()}
    SELECT * FROM subscriber WHERE organization_id = ${organizationId}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (!row) throw errors.notFound('Subscriber');

  const notes = await db
    .selectFrom('organizations')
    .select('internal_notes')
    .where('id', '=', organizationId)
    .executeTakeFirst();

  const members = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select([
      'organization_memberships.user_id',
      'organization_memberships.role',
      'organization_memberships.status as membership_status',
      'organization_memberships.created_at as joined_at',
      'users.full_name',
      'users.email',
      'users.status as account_status',
      'users.email_verified_at',
      'users.last_login_at',
    ])
    .where('organization_memberships.organization_id', '=', organizationId)
    .orderBy('organization_memberships.created_at', 'asc')
    .execute();

  const invoices = await db
    .selectFrom('subscription_invoices')
    .leftJoin('payment_proofs', 'payment_proofs.invoice_id', 'subscription_invoices.id')
    .select([
      'subscription_invoices.id',
      'subscription_invoices.invoice_number',
      'subscription_invoices.status',
      'subscription_invoices.currency',
      'subscription_invoices.total',
      'subscription_invoices.payment_reference',
      'subscription_invoices.issued_at',
      'subscription_invoices.due_at',
      'subscription_invoices.paid_at',
      'payment_proofs.id as proof_id',
      'payment_proofs.status as proof_status',
    ])
    .where('subscription_invoices.organization_id', '=', organizationId)
    .orderBy('subscription_invoices.created_at', 'desc')
    .execute();

  return {
    subscriber: toSubscriberRow(row),
    internalNotes: notes?.internal_notes ?? null,
    entitlements: await getEntitlements(db, organizationId),
    members: members.map((m) => ({
      userId: m.user_id,
      fullName: m.full_name,
      email: m.email,
      role: m.role,
      membershipStatus: m.membership_status,
      accountStatus: m.account_status,
      emailVerified: m.email_verified_at !== null,
      lastLoginAt: iso(m.last_login_at),
      joinedAt: new Date(m.joined_at).toISOString(),
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      status: i.status,
      currency: i.currency,
      total: Number(i.total),
      paymentReference: i.payment_reference,
      issuedAt: new Date(i.issued_at).toISOString(),
      dueAt: new Date(i.due_at).toISOString(),
      paidAt: iso(i.paid_at),
      proofId: i.proof_id,
      proofStatus: i.proof_status,
    })),
    packageHistory: await listPackageHistory(db, organizationId),
  };
}

/* ── Lifecycle ────────────────────────────────────────────────────────────── */

export type SubscriberAction = 'activate' | 'suspend' | 'archive' | 'restore';

/**
 * Organization status per action. `archive` maps to the dedicated `archived`
 * status — not `closed`, which meant "this customer left" — and nothing is
 * deleted: the tenant's records stay exactly where they are, which is what makes
 * `restore` a real operation rather than a re-creation.
 *
 * The richer archive path (session revocation, archive metadata, retention
 * reporting) lives in `deletionService.archiveSubscriber`; this remains the
 * simple status transition used by the generic lifecycle control.
 */
const ORGANIZATION_STATUS: Record<SubscriberAction, OrganizationStatus> = {
  activate: 'active',
  suspend: 'suspended',
  archive: 'archived',
  restore: 'active',
};

export interface SubscriberStatusResult {
  organizationId: string;
  organizationStatus: OrganizationStatus;
  subscriptionStatus: string | null;
  entitlements: EntitlementView;
}

/**
 * Activate, suspend, archive or restore a subscriber ACCOUNT.
 *
 * The organization status and the subscription move together — an "active"
 * organization whose subscription is still suspended would show the customer a
 * working account that refuses to save anything. Entitlements are recomputed in
 * the same transaction, so access matches the status the moment it commits.
 */
export async function setSubscriberStatus(
  db: Kysely<Database>,
  organizationId: string,
  action: SubscriberAction,
  reason: string,
  context: SubscriberAdminContext,
): Promise<SubscriberStatusResult> {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this subscriber account is changing state.' },
    });
  }

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Subscriber');

    const status = ORGANIZATION_STATUS[action];
    await trx
      .updateTable('organizations')
      .set({ status, updated_at: new Date() })
      .where('id', '=', organizationId)
      .execute();

    const subscription = await trx
      .selectFrom('subscriptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy(sql`(status = 'active') DESC`)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    let subscriptionStatus: string | null = subscription?.status ?? null;
    if (subscription) {
      /*
       * Suspending or archiving withdraws the entitlement. Activating or
       * restoring does NOT invent one: a tenant whose subscription was never
       * paid for comes back to `pending_payment`, not to `active`. Only a
       * subscription that HAD been active is restored to active.
       */
      if (action === 'suspend' || action === 'archive') {
        subscriptionStatus = action === 'archive' ? 'cancelled' : 'suspended';
      } else if (subscription.status === 'suspended') {
        subscriptionStatus = subscription.starts_at ? 'active' : 'pending_payment';
      }

      if (subscriptionStatus !== subscription.status) {
        await trx
          .updateTable('subscriptions')
          .set({ status: subscriptionStatus as SubscriptionStatus, updated_at: new Date() })
          .where('id', '=', subscription.id)
          .execute();
      }
    }

    // Keep the applicant roster in step, as the payment paths do.
    await trx
      .updateTable('subscription_applications')
      .set({
        status:
          action === 'suspend'
            ? 'suspended'
            : action === 'archive'
              ? 'archived'
              : subscriptionStatus === 'active'
                ? 'active_subscriber'
                : 'awaiting_payment',
        updated_at: new Date(),
      })
      .where('organization_id', '=', organizationId)
      .execute();

    const entitlements = await recalculateEntitlements(trx, organizationId);

    await writeAuditLog(trx, {
      ...context,
      organizationId,
      action: 'organization.status_changed',
      targetType: 'organization',
      targetId: organizationId,
      metadata: {
        reason: trimmed,
        adminAction: action,
        previousStatus: organization.status,
        newStatus: status,
        previousSubscriptionStatus: subscription?.status ?? null,
        newSubscriptionStatus: subscriptionStatus,
        entitlementActive: entitlements.active,
      },
    });

    return { organizationId, organizationStatus: status, subscriptionStatus, entitlements };
  });
}

/* ── Ownership ────────────────────────────────────────────────────────────── */

export interface ChangeOwnerResult {
  organizationId: string;
  previousOwnerUserId: string | null;
  newOwnerUserId: string;
  previousOwnerRole: string | null;
}

/**
 * Transfer ownership to another member of the SAME organization.
 *
 * Deliberately not "make this arbitrary user the owner": the new owner must
 * already be a member, so ownership cannot be used as a back door for adding an
 * account to a tenant. The outgoing owner keeps a membership (demoted, by
 * default to `accountant`) rather than being removed — an organization that
 * loses its only administrator in a transfer is exactly the failure the
 * last-owner rule exists to prevent.
 */
export async function changeSubscriberOwner(
  db: Kysely<Database>,
  input: {
    organizationId: string;
    newOwnerUserId: string;
    /** Role the outgoing owner keeps. `null` demotes them to `accountant`. */
    previousOwnerRole?: 'accountant' | 'member' | 'viewer';
    reason: string;
  },
  context: SubscriberAdminContext,
): Promise<ChangeOwnerResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why ownership is being transferred.' },
    });
  }

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', input.organizationId)
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Subscriber');

    const target = await trx
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.newOwnerUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!target) {
      throw errors.validation('The new owner must already be a member of this organization.', {
        fieldErrors: { newOwnerUserId: 'Add them as a member first, then transfer ownership.' },
      });
    }
    if (target.role === 'owner' && target.status === 'active') {
      throw errors.conflict('That member is already the active owner.');
    }

    // A platform operator must never end up owning a tenant — that is how a
    // tenantless administrator quietly becomes a subscriber.
    const operatorRole = await trx
      .selectFrom('platform_user_roles')
      .select('id')
      .where('user_id', '=', input.newOwnerUserId)
      .executeTakeFirst();
    if (operatorRole) {
      throw errors.validation('A Ledgora platform operator cannot own a subscriber organization.');
    }

    const currentOwner = await trx
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('role', '=', 'owner')
      .orderBy(sql`(status = 'active') DESC`)
      .orderBy('created_at', 'asc')
      .forUpdate()
      .executeTakeFirst();

    // Promote first, demote second: at no point inside the transaction is the
    // organization without an owner.
    await trx
      .updateTable('organization_memberships')
      .set({ role: 'owner', status: 'active', updated_at: new Date() })
      .where('id', '=', target.id)
      .execute();

    if (currentOwner && currentOwner.user_id !== input.newOwnerUserId) {
      await trx
        .updateTable('organization_memberships')
        .set({ role: input.previousOwnerRole ?? 'accountant', updated_at: new Date() })
        .where('id', '=', currentOwner.id)
        .execute();
    }

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'organization.owner_changed',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        previousOwnerUserId: currentOwner?.user_id ?? null,
        newOwnerUserId: input.newOwnerUserId,
        previousOwnerNewRole: currentOwner ? (input.previousOwnerRole ?? 'accountant') : null,
      },
    });

    return {
      organizationId: input.organizationId,
      previousOwnerUserId: currentOwner?.user_id ?? null,
      newOwnerUserId: input.newOwnerUserId,
      previousOwnerRole: currentOwner ? (input.previousOwnerRole ?? 'accountant') : null,
    };
  });
}

/** Operator notes on a subscriber account. Audited, but the text is not logged. */
export async function updateSubscriberNotes(
  db: Kysely<Database>,
  organizationId: string,
  notes: string,
  context: SubscriberAdminContext,
): Promise<{ organizationId: string; internalNotes: string | null }> {
  const organization = await db
    .selectFrom('organizations')
    .select('id')
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');

  const value = notes.trim() || null;
  await db
    .updateTable('organizations')
    .set({ internal_notes: value, updated_at: new Date() })
    .where('id', '=', organizationId)
    .execute();

  await writeAuditLog(db, {
    ...context,
    organizationId,
    action: 'organization.notes_updated',
    targetType: 'organization',
    targetId: organizationId,
    // The note's CONTENT is not duplicated into the audit trail; it may contain
    // commercially sensitive detail and the record itself is the canonical copy.
    metadata: { cleared: value === null, length: value?.length ?? 0 },
  });

  return { organizationId, internalNotes: value };
}
