import { Check, X } from 'lucide-react';
import type { JournalApprovalStep } from '@/types/journal';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

const STAGE_LABEL: Record<JournalApprovalStep['stage'], string> = {
  created: 'Created',
  review: 'Review',
  approval: 'Approval',
  posting: 'Post',
};

function fmt(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function JournalWorkflow({ steps }: { steps: JournalApprovalStep[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  s.status === 'complete'
                    ? 'bg-emerald-500 text-white'
                    : s.status === 'rejected'
                      ? 'bg-red-500 text-white'
                      : 'border-2 border-brand-300 bg-white text-brand-600 dark:border-brand-500/50 dark:bg-slate-900 dark:text-brand-300',
                )}
              >
                {s.status === 'complete' ? <Check className="h-3.5 w-3.5" /> : s.status === 'rejected' ? <X className="h-3.5 w-3.5" /> : i + 1}
              </span>
              {!last && <span className="my-0.5 h-8 w-px bg-slate-200 dark:bg-slate-700" />}
            </div>
            <div className="min-w-0 pb-3">
              <p className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                {STAGE_LABEL[s.stage]}
                {s.status === 'pending' && <Badge tone="amber">Pending</Badge>}
                {s.status === 'rejected' && <Badge tone="red">Rejected</Badge>}
              </p>
              {s.assignedTo && <p className="text-xs text-slate-500 dark:text-slate-400">{s.status === 'complete' ? s.assignedTo : `Assigned to: ${s.assignedTo}`}</p>}
              {s.completedAt && <p className="text-[11px] text-slate-400">{fmt(s.completedAt)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
