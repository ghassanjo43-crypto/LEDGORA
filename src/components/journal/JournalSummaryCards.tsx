import type { LucideIcon } from 'lucide-react';
import { ArrowDownLeft, ArrowUpRight, Scale, FileEdit, CheckCircle2 } from 'lucide-react';
import type { JournalSummary } from '@/lib/journalWorkspace';
import { formatMoney } from '@/lib/journalSelectors';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/utils';

function KpiCard({
  icon: Icon,
  tone,
  title,
  value,
  secondary,
  valueTone,
}: {
  icon: LucideIcon;
  tone: string;
  title: string;
  value: string;
  secondary: string;
  valueTone?: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-3.5">
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', tone)}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">{title}</p>
        <p className={cn('truncate text-lg font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-50', valueTone)} title={value}>
          {value}
        </p>
        <p className="truncate text-[11px] text-slate-400">{secondary}</p>
      </div>
    </Card>
  );
}

export function JournalSummaryCards({ summary, currency }: { summary: JournalSummary; currency: string }) {
  const balanced = Math.abs(summary.difference) < 0.005;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <KpiCard
        icon={ArrowDownLeft}
        tone="bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300"
        title="Total Debits"
        value={formatMoney(summary.totalDebit)}
        secondary={currency}
      />
      <KpiCard
        icon={ArrowUpRight}
        tone="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300"
        title="Total Credits"
        value={formatMoney(summary.totalCredit)}
        secondary={currency}
      />
      <KpiCard
        icon={Scale}
        tone={balanced ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'}
        title="Difference"
        value={formatMoney(summary.difference)}
        secondary={currency}
        valueTone={balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}
      />
      <KpiCard
        icon={FileEdit}
        tone="bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300"
        title="Draft Entries"
        value={String(summary.draftCount)}
        secondary={`${formatMoney(summary.draftTotal)} ${currency}`}
      />
      <KpiCard
        icon={CheckCircle2}
        tone="bg-cyan-50 text-cyan-600 dark:bg-cyan-500/10 dark:text-cyan-300"
        title="Posted Entries"
        value={String(summary.postedCount)}
        secondary={`${formatMoney(summary.postedTotal)} ${currency}`}
      />
    </div>
  );
}
