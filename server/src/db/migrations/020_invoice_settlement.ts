/**
 * What a sales invoice needs before a receipt can be recorded against it.
 *
 * ══ 1. The receivable the invoice actually used ══════════════════════════════
 *
 * A receipt credits the receivable the invoice debited. Migration 019 stored no
 * such column, because issuing took the account as an argument and did not keep
 * it — so a payment had no way to know which account to clear, and any account
 * the caller happened to pass would balance the entry while leaving the real
 * receivable outstanding forever.
 *
 * `receivable_account_id` is therefore recorded AT ISSUE and read back at
 * settlement. It is nullable because a draft has not chosen one yet, and
 * because every invoice migrated from the browser was posted in books this
 * server never saw.
 *
 * `tax_account_id` is stored for the same reason: a void reverses the original
 * entry, and a reversal that cannot name the account it is unwinding is a
 * reversal that has to guess.
 *
 * ══ 2. Reversal, not deletion ════════════════════════════════════════════════
 *
 * A receipt recorded in error is REVERSED: the row stays, a reversing journal
 * entry is posted, and both documents remain. Deleting the row would balance
 * the subledger by making the mistake unfindable, which is precisely what an
 * audit trail exists to prevent — the same reason `voidInvoice` never deletes.
 *
 * ══ 3. Additional charges ════════════════════════════════════════════════════
 *
 * `additional_charges_total` already exists from 019 but nothing ever wrote it,
 * so a browser invoice carrying delivery or handling charges would have arrived
 * with a grand total quietly smaller than the document the customer holds. The
 * column needed no change; the service did. This migration only adds the
 * account those charges are credited to when the invoice posts.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS receivable_account_id uuid,
      ADD COLUMN IF NOT EXISTS tax_account_id uuid,
      ADD COLUMN IF NOT EXISTS additional_charges_account_id uuid
  `.execute(db);

  /*
   * Tenant-scoped composite foreign keys, matching the pattern 019 uses for
   * every other account reference: a cross-tenant account is unrepresentable
   * rather than merely rejected at write time.
   */
  await sql`
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_receivable_account_fk
      FOREIGN KEY (organization_id, receivable_account_id)
      REFERENCES accounts (organization_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_tax_account_fk
      FOREIGN KEY (organization_id, tax_account_id)
      REFERENCES accounts (organization_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_charges_account_fk
      FOREIGN KEY (organization_id, additional_charges_account_id)
      REFERENCES accounts (organization_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`
    ALTER TABLE invoice_payments
      ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
      ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid,
      ADD COLUMN IF NOT EXISTS reversal_reason text
  `.execute(db);

  /*
   * A reversed payment carries its reason, the same rule 019 applies to a void
   * invoice. "Reversed, no reason given" is the state that makes a subledger
   * impossible to explain a year later.
   */
  await sql`
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_reversal_complete
      CHECK (reversed_at IS NULL OR reversal_reason IS NOT NULL)
  `.execute(db);

  /* Settling an invoice reads its unreversed payments; this is that lookup. */
  await sql`
    CREATE INDEX IF NOT EXISTS invoice_payments_open_idx
      ON invoice_payments (organization_id, invoice_id)
      WHERE reversed_at IS NULL
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS invoice_payments_open_idx`.execute(db);
  await sql`
    ALTER TABLE invoice_payments
      DROP CONSTRAINT IF EXISTS invoice_payments_reversal_complete,
      DROP COLUMN IF EXISTS reversal_reason,
      DROP COLUMN IF EXISTS reversal_journal_entry_id,
      DROP COLUMN IF EXISTS reversed_at
  `.execute(db);
  await sql`
    ALTER TABLE invoices
      DROP CONSTRAINT IF EXISTS invoices_charges_account_fk,
      DROP CONSTRAINT IF EXISTS invoices_tax_account_fk,
      DROP CONSTRAINT IF EXISTS invoices_receivable_account_fk,
      DROP COLUMN IF EXISTS additional_charges_account_id,
      DROP COLUMN IF EXISTS tax_account_id,
      DROP COLUMN IF EXISTS receivable_account_id
  `.execute(db);
}
