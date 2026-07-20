/**
 * Subscription selection, confirmation and invoicing.
 *
 * The payment reference is generated HERE — on the server, from
 * `crypto.randomBytes`, inside the same transaction that creates the invoice,
 * with the database's UNIQUE constraint as the real guarantee. The browser
 * never mints one.
 *
 * Nothing in this module activates a subscription. Activation is exclusively an
 * administrator action after payment verification (Phase 3).
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, SubscriptionStatus } from '../db/schema.js';
import { generatePaymentReference } from '../lib/tokens.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

/** How many times to retry when a generated identifier collides. */
const UNIQUE_RETRY_LIMIT = 5;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const message = String((error as { message?: string })?.message ?? '');
  // 23505 = unique_violation (node-postgres); PGlite surfaces the text.
  return code === '23505' || /duplicate key value violates unique constraint/i.test(message);
}

export interface PublicPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  edition: string;
  currency: string;
  monthlyPrice: number;
  annualPrice: number | null;
  userLimit: number;
  entityLimit: number;
  modules: string[];
}

/** Only public, active plans are ever exposed to customers. */
export async function listPublicPlans(db: Kysely<Database>): Promise<PublicPlan[]> {
  const rows = await db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('is_public', '=', true)
    .where('is_active', '=', true)
    .orderBy('sort_order', 'asc')
    .execute();

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
  }));
}

/**
 * Select a package. Creates (or re-points) a DRAFT subscription — no invoice, no
 * payment reference and no entitlement yet.
 */
export async function selectPlan(
  db: Kysely<Database>,
  input: { organizationId: string; planId: string; billingCycle?: 'monthly' | 'annual'; userId: string },
  context: AuditContext = {},
): Promise<{ subscriptionId: string; status: SubscriptionStatus }> {
  const plan = await db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('id', '=', input.planId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!plan) throw errors.notFound('Package');
  if (!plan.is_public) throw errors.forbidden('That package is not available for self-service purchase.');

  const active = await db
    .selectFrom('subscriptions')
    .selectAll()
    .where('organization_id', '=', input.organizationId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (active) throw errors.conflict('This organization already has an active subscription.');

  const existingDraft = await db
    .selectFrom('subscriptions')
    .selectAll()
    .where('organization_id', '=', input.organizationId)
    .where('status', 'in', ['draft', 'pending_payment'])
    .executeTakeFirst();

  const billingCycle = input.billingCycle ?? 'monthly';

  const subscriptionId = await db.transaction().execute(async (trx) => {
    let id: string;
    if (existingDraft) {
      // Re-selecting before payment supersedes the previous choice.
      await trx
        .updateTable('subscriptions')
        .set({
          plan_id: plan.id,
          billing_cycle: billingCycle,
          status: 'draft',
          user_limit: plan.user_limit,
          entity_limit: plan.entity_limit,
          updated_at: new Date(),
        })
        .where('id', '=', existingDraft.id)
        .execute();
      await cancelOpenInvoices(trx, existingDraft.id);
      id = existingDraft.id;
    } else {
      const created = await trx
        .insertInto('subscriptions')
        .values({
          organization_id: input.organizationId,
          plan_id: plan.id,
          status: 'draft',
          billing_cycle: billingCycle,
          user_limit: plan.user_limit,
          entity_limit: plan.entity_limit,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = created.id;
    }

    await writeAuditLog(trx, {
      ...context,
      actorUserId: input.userId,
      organizationId: input.organizationId,
      action: 'subscription.plan_selected',
      targetType: 'subscription',
      targetId: id,
      metadata: { planCode: plan.code, billingCycle },
    });
    return id;
  });

  return { subscriptionId, status: 'draft' };
}

async function cancelOpenInvoices(trx: Transaction<Database>, subscriptionId: string): Promise<void> {
  await trx
    .updateTable('subscription_invoices')
    .set({ status: 'cancelled', updated_at: new Date() })
    .where('subscription_id', '=', subscriptionId)
    .where('status', 'in', ['issued', 'proof_submitted'])
    .execute();
}

/** `SUB-2026-00001`, sequential per year. Uniqueness is enforced by the index. */
async function nextInvoiceNumber(trx: Transaction<Database>): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await trx
    .selectFrom('subscription_invoices')
    .select('invoice_number')
    .where('invoice_number', 'like', `SUB-${year}-%`)
    .execute();
  return `SUB-${year}-${String(rows.length + 1).padStart(5, '0')}`;
}

export interface ConfirmedSubscription {
  subscriptionId: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentReference: string;
  total: number;
  currency: string;
  dueAt: string;
}

/**
 * Confirm a draft: issue the invoice and the unique payment reference in ONE
 * transaction. On a unique collision the whole transaction is retried with
 * freshly generated identifiers.
 */
export async function confirmSubscription(
  db: Kysely<Database>,
  input: { subscriptionId: string; organizationId: string; userId: string },
  context: AuditContext = {},
): Promise<ConfirmedSubscription> {
  for (let attempt = 0; attempt < UNIQUE_RETRY_LIMIT; attempt += 1) {
    try {
      return await db.transaction().execute(async (trx) => {
        const subscription = await trx
          .selectFrom('subscriptions')
          .selectAll()
          .where('id', '=', input.subscriptionId)
          .where('organization_id', '=', input.organizationId)
          .executeTakeFirst();
        if (!subscription) throw errors.notFound('Subscription');
        if (subscription.status === 'active') throw errors.conflict('This subscription is already active.');
        if (!subscription.plan_id) throw errors.validation('Choose a package before confirming.');

        const plan = await trx
          .selectFrom('subscription_plans')
          .selectAll()
          .where('id', '=', subscription.plan_id)
          .executeTakeFirstOrThrow();

        const settings = await trx.selectFrom('billing_settings').selectAll().executeTakeFirst();
        const dueDays = settings?.payment_due_days ?? 7;

        const price = subscription.billing_cycle === 'annual' ? (plan.annual_price ?? plan.monthly_price) : plan.monthly_price;
        const dueAt = new Date(Date.now() + dueDays * 86_400_000);

        const paymentReference = generatePaymentReference();
        const invoiceNumber = await nextInvoiceNumber(trx);

        const invoice = await trx
          .insertInto('subscription_invoices')
          .values({
            invoice_number: invoiceNumber,
            organization_id: input.organizationId,
            subscription_id: subscription.id,
            currency: plan.currency,
            subtotal: price,
            tax: '0',
            total: price,
            status: 'issued',
            payment_reference: paymentReference,
            due_at: dueAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .updateTable('subscriptions')
          .set({
            // Awaiting the customer's bank transfer — NOT active.
            status: 'pending_payment',
            payment_reference: paymentReference,
            updated_at: new Date(),
          })
          .where('id', '=', subscription.id)
          .execute();

        await writeAuditLog(trx, {
          ...context,
          actorUserId: input.userId,
          organizationId: input.organizationId,
          action: 'subscription.confirmed',
          targetType: 'invoice',
          targetId: invoice.id,
          metadata: { invoiceNumber, paymentReference, planCode: plan.code, total: Number(price) },
        });

        return {
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          invoiceNumber,
          paymentReference,
          total: Number(invoice.total),
          currency: invoice.currency,
          dueAt: new Date(invoice.due_at).toISOString(),
        };
      });
    } catch (error) {
      // Regenerate and retry only for identifier collisions.
      if (isUniqueViolation(error) && attempt < UNIQUE_RETRY_LIMIT - 1) continue;
      throw error;
    }
  }
  throw errors.conflict('Could not allocate a unique payment reference. Please try again.');
}

export interface CurrentSubscriptionView {
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billingCycle: string;
    planCode: string | null;
    planName: string | null;
    paymentReference: string | null;
    startsAt: string | null;
    expiresAt: string | null;
  } | null;
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    currency: string;
    total: number;
    paymentReference: string;
    dueAt: string;
  } | null;
  bank: Record<string, unknown> | null;
}

/** Everything the customer's subscription screen needs, in one call. */
export async function getCurrentSubscription(
  db: Kysely<Database>,
  organizationId: string,
): Promise<CurrentSubscriptionView> {
  const subscription = await db
    .selectFrom('subscriptions')
    .leftJoin('subscription_plans', 'subscription_plans.id', 'subscriptions.plan_id')
    .select([
      'subscriptions.id',
      'subscriptions.status',
      'subscriptions.billing_cycle',
      'subscriptions.payment_reference',
      'subscriptions.starts_at',
      'subscriptions.expires_at',
      'subscription_plans.code as plan_code',
      'subscription_plans.name as plan_name',
    ])
    .where('subscriptions.organization_id', '=', organizationId)
    .orderBy('subscriptions.created_at', 'desc')
    .executeTakeFirst();

  if (!subscription) return { subscription: null, invoice: null, bank: null };

  const invoice = await db
    .selectFrom('subscription_invoices')
    .selectAll()
    .where('subscription_id', '=', subscription.id)
    .where('status', 'in', ['issued', 'proof_submitted', 'paid'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  const bank = invoice && invoice.status !== 'paid' ? await db.selectFrom('bank_details').selectAll().executeTakeFirst() : undefined;

  return {
    subscription: {
      id: subscription.id,
      status: subscription.status,
      billingCycle: subscription.billing_cycle,
      planCode: subscription.plan_code,
      planName: subscription.plan_name,
      paymentReference: subscription.payment_reference,
      startsAt: subscription.starts_at ? new Date(subscription.starts_at).toISOString() : null,
      expiresAt: subscription.expires_at ? new Date(subscription.expires_at).toISOString() : null,
    },
    invoice: invoice
      ? {
          id: invoice.id,
          invoiceNumber: invoice.invoice_number,
          status: invoice.status,
          currency: invoice.currency,
          total: Number(invoice.total),
          paymentReference: invoice.payment_reference,
          dueAt: new Date(invoice.due_at).toISOString(),
        }
      : null,
    bank: bank
      ? {
          bankName: bank.bank_name,
          accountName: bank.account_name,
          accountNumber: bank.account_number,
          iban: bank.iban,
          swift: bank.swift,
          branch: bank.branch,
          instructions: bank.instructions,
          isPlaceholder: bank.is_placeholder,
        }
      : null,
  };
}
