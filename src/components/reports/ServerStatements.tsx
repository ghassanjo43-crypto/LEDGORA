/**
 * The statements a durable subscriber sees, rendered from the server bundle.
 *
 * These components do no accounting. Every figure is a decimal string the
 * server aggregated, and every classification — which heading a row belongs
 * under, whether an account is cash — is a field the server sent. The screen
 * decides how it looks and nothing else, which is the whole point: the same
 * figure filed under a different heading by two browsers would mean neither was
 * authoritative.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck, Info } from 'lucide-react';
import type {
  ServerAccountAmount,
  ServerReportBundle,
  ServerTrialBalanceRow,
} from '@/services/api/reportsApi';
import type { ReportBundleState } from '@/services/books/useReportBundle';
import { cn } from '@/lib/utils';
import { serverAmount, serverAmountOrBlank } from './serverAmount';

/* ══ Frame: loading, failure, and the snapshot the figures came from ═══════ */

interface FrameProps {
  state: ReportBundleState;
  error: string | null;
  bundle: ServerReportBundle | null;
  onReload: () => void;
  children: ReactNode;
}

/**
 * One place for the three things every server-backed statement must say.
 *
 * The previous figures stay on screen behind a failure banner rather than being
 * blanked. A statement that vanishes on a dropped connection is alarming out of
 * all proportion to the cause, and there is nothing to protect against here:
 * nothing can be posted from a report screen, so a stale figure cannot become a
 * stale write. It is labelled stale, which is the honest presentation.
 */
export function ServerReportFrame({ state, error, bundle, onReload, children }: FrameProps) {
  return (
    <div className="space-y-3">
      {state === 'loading' && !bundle && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
        >
          <RefreshCw className="h-4 w-4 animate-spin" />
          Reading these statements from the server…
        </div>
      )}

      {state === 'unavailable' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {/* The server's own words: a refusal to produce an unbalanced
                statement is the one message that must not be paraphrased. */}
            <p>{error ?? 'Could not load these statements.'}</p>
            {bundle && <p className="text-xs opacity-80">The figures below are from the last successful read.</p>}
            <button type="button" onClick={onReload} className="focus-ring text-xs font-semibold underline">
              Try again
            </button>
          </div>
        </div>
      )}

      {bundle && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Server figures · {bundle.snapshot.currency} · snapshot {new Date(bundle.snapshot.at).toLocaleString()}
          {' · '}
          {bundle.parameters.from} to {bundle.parameters.to} (as of {bundle.parameters.asOf})
        </p>
      )}

      {bundle && children}
    </div>
  );
}

/* ══ Shared cells ═════════════════════════════════════════════════════════ */

function Amount({ value, decimals, always = false, className }: {
  value: string | null | undefined;
  decimals: number;
  always?: boolean;
  className?: string;
}) {
  return (
    <td className={cn('whitespace-nowrap px-3 py-1.5 text-right font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200', className)}>
      {always ? serverAmount(value ?? '0', decimals) : serverAmountOrBlank(value, decimals)}
    </td>
  );
}

function AccountCells({ row }: { row: ServerAccountAmount }) {
  return (
    <>
      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[13px] text-slate-500 dark:text-slate-400">{row.accountCode}</td>
      <td className="px-3 py-1.5 text-slate-800 dark:text-slate-100">{row.accountName}</td>
    </>
  );
}

const HEAD = 'sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400';
const TOTAL = 'border-t-2 border-slate-300 font-semibold dark:border-slate-600';

/* ══ Trial balance ════════════════════════════════════════════════════════ */

export function ServerTrialBalance({ bundle }: { bundle: ServerReportBundle }) {
  const { decimals } = bundle.snapshot;
  const { rows, totalDebit, totalCredit } = bundle.trialBalance;
  /* Compared as strings. Equality of two decimal strings the server produced at
   * the same scale is exact; parsing them to compare would not be. */
  const balances = totalDebit === totalCredit;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className={HEAD}>
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Code</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Account</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Debit</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row: ServerTrialBalanceRow) => (
            <tr key={row.accountId}>
              <AccountCells row={row} />
              <Amount value={row.debit} decimals={decimals} />
              <Amount value={row.credit} decimals={decimals} />
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">No posted activity in this period.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr className={TOTAL}>
            <td className="px-3 py-2" colSpan={2}>Total</td>
            <Amount value={totalDebit} decimals={decimals} always />
            <Amount value={totalCredit} decimals={decimals} always />
          </tr>
        </tfoot>
      </table>

      <p className={cn('mt-2 flex items-center gap-1.5 px-3 text-xs', balances ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
        {balances ? <ShieldCheck className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {balances ? 'Debits equal credits.' : 'Debits do not equal credits.'}
      </p>
    </div>
  );
}

/* ══ Income statement ═════════════════════════════════════════════════════ */

export function ServerIncomeStatement({ bundle }: { bundle: ServerReportBundle }) {
  const { decimals } = bundle.snapshot;
  const { rows, income, expense, netIncome } = bundle.incomeStatement;

  /* Grouped by the classification the SERVER decided. A browser sorting these
   * into cost of sales and finance costs from the ledger type would be making
   * the accounting call locally. */
  const groups = new Map<string, ServerAccountAmount[]>();
  for (const row of rows) {
    const key = row.presentationType || row.ifrsCategory || row.accountType;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className={HEAD}>
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Code</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Account</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        {[...groups.entries()].map(([label, groupRows]) => (
          <tbody key={label} className="divide-y divide-slate-100 dark:divide-slate-800">
            <tr className="bg-slate-50/60 dark:bg-slate-800/40">
              <td colSpan={3} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</td>
            </tr>
            {groupRows.map((row) => (
              <tr key={row.accountId}>
                <AccountCells row={row} />
                <Amount value={row.amount} decimals={decimals} />
              </tr>
            ))}
          </tbody>
        ))}
        <tfoot>
          <tr className="border-t border-slate-200 dark:border-slate-700">
            <td className="px-3 py-1.5" colSpan={2}>Income</td>
            <Amount value={income} decimals={decimals} always />
          </tr>
          <tr>
            <td className="px-3 py-1.5" colSpan={2}>Expense</td>
            <Amount value={expense} decimals={decimals} always />
          </tr>
          <tr className={TOTAL}>
            <td className="px-3 py-2" colSpan={2}>Net income</td>
            <Amount value={netIncome} decimals={decimals} always />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* ══ Balance sheet ════════════════════════════════════════════════════════ */

export function ServerBalanceSheet({ bundle }: { bundle: ServerReportBundle }) {
  const { decimals } = bundle.snapshot;
  const sheet = bundle.balanceSheet;

  const sections: Array<{ label: string; type: string }> = [
    { label: 'Assets', type: 'asset' },
    { label: 'Liabilities', type: 'liability' },
    { label: 'Equity', type: 'equity' },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className={HEAD}>
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Code</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Account</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">As of {bundle.parameters.asOf}</th>
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={section.type} className="divide-y divide-slate-100 dark:divide-slate-800">
            <tr className="bg-slate-50/60 dark:bg-slate-800/40">
              <td colSpan={3} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{section.label}</td>
            </tr>
            {sheet.rows.filter((row) => row.accountType === section.type).map((row) => (
              <tr key={row.accountId}>
                <AccountCells row={row} />
                <Amount value={row.amount} decimals={decimals} />
              </tr>
            ))}
          </tbody>
        ))}
        <tfoot>
          <tr className="border-t border-slate-200 dark:border-slate-700">
            <td className="px-3 py-1.5" colSpan={2}>Total assets</td>
            <Amount value={sheet.assets} decimals={decimals} always />
          </tr>
          <tr>
            <td className="px-3 py-1.5" colSpan={2}>Total liabilities</td>
            <Amount value={sheet.liabilities} decimals={decimals} always />
          </tr>
          <tr>
            <td className="px-3 py-1.5" colSpan={2}>Total equity</td>
            <Amount value={sheet.equity} decimals={decimals} always />
          </tr>
          <tr>
            {/*
              * Labelled as what it is. No closing entry exists anywhere in
              * Ledgora, so earlier years' results have never moved into equity;
              * calling this retained earnings would name it something it is not.
              */}
            <td className="px-3 py-1.5" colSpan={2}>Unclosed earnings</td>
            <Amount value={sheet.unclosedEarnings} decimals={decimals} always />
          </tr>
        </tfoot>
      </table>

      <p className={cn('mt-2 flex items-center gap-1.5 px-3 text-xs', sheet.balances ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
        {sheet.balances ? <ShieldCheck className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {sheet.balances
          ? 'Assets equal liabilities plus equity plus unclosed earnings.'
          : 'The balance sheet does not balance.'}
      </p>
    </div>
  );
}

/* ══ Cash movement summary ════════════════════════════════════════════════ */

/**
 * Opening cash, closing cash, and the movement between them.
 *
 * Deliberately NOT a classified operating/investing/financing statement. That
 * needs every posting mapped to an activity, which the server does not yet do,
 * and the browser's version of it was a regular expression over an account's
 * free-text subcategory — so renaming a subcategory silently changed the
 * statement. A summary that is true beats a classification that is guessed.
 */
export function ServerCashSummary({ bundle }: { bundle: ServerReportBundle }) {
  const { decimals } = bundle.snapshot;
  const cash = bundle.cashFlow;

  if (cash.status === 'cash_accounts_not_configured') {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">No cash accounts are configured.</p>
          <p className="text-xs opacity-80">{cash.reason}</p>
          <p className="text-xs opacity-80">
            Mark the cash and bank accounts in the chart of accounts. Until then no cash figure is
            produced, rather than one guessed from account names.
          </p>
        </div>
      </div>
    );
  }

  const lines = [
    { label: `Cash at ${bundle.parameters.from}`, value: cash.openingCash },
    { label: 'Movement in the period', value: cash.movement },
    { label: `Cash at ${bundle.parameters.to}`, value: cash.closingCash },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.map((line, index) => (
            <tr key={line.label} className={index === lines.length - 1 ? TOTAL : undefined}>
              <td className="px-3 py-2 text-slate-800 dark:text-slate-100">{line.label}</td>
              <Amount value={line.value} decimals={decimals} always />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
