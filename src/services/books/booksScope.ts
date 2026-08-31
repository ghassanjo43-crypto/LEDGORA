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
import {
  booksGeneration, isCurrentGeneration, bumpBooksGeneration, __resetBooksGenerationForTests,
} from './booksGenerationCounter';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { clearCustomerCache } from '@/services/parties/customerDirectory';
import { clearSupplierCache } from '@/services/parties/supplierDirectory';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useServerTaxCodeStore } from '@/store/serverTaxCodeStore';
import { useCompanyStore } from '@/store/companyStore';
import { clearMemoryWorkspace } from '@/lib/workspaceStorage';
import { resetCompanySettings } from '@/services/companySettingsSync';
import { resetCompanyRegistration } from '@/services/api/companyRegistration';
import { booksEngine } from '@/services/books/booksEngine';

/**
 * The counter itself lives in `booksGenerationCounter`, which imports nothing.
 * This module has to import the stores in order to clear them, and a store that
 * needed the counter from here would close a cycle whose resolution order
 * decides whether the clearing runs at all.
 */
/** The company the current caches describe, for diagnostics and tests. */
let scopedTo: string | null = null;

/** The controller for whatever hydration is in flight, so it can be dropped. */
let inFlight: AbortController | null = null;

export { booksGeneration, isCurrentGeneration };

export function scopedCompany(): string | null {
  return scopedTo;
}

/**
 * Claim a generation for a hydration about to start, aborting any earlier one.
 */
export function beginHydration(): { generation: number; signal: AbortSignal } {
  inFlight?.abort();
  inFlight = new AbortController();
  return { generation: booksGeneration(), signal: inFlight.signal };
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
  bumpBooksGeneration();
  scopedTo = reference;
  inFlight?.abort();
  inFlight = null;

  /* Only the server engine holds a CACHE. A demo workspace's records are the
   * originals, and clearing them would destroy the user's work. */
  if (booksEngine() === 'server') clearBooksCache();

  /*
   * The customer directory is cleared UNCONDITIONALLY, unlike the books.
   *
   * It is only ever a cache: a demo workspace's customers live in
   * `useEntityStore` and are not touched by this, so there is no user work to
   * destroy and no engine verdict worth depending on. Clearing it always is the
   * behaviour that cannot leave the previous company's customers in a picker.
   */
  clearCustomerCache();
  /* And the suppliers, for exactly the same reason: the previous company's
   * suppliers in a bill picker is how somebody bills the wrong party. */
  clearSupplierCache();

  /*
   * And the invoices, for the same reason: on server books they are a cache of
   * the previous company's documents, and leaving them puts another company's
   * receivables on screen for as long as the next fetch takes. A demo
   * workspace's invoices are the originals, so they are left alone.
   */
  if (booksEngine() === 'server') {
    useInvoiceStore.setState({ invoices: [] });
    /*
     * Tax codes are per company too. Leaving them would offer the previous
     * company's codes on the next company's invoice, and the server would
     * refuse a code the user can see on the screen in front of them.
     */
    useServerTaxCodeStore.setState({ taxCodes: [], loaded: false, loadError: undefined });
  }

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
  bumpBooksGeneration();
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
  __resetBooksGenerationForTests();
  scopedTo = null;
  inFlight = null;
}
