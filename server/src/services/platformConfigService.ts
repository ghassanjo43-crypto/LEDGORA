/**
 * Platform configuration: bank details, billing settings, the package catalogue
 * and the manual subscription lifecycle.
 *
 * All of it is administrator-only and fully audited. Bank details in particular
 * decide where customers send money, so every change records who made it.
 */
import type { Kysely } from 'kysely';
import type { Database, SubscriptionStatus } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

export interface AdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

/* ── Bank details ─────────────────────────────────────────────────────────── */

export interface BankDetailsView {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string | null;
  swift: string | null;
  branch: string | null;
  instructions: string | null;
  isPlaceholder: boolean;
  updatedAt: string;
}

export async function getBankDetails(db: Kysely<Database>): Promise<BankDetailsView | null> {
  const row = await db.selectFrom('bank_details').selectAll().executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    bankName: row.bank_name,
    accountName: row.account_name,
    accountNumber: row.account_number,
    iban: row.iban,
    swift: row.swift,
    branch: row.branch,
    instructions: row.instructions,
    isPlaceholder: row.is_placeholder,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface BankDetailsPatch {
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  iban?: string;
  swift?: string;
  branch?: string;
  instructions?: string;
}

/** Identifying fields — changing any of them retires the placeholder flag. */
const IDENTIFYING: Array<keyof BankDetailsPatch> = ['bankName', 'accountName', 'accountNumber', 'iban', 'swift'];

export async function updateBankDetails(
  db: Kysely<Database>,
  patch: BankDetailsPatch,
  context: AdminContext,
): Promise<BankDetailsView> {
  const existing = await db.selectFrom('bank_details').selectAll().executeTakeFirst();
  if (!existing) throw errors.notFound('Bank details');

  const changedIdentifying = IDENTIFYING.some(
    (key) => patch[key] !== undefined && patch[key] !== null && String(patch[key]).trim() !== '',
  );

  await db
    .updateTable('bank_details')
    .set({
      bank_name: patch.bankName?.trim() ?? existing.bank_name,
      account_name: patch.accountName?.trim() ?? existing.account_name,
      account_number: patch.accountNumber?.trim() ?? existing.account_number,
      iban: patch.iban?.trim() ?? existing.iban,
      swift: patch.swift?.trim() ?? existing.swift,
      branch: patch.branch?.trim() ?? existing.branch,
      instructions: patch.instructions?.trim() ?? existing.instructions,
      // Real account information has been supplied — stop warning customers.
      is_placeholder: changedIdentifying ? false : existing.is_placeholder,
      updated_at: new Date(),
      updated_by: context.actorUserId,
    })
    .where('id', '=', existing.id)
    .execute();

  await writeAuditLog(db, {
    ...context,
    action: 'bank_details.updated',
    targetType: 'bank_details',
    targetId: existing.id,
    // Field NAMES only — never the account numbers themselves.
    metadata: { changedFields: Object.keys(patch), placeholderCleared: changedIdentifying },
  });

  return (await getBankDetails(db))!;
}

/* ── Billing settings ─────────────────────────────────────────────────────── */

export interface BillingSettingsView {
  id: string;
  currency: string;
  paymentDueDays: number;
  graceDays: number;
  termMonths: number;
  updatedAt: string;
}

export async function getBillingSettings(db: Kysely<Database>): Promise<BillingSettingsView | null> {
  const row = await db.selectFrom('billing_settings').selectAll().executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    currency: row.currency,
    paymentDueDays: row.payment_due_days,
    graceDays: row.grace_days,
    termMonths: row.term_months,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function updateBillingSettings(
  db: Kysely<Database>,
  patch: { currency?: string; paymentDueDays?: number; graceDays?: number; termMonths?: number },
  context: AdminContext,
): Promise<BillingSettingsView> {
  const existing = await db.selectFrom('billing_settings').selectAll().executeTakeFirst();
  if (!existing) throw errors.notFound('Billing settings');

  await db
    .updateTable('billing_settings')
    .set({
      currency: patch.currency ?? existing.currency,
      payment_due_days: patch.paymentDueDays ?? existing.payment_due_days,
      grace_days: patch.graceDays ?? existing.grace_days,
      term_months: patch.termMonths ?? existing.term_months,
      updated_at: new Date(),
      updated_by: context.actorUserId,
    })
    .where('id', '=', existing.id)
    .execute();

  await writeAuditLog(db, {
    ...context,
    action: 'billing_settings.updated',
    targetType: 'billing_settings',
    targetId: existing.id,
    metadata: { ...patch },
  });

  return (await getBillingSettings(db))!;
}

/* ── Package catalogue ────────────────────────────────────────────────────── */

export interface PlanInput {
  code: string;
  name: string;
  description?: string;
  edition: string;
  currency?: string;
  monthlyPrice: number;
  annualPrice?: number;
  userLimit: number;
  entityLimit: number;
  modules?: string[];
  isPublic?: boolean;
  sortOrder?: number;
}

export async function listAllPlans(db: Kysely<Database>): Promise<Array<Record<string, unknown>>> {
  const rows = await db.selectFrom('subscription_plans').selectAll().orderBy('sort_order', 'asc').execute();
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    edition: row.edition,
    currency: row.currency,
    monthlyPrice: Number(row.monthly_price),
    annualPrice: row.annual_price === null ? null : Number(row.annual_price),
    userLimit: row.user_limit,
    entityLimit: row.entity_limit,
    modules: typeof row.module_entitlements === 'string' ? JSON.parse(row.module_entitlements) : row.module_entitlements,
    isPublic: row.is_public,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }));
}

export async function createPlan(db: Kysely<Database>, input: PlanInput, context: AdminContext): Promise<{ id: string }> {
  const duplicate = await db.selectFrom('subscription_plans').select('id').where('code', '=', input.code).executeTakeFirst();
  if (duplicate) throw errors.conflict(`A package with code "${input.code}" already exists.`);
  if (input.monthlyPrice < 0) throw errors.validation('Price cannot be negative.');

  const plan = await db
    .insertInto('subscription_plans')
    .values({
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      edition: input.edition,
      currency: input.currency ?? 'USD',
      monthly_price: String(input.monthlyPrice),
      annual_price: input.annualPrice === undefined ? null : String(input.annualPrice),
      user_limit: input.userLimit,
      entity_limit: input.entityLimit,
      module_entitlements: JSON.stringify(input.modules ?? []),
      is_public: input.isPublic ?? true,
      is_active: true,
      sort_order: input.sortOrder ?? 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await writeAuditLog(db, {
    ...context,
    action: 'plan.created',
    targetType: 'plan',
    targetId: plan.id,
    metadata: { code: input.code, monthlyPrice: input.monthlyPrice },
  });
  return { id: plan.id };
}

export async function updatePlan(
  db: Kysely<Database>,
  planId: string,
  patch: Partial<PlanInput>,
  context: AdminContext,
): Promise<void> {
  const existing = await db.selectFrom('subscription_plans').selectAll().where('id', '=', planId).executeTakeFirst();
  if (!existing) throw errors.notFound('Package');
  if (patch.monthlyPrice !== undefined && patch.monthlyPrice < 0) throw errors.validation('Price cannot be negative.');

  await db
    .updateTable('subscription_plans')
    .set({
      name: patch.name?.trim() ?? existing.name,
      description: patch.description?.trim() ?? existing.description,
      currency: patch.currency ?? existing.currency,
      monthly_price: patch.monthlyPrice === undefined ? existing.monthly_price : String(patch.monthlyPrice),
      annual_price: patch.annualPrice === undefined ? existing.annual_price : String(patch.annualPrice),
      user_limit: patch.userLimit ?? existing.user_limit,
      entity_limit: patch.entityLimit ?? existing.entity_limit,
      module_entitlements: patch.modules ? JSON.stringify(patch.modules) : existing.module_entitlements,
      is_public: patch.isPublic ?? existing.is_public,
      sort_order: patch.sortOrder ?? existing.sort_order,
      updated_at: new Date(),
    })
    .where('id', '=', planId)
    .execute();

  await writeAuditLog(db, {
    ...context,
    action: 'plan.updated',
    targetType: 'plan',
    targetId: planId,
    metadata: { changedFields: Object.keys(patch) },
  });
}

export async function setPlanArchived(
  db: Kysely<Database>,
  planId: string,
  archived: boolean,
  context: AdminContext,
): Promise<void> {
  const existing = await db.selectFrom('subscription_plans').select('id').where('id', '=', planId).executeTakeFirst();
  if (!existing) throw errors.notFound('Package');

  await db
    .updateTable('subscription_plans')
    // Archiving withdraws the package from sale. Existing subscriptions keep
    // their plan_id and are untouched.
    .set({ is_active: !archived, is_public: !archived, updated_at: new Date() })
    .where('id', '=', planId)
    .execute();

  await writeAuditLog(db, {
    ...context,
    action: archived ? 'plan.archived' : 'plan.restored',
    targetType: 'plan',
    targetId: planId,
  });
}

/* ── Subscription lifecycle (manual administrator actions) ────────────────── */

export async function listSubscriptions(
  db: Kysely<Database>,
  options: { status?: string; limit?: number; offset?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  let query = db
    .selectFrom('subscriptions')
    .innerJoin('organizations', 'organizations.id', 'subscriptions.organization_id')
    .leftJoin('subscription_plans', 'subscription_plans.id', 'subscriptions.plan_id')
    .select([
      'subscriptions.id',
      'subscriptions.status',
      'subscriptions.billing_cycle',
      'subscriptions.starts_at',
      'subscriptions.expires_at',
      'subscriptions.payment_reference',
      'organizations.id as organization_id',
      'organizations.legal_name',
      'subscription_plans.code as plan_code',
      'subscription_plans.name as plan_name',
    ])
    .orderBy('subscriptions.created_at', 'desc')
    .limit(Math.min(Math.max(options.limit ?? 25, 1), 100))
    .offset(Math.max(options.offset ?? 0, 0));

  if (options.status) query = query.where('subscriptions.status', '=', options.status as never);

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    billingCycle: row.billing_cycle,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    paymentReference: row.payment_reference,
    organizationId: row.organization_id,
    organizationName: row.legal_name,
    planCode: row.plan_code,
    planName: row.plan_name,
  }));
}

export type LifecycleAction = 'activate' | 'suspend' | 'cancel' | 'renew';

const ACTION_STATUS: Record<LifecycleAction, SubscriptionStatus> = {
  activate: 'active',
  suspend: 'suspended',
  cancel: 'cancelled',
  renew: 'active',
};

const ACTION_AUDIT = {
  activate: 'subscription.activated',
  suspend: 'subscription.suspended',
  cancel: 'subscription.cancelled',
  renew: 'subscription.renewed',
} as const;

/**
 * Manual lifecycle change. Every one requires a written reason, which is
 * recorded in the audit trail — manual activation bypasses payment verification
 * and must be accountable.
 */
export async function changeSubscriptionLifecycle(
  db: Kysely<Database>,
  subscriptionId: string,
  action: LifecycleAction,
  reason: string,
  context: AdminContext,
): Promise<{ id: string; status: SubscriptionStatus }> {
  if (!reason.trim()) throw errors.validation('A reason is required and is recorded in the audit trail.');

  return db.transaction().execute(async (trx) => {
    const subscription = await trx
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .forUpdate()
      .executeTakeFirst();
    if (!subscription) throw errors.notFound('Subscription');

    const settings = await trx.selectFrom('billing_settings').selectAll().executeTakeFirst();
    const termMonths = settings?.term_months ?? 1;
    const status = ACTION_STATUS[action];

    const now = new Date();
    const patch: Record<string, unknown> = { status, updated_at: now };

    if (action === 'activate' || action === 'renew') {
      const base = action === 'renew' && subscription.expires_at ? new Date(subscription.expires_at) : now;
      const expires = new Date(base);
      expires.setUTCMonth(expires.getUTCMonth() + (subscription.billing_cycle === 'annual' ? termMonths * 12 : termMonths));
      patch.starts_at = subscription.starts_at ?? now;
      patch.expires_at = expires;
      patch.grace_ends_at = new Date(expires.getTime() + (settings?.grace_days ?? 7) * 86_400_000);
    }

    await trx.updateTable('subscriptions').set(patch as never).where('id', '=', subscriptionId).execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: subscription.organization_id,
      action: ACTION_AUDIT[action],
      targetType: 'subscription',
      targetId: subscriptionId,
      metadata: { reason: reason.trim(), manual: true, previousStatus: subscription.status },
    });

    return { id: subscriptionId, status };
  });
}
