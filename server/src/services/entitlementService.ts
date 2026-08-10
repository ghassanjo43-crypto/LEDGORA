/**
 * Organization entitlements — resolved, cached, and always recomputable.
 *
 * ── Why a table at all ───────────────────────────────────────────────────────
 * An entitlement is a JOIN: subscription → plan → modules/limits, with per-tenant
 * overrides on top. Computing it on every read is both slow and easy to get
 * subtly wrong in one of the several places that need it. `organization_entitlements`
 * holds the resolved answer, one row per tenant.
 *
 * It is a CACHE, not a source of truth. Every field can be rebuilt from the
 * subscription by `recalculateEntitlements`, which is what every write path calls
 * after changing anything that could affect the answer. So a stale or missing row
 * is a performance problem, never a correctness one — and "invalidate the
 * entitlement cache" is implemented as "recompute it now", which cannot leave a
 * tenant holding an entitlement they no longer have.
 *
 * ── Why the plan is never the whole answer ───────────────────────────────────
 * The entitlement belongs to the ORGANIZATION and is derived from its
 * subscription — never from a user. A member inherits their organization's
 * entitlement by belonging to it; nothing here writes anything user-scoped, which
 * is what stops "assign a package to this person" from becoming representable.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, SubscriptionStatus } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';

export type Executor = Kysely<Database> | Transaction<Database>;

/** Subscription statuses that actually grant access to paid functionality. */
const ENTITLING_STATUSES: ReadonlySet<string> = new Set<SubscriptionStatus>(['active', 'past_due']);

export interface EntitlementView {
  organizationId: string;
  subscriptionId: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  edition: string | null;
  modules: string[];
  userLimit: number | null;
  entityLimit: number | null;
  storageLimit: number | null;
  status: string;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  computedAt: string;
}

/** jsonb arrives as a parsed array from `pg` and as text from some drivers. */
export function toModuleList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Deduplicated, stably ordered union — so a module list is comparable. */
function mergeModules(base: string[], extra: string[]): string[] {
  return [...new Set([...base, ...extra])].sort();
}

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);
const numberOrNull = (value: string | number | null): number | null =>
  value === null || value === undefined ? null : Number(value);

/**
 * The subscription an organization's entitlement is derived from.
 *
 * An ACTIVE subscription always wins, regardless of age — a tenant with a live
 * subscription and a newer draft (they were browsing an upgrade) must keep the
 * access they paid for. Otherwise the most recent record is used, so a pending
 * one still reports its status honestly.
 */
async function entitlingSubscription(db: Executor, organizationId: string) {
  return db
    .selectFrom('subscriptions')
    .selectAll()
    .where('organization_id', '=', organizationId)
    // Same precedence the applicant roster uses, so the two never disagree.
    .orderBy(sql`(status = 'active') DESC`)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

/**
 * Recompute and store the organization's entitlement.
 *
 * Idempotent, and safe to call from inside the transaction that made the change —
 * which is how it is always called, so a committed subscription change can never
 * be visible while the entitlement it implies is not.
 */
export async function recalculateEntitlements(
  db: Executor,
  organizationId: string,
): Promise<EntitlementView> {
  const subscription = await entitlingSubscription(db, organizationId);

  const plan = subscription?.plan_id
    ? await db.selectFrom('subscription_plans').selectAll().where('id', '=', subscription.plan_id).executeTakeFirst()
    : undefined;

  const extras = toModuleList(subscription?.extra_modules);
  const modules = mergeModules(toModuleList(plan?.module_entitlements), extras);
  const status = subscription?.status ?? 'none';
  const active = ENTITLING_STATUSES.has(status);

  // Per-tenant overrides beat the plan; the plan is the fallback, not the cap.
  const userLimit = subscription?.user_limit ?? plan?.user_limit ?? null;
  const entityLimit = subscription?.entity_limit ?? plan?.entity_limit ?? null;
  const storageLimit =
    numberOrNull(subscription?.storage_limit ?? null) ?? numberOrNull(plan?.storage_limit ?? null);

  const now = new Date();
  const values = {
    organization_id: organizationId,
    subscription_id: subscription?.id ?? null,
    plan_id: plan?.id ?? null,
    plan_code: plan?.code ?? null,
    edition: plan?.edition ?? null,
    modules: JSON.stringify(modules),
    user_limit: userLimit,
    entity_limit: entityLimit,
    storage_limit: storageLimit,
    status,
    active,
    starts_at: subscription?.starts_at ?? null,
    expires_at: subscription?.expires_at ?? null,
    computed_at: now,
    updated_at: now,
  };

  await db
    .insertInto('organization_entitlements')
    .values(values)
    // The UNIQUE index on organization_id makes this the whole concurrency story:
    // two operators recomputing at once converge rather than duplicating.
    .onConflict((oc) => oc.column('organization_id').doUpdateSet(values))
    .execute();

  return {
    organizationId,
    subscriptionId: subscription?.id ?? null,
    planId: plan?.id ?? null,
    planCode: plan?.code ?? null,
    planName: plan?.name ?? null,
    edition: plan?.edition ?? null,
    modules,
    userLimit,
    entityLimit,
    storageLimit,
    status,
    active,
    startsAt: iso(subscription?.starts_at ?? null),
    expiresAt: iso(subscription?.expires_at ?? null),
    computedAt: now.toISOString(),
  };
}

/**
 * Read the stored entitlement, recomputing it when there is none.
 *
 * Self-healing on purpose: a tenant created before this table existed, or one
 * whose row was lost, gets a correct answer rather than an empty entitlement that
 * would silently deny them access they have paid for.
 */
export async function getEntitlements(db: Executor, organizationId: string): Promise<EntitlementView> {
  const row = await db
    .selectFrom('organization_entitlements')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();

  if (!row) return recalculateEntitlements(db, organizationId);

  const plan = row.plan_id
    ? await db.selectFrom('subscription_plans').select(['name']).where('id', '=', row.plan_id).executeTakeFirst()
    : undefined;

  return {
    organizationId: row.organization_id,
    subscriptionId: row.subscription_id,
    planId: row.plan_id,
    planCode: row.plan_code,
    planName: plan?.name ?? null,
    edition: row.edition,
    modules: toModuleList(row.modules),
    userLimit: row.user_limit,
    entityLimit: row.entity_limit,
    storageLimit: numberOrNull(row.storage_limit),
    status: row.status,
    active: row.active,
    startsAt: iso(row.starts_at),
    expiresAt: iso(row.expires_at),
    computedAt: new Date(row.computed_at).toISOString(),
  };
}

/**
 * Recompute and record it in the audit trail.
 *
 * Used where the recalculation IS the administrator's action (a manual cache
 * refresh); the write paths audit their own change and call
 * `recalculateEntitlements` directly rather than logging twice.
 */
export async function refreshEntitlementsAudited(
  db: Executor,
  organizationId: string,
  context: AuditContext,
): Promise<EntitlementView> {
  const entitlement = await recalculateEntitlements(db, organizationId);
  await writeAuditLog(db as Kysely<Database>, {
    ...context,
    organizationId,
    action: 'entitlement.recalculated',
    targetType: 'organization',
    targetId: organizationId,
    metadata: {
      planCode: entitlement.planCode,
      status: entitlement.status,
      active: entitlement.active,
      moduleCount: entitlement.modules.length,
    },
  });
  return entitlement;
}
