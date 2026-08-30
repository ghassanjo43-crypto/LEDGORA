/**
 * The four statements, for a durable subscriber, from one server snapshot.
 *
 * ══ Why a screen may not compute these itself ════════════════════════════════
 *
 * A durable subscriber's books live in PostgreSQL. The browser holds a CACHE of
 * the chart and the journal, filled by two SEPARATE requests — the accounts,
 * then the journals — which is exactly right for showing a list and exactly
 * wrong for a financial statement: two requests are two snapshots, and a
 * posting committed between them lands in one and not the other.
 *
 * So the statements are not derived from that cache. They are read as a bundle
 * the server aggregated inside one REPEATABLE READ transaction, and the
 * snapshot timestamp comes back with them so two reports on a screen can be
 * shown to describe the same books.
 *
 * ══ What a late answer must never do ═════════════════════════════════════════
 *
 * A statement request outlives the screen that asked for it. Between asking and
 * answering the user can switch company, change the period, or leave. Applying
 * a late answer would show one company's figures under another's name — the
 * single worst thing this hook could do — so every response is checked against
 * the books generation it was issued under AND the request that superseded it.
 * A stale answer is dropped in silence, because it is not an error: nobody is
 * asking that question any more.
 *
 * ══ Demo workspaces do not come here ═════════════════════════════════════════
 *
 * Free Demo and Free Preview have no server books. They keep the local
 * calculators, which is not a lesser path but the only correct one: there is
 * nothing on a server to aggregate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { reportsApi, type ReportBundleQuery, type ServerReportBundle } from '@/services/api/reportsApi';
import { booksEngine } from './booksEngine';
import { booksGeneration, isCurrentGeneration } from './booksScope';

export type ReportBundleState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface ReportBundleResult {
  state: ReportBundleState;
  bundle: ServerReportBundle | null;
  error: string | null;
  /** True when this screen must show server figures rather than compute them. */
  serverBacked: boolean;
  reload: () => void;
}

/**
 * The message for a failure, keeping the server's own words where it gave any.
 *
 * A reporting failure is frequently the server REFUSING to produce a statement —
 * debits not equal to credits, or a balance sheet that does not balance. That
 * refusal is the most important thing the screen can say, and replacing it with
 * "could not load reports" would hide the one message a bookkeeper needs.
 */
function messageFor(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Could not load these statements.';
}

export function useReportBundle(query: ReportBundleQuery): ReportBundleResult {
  const serverBacked = booksEngine() === 'server';

  const [state, setState] = useState<ReportBundleState>(serverBacked ? 'loading' : 'idle');
  const [bundle, setBundle] = useState<ServerReportBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /*
   * Which request is the current one. A response from an earlier request must
   * not overwrite a later one's answer even within the same company — a user
   * widening the period twice quickly would otherwise see the first period's
   * figures win because they happened to arrive last.
   */
  const latest = useRef(0);

  const { asOf, from, to } = query;
  const comparative = query.comparative ?? null;
  /* Compared by value: a fresh object each render would refetch forever. */
  const comparativeKey = comparative
    ? `${comparative.from}:${comparative.to}:${comparative.asOf}`
    : '';

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!serverBacked) {
      setState('idle');
      setBundle(null);
      setError(null);
      return;
    }

    const requestId = latest.current + 1;
    latest.current = requestId;
    const generation = booksGeneration();

    let abandoned = false;
    setState('loading');
    setError(null);

    reportsApi
      .bundle({ asOf, from, to, comparative })
      .then((result) => {
        /* Three ways this answer can already be irrelevant. */
        if (abandoned || requestId !== latest.current || !isCurrentGeneration(generation)) return;
        setBundle(result);
        setState('ready');
      })
      .catch((cause) => {
        if (abandoned || requestId !== latest.current || !isCurrentGeneration(generation)) return;
        /*
         * The previous figures are NOT cleared. A period that fails to load
         * leaves the last good statement on screen behind a visible error,
         * rather than blanking the page for a reason as ordinary as a dropped
         * connection. Nothing can be posted from this screen, so a stale
         * statement cannot become a stale write.
         */
        setError(messageFor(cause));
        setState('unavailable');
      });

    return () => { abandoned = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverBacked, asOf, from, to, comparativeKey, nonce]);

  return { state, bundle, error, serverBacked, reload };
}
