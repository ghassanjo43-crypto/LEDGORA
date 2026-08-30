/**
 * The multi-account ledger for a durable subscriber.
 *
 * ══ Collapsed rows cost nothing ══════════════════════════════════════════════
 *
 * Every collapsed row's opening balance, turnover and closing balance arrives in
 * the report bundle that the screen already fetched. So listing the whole chart
 * is ONE request, and expanding nothing costs nothing — which is what the local
 * version did too, and the property worth keeping.
 *
 * A single account's lines are fetched only when that account is individually
 * opened. There is deliberately no control that opens them all: that would be
 * one request per account, hundreds on a real chart, and the thing a reader
 * actually wants from "expand all" — the whole book — is the export, which is
 * one server operation.
 *
 * ══ Two different reads, labelled as two different reads ═════════════════════
 *
 * The summaries belong to the bundle's snapshot. An account opened afterwards is
 * a SEPARATE read, minutes later, with its own watermark. Presenting those lines
 * as though they belonged to the earlier snapshot would be a quiet lie about
 * when the books were seen, so each opened account states its own read time.
 *
 * ══ Search, sorting and include-zero are presentation ════════════════════════
 *
 * They filter and order rows the server computed. None of them recomputes a
 * figure: hiding a row cannot change another row's balance, and the totals were
 * never a sum of what is visible.
 */
import { ChevronRight } from 'lucide-react';
import type { ServerAccountLedgerSummary } from '@/services/api/reportsApi';
import { useServerLedger } from '@/services/books/useServerLedger';
import { cn } from '@/lib/utils';
import { serverAmount, isServerZero } from './serverAmount';

export interface ServerMultiAccountProps {
  summaries: ServerAccountLedgerSummary[];
  decimals: number;
  period: { from: string; to: string };
  search: string;
  includeZero: boolean;
  /** Line order WITHIN an opened account. Display only. */
  sort: 'oldest' | 'newest';
  expanded: Set<string>;
  onToggle: (accountId: string) => void;
}

/**
 * Which rows to show.
 *
 * A dormant account — nothing posted in the period and nothing brought forward
 * — is hidden unless asked for, because a chart listing every unused code
 * buries the accounts that were actually used.
 */
export function visibleSummaries(
  summaries: ServerAccountLedgerSummary[],
  { search, includeZero }: { search: string; includeZero: boolean },
): ServerAccountLedgerSummary[] {
  const query = search.trim().toLowerCase();
  return summaries.filter((row) => {
    const dormant = row.lineCount === 0 && isServerZero(row.openingBalance);
    if (dormant && !includeZero) return false;
    if (!query) return true;
    return `${row.accountCode} ${row.accountName}`.toLowerCase().includes(query);
  });
}

export function ServerMultiAccountLedger({
  summaries, decimals, period, search, includeZero, sort, expanded, onToggle,
}: ServerMultiAccountProps) {
  const rows = visibleSummaries(summaries, { search, includeZero });

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
        No accounts match. Turn on “Include zero-balance” to list accounts with no activity.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {rows.map((row) => {
        const open = expanded.has(row.accountId);
        return (
          <div
            key={row.accountId}
            className={cn(
              'overflow-hidden rounded-xl border bg-white shadow-card dark:bg-slate-900',
              open ? 'border-brand-200 dark:border-brand-500/30' : 'border-slate-200/80 dark:border-slate-800',
            )}
          >
            <button
              type="button"
              onClick={() => onToggle(row.accountId)}
              aria-expanded={open}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
            >
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
              <span className="min-w-0 flex-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <span className="font-mono text-xs text-slate-400">{row.accountCode}</span>
                {' — '}
                <span>{row.accountName}</span>
              </span>
              <span className="hidden items-center gap-5 text-xs sm:flex">
                <Meta label="Opening" value={serverAmount(row.openingBalance, decimals)} />
                <Meta label="Debits" value={serverAmount(row.periodDebit, decimals)} />
                <Meta label="Credits" value={serverAmount(row.periodCredit, decimals)} />
                <Meta label="Closing" value={serverAmount(row.closingBalance, decimals)} strong />
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                  {row.lineCount}
                </span>
              </span>
            </button>

            {/* Mounted only while open: the request is made by opening, and by
                nothing else. */}
            {open && <ExpandedAccount accountId={row.accountId} period={period} sort={sort} />}
          </div>
        );
      })}
    </div>
  );
}

function ExpandedAccount({
  accountId, period, sort,
}: { accountId: string; period: { from: string; to: string }; sort: 'oldest' | 'newest' }) {
  const ledger = useServerLedger({ accountId, from: period.from, to: period.to });
  const decimals = ledger.page?.decimals ?? 2;

  /* Display order only. Each line carries the running balance the server
   * computed for it, so reversing the list re-orders rows without altering a
   * single figure. */
  const lines = sort === 'newest' ? [...ledger.lines].reverse() : ledger.lines;

  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      {ledger.state === 'loading' && !ledger.page && (
        <p role="status" className="px-3.5 py-3 text-sm text-slate-500">Reading this account’s ledger…</p>
      )}

      {ledger.state === 'unavailable' && (
        <p role="alert" className="px-3.5 py-3 text-sm text-amber-800 dark:text-amber-200">
          {ledger.error ?? 'Could not load this account’s ledger.'}
        </p>
      )}

      {ledger.page && (
        <>
          {/*
            * Its own read, and it says so. These lines were fetched after the
            * summary above, so they are not part of that snapshot and must not
            * be presented as if they were.
            */}
          <p className="px-3.5 pt-2 text-[11px] text-slate-500 dark:text-slate-400">
            Lines read separately at {new Date(ledger.page.readAt).toLocaleTimeString()} · reference{' '}
            <span className="font-mono">{ledger.page.watermark}</span>
          </p>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Date</th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Journal</th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Description</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Debit</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Credit</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {lines.map((line) => (
                  <tr key={line.lineId}>
                    <td className="whitespace-nowrap px-3 py-1.5">{line.postingDate}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[13px]">{line.journalNumber}</td>
                    <td className="px-3 py-1.5">{line.memo || line.description}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{serverAmount(line.debit, decimals)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{serverAmount(line.credit, decimals)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{serverAmount(line.runningBalance, decimals)}</td>
                  </tr>
                ))}
                {lines.length === 0 && ledger.state === 'ready' && (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-500">No postings in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {ledger.hasMore && (
            <div className="px-3.5 py-2">
              <button
                type="button"
                onClick={ledger.loadMore}
                disabled={ledger.state === 'loading'}
                className="focus-ring text-xs font-semibold text-brand-700 underline dark:text-brand-300"
              >
                {ledger.state === 'loading'
                  ? 'Loading…'
                  : `Load more (${ledger.lines.length} of ${ledger.page.totals.lineCount})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Meta({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className="text-right">
      <span className="block text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className={cn('block font-mono tabular-nums', strong ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>
        {value}
      </span>
    </span>
  );
}
