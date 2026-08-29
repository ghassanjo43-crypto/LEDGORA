/**
 * Which company's books the caches currently hold, and when they stop being
 * true.
 *
 * ══ The bug this module exists to make unrepresentable ═══════════════════════
 *
 * Company A's chart is loading. The user switches to company B. A's response
 * arrives second and writes A's accounts into the store — under B's name, in
 * B's screens, and, if anything then posts against them, into B's books. The
 * request was correct, the scoping was correct, the ANSWER was correct; it was
 * simply about a question nobody is asking any more.
 *
 * A cancelled `fetch` does not fix this on its own, because the failure is not
 * the request: it is applying a result the user has moved past. So every
 * hydration records the generation it started in and refuses to write if the
 * generation has moved, whether or not the request was aborted. The
 * `AbortController` is the optimisation; the generation check is the guarantee.
 *
 * ══ The cache is cleared FIRST ═══════════════════════════════════════════════
 *
 * On a company change the caches are emptied immediately and synchronously,
 * before anything is fetched. Leaving the previous company's accounts on screen
 * "until the new ones arrive" means a bookkeeper spends the loading interval
 * looking at another company's books, which is the exact confusion that makes
 * somebody post to the wrong ledger. Empty and loading is honest; populated and
 * wrong is not.
 */
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useCompanyStore } from '@/store/companyStore';
import { clearMemoryWorkspace } from '@/lib/workspaceStorage';
import { resetCompanySettings } from '@/services/companySettingsSync';
import { resetCompanyRegistration } from '@/services/api/companyRegistration';
import { booksEngine } from './booksEngine';

/**
 * Bumped by every company change. A hydration that started under an older
 * value has been overtaken and must not write.
 */
let generation = 0;

/** The company the current caches describe, for diagnostics and tests. */
let scopedTo: string | null = null;

/** The controller for whatever hydration is in flight, so it can be dropped. */
let inFlight: AbortController | null = null;

export function booksGeneration(): number {
  return generation;
}

export function scopedCompany(): string | null {
  return scopedTo;
}

/** Whether a result from `startedAt` may still be applied. */
export function isCurrentGeneration(startedAt: number): boolean {
  return startedAt === generation;
}

/**
 * Claim a generation for a hydration about to start, aborting any earlier one.
 */
export function beginHydration(): { generation: number; signal: AbortSignal } {
  inFlight?.abort();
  inFlight = new AbortController();
  return { generation, signal: inFlight.signal };
}

/**
 * Empty every cached book record.
 *
 * `setState` deliberately, not the stores' own `replaceAll`: those are guarded
 * mutators that refuse a write while the server owns the books, and clearing a
 * cache is not a user's edit. The persist middleware still runs on `setState`,
 * so the emptied cache reaches storage too.
 */
export function clearBooksCache(): void {
  useStore.setState({ accounts: [], collapsedIds: {} });
  useJournalStore.setState({ entries: [] });
}

/**
 * A different company is open: everything cached about the previous one is now
 * wrong, and everything in flight about it is now irrelevant.
 */
export function enterCompanyScope(reference: string | null): void {
  generation += 1;
  scopedTo = reference;
  inFlight?.abort();
  inFlight = null;

  /* Only the server engine holds a CACHE. A demo workspace's records are the
   * originals, and clearing them would destroy the user's work. */
  if (booksEngine() === 'server') clearBooksCache();

  /* Both are per-company verdicts, and both are stale for the same reason. */
  resetCompanySettings();
  resetCompanyRegistration();
}

/**
 * Sign-out. Nothing cached survives, and the next session starts clean.
 *
 * Clears UNCONDITIONALLY, unlike a company change. The engine has already been
 * released by the time this runs — signing out ends the durable session — so an
 * engine-dependent clear would look at a `demo` verdict and leave the previous
 * user's chart of accounts sitting in the store for whoever signs in next. The
 * workspace reset happens to clear it as well today; relying on that would make
 * this correct by coincidence.
 */
export function leaveCompanyScope(): void {
  generation += 1;
  scopedTo = null;
  inFlight?.abort();
  inFlight = null;
  clearBooksCache();
  /*
   * And the volatile copy the clear itself just wrote.
   *
   * Emptying a persisted store writes the empty state THROUGH to storage, so
   * without this the keys survive a sign-out holding `{ entries: [] }` — the
   * records are gone but the workspace is not empty, which is not what "the
   * preview disappears on logout" promises. Only the in-memory map is dropped:
   * a durable subscriber's own records stay exactly where they are, because
   * signing out is not a request to destroy books.
   */
  clearMemoryWorkspace();
  resetCompanySettings();
  resetCompanyRegistration();
}

/**
 * Start mirroring company changes onto the caches.
 *
 * A subscription rather than a call inside `switchCompany`, for the reason the
 * request selector is one: a rule enforced at call sites holds until somebody
 * adds a call site, and every path that opens a different company — the
 * switcher, a deep link, a restore after archiving — has to clear the cache.
 *
 * Returns the unsubscribe function so tests can detach.
 */
export function bindCompanyScope(): () => void {
  scopedTo = useCompanyStore.getState().activeCompanyId || null;

  return useCompanyStore.subscribe((state, previous) => {
    if (state.activeCompanyId === previous.activeCompanyId) return;
    enterCompanyScope(state.activeCompanyId || null);
  });
}

/** Test seam: forget which company the caches describe. */
export function __resetBooksScopeForTests(): void {
  generation = 0;
  scopedTo = null;
  inFlight = null;
}
