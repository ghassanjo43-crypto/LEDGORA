import { TriangleAlert } from 'lucide-react';
import type { AccountLedger } from '@/types/generalLedger';
import { formatAccountBalance, getBalanceSide } from '@/lib/generalLedgerCalculations';
import { formatMoney } from '@/lib/journalSelectors';
import { accountTypeLabel } from '@/data/ifrsOptions';
import { AccountDot } from '@/components/shared/AccountChip';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

export function AccountSummaryCard({ ledger }: { ledger: AccountLedger }) {
  const a = ledger.account;
  const closingAbnormal =
    getBalanceSide(ledger.closingBalance, a.normalBalance) !== 'zero' &&
    getBalanceSide(ledger.closingBalance, a.normalBalance) !== (a.normalBalance === 'DEBIT' ? 'debit' : 'credit');

  const stats: { label: string; value: string; tone?: string }[] = [
    { label: 'Opening balance', value: formatAccountBalance(ledger.openingBalance, a.normalBalance) },
    { label: 'Period debits', value: formatMoney(ledger.periodDebits) },
    { label: 'Period credits', value: formatMoney(ledger.periodCredits) },
    { label: 'Net movement', value: formatAccountBalance(ledger.netMovement, a.normalBalance) },
    { label: 'Closing balance', value: formatAccountBalance(ledger.closingBalance, a.normalBalance), tone: 'text-slate-900 dark:text-slate-50 font-semibold' },
    { label: 'Transactions', value: String(ledger.transactionCount) },
  ];

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <AccountDot type={a.type} className="mt-1" />
          <div>
            <p className="text-base font-semibold text-slate-900 dark:text-slate-50">
              <span className="font-mono text-sm text-slate-400">{a.code}</span> — {a.name}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Badge tone="slate">{accountTypeLabel(a.type)}</Badge>
              <span>{a.ifrsCategory || '—'}</span>
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <span>Normal balance: {a.normalBalance === 'DEBIT' ? 'Debit' : 'Credit'}</span>
            </p>
          </div>
        </div>
        {closingAbnormal && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5" /> Abnormal balance
          </span>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{s.label}</dt>
            <dd className={cn('mt-0.5 font-mono text-sm tabular-nums text-slate-700 dark:text-slate-200', s.tone)}>{s.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
