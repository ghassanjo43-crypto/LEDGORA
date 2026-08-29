/**
 * Loading the open company's books from the server into the caches.
 *
 * ══ Hydration REPLACES; it never merges ══════════════════════════════════════
 *
 * A merge would let a local record with no server counterpart survive — which
 * is precisely how a browser-only account or entry outlives the cutover and
 * starts appearing in a chart the server does not have. Whatever the server
 * returns IS the chart and IS the journal. Anything else in the cache was, by
 * definition, not saved.
 *
 * That is also why the disposable browser test records need no import step:
 * they are not migrated, not merged and not consulted. The first successful
 * hydration replaces them.
 *
 * ══ Failure leaves the caches ALONE ══════════════════════════════════════════
 *
 * A hydration that fails reports itself and changes nothing. Clearing the chart
 * because the network dropped would show a bookkeeper an empty set of books,
 * which is the single most alarming thing this code could display for a reason
 * as ordinary as a flaky connection. The screen says it could not load; the
 * previous answer stays visible; nothing may be written, because the write path
 * goes to the server regardless of what the cache holds.
 */
import { accountingApi } from '@/services/api/accountingApi';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { recomputeLevels } from '@/lib/accountTree';
import type { Account } from '@/types';
import { booksEngine } from './booksEngine';
import { beginHydration, isCurrentGeneration } from './booksScope';
import { toAccount } from './accountMapping';
import { toJournalEntry } from './journalMapping';

export type BooksLoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface BooksStatus {
  state: BooksLoadState;
  error: string | null;
}

let status: BooksStatus = { state: 'idle', error: null };
const listeners = new Set<(status: BooksStatus) => void>();

/**
 * The current load state.
 *
 * Returns the held object ITSELF rather than a copy, and `setStatus` replaces
 * it rather than mutating it. That is not a micro-optimisation: this is the
 * `getSnapshot` of a `useSyncExternalStore`, which compares snapshots by
 * identity. Handing back a fresh object each call makes every render look like
 * a change, and React re-renders forever - which is exactly what happened,
 * taking the whole application shell down with it.
 */
export function booksStatus(): Readonly<BooksStatus> {
  return status;
}

/** Subscribe to load state, for the banner a screen shows while it waits. */
export function subscribeToBooksStatus(listener: (status: BooksStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: BooksStatus): void {
  /* Skip an identical verdict, so a re-hydration that changes nothing does not
   * wake every subscriber to tell them so. */
  if (status.state === next.state && status.error === next.error) return;
  status = next;
  for (const listener of listeners) listener(status);
}

export function __resetBooksStatusForTests(): void {
  status = { state: 'idle', error: null };
  listeners.clear();
}

/**
 * Load the chart of accounts and the general journal, in that order.
 *
 * Sequential and not parallel, because the journal's line snapshots — the
 * account code and name shown against each line — are resolved from the chart.
 * Fetching both at once and mapping the entries against a half-built chart
 * would render a ledger of "Unknown account" rows for no reason other than
 * ordering.
 */
export async function hydrateBooks(): Promise<{ ok: boolean; error?: string }> {
  if (booksEngine() !== 'server') {
    /* A demo workspace's records ARE the originals; there is nothing to load. */
    return { ok: true };
  }

  const { generation, signal } = beginHydration();
  setStatus({ state: 'loading', error: null });

  try {
    const serverAccounts = await accountingApi.listAll();
    /*
     * Checked between the two requests as well as after them. The company can
     * change at any await, and issuing the journal request for a company the
     * user has already left wastes it and risks applying it.
     */
    if (!isCurrentGeneration(generation) || signal.aborted) return { ok: false, error: 'superseded' };

    const accounts: Account[] = recomputeLevels(serverAccounts.map(toAccount));

    const serverJournals = await accountingApi.listJournals();
    if (!isCurrentGeneration(generation) || signal.aborted) return { ok: false, error: 'superseded' };

    const entries = serverJournals
      .map((journal) => toJournalEntry(journal, accounts))
      /* Oldest first, the order a journal is read in. The server returns the
       * newest first because that is what a paginated list wants. */
      .reverse();

    useStore.setState({ accounts });
    useJournalStore.setState({ entries });
    setStatus({ state: 'ready', error: null });
    return { ok: true };
  } catch (error) {
    if (!isCurrentGeneration(generation)) return { ok: false, error: 'superseded' };
    const message = error instanceof Error ? error.message : 'Could not load these books.';
    setStatus({ state: 'unavailable', error: message });
    return { ok: false, error: message };
  }
}

/**
 * Re-read the books after a mutation the server accepted.
 *
 * Every gateway calls this rather than patching the cache with what it sent.
 * The server allocates journal numbers, bumps versions, may normalise a value
 * and — for a reversal — writes a second entry the caller never mentioned.
 * Echoing the request into the cache would leave the screen disagreeing with
 * the books until the next reload, which is the whole failure being removed.
 */
export async function refreshBooks(): Promise<void> {
  await hydrateBooks();
}
