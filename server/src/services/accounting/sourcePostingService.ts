/**
 * Posting a journal on behalf of a source document, exactly once.
 *
 * ══ What this is for ═════════════════════════════════════════════════════════
 *
 * Inventory documents, journal vouchers, fixed assets and the rest do not draft
 * a journal and post it later — they produce a balanced entry as part of one
 * business action, and that entry must exist in the books before the document
 * may call itself posted. This is the door for those postings, and the only one
 * with an idempotency guarantee.
 *
 * ══ Idempotency is a CONSTRAINT, not a check ═════════════════════════════════
 *
 * Reading first and inserting second does not make a repeat safe. Two requests
 * can both read nothing and both insert, and that window is exactly where a
 * retry lands: a retry follows a timeout, and a timeout is when the first
 * attempt is still in flight. So the guarantee is
 * `journal_entries_source_event_unique` in PostgreSQL, and this service is
 * written to LOSE that race gracefully — a unique violation is caught and
 * turned into "here is the journal you already posted", which is the answer the
 * caller wanted in the first place.
 *
 * The read before the insert is still there, because winning without raising an
 * error is cheaper and far commoner than colliding. It is an optimisation. The
 * constraint is the correctness.
 *
 * ══ The vocabulary is closed ═════════════════════════════════════════════════
 *
 * `sourceType` is checked against a list in this file. `journalService` accepts
 * any string, which was tolerable while only two server-side callers used it and
 * is not once a browser can name one: an invented type would post a journal that
 * no module recognises, no reversal path can find, and no reconciliation can
 * match — a permanent orphan in the ledger with a plausible label.
 *
 * ══ Nothing is taken from the caller but the document ════════════════════════
 *
 * Organization and company come from the actor the guards derived. Journal
 * number, posting status, creator and timestamps are the server's. The caller
 * supplies what only it knows: which document, what happened to it, and the
 * lines.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from './audit.js';
import * as journals from './journalService.js';

/**
 * Every kind of document allowed to generate a journal.
 *
 * Deliberately the WHOLE domain rather than only the modules wired up today.
 * The list is a statement about what Ledgora's ledger can be produced by, and
 * adding a module should not need a migration — but inventing a type from a
 * browser must stay impossible.
 */
export const SOURCE_TYPES = [
  /* Already posting through their own server services. */
  'sales_invoice',
  'opening_balance',
  /* Browser-backed source documents. */
  'journal_voucher',
  'inventory_document',
  'manufacturing_document',
  'fixed_asset',
  'bill',
  'credit_note',
  'supplier_debit_note',
  'payment',
  'receipt',
  'cost_center_allocation',
  'currency_revaluation',
  'project_recognition',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** Bounds on the identity strings, so an index entry cannot be unbounded. */
const MAX_ID = 128;
const MAX_EVENT = 128;

export interface SourcePostingInput {
  sourceType: string;
  /** The document's own id. Text: browser documents are not uuids. */
  sourceId: string;
  /**
   * WHAT happened — `issue`, `settlement:<paymentId>`, `depreciation:2026-06`.
   * One document may produce several journals; this is what tells them apart,
   * and what a retry repeats to find the one it already made.
   */
  sourceEvent: string;
  transactionDate: string;
  postingDate?: string;
  reference?: string;
  description?: string;
  notes?: string;
  lines: journals.JournalLineInput[];
}

export interface SourcePostingResult {
  journal: journals.JournalRecord;
  /**
   * False when this call found the journal a previous one had already posted.
   *
   * The caller needs to know: it is the difference between "your document is
   * now in the books" and "your document was already in the books", and a
   * module that treated the second as a failure would refuse a retry that had
   * in fact succeeded.
   */
  created: boolean;
}

function assertIdentity(input: SourcePostingInput): {
  sourceType: SourceType; sourceId: string; sourceEvent: string;
} {
  const sourceType = (input.sourceType ?? '').trim();
  if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    throw errors.validation(
      `"${sourceType}" is not a source document Ledgora can post for. `
      + `Expected one of: ${SOURCE_TYPES.join(', ')}.`,
    );
  }
  const sourceId = (input.sourceId ?? '').trim();
  if (!sourceId) throw errors.validation('A source document id is required.');
  if (sourceId.length > MAX_ID) throw errors.validation('That source document id is too long.');

  const sourceEvent = (input.sourceEvent ?? '').trim();
  /*
   * Required, and required for a reason. Without an event the key would be the
   * document alone, and a document that legitimately posts twice — an invoice
   * and its receipts — would have its second posting refused as a duplicate.
   */
  if (!sourceEvent) throw errors.validation('A source posting event is required.');
  if (sourceEvent.length > MAX_EVENT) throw errors.validation('That source posting event is too long.');

  return { sourceType: sourceType as SourceType, sourceId, sourceEvent };
}

/** Whether a unique-violation came from the source-identity index. */
function isSourceDuplicate(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? '');
  return code === '23505' || /journal_entries_source_event_unique|duplicate key/i.test(message);
}

/**
 * The journal this document posted for this event, or null.
 *
 * Company-scoped as well as organization-scoped, so the same browser-minted
 * reference under a sibling company simply does not resolve — which is the
 * honest answer: that document did not post in THESE books.
 */
export async function findSourceJournal(
  db: Kysely<Database>,
  actor: AccountingActor,
  identity: { sourceType: string; sourceId: string; sourceEvent: string },
): Promise<journals.JournalRecord | null> {
  const row = await db
    .selectFrom('journal_entries')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('source_type', '=', identity.sourceType)
    .where('source_id', '=', identity.sourceId)
    .where('source_event', '=', identity.sourceEvent)
    .executeTakeFirst();
  if (!row) return null;
  return journals.getJournal(db, actor, row.id);
}

/**
 * Every journal this document has produced, newest first.
 *
 * What a RECONCILE asks for when a caller does not know whether its posting
 * landed and cannot reproduce the exact event string — and what a screen shows
 * to explain why a document is in the books twice over (an issue and its
 * receipts) rather than once.
 */
export async function listSourceJournals(
  db: Kysely<Database>,
  actor: AccountingActor,
  identity: { sourceType: string; sourceId: string },
): Promise<journals.JournalRecord[]> {
  const rows = await db
    .selectFrom('journal_entries')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('source_type', '=', identity.sourceType)
    .where('source_id', '=', identity.sourceId)
    .orderBy('created_at', 'desc')
    .execute();
  const found: journals.JournalRecord[] = [];
  for (const row of rows) found.push(await journals.getJournal(db, actor, row.id));
  return found;
}

/**
 * Post a source document's journal, or return the one already posted for it.
 *
 * Draft and post are two service calls because that is where every rule lives —
 * balancing, account eligibility, period locks, currency, numbering. Doing it
 * any other way would mean a second posting engine with its own opinion about
 * when the books may be written to, which is exactly the divergence this phase
 * exists to end.
 */
export async function postSourceJournal(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: SourcePostingInput,
): Promise<SourcePostingResult> {
  const identity = assertIdentity(input);

  /* The cheap path: somebody already posted this. */
  const existing = await findSourceJournal(db, actor, identity);
  if (existing) return { journal: existing, created: false };

  let draft: journals.JournalRecord;
  try {
    draft = await journals.createDraft(db, actor, {
      transactionDate: input.transactionDate,
      postingDate: input.postingDate,
      reference: input.reference ?? '',
      description: input.description ?? '',
      notes: input.notes ?? '',
      sourceType: identity.sourceType,
      sourceId: identity.sourceId,
      sourceEvent: identity.sourceEvent,
      lines: input.lines,
    });
  } catch (error) {
    /*
     * Lost the race. Another request inserted the draft between our read and
     * our write, and PostgreSQL refused this one — which is the guarantee
     * working. Return what won.
     */
    if (isSourceDuplicate(error)) {
      const won = await findSourceJournal(db, actor, identity);
      if (won) return { journal: won, created: false };
    }
    throw error;
  }

  try {
    const posted = await journals.postJournal(db, actor, draft.id, { expectedVersion: draft.version });
    return { journal: posted, created: true };
  } catch (error) {
    /*
     * The draft exists but could not be posted — a closed period, an ineligible
     * account, an unbalanced entry. It must not be left behind: a draft holding
     * this document's source identity would make every retry find it, decide
     * the document was already posted, and report success for a journal that is
     * not in the books.
     *
     * Deleting is safe precisely because it is a draft: nothing has counted it.
     */
    await journals
      .deleteDraft(db, actor, draft.id, { expectedVersion: draft.version })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Reverse the journal a source document posted, once.
 *
 * ══ Why the lock ════════════════════════════════════════════════════════════
 *
 * Two people voiding the same document at the same moment would each find a
 * posted entry and each write a mirror, and the document would then be reversed
 * twice — the books would show the transaction, its reversal, and a second
 * reversal that corresponds to nothing. `reverseJournal` refuses a second
 * reversal once the first has committed, but both readers can pass that check
 * before either commits. A lock keyed on the document itself is what makes them
 * take turns, and the second then finds the reversal the first made.
 *
 * The lock is taken on the SOURCE, not the journal, because the source is what
 * the two callers share and what they are competing to withdraw.
 */
export async function reverseSourceJournal(
  db: Kysely<Database>,
  actor: AccountingActor,
  identity: { sourceType: string; sourceId: string; sourceEvent: string },
  options: { reason: string; postingDate?: string },
): Promise<{ original: journals.JournalRecord; reversal: journals.JournalRecord; created: boolean }> {
  /* Only the identity is validated here; the dates and lines belong to a
   * posting, and a reversal supplies neither. */
  const checked = assertIdentity({
    ...identity, transactionDate: '1970-01-01', lines: [],
  } as SourcePostingInput);
  if (!options.reason?.trim()) {
    throw errors.validation('A reason is required to withdraw a posted document.');
  }

  return db.transaction().execute(async (trx) => {
    /*
     * Per company, per document, per event. Held to the end of THIS transaction
     * — which does no writing itself, so it is released before the reversal is
     * attempted below and cannot deadlock against it.
     */
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${`${actor.organizationId}:${actor.companyId}`}),
        hashtext(${`${checked.sourceType}:${checked.sourceId}:${checked.sourceEvent}`})
      )
    `.execute(trx);

    const original = await findSourceJournalIn(trx, actor, checked);
    if (!original) {
      throw errors.notFound('A journal for that source document');
    }

    /*
     * Already reversed: return the reversal that exists rather than refusing.
     * A caller retrying after a lost response is asking "is this withdrawn
     * yet", and the truthful answer is yes, here it is.
     */
    if (original.reversalEntryId) {
      const reversal = await journals.getJournal(trx, actor, original.reversalEntryId);
      return { original, reversal, created: false };
    }

    /*
     * `reverseJournalIn`, not `reverseJournal`: this transaction already holds
     * the lock, and Kysely does not nest transactions. Going through the
     * wrapper would either fail or take the lock in a transaction that ends
     * before the reversal runs.
     */
    const result = await journals.reverseJournalIn(
      trx, actor, original.id,
      { expectedVersion: original.version, reason: options.reason, postingDate: options.postingDate },
    );
    return { ...result, created: true };
  });
}

/** `findSourceJournal` against an open transaction. */
async function findSourceJournalIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trx: any,
  actor: AccountingActor,
  identity: { sourceType: string; sourceId: string; sourceEvent: string },
): Promise<journals.JournalRecord | null> {
  const row = await trx
    .selectFrom('journal_entries')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('source_type', '=', identity.sourceType)
    .where('source_id', '=', identity.sourceId)
    .where('source_event', '=', identity.sourceEvent)
    .executeTakeFirst();
  if (!row) return null;
  return journals.getJournal(trx, actor, row.id);
}
