/**
 * Package assignment — an ORGANIZATION-level operation.
 *
 * ── The domain rule this module enforces ─────────────────────────────────────
 * A package belongs to the organization, never to a user. The console lets an
 * administrator start this action from a member's profile because that is where
 * they usually are when they need it, but the operation itself takes an
 * `organizationId` and nothing else identifying a person. There is no code path
 * here that could write a user-scoped entitlement, so "give this one member the
 * Enterprise plan" is not merely discouraged — it is unrepresentable.
 *
 * ── What a change preserves ──────────────────────────────────────────────────
 * The subscription row is UPDATED (it is the tenant's current commercial state)
 * and the previous values are written to `subscription_package_changes` before
 * they are overwritten. Invoices, payment proofs and accounting data are never
 * touched. A downgrade in particular deletes nothing: it narrows the entitlement
 * and reports what now sits outside it, which is the administrator's decision to
 * make with their eyes open.
 *
 * ── Downgrade consequences ───────────────────────────────────────────────────
 * `assessPackageChange` is a pure read. The console calls it to show consequences
 * BEFORE confirmation, and `assignPackage` calls it again server-side so the
 * warning that was displayed is the one that gets recorded — a client cannot
 * suppress the assessment by not asking for it.
 */
import { sql, type Kysely } from 'kysely';
import type { BillingCycle, Database, SubscriptionStatus } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { advanceApplicationForOrganization } from './applicantService.js';
import { recalculateEntitlements, toModuleList, type EntitlementView } from './entitlementService.js';

export interface PackageAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

/**
 * "The live subscription first, then the newest." A tenant browsing an upgrade
 * has a draft alongside the subscription they paid for; the paid one is the one a
 * package change must operate on.
 */
const sqlActiveFirst = sql`(status = 'active') DESC`;

/** Statuses an administrator may set directly when assigning a package. */
export const ASSIGNABLE_SUBSCRIPTION_STATUSES = [
  'draft',
  'pending_payment',
  'pending_verification',
  'active',
  'past_due',
  'suspended',
  'cancelled',
] as const satisfies readonly SubscriptionStatus[];

export interface AssignPackageInput {
  organizationId: string;
  planId: string;
  /** Optional modules ON TOP of the plan's own. */
  modules?: string[];
  billingCycle?: BillingCycle;
  status?: (typeof ASSIGNABLE_SUBSCRIPTION_STATUSES)[number];
  effectiveDate?: Date;
  /** Per-tenant overrides; omit to inherit the plan's limits. */
  seatOverride?: number | null;
  entityOverride?: number | null;
  storageOverride?: number | null;
  /** Required. Recorded in both the history row and the audit trail. */
  reason: string;
  /**
   * The consequences the administrator was shown. When present it is recorded
   * with the change, so the audit trail says what they were told, not just what
   * they did.
   */
  acknowledgedConsequences?: string[];
}

export interface PackageConsequence {
  code: 'seats_over_limit' | 'modules_removed' | 'entities_over_limit' | 'storage_reduced' | 'status_loses_access';
  severity: 'warning' | 'blocking';
  message: string;
  detail?: Record<string, unknown>;
}

export interface PackageAssessment {
  organizationId: string;
  direction: 'upgrade' | 'downgrade' | 'lateral' | 'initial';
  isDowngrade: boolean;
  current: {
    planId: string | null;
    planCode: string | null;
    planName: string | null;
    status: string;
    modules: string[];
    userLimit: number | null;
    entityLimit: number | null;
    seatsUsed: number;
  };
  proposed: {
    planId: string;
    planCode: string;
    planName: string;
    status: string;
    modules: string[];
    userLimit: number | null;
    entityLimit: number | null;
  };
  consequences: PackageConsequence[];
  /** Members that would sit above the new seat allowance, oldest kept first. */
  membersOverLimit: Array<{ userId: string; fullName: string; email: string; role: string; joinedAt: string }>;
  /** Modules in force today that the new package would withdraw. */
  modulesRemoved: string[];
}

/* ── Shared loading ───────────────────────────────────────────────────────── */

async function requirePlan(db: Kysely<Database>, planId: string) {
  const plan = await db.selectFrom('subscription_plans').selectAll().where('id', '=', planId).executeTakeFirst();
  if (!plan) throw errors.notFound('Package');
  // An archived plan may still be ASSIGNED by an operator — that is how a
  // grandfathered or bespoke package is honoured. Only self-service is blocked.
  return plan;
}

async function requireOrganizationRow(db: Kysely<Database>, organizationId: string) {
  const row = await db
    .selectFrom('organizations')
    .select(['id', 'legal_name', 'status'])
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Organization');
  return row;
}

/** Current subscription for the tenant, active preferred. */
async function currentSubscription(db: Kysely<Database>, organizationId: string) {
  const active = await db
    .selectFrom('subscriptions')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (active) return active;
  return db
    .selectFrom('subscriptions')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

async function activeMembers(db: Kysely<Database>, organizationId: string) {
  return db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select([
      'organization_memberships.user_id',
      'organization_memberships.role',
      'organization_memberships.created_at as joined_at',
      'users.full_name',
      'users.email',
    ])
    .where('organization_memberships.organization_id', '=', organizationId)
    .where('organization_memberships.status', '!=', 'suspended')
    .orderBy('organization_memberships.created_at', 'asc')
    .execute();
}

/**
 * Direction of travel, judged on what the tenant can DO rather than on price.
 *
 * Fewer seats or fewer modules is a downgrade even if the new package costs more,
 * because it is the loss of capability that has consequences for their data.
 */
function classifyDirection(
  before: { planId: string | null; modules: string[]; userLimit: number | null },
  after: { modules: string[]; userLimit: number | null },
): PackageAssessment['direction'] {
  if (!before.planId) return 'initial';

  const lostModules = before.modules.filter((m) => !after.modules.includes(m));
  const gainedModules = after.modules.filter((m) => !before.modules.includes(m));
  const seatsBefore = before.userLimit ?? Number.POSITIVE_INFINITY;
  const seatsAfter = after.userLimit ?? Number.POSITIVE_INFINITY;

  if (lostModules.length > 0 || seatsAfter < seatsBefore) return 'downgrade';
  if (gainedModules.length > 0 || seatsAfter > seatsBefore) return 'upgrade';
  return 'lateral';
}

/**
 * What would happen. A pure read — nothing is written, so the console can call it
 * freely as the administrator adjusts the form.
 */
export async function assessPackageChange(
  db: Kysely<Database>,
  input: Pick<AssignPackageInput, 'organizationId' | 'planId' | 'modules' | 'status' | 'seatOverride' | 'entityOverride' | 'storageOverride'>,
): Promise<PackageAssessment> {
  await requireOrganizationRow(db, input.organizationId);
  const plan = await requirePlan(db, input.planId);
  const subscription = await currentSubscription(db, input.organizationId);
  const currentPlan = subscription?.plan_id
    ? await db.selectFrom('subscription_plans').selectAll().where('id', '=', subscription.plan_id).executeTakeFirst()
    : undefined;

  const members = await activeMembers(db, input.organizationId);
  const seatsUsed = members.length;

  const currentModules = [
    ...new Set([...toModuleList(currentPlan?.module_entitlements), ...toModuleList(subscription?.extra_modules)]),
  ].sort();
  const proposedModules = [
    ...new Set([...toModuleList(plan.module_entitlements), ...(input.modules ?? [])]),
  ].sort();

  const currentUserLimit = subscription?.user_limit ?? currentPlan?.user_limit ?? null;
  const currentEntityLimit = subscription?.entity_limit ?? currentPlan?.entity_limit ?? null;
  const proposedUserLimit = input.seatOverride ?? plan.user_limit;
  const proposedEntityLimit = input.entityOverride ?? plan.entity_limit;
  const proposedStatus = input.status ?? subscription?.status ?? 'draft';

  const direction = classifyDirection(
    { planId: subscription?.plan_id ?? null, modules: currentModules, userLimit: currentUserLimit },
    { modules: proposedModules, userLimit: proposedUserLimit },
  );

  const consequences: PackageConsequence[] = [];
  const modulesRemoved = currentModules.filter((m) => !proposedModules.includes(m));

  // Members above the new allowance. The OLDEST memberships are kept — the
  // owner joined first — so the list names the ones that would be over.
  const membersOverLimit =
    proposedUserLimit !== null && seatsUsed > proposedUserLimit
      ? members.slice(proposedUserLimit).map((m) => ({
          userId: m.user_id,
          fullName: m.full_name,
          email: m.email,
          role: m.role,
          joinedAt: new Date(m.joined_at).toISOString(),
        }))
      : [];

  if (membersOverLimit.length > 0) {
    consequences.push({
      code: 'seats_over_limit',
      severity: 'warning',
      message: `${seatsUsed} members occupy seats but the new package allows ${proposedUserLimit}. ${membersOverLimit.length} member(s) will be over the limit. Nobody is removed automatically — suspend or remove them, or raise the seat override.`,
      detail: { seatsUsed, newLimit: proposedUserLimit, overBy: membersOverLimit.length },
    });
  }

  if (modulesRemoved.length > 0) {
    consequences.push({
      code: 'modules_removed',
      severity: 'warning',
      message: `These modules will no longer be available: ${modulesRemoved.join(', ')}. Existing records stay in the database and become read-only to the customer — nothing is deleted.`,
      detail: { modules: modulesRemoved },
    });
  }

  if (
    currentEntityLimit !== null &&
    proposedEntityLimit !== null &&
    proposedEntityLimit < currentEntityLimit
  ) {
    consequences.push({
      code: 'entities_over_limit',
      severity: 'warning',
      message: `The entity allowance falls from ${currentEntityLimit} to ${proposedEntityLimit}. Existing entities are retained; the customer cannot create new ones beyond the new limit.`,
      detail: { from: currentEntityLimit, to: proposedEntityLimit },
    });
  }

  const currentStorage = subscription?.storage_limit ?? currentPlan?.storage_limit ?? null;
  const proposedStorage = input.storageOverride ?? plan.storage_limit ?? null;
  if (currentStorage !== null && proposedStorage !== null && Number(proposedStorage) < Number(currentStorage)) {
    consequences.push({
      code: 'storage_reduced',
      severity: 'warning',
      message: `The storage allowance falls from ${Number(currentStorage)} to ${Number(proposedStorage)} bytes. Stored files are kept; new uploads are refused once the new limit is reached.`,
      detail: { from: Number(currentStorage), to: Number(proposedStorage) },
    });
  }

  if (subscription?.status === 'active' && proposedStatus !== 'active' && proposedStatus !== 'past_due') {
    consequences.push({
      code: 'status_loses_access',
      severity: 'warning',
      message: `The subscription moves from active to ${proposedStatus}, so the customer loses access to paid functionality and can no longer save records permanently.`,
      detail: { from: 'active', to: proposedStatus },
    });
  }

  return {
    organizationId: input.organizationId,
    direction,
    isDowngrade: direction === 'downgrade',
    current: {
      planId: subscription?.plan_id ?? null,
      planCode: currentPlan?.code ?? null,
      planName: currentPlan?.name ?? null,
      status: subscription?.status ?? 'none',
      modules: currentModules,
      userLimit: currentUserLimit,
      entityLimit: currentEntityLimit,
      seatsUsed,
    },
    proposed: {
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      status: proposedStatus,
      modules: proposedModules,
      userLimit: proposedUserLimit,
      entityLimit: proposedEntityLimit,
    },
    consequences,
    membersOverLimit,
    modulesRemoved,
  };
}

export interface AssignPackageResult {
  organizationId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  direction: PackageAssessment['direction'];
  previousPlanCode: string | null;
  newPlanCode: string;
  entitlements: EntitlementView;
  historyId: string;
  consequences: PackageConsequence[];
}

function addMonths(from: Date, months: number): Date {
  const date = new Date(from);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

/**
 * Assign or change the organization's package.
 *
 * One transaction: history row, subscription update, applicant-stage sync,
 * entitlement recalculation and audit entry. A failure anywhere leaves the tenant
 * on the package they had — a half-applied package change is the one outcome that
 * could grant access nobody authorised.
 */
export async function assignPackage(
  db: Kysely<Database>,
  input: AssignPackageInput,
  context: PackageAdminContext,
): Promise<AssignPackageResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why the package is being changed.' },
    });
  }

  // Assessed BEFORE the transaction and recorded inside it, so the consequences
  // stored with the change are computed from the state the change applied to.
  const assessment = await assessPackageChange(db, input);
  const plan = await requirePlan(db, input.planId);

  const result = await db.transaction().execute(async (trx) => {
    const settings = await trx.selectFrom('billing_settings').selectAll().executeTakeFirst();
    const termMonths = settings?.term_months ?? 1;
    const graceDays = settings?.grace_days ?? 7;

    const existing = await trx
      .selectFrom('subscriptions')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .orderBy(sqlActiveFirst)
      .orderBy('created_at', 'desc')
      .forUpdate()
      .executeTakeFirst();

    const previousPlan = existing?.plan_id
      ? await trx.selectFrom('subscription_plans').selectAll().where('id', '=', existing.plan_id).executeTakeFirst()
      : undefined;

    const status: SubscriptionStatus = input.status ?? existing?.status ?? 'active';
    const billingCycle: BillingCycle = input.billingCycle ?? existing?.billing_cycle ?? 'monthly';
    const effective = input.effectiveDate ?? new Date();
    const extras = [...new Set(input.modules ?? [])].sort();

    // Term dates only mean something once the subscription actually entitles.
    const entitling = status === 'active' || status === 'past_due';
    const expiresAt = entitling ? addMonths(effective, billingCycle === 'annual' ? termMonths * 12 : termMonths) : null;

    const patch = {
      plan_id: plan.id,
      status,
      billing_cycle: billingCycle,
      user_limit: input.seatOverride ?? plan.user_limit,
      entity_limit: input.entityOverride ?? plan.entity_limit,
      storage_limit: input.storageOverride ?? plan.storage_limit ?? null,
      extra_modules: JSON.stringify(extras),
      starts_at: entitling ? effective : (existing?.starts_at ?? null),
      expires_at: expiresAt,
      grace_ends_at: expiresAt ? new Date(expiresAt.getTime() + graceDays * 86_400_000) : null,
      updated_at: new Date(),
    };

    let subscriptionId: string;
    if (existing) {
      await trx.updateTable('subscriptions').set(patch).where('id', '=', existing.id).execute();
      subscriptionId = existing.id;
    } else {
      const created = await trx
        .insertInto('subscriptions')
        .values({ organization_id: input.organizationId, ...patch })
        .returning('id')
        .executeTakeFirstOrThrow();
      subscriptionId = created.id;
    }

    // History BEFORE the entitlement is recomputed, so the row records the
    // transition rather than its outcome.
    const history = await trx
      .insertInto('subscription_package_changes')
      .values({
        organization_id: input.organizationId,
        subscription_id: subscriptionId,
        previous_plan_id: existing?.plan_id ?? null,
        new_plan_id: plan.id,
        previous_plan_code: previousPlan?.code ?? null,
        new_plan_code: plan.code,
        previous_status: existing?.status ?? null,
        new_status: status,
        previous_modules: JSON.stringify(assessment.current.modules),
        new_modules: JSON.stringify(assessment.proposed.modules),
        previous_user_limit: assessment.current.userLimit,
        new_user_limit: assessment.proposed.userLimit,
        direction: assessment.direction,
        effective_at: effective,
        reason,
        changed_by_user_id: context.actorUserId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Keep the applicant roster honest about a manual change.
    await advanceApplicationForOrganization(trx, input.organizationId, {
      status: entitling ? 'active_subscriber' : 'package_selected',
      selectedPlanId: plan.id,
      subscriptionId,
      ...(entitling ? { activatedAt: effective } : {}),
    });

    // Same transaction: the entitlement cache cannot lag the commit.
    const entitlements = await recalculateEntitlements(trx, input.organizationId);

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscription.package_assigned',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        manual: true,
        direction: assessment.direction,
        previousPlanCode: previousPlan?.code ?? null,
        newPlanCode: plan.code,
        previousStatus: existing?.status ?? null,
        newStatus: status,
        billingCycle,
        effectiveAt: effective.toISOString(),
        seatOverride: input.seatOverride ?? null,
        optionalModules: extras,
        // What the operator was warned about, recorded with what they did.
        consequences: assessment.consequences.map((c) => c.code),
        acknowledgedConsequences: input.acknowledgedConsequences ?? [],
        // Explicit: this is a tenant-wide change, not a per-member one.
        scope: 'organization',
      },
    });

    return {
      organizationId: input.organizationId,
      subscriptionId,
      status,
      direction: assessment.direction,
      previousPlanCode: previousPlan?.code ?? null,
      newPlanCode: plan.code,
      entitlements,
      historyId: history.id,
      consequences: assessment.consequences,
    };
  });

  return result;
}

export interface PackageHistoryEntry {
  id: string;
  previousPlanCode: string | null;
  newPlanCode: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  previousModules: string[];
  newModules: string[];
  previousUserLimit: number | null;
  newUserLimit: number | null;
  direction: string;
  effectiveAt: string;
  reason: string;
  changedByUserId: string | null;
  changedByName: string | null;
  createdAt: string;
}

/** The tenant's package history, newest first. Never pruned. */
export async function listPackageHistory(
  db: Kysely<Database>,
  organizationId: string,
  limit = 25,
): Promise<PackageHistoryEntry[]> {
  const rows = await db
    .selectFrom('subscription_package_changes')
    .leftJoin('users', 'users.id', 'subscription_package_changes.changed_by_user_id')
    .select([
      'subscription_package_changes.id',
      'subscription_package_changes.previous_plan_code',
      'subscription_package_changes.new_plan_code',
      'subscription_package_changes.previous_status',
      'subscription_package_changes.new_status',
      'subscription_package_changes.previous_modules',
      'subscription_package_changes.new_modules',
      'subscription_package_changes.previous_user_limit',
      'subscription_package_changes.new_user_limit',
      'subscription_package_changes.direction',
      'subscription_package_changes.effective_at',
      'subscription_package_changes.reason',
      'subscription_package_changes.changed_by_user_id',
      'subscription_package_changes.created_at',
      'users.full_name as changed_by_name',
    ])
    .where('subscription_package_changes.organization_id', '=', organizationId)
    .orderBy('subscription_package_changes.created_at', 'desc')
    .limit(Math.min(Math.max(limit, 1), 100))
    .execute();

  return rows.map((row) => ({
    id: row.id,
    previousPlanCode: row.previous_plan_code,
    newPlanCode: row.new_plan_code,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    previousModules: toModuleList(row.previous_modules),
    newModules: toModuleList(row.new_modules),
    previousUserLimit: row.previous_user_limit,
    newUserLimit: row.new_user_limit,
    direction: row.direction,
    effectiveAt: new Date(row.effective_at).toISOString(),
    reason: row.reason,
    changedByUserId: row.changed_by_user_id,
    changedByName: row.changed_by_name,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
