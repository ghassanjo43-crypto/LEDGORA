/**
 * Keeping the open company's books loaded, for every screen at once.
 *
 * ══ Why one hook at the top and not one per page ═════════════════════════════
 *
 * The chart of accounts, the general journal, the ledger, the registers and
 * every statement read the same two caches. Hydrating inside each of them would
 * mean the same fetch written a dozen times, a dozen chances to forget, and a
 * user who switches company while on the ledger seeing the previous company's
 * entries until they happen to visit a page that reloads.
 *
 * So it is mounted once, above the view switch. Every screen then reads a cache
 * that is either current or visibly loading, and a new page inherits that for
 * free instead of having to remember.
 *
 * ══ What it does NOT do ══════════════════════════════════════════════════════
 *
 * It does not poll, and it does not refetch on window focus. The books change
 * when this browser changes them — and every gateway re-reads after a mutation
 * it made — so a timer would spend a subscriber's connection re-downloading a
 * ledger to discover it is identical.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useCompanyStore } from '@/store/companyStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { booksEngine } from './booksEngine';
import { booksStatus, subscribeToBooksStatus, hydrateBooks, type BooksStatus } from './booksHydration';

/**
 * The load state of the open company's books.
 *
 * Safe to call from several components: the subscription is to a module-level
 * status, and the effect below is keyed so only a genuine change re-runs it.
 */
export function useBooksStatus(): BooksStatus {
  return useSyncExternalStore(subscribeToBooksStatus, booksStatus, booksStatus);
}

/**
 * Load the books, and reload them whenever the answer could have changed.
 *
 * ══ Why three keys and not one ═══════════════════════════════════════════════
 *
 * On a cold load these three become true in an order nobody controls, and every
 * one of them is a precondition for reading the books:
 *
 *   · the COMPANY — which set of books, and the obvious key;
 *   · the SESSION — the server has to have confirmed who is asking, and until
 *     it has, the engine is not even the server;
 *   · the ORGANIZATION — the adoption gate needs its legal name to claim the
 *     company under, and refuses the request as retryable until it has one.
 *
 * Keyed on the first two alone, a browser that finished its session before its
 * organization made exactly one attempt, was told "still loading your
 * organization", and never tried again. The screen then sat on an error for a
 * bootstrap step that had completed a moment later. The third key is what turns
 * that into a retry.
 */
export function useHydratedBooks(): BooksStatus {
  const activeCompanyId = useCompanyStore((state) => state.activeCompanyId);
  const sessionStatus = useBackendSessionStore((state) => state.status);
  const organizationHydration = useOrganizationStore((state) => state.hydration.status);
  const status = useBooksStatus();

  useEffect(() => {
    if (booksEngine() !== 'server') return;
    void hydrateBooks();
  }, [activeCompanyId, sessionStatus, organizationHydration]);

  return status;
}
