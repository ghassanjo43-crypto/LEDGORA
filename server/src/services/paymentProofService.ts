/**
 * Payment-proof submission.
 *
 * Submitting a proof moves the invoice to `proof_submitted` and the subscription
 * to `pending_verification`. It NEVER activates anything — activation is an
 * administrator decision (Phase 3) and is enforced by keeping activation code
 * out of this module entirely.
 *
 * The file bytes go to `FileStorage`; PostgreSQL keeps only the opaque key.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { FileStorage } from '../storage/fileStorage.js';
import { assertAcceptableProof } from '../storage/fileStorage.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

export interface SubmitProofInput {
  invoiceId: string;
  organizationId: string;
  userId: string;
  content: Buffer;
  fileName: string;
  mimeType: string;
  /** The LEDGORA reference the customer says they quoted on the transfer. */
  ledgoraPaymentReference: string;
  /** The bank's own transaction number, when supplied. */
  bankTransactionReference?: string;
  amount: number;
  paidAt: string;
  note?: string;
}

export interface SubmittedProof {
  id: string;
  status: string;
  matchesInvoiceReference: boolean;
}

function normaliseReference(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export async function submitPaymentProof(
  db: Kysely<Database>,
  storage: FileStorage,
  input: SubmitProofInput,
  maxBytes: number,
  context: AuditContext = {},
): Promise<SubmittedProof> {
  if (!(input.amount > 0)) throw errors.validation('Enter the amount paid.');
  if (!input.paidAt) throw errors.validation('Enter the payment date.');
  if (!input.ledgoraPaymentReference.trim()) throw errors.validation('Enter the LEDGORA payment reference you quoted.');

  // Content-type AND magic bytes must agree, and the size cap applies.
  assertAcceptableProof(input.content, input.mimeType, maxBytes);

  const invoice = await db
    .selectFrom('subscription_invoices')
    .selectAll()
    .where('id', '=', input.invoiceId)
    // Scoped to the caller's organization: a customer cannot attach a proof to
    // somebody else's invoice.
    .where('organization_id', '=', input.organizationId)
    .executeTakeFirst();

  if (!invoice) throw errors.notFound('Invoice');
  if (invoice.status === 'paid') throw errors.conflict('This invoice has already been paid.');
  if (invoice.status === 'cancelled') throw errors.conflict('This invoice has been cancelled.');

  const open = await db
    .selectFrom('payment_proofs')
    .select('id')
    .where('invoice_id', '=', invoice.id)
    .where('status', '=', 'submitted')
    .executeTakeFirst();
  if (open) throw errors.conflict('A payment proof for this invoice is already awaiting review.');

  // Recorded for the reviewer; a mismatch is a warning, never a rejection.
  const matchesInvoiceReference =
    normaliseReference(input.ledgoraPaymentReference) === normaliseReference(invoice.payment_reference);

  // Store the file first: an orphaned object is harmless, a database row
  // pointing at a file that was never written is not.
  const stored = await storage.put({ content: input.content, mimeType: input.mimeType });

  try {
    return await db.transaction().execute(async (trx) => {
      const proof = await trx
        .insertInto('payment_proofs')
        .values({
          invoice_id: invoice.id,
          uploaded_by_user_id: input.userId,
          file_name: input.fileName.slice(0, 255),
          storage_key: stored.storageKey,
          mime_type: stored.mimeType,
          file_size: stored.size,
          bank_transaction_reference: input.bankTransactionReference?.trim() || null,
          ledgora_payment_reference: normaliseReference(input.ledgoraPaymentReference),
          amount: String(input.amount),
          paid_at: new Date(input.paidAt),
          note: input.note?.trim() || null,
          status: 'submitted',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('subscription_invoices')
        .set({ status: 'proof_submitted', updated_at: new Date() })
        .where('id', '=', invoice.id)
        .execute();

      // Awaiting an administrator — deliberately NOT 'active'.
      await trx
        .updateTable('subscriptions')
        .set({ status: 'pending_verification', updated_at: new Date() })
        .where('id', '=', invoice.subscription_id)
        .execute();

      await writeAuditLog(trx, {
        ...context,
        actorUserId: input.userId,
        organizationId: input.organizationId,
        action: 'payment_proof.submitted',
        targetType: 'payment_proof',
        targetId: proof.id,
        metadata: {
          invoiceNumber: invoice.invoice_number,
          quotedReference: normaliseReference(input.ledgoraPaymentReference),
          matchesInvoiceReference,
          amount: input.amount,
        },
      });

      return { id: proof.id, status: proof.status, matchesInvoiceReference };
    });
  } catch (error) {
    // Roll back the stored object so a failed insert leaves nothing behind.
    await storage.delete(stored.storageKey).catch(() => {});
    throw error;
  }
}
