import { useMemo, useState, type ReactNode } from 'react';
import { Paperclip, MessageSquare, History, Circle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { JournalEntry } from '@/types/journal';
import { buildAuditTrail } from '@/lib/journalMeta';
import { formatDate, timeAgo, cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';

type Panel = 'notes' | 'audit' | null;

/**
 * Attachments · Notes · Audit-trail strip shown under an expanded journal
 * entry. Notes and the audit timeline are built from fields already on the
 * entry; attachments is a roadmap affordance. Nothing here changes the data
 * model or posting behaviour.
 */
export function EntryMetaBar({ entry }: { entry: JournalEntry }) {
  const [panel, setPanel] = useState<Panel>(null);
  const audit = useMemo(() => buildAuditTrail(entry), [entry]);
  const hasNotes = !!entry.notes.trim();

  const toggle = (p: Exclude<Panel, null>): void => setPanel((cur) => (cur === p ? null : p));

  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
        <MetaButton icon={Paperclip} label="Attachments" count={0} soon />
        <MetaButton
          icon={MessageSquare}
          label="Notes"
          count={hasNotes ? 1 : 0}
          active={panel === 'notes'}
          onClick={() => toggle('notes')}
        />
        <MetaButton
          icon={History}
          label="Audit trail"
          count={audit.length}
          active={panel === 'audit'}
          onClick={() => toggle('audit')}
        />
      </div>

      {panel === 'notes' && (
        <Panel>
          {hasNotes ? (
            <p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{entry.notes}</p>
          ) : (
            <p className="text-sm italic text-slate-400">No notes on this entry.</p>
          )}
        </Panel>
      )}

      {panel === 'audit' && (
        <Panel>
          <ol className="space-y-3">
            {audit.map((ev, i) => (
              <li key={`${ev.action}-${i}`} className="flex items-start gap-3">
                <span className="mt-0.5 flex flex-col items-center">
                  <Circle className="h-2.5 w-2.5 fill-brand-500 text-brand-500" />
                  {i < audit.length - 1 && <span className="mt-1 h-6 w-px bg-slate-200 dark:bg-slate-700" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{ev.action}</p>
                  <p className="flex items-center gap-1.5 text-xs text-slate-400">
                    <Avatar name={ev.actor} size="sm" className="!h-4 !w-4 !text-[8px]" />
                    {ev.actor} · {timeAgo(ev.at)} · {formatDate(ev.at)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="animate-[expandIn_0.2s_ease-in-out] border-t border-slate-100 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900/40">
      {children}
    </div>
  );
}

function MetaButton({
  icon: Icon,
  label,
  count,
  active,
  soon,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  active?: boolean;
  soon?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={soon}
      title={soon ? `${label} — coming soon` : label}
      className={cn(
        'focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
        soon
          ? 'cursor-not-allowed text-slate-400 dark:text-slate-500'
          : active
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
            : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      {count > 0 && (
        <span className="rounded-full bg-slate-200 px-1.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200">
          {count}
        </span>
      )}
      {soon && (
        <span className="rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase text-slate-400 dark:bg-slate-800">
          Soon
        </span>
      )}
    </button>
  );
}
