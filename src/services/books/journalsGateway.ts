/**
 * Every general-journal mutation, whichever engine the books are on.
 *
 * ══ The version travels, always ══════════════════════════════════════════════
 *
 * Each correcting call carries the version the editor READ. The server refuses
 * a stale one, and refuses an ABSENT one — it never fills the token in on the
 * caller's behalf, because a mutation with no version is last-write-wins, and
 * last-write-wins on a posted journal entry means one bookkeeper's correction
 * silently erases another's. So a gateway with no version to send does not
 * send the request at all; it reports that the entry must be reopened.
 *
 * ══ Numbering is not the browser's business ══════════════════════════════════
 *
 * The browser's `nextEntryNumber` scans the local entries and picks the next.
 * Two tabs, two people, or one dropped response and it allocates the same
 * number twice. The server allocates under a per-company advisory lock, and the
 * number comes back in the response — which is why every path here re-reads the
 * books rather than patching the cache with what it sent.
 */
import type { JournalFormValues } from '@/lib/journalValidation';
import { accountingApi } from '@/services/api/accountingApi';
import { ApiError } from '@/services/api/client';
import { useJournalStore, entryToFormValues, type JournalActionResult } from '@/store/journalStore';
import { booksEngine } from './booksEngine';
import { refreshBooks } from './booksHydration';
import { toServerJournalInput } from './journalMapping';

function failure(error: unknown, fallback: string): JournalActionResult {
  if (error instanceof ApiError) return { ok: false, error: error.message || fallback };
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

/** The version the editor read, or a refusal to proceed without one. */
function versionOf(entryId: string): number | null {
  const entry = useJournalStore.getState().entries.find((candidate) => candidate.id === entryId);
  return typeof entry?.version === 'number' ? entry.version : null;
}

const NEEDS_RELOAD: JournalActionResult = {
  ok: false,
  error: 'Reopen this entry before saving — its current version could not be confirmed.',
};

export async function createEntry(values: JournalFormValues): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') return useJournalStore.getState().addEntry(values);
  try {
    const journal = await accountingApi.createJournal(toServerJournalInput(values));
    await refreshBooks();
    return { ok: true, id: journal.id };
  } catch (error) {
    return failure(error, 'Could not save the journal entry.');
  }
}

export async function updateDraft(
  id: string,
  values: JournalFormValues,
  expectedVersion?: number,
): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') {
    return useJournalStore.getState().updateEntry(id, values, { expectedVersion });
  }
  const version = expectedVersion ?? versionOf(id);
  if (version === null) return NEEDS_RELOAD;
  try {
    await accountingApi.updateJournal(id, toServerJournalInput(values), version);
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    return failure(error, 'Could not save the journal entry.');
  }
}

export async function deleteEntry(id: string): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') return useJournalStore.getState().deleteEntry(id);
  const version = versionOf(id);
  if (version === null) return NEEDS_RELOAD;
  try {
    await accountingApi.deleteJournal(id, version);
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    /* The server refuses to delete anything POSTED — a posted entry is
     * corrected, never removed — and says so. */
    return failure(error, 'Could not delete the journal entry.');
  }
}

export async function postEntry(id: string, expectedVersion?: number): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') return useJournalStore.getState().postEntry(id);
  const version = expectedVersion ?? versionOf(id);
  if (version === null) return NEEDS_RELOAD;
  try {
    const journal = await accountingApi.postJournal(id, version);
    await refreshBooks();
    /* The number the SERVER allocated, so a confirmation can quote it. */
    return { ok: true, id: journal.id };
  } catch (error) {
    return failure(error, 'Could not post the journal entry.');
  }
}

/** Correct a posted entry in place, keeping the superseded version. */
export async function amendPostedEntry(
  id: string,
  values: JournalFormValues,
  options: { reason: string; expectedVersion?: number },
): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') {
    return useJournalStore.getState().amendPostedEntry(id, values, options);
  }
  const version = options.expectedVersion ?? versionOf(id);
  if (version === null) return NEEDS_RELOAD;
  try {
    await accountingApi.amendJournal(id, toServerJournalInput(values), version, options.reason);
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    return failure(error, 'Could not amend the journal entry.');
  }
}

/**
 * Reverse a posted entry.
 *
 * Two entries exist afterwards: the original, flipped to `reversed` with its
 * lines untouched, and a mirrored posting. Both remain in the books and both
 * count — which is why this returns after a full re-read rather than trying to
 * describe the outcome from the request.
 */
export async function reverseEntry(
  id: string,
  options: { reason?: string; expectedVersion?: number } = {},
): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') return useJournalStore.getState().reverseEntry(id);
  const version = options.expectedVersion ?? versionOf(id);
  if (version === null) return NEEDS_RELOAD;
  try {
    const result = await accountingApi.reverseJournal(id, version, options.reason);
    await refreshBooks();
    return { ok: true, id: result.reversal.id };
  } catch (error) {
    return failure(error, 'Could not reverse the journal entry.');
  }
}

/** Reverse and replace, as ONE atomic server operation. */
export async function reverseAndReplace(
  id: string,
  values: JournalFormValues,
  options: { reason: string; expectedVersion?: number },
): Promise<JournalActionResult & { reversalId?: string; replacementId?: string }> {
  if (booksEngine() !== 'server') {
    return useJournalStore.getState().reverseAndReplace(id, values, options);
  }
  const version = options.expectedVersion ?? versionOf(id);
  if (version === null) return NEEDS_RELOAD;
  try {
    const result = await accountingApi.reverseAndReplaceJournal(
      id, toServerJournalInput(values), version, options.reason,
    );
    await refreshBooks();
    return {
      ok: true,
      id: result.replacement.id,
      reversalId: result.reversal.id,
      replacementId: result.replacement.id,
    };
  } catch (error) {
    return failure(error, 'Could not correct the journal entry.');
  }
}

/**
 * Copy an entry into a new draft.
 *
 * Built from the source entry's own form values rather than from a "duplicate"
 * endpoint, because a duplicate is not a relationship the books record — it is
 * simply a new entry that happens to start with the same lines. Giving it a
 * server-side link would imply a connection between two transactions that have
 * none.
 */
export async function duplicateEntry(id: string): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') return useJournalStore.getState().duplicateEntry(id);
  const entry = useJournalStore.getState().entries.find((candidate) => candidate.id === id);
  if (!entry) return { ok: false, error: 'That entry is no longer in the journal.' };
  return createEntry(entryToFormValues(entry));
}

/**
 * Withdraw a posted entry from the books.
 *
 * The browser calls this "void"; the server reverses. They are the same
 * intention and NOT the same record: reversing leaves the original in place and
 * posts a mirror, so the transaction and its withdrawal are both visible. The
 * browser's void status is a display of that, never a deletion.
 */
export async function voidEntry(id: string): Promise<JournalActionResult> {
  if (booksEngine() !== 'server') return useJournalStore.getState().voidEntry(id);
  return reverseEntry(id);
}
