import { Circle } from 'lucide-react';
import type { JournalEntry } from '@/types/journal';
import { buildAuditTrail } from '@/lib/journalMeta';
import { Avatar } from '@/components/ui/Avatar';
import { timeAgo, formatDate } from '@/lib/utils';

/** Chronological audit trail built from the entry's existing timestamps. */
export function JournalAuditTrail({ entry }: { entry: JournalEntry }) {
  const events = buildAuditTrail(entry);

  if (events.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">No audit history recorded yet.</p>;
  }

  return (
    <ol className="space-y-4">
      {events.map((ev, i) => (
        <li key={`${ev.action}-${i}`} className="flex gap-3">
          <span className="mt-1 flex flex-col items-center">
            <Circle className="h-2.5 w-2.5 fill-brand-500 text-brand-500" />
            {i < events.length - 1 && <span className="mt-1 h-8 w-px bg-slate-200 dark:bg-slate-700" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{ev.action}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              <Avatar name={ev.actor} size="sm" className="!h-4 !w-4 !text-[8px]" />
              {ev.actor} · {timeAgo(ev.at)} · {formatDate(ev.at)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
