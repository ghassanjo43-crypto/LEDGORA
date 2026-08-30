/**
 * One account's ledger, read from the server, one page at a time.
 *
 * ══ Why the pages accumulate rather than replace ═════════════════════════════
 *
 * A ledger is read downwards. Replacing the visible rows with each new page
 * would make "next" behave like a jump rather than a continuation, and the
 * running balance — which the server computes over the whole range so a row
 * carries the same figure on whichever page it lands — would appear to start
 * again. So pages append, and the cursor comes from the server.
 *
 * ══ The watermark is not decoration ══════════════════════════════════════════
 *
 * Separate requests cannot share a transaction, so a walk is not a snapshot. A
 * backdated entry posted mid-walk sorts BEFORE the cursor and will not be seen
 * for the rest of the run. The server returns a watermark that changes when the
 * ledger under the query changes; when it moves between pages the reader is
 * told the books changed underneath them, instead of being handed a mixture of
 * two states and left to wonder why the totals moved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { reportsApi, type ServerLedgerLine, type ServerLedgerPage } from '@/services/api/reportsApi';
import { booksEngine } from './booksEngine';
import { booksGeneration, isCurrentGeneration } from './booksScope';

export type ServerLedgerState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface ServerLedgerResult {
  state: ServerLedgerState;
  /** The first page's header figures: account, totals, opening balance. */
  page: ServerLedgerPage | null;
  lines: ServerLedgerLine[];
  error: string | null;
  serverBacked: boolean;
  hasMore: boolean;
  /** True once the books changed underneath an in-progress walk. */
  stale: boolean;
  loadMore: () => void;
  reload: () => void;
}

const PAGE_SIZE = 100;

export function useServerLedger(query: { accountId: string; from: string; to: string }): ServerLedgerResult {
  const serverBacked = booksEngine() === 'server';
  const active = serverBacked && Boolean(query.accountId);

  const [state, setState] = useState<ServerLedgerState>('idle');
  const [page, setPage] = useState<ServerLedgerPage | null>(null);
  const [lines, setLines] = useState<ServerLedgerLine[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [nonce, setNonce] = useState(0);

  const latest = useRef(0);
  const { accountId, from, to } = query;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /* A new account or period is a NEW walk: previous rows describe a different
   * question and appending to them would splice two ledgers together. */
  useEffect(() => {
    if (!active) {
      setState('idle');
      setPage(null);
      setLines([]);
      setCursor(null);
      setStale(false);
      return;
    }

    const requestId = latest.current + 1;
    latest.current = requestId;
    const generation = booksGeneration();
    let abandoned = false;

    setState('loading');
    setError(null);
    setStale(false);

    reportsApi
      .ledgerPage({ accountId, from, to, limit: PAGE_SIZE })
      .then((result) => {
        if (abandoned || requestId !== latest.current || !isCurrentGeneration(generation)) return;
        setPage(result);
        setLines(result.lines);
        setCursor(result.nextCursor);
        setState('ready');
      })
      .catch((cause) => {
        if (abandoned || requestId !== latest.current || !isCurrentGeneration(generation)) return;
        setError(cause instanceof Error ? cause.message : 'Could not load this ledger.');
        setState('unavailable');
      });

    return () => { abandoned = true; };
  }, [active, accountId, from, to, nonce]);

  const loadMore = useCallback(() => {
    if (!active || !cursor || state === 'loading') return;

    const requestId = latest.current;
    const generation = booksGeneration();
    setState('loading');

    reportsApi
      .ledgerPage({ accountId, from, to, cursor, limit: PAGE_SIZE })
      .then((result) => {
        /* A page fetched for a walk that has since been restarted is not merely
         * late: appending it would interleave two different queries' rows. */
        if (requestId !== latest.current || !isCurrentGeneration(generation)) return;
        setLines((previous) => [...previous, ...result.lines]);
        setCursor(result.nextCursor);
        /* Header figures come from the newest page, so the totals on screen are
         * always the server's current whole-range answer. */
        setPage(result);
        setStale((was) => was || (page !== null && result.watermark !== page.watermark));
        setState('ready');
      })
      .catch((cause) => {
        if (requestId !== latest.current || !isCurrentGeneration(generation)) return;
        setError(cause instanceof Error ? cause.message : 'Could not load more of this ledger.');
        setState('unavailable');
      });
  }, [active, accountId, from, to, cursor, state, page]);

  return {
    state,
    page,
    lines,
    error,
    serverBacked,
    hasMore: Boolean(cursor),
    stale,
    loadMore,
    reload,
  };
}
