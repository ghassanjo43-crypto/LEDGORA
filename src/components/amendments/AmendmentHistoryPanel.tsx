/**
 * The version history of a document, and the postings each version produced.
 *
 * Shown inside the amendment drawer and from the document view, so "what has
 * happened to this invoice" is answerable without leaving the screen the
 * question was asked on.
 */
import type { AmendableDocumentType } from '@/types/documentAmendment';
import { amendmentChain } from '@/services/documentAmendmentService';
import { useAmendmentAuditStore } from '@/store/amendmentAuditStore';
import { useJournalStore } from '@/store/journalStore';
import { AMENDMENT_AUDIT_LIMITATION } from '@/lib/amendmentAudit';
import { Badge } from '@/components/ui/Badge';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Props {
  documentType: AmendableDocumentType;
  documentId: string;
  currency: string;
  /** Hide the trail's limitation note where it has already been stated. */
  compact?: boolean;
}

export function AmendmentHistoryPanel({ documentType, documentId, currency, compact }: Props) {
  const events = useAmendmentAuditStore((s) => s.events);
  const entries = useJournalStore((s) => s.entries);
  const chain = amendmentChain(documentType, documentId);
  const entryNumber = (id: string | undefined): string =>
    (id ? entries.find((e) => e.id === id)?.entryNumber : undefined) ?? '—';

  const relevant = events.filter(
    (e) => chain.some((c) => c.id === e.documentId || c.id === e.replacementDocumentId),
  );

  if (chain.length <= 1 && relevant.length === 0) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        This document has never been amended. It is version 1, and its original posting is the one in force.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Version history
        </h4>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                {['Version', 'Document', 'Date', 'Total', 'Status', 'Journal', 'Reversal'].map((h) => (
                  <th key={h} className={cn('px-2 py-1 text-left font-semibold', h === 'Total' && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {chain.map((version) => (
                <tr key={version.id} className={cn(version.current && 'bg-emerald-50/60 dark:bg-emerald-500/5')}>
                  <td className="px-2 py-1.5 font-mono">v{version.version}</td>
                  <td className="px-2 py-1.5 font-mono font-semibold">{version.number}</td>
                  <td className="px-2 py-1.5 text-slate-500">{version.date}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatCurrency(version.total, currency)}</td>
                  <td className="px-2 py-1.5">
                    <Badge tone={version.current ? 'green' : 'slate'}>
                      {version.current ? 'current' : version.status}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">{entryNumber(version.journalEntryId)}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">{entryNumber(version.reversalJournalEntryId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {relevant.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Amendment audit
          </h4>
          <ul className="mt-2 space-y-2">
            {relevant.map((event) => (
              <li
                key={event.id}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={event.outcome === 'succeeded' ? 'green' : event.outcome === 'failed' ? 'red' : 'amber'}>
                    {event.outcome}
                  </Badge>
                  <span className="font-medium text-slate-700 dark:text-slate-200">{event.actorName}</span>
                  <span className="text-slate-400">({event.actorRole})</span>
                  <span className="text-slate-400">{event.at.slice(0, 19).replace('T', ' ')}</span>
                  {event.actedAsPlatformOperator && <Badge tone="red">platform operator</Badge>}
                </div>
                <p className="mt-1 text-slate-600 dark:text-slate-300">{event.reason}</p>
                {event.failureReason && (
                  <p className="mt-1 text-red-600 dark:text-red-300">{event.failureReason}</p>
                )}
                {event.changes.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-slate-500 dark:text-slate-400">
                    {event.changes.map((change) => (
                      <li key={change.field} className="font-mono text-[11px]">
                        {change.label}: <span className="line-through">{change.before}</span> → <span className="text-slate-700 dark:text-slate-200">{change.after}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {(event.settlementEffect.length > 0 || event.inventoryEffect.movementCount > 0) && (
                  <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {event.settlementEffect.length > 0 && `${event.settlementEffect.length} settlement record(s) carried across. `}
                    {event.inventoryEffect.movementCount > 0 && `${event.inventoryEffect.movementCount} stock movement(s) reversed and reposted.`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (
        <p className="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          {AMENDMENT_AUDIT_LIMITATION}
        </p>
      )}
    </div>
  );
}
