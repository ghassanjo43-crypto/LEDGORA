import { Circle, ArrowRight, Link2 } from 'lucide-react';
import type { JournalAmendmentRecord, JournalEntry } from '@/types/journal';
import { buildAuditTrail } from '@/lib/journalMeta';
import { amendmentHistory } from '@/lib/journalAmendment';
import { Avatar } from '@/components/ui/Avatar';
import { timeAgo, formatDate } from '@/lib/utils';

const KIND_LABEL: Record<JournalAmendmentRecord['kind'], string> = {
  created: 'Created',
  posted: 'Posted',
  amended: 'Edited',
  reversed: 'Reversal of',
  replaced: 'Replaced by',
  replacement: 'Replacement for',
  voided: 'Voided',
};

/**
 * The entry's version history.
 *
 * ── Why the recorded history wins over the derived one ───────────────────────
 * `buildAuditTrail` reconstructs a timeline from the entry's timestamps
 * (`createdAt`, `postedAt`, …). That is a reasonable fallback for records
 * written before amendments were tracked, but it can only ever describe the
 * CURRENT state — it cannot say that line 2's account used to be something else,
 * because the old value is not in those fields. So when real amendment records
 * exist they are shown instead, with their before/after values: the question an
 * auditor opens this panel to answer is "what changed, and why", and only the
 * recorded history can answer it.
 *
 * Nothing here filters or collapses records. Every version ever written stays
 * visible, including the original posting that a later correction superseded.
 */
export function JournalAuditTrail({ entry }: { entry: JournalEntry }) {
  const history = amendmentHistory(entry);

  if (history.length === 0) {
    // No recorded history: fall back to the timestamp-derived timeline.
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

  return (
    <ol className="space-y-4" data-testid="journal-audit-trail">
      {history.map((record, i) => (
        <li key={record.id} className="flex gap-3">
          <span className="mt-1 flex flex-col items-center">
            <Circle className="h-2.5 w-2.5 fill-brand-500 text-brand-500" />
            {i < history.length - 1 && <span className="mt-1 h-full min-h-[2rem] w-px bg-slate-200 dark:bg-slate-700" />}
          </span>

          <div className="min-w-0 flex-1 pb-1">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Version {record.version} · {KIND_LABEL[record.kind]}
              {record.relatedEntryNumber && (
                <span className="ml-1 inline-flex items-center gap-1 font-mono text-xs text-brand-600 dark:text-brand-400">
                  <Link2 className="h-3 w-3" />
                  {record.relatedEntryNumber}
                </span>
              )}
            </p>

            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              <Avatar name={record.actor} size="sm" className="!h-4 !w-4 !text-[8px]" />
              {record.actor} · {timeAgo(record.at)} · {formatDate(record.at)}
            </p>

            {record.reason && (
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                <span className="font-medium text-slate-500 dark:text-slate-400">Reason:</span> {record.reason}
              </p>
            )}

            {record.changes.length > 0 ? (
              <ul className="mt-1.5 space-y-1 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/50">
                {record.changes.map((change) => (
                  <li key={change.field} className="text-xs">
                    <span className="text-slate-500 dark:text-slate-400">{change.label}:</span>{' '}
                    <span className="font-mono text-slate-500 line-through dark:text-slate-400">{change.before}</span>
                    <ArrowRight className="mx-1 inline h-3 w-3 text-slate-400" />
                    <span className="font-mono font-medium text-slate-800 dark:text-slate-100">{change.after}</span>
                  </li>
                ))}
              </ul>
            ) : (
              record.kind === 'amended' && (
                <p className="mt-1 text-xs italic text-slate-400">No field values changed.</p>
              )
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
