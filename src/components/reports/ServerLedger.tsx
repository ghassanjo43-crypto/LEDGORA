/**
 * One account's ledger, as the server computed it.
 *
 * The three figures at the top — opening, movement, closing — are aggregated by
 * PostgreSQL over the WHOLE range on every request, not summed from the rows on
 * screen. That is the difference between a closing balance and a running total
 * of whatever happened to be fetched, and it is the reason those figures do not
 * move as the reader pages downwards.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ServerLedgerResult } from '@/services/books/useServerLedger';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { serverAmount, serverAmountOrBlank } from './serverAmount';

const HEAD = 'sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400';
const NUM = 'whitespace-nowrap px-3 py-1.5 text-right font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200';

export function ServerLedger({ ledger }: { ledger: ServerLedgerResult }) {
  const { page, lines, state, error, stale, hasMore } = ledger;
  const decimals = page?.decimals ?? 2;

  return (
    <div className="space-y-3 p-4">
      {state === 'loading' && !page && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <RefreshCw className="h-4 w-4 animate-spin" /> Reading this ledger from the server…
        </div>
      )}

      {state === 'unavailable' && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>{error ?? 'Could not load this ledger.'}</p>
            <button type="button" onClick={ledger.reload} className="focus-ring text-xs font-semibold underline">Try again</button>
          </div>
        </div>
      )}

      {stale && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {/* The gap keyset paging cannot close: an entry backdated during the
                walk sorts before the cursor and will not appear in it. */}
            <p>These books changed while this ledger was being read. A backdated entry may not appear below.</p>
            <button type="button" onClick={ledger.reload} className="focus-ring text-xs font-semibold underline">Reload the ledger</button>
          </div>
        </div>
      )}

      {page && (
        <>
          <div className="flex flex-wrap gap-4 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
            <span className="text-slate-500 dark:text-slate-400">
              {page.account.code} — {page.account.name} · {page.currency}
            </span>
            <span>Opening <strong className="font-mono tabular-nums">{serverAmount(page.openingBalance, decimals)}</strong></span>
            <span>Debits <strong className="font-mono tabular-nums">{serverAmount(page.totals.debit, decimals)}</strong></span>
            <span>Credits <strong className="font-mono tabular-nums">{serverAmount(page.totals.credit, decimals)}</strong></span>
            <span>Closing <strong className="font-mono tabular-nums">{serverAmount(page.totals.closingBalance, decimals)}</strong></span>
            <span className="text-slate-500 dark:text-slate-400">{page.totals.lineCount} lines in the period</span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className={HEAD}>
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Date</th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Journal</th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Reference</th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Description</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Debit</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Credit</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {lines.map((line) => (
                  <tr key={line.lineId} className={cn(line.status === 'reversed' && 'text-slate-500 line-through decoration-slate-400/60')}>
                    <td className="whitespace-nowrap px-3 py-1.5">{line.postingDate}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[13px]">{line.journalNumber}</td>
                    <td className="px-3 py-1.5">{line.reference}</td>
                    <td className="px-3 py-1.5">{line.memo || line.description}</td>
                    <td className={NUM}>{serverAmountOrBlank(line.debit, decimals)}</td>
                    <td className={NUM}>{serverAmountOrBlank(line.credit, decimals)}</td>
                    <td className={NUM}>{serverAmount(line.runningBalance, decimals)}</td>
                  </tr>
                ))}
                {lines.length === 0 && state === 'ready' && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No postings to this account in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={ledger.loadMore} disabled={state === 'loading'}>
                {state === 'loading' ? 'Loading…' : `Load more (${lines.length} of ${page.totals.lineCount})`}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
