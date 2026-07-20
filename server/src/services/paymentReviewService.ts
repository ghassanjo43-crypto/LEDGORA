/**
 * Administrator payment review — the only path that activates a subscription.
 *
 * Approval is a single serialised transaction:
 *   1. `SELECT … FOR UPDATE` on the proof, invoice and subscription, so two
 *      concurrent reviewers cannot both approve.
 *   2. Re-check the proof is still `submitted` (guards against a double click
 *      and against a stale admin screen).
 *   3. Mark the proof approved and record the reviewer.
 *   4. Mark the invoice paid.
 *   5. Activate the subscription and apply the plan's limits/entitlements.
 *   6. Write the audit entries in the same transaction.
 *
 * Rejection and information requests deliberately share none of the activation
 * code — they cannot grant entitlements even by mistake.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, SubscriptionStatus } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

export interface ReviewerContext extends AuditContext {
  reviewerUserId: string;
  reviewerRole: string;
}

export interface ApprovalResult {
  proofId: string;
  invoiceId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  startsAt: string;
  expiresAt: string;
  appliedModules: string[];
}

function addMonths(from: Date, months: number): Date {
  const date = new Date(from);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

/** Load the proof + invoice + subscription under row locks. */
async function lockReviewTargets(trx: Transaction<Database>, proofId: string) {
  const proof = await trx
    .selectFrom('payment_proofs')
    .selectAll()
    .where('id', '=', proofId)
    .forUpdate()
    .executeTakeFirst();
  if (!proof) throw errors.notFound('Payment proof');

  const invoice = await trx
    .selectFrom('subscription_invoices')
    .selectAll()
    .where('id', '=', proof.invoice_id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const subscription = await trx
    .selectFrom('subscriptions')
    .selectAll()
    .where('id', '=', invoice.subscription_id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  return { proof, invoice, subscription };
}

export async function approvePaymentProof(
  db: Kysely<Database>,
  proofId: string,
  context: ReviewerContext,
): Promise<ApprovalResult> {
  return db.transaction().execute(async (trx) => {
    const { proof, invoice, subscription } = await lockReviewTargets(trx, proofId);

    // Idempotence guard: only a proof still awaiting review may be approved.
    if (proof.status !== 'submitted') {
      throw errors.conflict(`This payment proof has already been reviewed (${proof.status}).`);
    }
    if (invoice.status === 'paid') throw errors.conflict('This invoice is already paid.');
    if (invoice.status === 'cancelled') throw errors.conflict('This invoice has been cancelled.');

    const settings = await trx.selectFrom('billing_settings').selectAll().executeTakeFirst();
    const termMonths = settings?.term_months ?? 1;
    const graceDays = settings?.grace_days ?? 7;

    const plan = subscription.plan_id
      ? await trx.selectFrom('subscription_plans').selectAll().where('id', '=', subscription.plan_id).executeTakeFirst()
      : undefined;

    const startsAt = new Date();
    const expiresAt = addMonths(startsAt, subscription.billing_cycle === 'annual' ? termMonths * 12 : termMonths);
    const graceEndsAt = new Date(expiresAt.getTime() + graceDays * 86_400_000);

    await trx
      .updateTable('payment_proofs')
      .set({
        status: 'approved',
        reviewed_by_user_id: context.reviewerUserId,
        reviewed_at: new Date(),
        rejection_reason: null,
        information_request: null,
        updated_at: new Date(),
      })
      .where('id', '=', proof.id)
      .execute();

    await trx
      .updateTable('subscription_invoices')
      .set({ status: 'paid', paid_at: new Date(), updated_at: new Date() })
      .where('id', '=', invoice.id)
      .execute();

    // Activation + entitlement application, in the same transaction.
    await trx
      .updateTable('subscriptions')
      .set({
        status: 'active',
        starts_at: startsAt,
        expires_at: expiresAt,
        grace_ends_at: graceEndsAt,
        user_limit: plan?.user_limit ?? subscription.user_limit,
        entity_limit: plan?.entity_limit ?? subscription.entity_limit,
        updated_at: new Date(),
      })
      .where('id', '=', subscription.id)
      .execute();

    const appliedModules: string[] = plan
      ? typeof plan.module_entitlements === 'string'
        ? JSON.parse(plan.module_entitlements)
        : plan.module_entitlements
      : [];

    const auditBase = {
      ...context,
      actorUserId: context.reviewerUserId,
      actorPlatformRole: context.reviewerRole,
      organizationId: invoice.organization_id,
    };
    await writeAuditLog(trx, {
      ...auditBase,
      action: 'payment_proof.approved',
      targetType: 'payment_proof',
      targetId: proof.id,
      metadata: { invoiceNumber: invoice.invoice_number, amount: Number(proof.amount), quotedReference: proof.ledgora_payment_reference },
    });
    await writeAuditLog(trx, {
      ...auditBase,
      action: 'subscription.activated',
      targetType: 'subscription',
      targetId: subscription.id,
      metadata: {
        planCode: plan?.code ?? null,
        startsAt: startsAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        appliedModules,
      },
    });

    return {
      proofId: proof.id,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      status: 'active' as SubscriptionStatus,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      appliedModules,
    };
  });
}

export async function rejectPaymentProof(
  db: Kysely<Database>,
  proofId: string,
  reason: string,
  context: ReviewerContext,
): Promise<{ proofId: string; status: string }> {
  if (!reason.trim()) throw errors.validation('A rejection reason is required.');

  return db.transaction().execute(async (trx) => {
    const { proof, invoice, subscription } = await lockReviewTargets(trx, proofId);
    if (proof.status !== 'submitted') {
      throw errors.conflict(`This payment proof has already been reviewed (${proof.status}).`);
    }

    await trx
      .updateTable('payment_proofs')
      .set({
        status: 'rejected',
        rejection_reason: reason.trim(),
        reviewed_by_user_id: context.reviewerUserId,
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', proof.id)
      .execute();

    await trx
      .updateTable('subscription_invoices')
      .set({ status: 'rejected', updated_at: new Date() })
      .where('id', '=', invoice.id)
      .execute();

    // Back to the customer to re-pay. NO entitlement is granted.
    await trx
      .updateTable('subscriptions')
      .set({ status: 'rejected', updated_at: new Date() })
      .where('id', '=', subscription.id)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      actorUserId: context.reviewerUserId,
      actorPlatformRole: context.reviewerRole,
      organizationId: invoice.organization_id,
      action: 'payment_proof.rejected',
      targetType: 'payment_proof',
      targetId: proof.id,
      metadata: { invoiceNumber: invoice.invoice_number, reason: reason.trim() },
    });

    return { proofId: proof.id, status: 'rejected' };
  });
}

export async function requestProofInformation(
  db: Kysely<Database>,
  proofId: string,
  note: string,
  context: ReviewerContext,
): Promise<{ proofId: string; status: string }> {
  if (!note.trim()) throw errors.validation('Describe the information you need from the customer.');

  return db.transaction().execute(async (trx) => {
    const { proof, invoice } = await lockReviewTargets(trx, proofId);
    if (proof.status !== 'submitted') {
      throw errors.conflict(`This payment proof has already been reviewed (${proof.status}).`);
    }

    // The proof stays open for review; the customer is asked for more detail.
    await trx
      .updateTable('payment_proofs')
      .set({ information_request: note.trim(), updated_at: new Date() })
      .where('id', '=', proof.id)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      actorUserId: context.reviewerUserId,
      actorPlatformRole: context.reviewerRole,
      organizationId: invoice.organization_id,
      action: 'payment_proof.information_requested',
      targetType: 'payment_proof',
      targetId: proof.id,
      metadata: { invoiceNumber: invoice.invoice_number, note: note.trim() },
    });

    return { proofId: proof.id, status: 'more_information_required' };
  });
}

/* ── Review queue ─────────────────────────────────────────────────────────── */

export interface ProofListItem {
  id: string;
  status: string;
  invoiceId: string;
  invoiceNumber: string;
  organizationId: string;
  organizationName: string;
  invoicePaymentReference: string;
  quotedReference: string;
  bankTransactionReference: string | null;
  matchesInvoiceReference: boolean;
  amount: number;
  invoiceTotal: number;
  paidAt: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
  informationRequest: string | null;
  rejectionReason: string | null;
}

/** Shared projection so the list and single-proof views cannot drift apart. */
function proofQuery(db: Kysely<Database>) {
  return db
    .selectFrom('payment_proofs')
    .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
    .innerJoin('organizations', 'organizations.id', 'subscription_invoices.organization_id')
    .select([
      'payment_proofs.id',
      'payment_proofs.status',
      'payment_proofs.ledgora_payment_reference',
      'payment_proofs.bank_transaction_reference',
      'payment_proofs.amount',
      'payment_proofs.paid_at',
      'payment_proofs.file_name',
      'payment_proofs.mime_type',
      'payment_proofs.file_size',
      'payment_proofs.created_at',
      'payment_proofs.information_request',
      'payment_proofs.rejection_reason',
      'subscription_invoices.id as invoice_id',
      'subscription_invoices.invoice_number',
      'subscription_invoices.payment_reference as invoice_reference',
      'subscription_invoices.total as invoice_total',
      'organizations.id as organization_id',
      'organizations.legal_name',
    ]);
}

type ProofRow = Awaited<ReturnType<ReturnType<typeof proofQuery>['execute']>>[number];

function toProofListItem(row: ProofRow): ProofListItem {
  return {
    id: row.id,
    status: row.status,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    organizationId: row.organization_id,
    organizationName: row.legal_name,
    invoicePaymentReference: row.invoice_reference,
    quotedReference: row.ledgora_payment_reference,
    bankTransactionReference: row.bank_transaction_reference,
    // Recomputed at read time — the reviewer always sees the truth.
    matchesInvoiceReference: row.ledgora_payment_reference === row.invoice_reference,
    amount: Number(row.amount),
    invoiceTotal: Number(row.invoice_total),
    paidAt: new Date(row.paid_at).toISOString(),
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    uploadedAt: new Date(row.created_at).toISOString(),
    informationRequest: row.information_request,
    rejectionReason: row.rejection_reason,
  };
}

export async function listPaymentProofs(
  db: Kysely<Database>,
  options: { status?: string; limit?: number; offset?: number } = {},
): Promise<ProofListItem[]> {
  let query = proofQuery(db)
    .orderBy('payment_proofs.created_at', 'desc')
    .limit(Math.min(Math.max(options.limit ?? 25, 1), 100))
    .offset(Math.max(options.offset ?? 0, 0));

  if (options.status) query = query.where('payment_proofs.status', '=', options.status as never);

  return (await query.execute()).map(toProofListItem);
}

export async function getPaymentProof(db: Kysely<Database>, proofId: string): Promise<ProofListItem> {
  const row = await proofQuery(db).where('payment_proofs.id', '=', proofId).executeTakeFirst();
  if (!row) throw errors.notFound('Payment proof');
  return toProofListItem(row);
}

/** The stored file, for the reviewer to inspect. Never publicly reachable. */
export async function getProofStorageKey(db: Kysely<Database>, proofId: string): Promise<{ storageKey: string; mimeType: string; fileName: string }> {
  const row = await db
    .selectFrom('payment_proofs')
    .select(['storage_key', 'mime_type', 'file_name'])
    .where('id', '=', proofId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Payment proof');
  return { storageKey: row.storage_key, mimeType: row.mime_type, fileName: row.file_name };
}
