/**
 * Posting a periodic RUN — an allocation, a revaluation, a recognition.
 *
 * ══ What these three have in common ══════════════════════════════════════════
 *
 * Each builds a balanced journal from a calculation, posts it, and records the
 * journal id on the run. Each can be reversed exactly once. None of them is a
 * document somebody types: the run IS the source document, its id is stable
 * from the moment it is built, and that id is what makes a repeat identifiable.
 *
 * They were the first modules moved onto the server posting door because they
 * are the only ones whose posting is genuinely self-contained — no inventory
 * movements to unwind, no delegation into another module's engine, one post and
 * one reversal each. Everything learned here applies to the rest; nothing here
 * depends on the rest.
 *
 * ══ The event names ══════════════════════════════════════════════════════════
 *
 * `post` and `reversal`, derived from the run and nothing else. Deliberately
 * NOT a timestamp or a random token: a fresh value per attempt would make every
 * retry a new event, and the uniqueness invariant would happily record each one
 * as a separate journal — which is precisely the duplicate it exists to stop.
 */
import type { JournalFormValues } from '@/lib/journalValidation';
import { toServerJournalInput } from './journalMapping';
import {
  postSourceJournal,
  reverseSourceJournal,
  type SourceType,
} from './sourcePostingGateway';

/** What a run's post attempt tells its store. */
export type RunPostingOutcome =
  | { ok: true; journalEntryId: string }
  | { ok: false; error: string };

/**
 * Post a run's journal through the server, once.
 *
 * The caller must not mark the run posted until this succeeds. That ordering is
 * the whole point: a run recorded as posted against a journal the server never
 * accepted is a document claiming to be in books it never reached, and no later
 * reconciliation can tell it apart from one that was.
 */
export async function postRunJournal(
  sourceType: SourceType,
  runId: string,
  values: JournalFormValues,
): Promise<RunPostingOutcome> {
  const input = toServerJournalInput(values);
  const result = await postSourceJournal({
    sourceType,
    sourceId: runId,
    sourceEvent: 'post',
    transactionDate: input.transactionDate,
    reference: input.reference,
    description: input.description,
    notes: input.notes,
    lines: input.lines,
  });

  if (!result.ok) return { ok: false, error: result.error };
  /*
   * `created: false` means a previous attempt had already posted this run — a
   * retry, a refresh, a second tab. That is a SUCCESS: the journal exists and
   * it is this run's. Treating it as a failure would leave a run permanently
   * unable to record the posting it had genuinely made.
   */
  return { ok: true, journalEntryId: result.journal.id };
}

/** Withdraw a run's posting. Idempotent: a repeat returns the same reversal. */
export async function reverseRunJournal(
  sourceType: SourceType,
  runId: string,
  reason: string,
): Promise<RunPostingOutcome> {
  const result = await reverseSourceJournal(
    { sourceType, sourceId: runId, sourceEvent: 'post' },
    { reason },
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, journalEntryId: result.reversal.id };
}
