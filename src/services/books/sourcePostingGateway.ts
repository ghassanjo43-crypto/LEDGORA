/**
 * A source document's journal, posted through the server exactly once.
 *
 * ══ Why source modules do not use `journalsGateway` ══════════════════════════
 *
 * `journalsGateway` is for a person editing the general journal: draft, post,
 * amend, reverse — each a deliberate act with a version token behind it. A
 * source document does none of that. It produces a balanced entry as part of
 * one business action and needs a different guarantee: that repeating the
 * action does not repeat the entry.
 *
 * That guarantee is the document's own identity — `sourceType`, `sourceId`,
 * `sourceEvent` — and a unique index in PostgreSQL. Retries, refreshes, a
 * second tab and two racing requests all resolve to the same journal, because
 * they all name the same event.
 *
 * ══ An ambiguous answer is RECONCILED, never re-posted ═══════════════════════
 *
 * A dropped connection leaves the caller not knowing whether the posting landed.
 * Posting again would be the obvious move and the wrong one — the request may
 * have succeeded and the response been lost, and a blind repeat is how a
 * document ends up in the books twice.
 *
 * So a transport failure is followed by a LOOK-UP by source identity. If the
 * journal is there, the first attempt succeeded and its result is returned. If
 * it is not, nothing was written and the caller may try again. The idempotency
 * key makes even a mistaken repeat safe; the reconcile makes it unnecessary.
 *
 * ══ There is no browser path here ════════════════════════════════════════════
 *
 * Free Demo keeps its own ephemeral engine — `journalStore.insertPostedEntry`
 * still serves it, because a demo's records are the originals rather than a
 * cache. But once the books engine has latched to the server there is no local
 * fallback at all: a posted journal written to browser storage looks saved,
 * counts towards nothing, and is erased by the next hydration.
 */
import { api, ApiError } from '@/services/api/client';
import { booksEngine } from './booksEngine';
import { refreshBooks } from './booksHydration';

/**
 * The documents allowed to generate a journal.
 *
 * A copy of the server's list so a module can be checked at the call site, NOT
 * the authority: the server validates every value and refuses one it does not
 * know, so a copy that drifts produces a refusal rather than an orphan journal.
 */
export const SOURCE_TYPES = [
  'sales_invoice',
  'opening_balance',
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

export interface SourceIdentity {
  sourceType: SourceType;
  /** The document's own id, as the browser minted it. */
  sourceId: string;
  /**
   * WHAT happened to it. `post`, `reversal`, `depreciation:2026-06`.
   *
   * Must be DERIVED from the document, never generated fresh per attempt — a
   * random value would make every retry a new event and defeat the whole
   * mechanism.
   */
  sourceEvent: string;
}

export interface SourceLine {
  accountId: string;
  /** Decimal strings. Never parsed on the way out; see `journalMapping`. */
  debit?: string | null;
  credit?: string | null;
  memo?: string;
  entityId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
}

export interface SourcePostingRequest extends SourceIdentity {
  transactionDate: string;
  postingDate?: string;
  reference?: string;
  description?: string;
  notes?: string;
  lines: SourceLine[];
}

export interface ServerSourceJournal {
  id: string;
  journalNumber: string;
  status: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceEvent: string | null;
  reversalEntryId: string | null;
  version: number;
}

export type SourcePostingOutcome =
  | { ok: true; journal: ServerSourceJournal; created: boolean }
  | { ok: false; error: string; retryable: boolean };

/** A number as an exact decimal string, without float notation. */
export function decimalString(value: number | null | undefined): string {
  if (!value) return '0';
  return Number(value).toFixed(6).replace(/\.?0+$/, '') || '0';
}

function query(identity: SourceIdentity | Omit<SourceIdentity, 'sourceEvent'>): string {
  const parts = [
    `sourceType=${encodeURIComponent(identity.sourceType)}`,
    `sourceId=${encodeURIComponent(identity.sourceId)}`,
  ];
  if ('sourceEvent' in identity && identity.sourceEvent) {
    parts.push(`sourceEvent=${encodeURIComponent(identity.sourceEvent)}`);
  }
  return parts.join('&');
}

/** The journal this document posted for this event, or null. */
export async function findSourceJournal(
  identity: SourceIdentity,
): Promise<ServerSourceJournal | null> {
  const response = await api.get<{ journals: ServerSourceJournal[] }>(
    `/api/accounting/source-postings?${query(identity)}`,
  );
  return response.journals[0] ?? null;
}

/** Every journal this document produced — what a screen shows to explain itself. */
export async function listSourceJournals(
  identity: Omit<SourceIdentity, 'sourceEvent'>,
): Promise<ServerSourceJournal[]> {
  const response = await api.get<{ journals: ServerSourceJournal[] }>(
    `/api/accounting/source-postings?${query(identity)}`,
  );
  return response.journals;
}

/** A transport failure, as opposed to a refusal the server meant. */
function isAmbiguous(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  /* Status 0 is "never reached the server or never got back"; 5xx is "reached
   * it and something went wrong on the way", which may or may not have
   * committed. Both leave the caller not knowing. A 4xx is a decision. */
  return error.status === 0 || error.status >= 500;
}

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Post a source document's journal.
 *
 * Refuses outright on the demo engine: the caller keeps its own ephemeral path
 * for that, and silently doing something different here would hide which engine
 * a module was running on.
 */
export async function postSourceJournal(
  request: SourcePostingRequest,
): Promise<SourcePostingOutcome> {
  if (booksEngine() !== 'server') {
    return { ok: false, error: 'These books are not kept on the Ledgora service.', retryable: false };
  }

  try {
    const result = await api.post<{ journal: ServerSourceJournal; created: boolean }>(
      '/api/accounting/source-postings',
      request,
    );
    await refreshBooks();
    return { ok: true, journal: result.journal, created: result.created };
  } catch (error) {
    if (!isAmbiguous(error)) {
      /* The server decided: an unbalanced entry, a locked period, an account
       * that may not be posted to. Nothing was written and nothing will be. */
      return { ok: false, error: message(error, 'Could not post this document.'), retryable: false };
    }

    /*
     * Ambiguous. Ask whether the posting landed rather than sending it again —
     * the answer may already be in the books, and a blind repeat is how a
     * document is recorded twice.
     */
    try {
      const existing = await findSourceJournal(request);
      if (existing) {
        await refreshBooks();
        return { ok: true, journal: existing, created: false };
      }
    } catch {
      /* The reconcile could not reach the server either. Still ambiguous, and
       * still safe to retry: the identity makes a repeat idempotent. */
    }
    return { ok: false, error: message(error, 'Could not reach the Ledgora service.'), retryable: true };
  }
}

/**
 * Withdraw a document's posting.
 *
 * Idempotent on the server, so a retry after a lost answer returns the reversal
 * that already exists rather than writing a second one — two reversals of one
 * transaction would leave the books showing a withdrawal that corresponds to
 * nothing.
 */
export async function reverseSourceJournal(
  identity: SourceIdentity,
  options: { reason: string; postingDate?: string },
): Promise<
  | { ok: true; journal: ServerSourceJournal; reversal: ServerSourceJournal; created: boolean }
  | { ok: false; error: string; retryable: boolean }
> {
  if (booksEngine() !== 'server') {
    return { ok: false, error: 'These books are not kept on the Ledgora service.', retryable: false };
  }

  try {
    const result = await api.post<{
      original: ServerSourceJournal; reversal: ServerSourceJournal; created: boolean;
    }>('/api/accounting/source-postings/reverse', { ...identity, ...options });
    await refreshBooks();
    return { ok: true, journal: result.original, reversal: result.reversal, created: result.created };
  } catch (error) {
    if (!isAmbiguous(error)) {
      return { ok: false, error: message(error, 'Could not withdraw this posting.'), retryable: false };
    }
    /*
     * Same reconcile: a reversal may have committed before the connection
     * dropped. The original then carries a link to it.
     */
    try {
      const original = await findSourceJournal(identity);
      if (original?.reversalEntryId) {
        await refreshBooks();
        return {
          ok: true,
          journal: original,
          reversal: { ...original, id: original.reversalEntryId },
          created: false,
        };
      }
    } catch {
      /* Still unknown; still safe to retry. */
    }
    return { ok: false, error: message(error, 'Could not reach the Ledgora service.'), retryable: true };
  }
}
