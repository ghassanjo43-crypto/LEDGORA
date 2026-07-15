import { X, BookOpenText, Building2, ListTree } from 'lucide-react';
import type { Account } from '@/types';
import type { GeneralLedgerLine } from '@/types/generalLedger';
import { formatAccountBalance } from '@/lib/generalLedgerCalculations';
import { formatMoney } from '@/lib/journalSelectors';
import { formatDate, cn } from '@/lib/utils';
import { accountTypeLabel } from '@/data/ifrsOptions';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FileText } from 'lucide-react';

export function LedgerDetailsPanel({
  line,
  account,
  onClose,
  onOpenJournal,
  onViewEntity,
  onViewAccount,
}: {
  line: GeneralLedgerLine | undefined;
  account: Account | undefined;
  onClose: () => void;
  onOpenJournal: (entryId: string) => void;
  onViewEntity: (entityId: string) => void;
  onViewAccount: () => void;
}) {
  if (!line) {
    return (
      <div className="flex h-full flex-col rounded-xl border border-slate-200/80 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
        <EmptyState icon={FileText} title="No transaction selected" description="Select a ledger line to see its full transaction, account and audit details." />
      </div>
    );
  }
  const normal = account?.normalBalance ?? 'DEBIT';

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200/80 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-2 rounded-t-xl border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{line.journalNumber}</h2>
          <Badge tone="slate">{line.transactionType}</Badge>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Section title="Transaction">
          <Row label="Journal no." value={line.journalNumber} />
          <Row label="Date" value={formatDate(line.entryDate)} />
          <Row label="Posting date" value={formatDate(line.postingDate)} />
          <Row label="Reference" value={line.reference || '—'} />
          <Row label="Type" value={line.transactionType} />
          <Row label="Description" value={line.description} wrap />
          {line.memo && <Row label="Line memo" value={line.memo} wrap />}
        </Section>

        <Section title="Account">
          <Row label="Code" value={line.accountCode} mono />
          <Row label="Name" value={line.accountName} />
          {account && <Row label="Type" value={accountTypeLabel(account.type)} />}
          {account && <Row label="IFRS category" value={account.ifrsCategory || '—'} />}
        </Section>

        <Section title="Amount">
          <Row label="Debit" value={line.baseDebit ? formatMoney(line.baseDebit) : '—'} mono />
          <Row label="Credit" value={line.baseCredit ? formatMoney(line.baseCredit) : '—'} mono />
          <Row label="Running balance" value={formatAccountBalance(line.runningBalance, normal)} mono tone={line.abnormal ? 'text-amber-600 dark:text-amber-400' : undefined} />
          <Row label="Currency" value={`${line.currency} @ ${line.exchangeRate}`} />
          {line.currency !== 'USD' && (
            <>
              <Row label="Foreign debit" value={line.debit ? formatMoney(line.debit) : '—'} mono />
              <Row label="Foreign credit" value={line.credit ? formatMoney(line.credit) : '—'} mono />
            </>
          )}
        </Section>

        <Section title="Dimensions">
          <Row label="Entity" value={line.entityName || '—'} />
          <Row label="Project" value={line.project || '—'} />
          <Row label="Cost center" value={line.costCenter || '—'} />
          <Row label="Tax code" value={line.taxCode || '—'} />
        </Section>

        <Section title="Audit">
          <Row label="Created by" value={line.createdBy || '—'} />
          <Row label="Posted by" value={line.postedBy || '—'} />
          {line.reversalReference && <Row label="Reversal ref." value={line.reversalReference} />}
          {line.originalEntryId && <Row label="Reverses" value="Original entry" />}
        </Section>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
        <Button size="sm" variant="secondary" onClick={() => onOpenJournal(line.journalEntryId)}><BookOpenText className="h-4 w-4" /> View journal</Button>
        <Button size="sm" variant="ghost" onClick={onViewAccount}><ListTree className="h-4 w-4" /> Account</Button>
        {line.entityId && <Button size="sm" variant="ghost" onClick={() => onViewEntity(line.entityId!)}><Building2 className="h-4 w-4" /> Entity</Button>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function Row({ label, value, mono, wrap, tone }: { label: string; value: string; mono?: boolean; wrap?: boolean; tone?: string }) {
  return (
    <div className={cn('flex gap-3 text-sm', wrap ? 'flex-col' : 'items-center justify-between')}>
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className={cn(wrap ? 'text-slate-700 dark:text-slate-200' : 'truncate text-right font-medium text-slate-800 dark:text-slate-100', mono && 'font-mono tabular-nums', tone)}>{value}</span>
    </div>
  );
}
