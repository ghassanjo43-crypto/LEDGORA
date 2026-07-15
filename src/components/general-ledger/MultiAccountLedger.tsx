import { ChevronRight } from 'lucide-react';
import type { AccountLedger, GeneralLedgerLine } from '@/types/generalLedger';
import { formatAccountBalance } from '@/lib/generalLedgerCalculations';
import { formatMoney } from '@/lib/journalSelectors';
import { AccountDot } from '@/components/shared/AccountChip';
import { cn } from '@/lib/utils';
import { LedgerTable } from './LedgerTable';

export function MultiAccountLedger({
  ledgers,
  expanded,
  onToggle,
  onOpenJournal,
  onSelectLine,
  focusedLineId,
}: {
  ledgers: AccountLedger[];
  expanded: Set<string>;
  onToggle: (accountId: string) => void;
  onOpenJournal: (entryId: string) => void;
  onSelectLine: (line: GeneralLedgerLine) => void;
  focusedLineId: string | null;
}) {
  return (
    <div className="space-y-2.5">
      {ledgers.map((led) => {
        const a = led.account;
        const open = expanded.has(a.id);
        return (
          <div key={a.id} className={cn('overflow-hidden rounded-xl border bg-white shadow-card dark:bg-slate-900', open ? 'border-brand-200 dark:border-brand-500/30' : 'border-slate-200/80 dark:border-slate-800')}>
            <button
              type="button"
              onClick={() => onToggle(a.id)}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
            >
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
              <AccountDot type={a.type} />
              <span className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  <span className="font-mono text-xs text-slate-400">{a.code}</span> — {a.name}
                </span>
              </span>
              <span className="hidden items-center gap-5 text-xs sm:flex">
                <Meta label="Opening" value={formatAccountBalance(led.openingBalance, a.normalBalance)} />
                <Meta label="Debits" value={formatMoney(led.periodDebits)} />
                <Meta label="Credits" value={formatMoney(led.periodCredits)} />
                <Meta label="Closing" value={formatAccountBalance(led.closingBalance, a.normalBalance)} strong />
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">{led.transactionCount}</span>
              </span>
            </button>
            {open && (
              <div className="border-t border-slate-100 dark:border-slate-800">
                <LedgerTable
                  ledger={led}
                  lines={led.lines}
                  showOpeningRow
                  onOpenJournal={onOpenJournal}
                  onSelectLine={onSelectLine}
                  focusedLineId={focusedLineId}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Meta({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className="text-right">
      <span className="block text-[9px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className={cn('block font-mono tabular-nums', strong ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{value}</span>
    </span>
  );
}
