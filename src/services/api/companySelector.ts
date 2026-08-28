/**
 * Keep the API client's company selector in step with the open company.
 *
 * ══ Why this is a subscription and not a call at each request site ═══════════
 *
 * Every accounting request has to say which set of books it concerns. Threading
 * that through each call site would mean roughly a hundred places that must all
 * remember, and the failure of forgetting one is not a compile error — it is a
 * request that quietly falls back to the server's omitted-selector rule and,
 * for a subscriber with a single company, succeeds. It would work in testing
 * and mis-scope the moment a customer adds a second company.
 *
 * So the selector is set in exactly one place, from the store that already
 * knows which company is open, and every request picks it up.
 *
 * ══ What is sent ═════════════════════════════════════════════════════════════
 *
 * `activeCompanyId` — the browser's own `co_...` reference. That is deliberate:
 * it is the identifier the server's registry adopted as `client_reference`, and
 * it is meaningful only inside an organization that already contains it. The
 * server's company UUID is never sent.
 */
import { useCompanyStore } from '@/store/companyStore';
import { setCompanyReference } from './client';

/**
 * Begin mirroring the open company onto outgoing requests. Called once during
 * start-up; returns the unsubscribe function so tests can detach.
 */
export function bindCompanySelector(): () => void {
  /*
   * Seed from the current value before subscribing. A subscription alone would
   * leave the very first requests after a reload with no selector — the app
   * rehydrates its open company from storage before anything subscribes.
   */
  setCompanyReference(useCompanyStore.getState().activeCompanyId || null);

  return useCompanyStore.subscribe((state, previous) => {
    if (state.activeCompanyId === previous.activeCompanyId) return;
    setCompanyReference(state.activeCompanyId || null);
  });
}
