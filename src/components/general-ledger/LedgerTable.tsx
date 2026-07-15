import type { AccountLedger, GeneralLedgerLine } from '@/types/generalLedger';
import { formatAccountBalance } from '@/lib/generalLedgerCalculations';
import { formatMoney, formatAmountCell } from '@/lib/journalSelectors';
import { formatDate, cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';

interface LedgerTableProps {
  ledger: AccountLedger;
  lines: GeneralLedgerLine[];
  showOpeningRow: boolean;
  onOpenJournal: (entryId: string) => void;
  onSelectLine: (line: GeneralLedgerLine) => void;
  focusedLineId: string | null;
}

export function LedgerTable({ ledger, lines, showOpeningRow, onOpenJournal, onSelectLine, focusedLineId }: LedgerTableProps) {
  const normal = ledger.account.normalBalance;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-xs">
        <thead className="table-head-sticky">
          <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Journal No.</th>
            <th className="px-3 py-2">Reference</th>
            <th className="px-3 py-2">Entity</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2 text-right">Debit</th>
            <th className="px-3 py-2 text-right">Credit</th>
            <th className="px-3 py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {showOpeningRow && (
            <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
              <td className="px-3 py-2">—</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              <td className="px-3 py-2 font-medium italic">Opening Balance</td>
              <td className="px-3 py-2 text-right">—</td>
              <td className="px-3 py-2 text-right">—</td>
              <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {formatAccountBalance(ledger.openingBalance, normal)}
              </td>
            </tr>
          )}
          {lines.map((l) => {
            const focused = focusedLineId === l.id;
            return (
              <tr
                key={l.id}
                onClick={() => onSelectLine(l)}
                className={cn(
                  'cursor-pointer border-b border-slate-100 transition-colors dark:border-slate-800/60',
                  focused ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40',
                )}
              >
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-500 dark:text-slate-400">{formatDate(l.entryDate)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpenJournal(l.journalEntryId); }}
                    className="focus-ring rounded font-medium text-brand-600 hover:underline dark:text-brand-300"
                  >
                    {l.journalNumber}
                  </button>
                  {l.transactionType === 'Reversal' && <Badge tone="slate" className="ml-1.5">Reversal</Badge>}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-500 dark:text-slate-400">{l.reference || '—'}</td>
                <td className="max-w-[9rem] truncate px-3 py-1.5 text-slate-600 dark:text-slate-300">{l.entityName || '—'}</td>
                <td className="max-w-[16rem] truncate px-3 py-1.5 text-slate-600 dark:text-slate-300">{l.memo || l.description}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatAmountCell(l.baseDebit)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatAmountCell(l.baseCredit)}</td>
                <td className={cn('whitespace-nowrap px-3 py-1.5 text-right font-mono font-medium tabular-nums', l.abnormal ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-200')}>
                  {formatAccountBalance(l.runningBalance, normal)}
                </td>
              </tr>
            );
          })}
          {lines.length === 0 && !showOpeningRow && (
            <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">No transactions on this page.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-800/40">
            <td className="px-3 py-2 uppercase tracking-wide text-slate-500 dark:text-slate-300" colSpan={5}>Period totals</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatMoney(ledger.periodDebits)}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatMoney(ledger.periodCredits)}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900 dark:text-slate-50">{formatAccountBalance(ledger.closingBalance, normal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
