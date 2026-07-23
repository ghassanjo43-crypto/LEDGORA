import { useEffect, useState } from 'react';
import { X, Pencil, Send, RotateCcw, Copy, Trash2, FileText } from 'lucide-react';
import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import { buildWorkflowSteps, journalDisplayStatus } from '@/lib/journalWorkspace';
import { formatMoney } from '@/lib/journalSelectors';
import { formatDate, cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { DisplayStatusBadge } from './JournalBadges';
import { useJournalView } from '@/store/journalViewStore';
import { useStore } from '@/store/useStore';
import { JournalWorkflow } from './JournalWorkflow';
import { JournalAttachmentList } from './JournalAttachmentList';
import { JournalAuditTrail } from './JournalAuditTrail';

type Tab = 'details' | 'audit';

function fmtDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function JournalDetailsPanel({
  entry,
  accountsById,
  onClose,
  onEdit,
  onPost,
  onReverse,
  onDuplicate,
  onDelete,
  onSaveNotes,
}: {
  entry: JournalEntry | undefined;
  accountsById: Map<string, Account>;
  onClose: () => void;
  onEdit: (id: string) => void;
  onPost: (id: string) => void;
  onReverse: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveNotes: (id: string, notes: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('details');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setTab('details');
    setNotes(entry?.notes ?? '');
  }, [entry?.id, entry?.notes]);

  if (!entry) {
    return (
      <div className="flex h-full flex-col rounded-xl border border-slate-200/80 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
        <EmptyState icon={FileText} title="No entry selected" description="Select a journal entry from the table to see its details, workflow and audit trail." />
      </div>
    );
  }

  const isDraft = entry.status === 'draft';
  const isPosted = entry.status === 'posted';
  const status = journalDisplayStatus(entry, accountsById);
  const postable = isDraft && journalDisplayStatus(entry, accountsById) === 'pending';
  const steps = buildWorkflowSteps(entry);

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200/80 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 rounded-t-xl border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Journal: {entry.entryNumber}</h2>
            <DisplayStatusBadge status={status} />
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2 flex gap-1 border-b border-slate-100 dark:border-slate-800">
          {(['details', 'audit'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn('-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium capitalize transition-colors', tab === t ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400')}
            >
              {t === 'audit' ? 'Audit Trail' : 'Details'}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {tab === 'details' ? (
          <div className="space-y-5">
            <Section title="General Information">
              <Row label="Date" value={formatDate(entry.entryDate)} />
              <Row label="Entity" value={entry.lines.find((l) => l.entityName)?.entityName || '—'} />
              <Row label="Reference" value={entry.reference || '—'} />
              {entry.reference.startsWith('JV:') && <SourceVoucherLink reference={entry.reference} />}
              <Row label="Currency" value={`${entry.currency} @ ${entry.exchangeRate}`} />
              <Row label="Description" value={entry.description} wrap />
            </Section>

            <Section title="Amounts">
              <Row label="Debit" value={formatMoney(entry.totalDebit)} mono />
              <Row label="Credit" value={formatMoney(entry.totalCredit)} mono />
              <Row label="Difference" value={formatMoney(entry.difference)} mono tone={Math.abs(entry.difference) < 0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'} />
            </Section>

            <Section title="Workflow & Approvals">
              <JournalWorkflow steps={steps} />
            </Section>

            <Section title="Attachments">
              <JournalAttachmentList />
            </Section>

            <Section title="Notes">
              {isDraft ? (
                <div className="space-y-2">
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Add a note…" className="min-h-[64px] text-sm" />
                  {notes !== (entry.notes ?? '') && (
                    <Button size="sm" onClick={() => onSaveNotes(entry.id, notes)}>Save note</Button>
                  )}
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{entry.notes || <span className="italic text-slate-400">No notes.</span>}</p>
              )}
            </Section>

            <Section title="Audit">
              <Row label="Created By" value={entry.createdBy || 'System'} />
              <Row label="Created At" value={fmtDateTime(entry.createdAt)} />
              <Row label="Last Modified By" value={entry.updatedBy || entry.createdBy || 'System'} />
              <Row label="Last Modified At" value={fmtDateTime(entry.updatedAt)} />
            </Section>
          </div>
        ) : (
          <JournalAuditTrail entry={entry} />
        )}
      </div>

      {/* Sticky actions */}
      <div className="flex flex-wrap gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
        {isDraft && (
          <>
            <Button size="sm" variant="secondary" onClick={() => onEdit(entry.id)}><Pencil className="h-4 w-4" /> Edit</Button>
            <Button size="sm" disabled={!postable} onClick={() => onPost(entry.id)}><Send className="h-4 w-4" /> Post</Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(entry.id)} className="text-red-600 dark:text-red-400"><Trash2 className="h-4 w-4" /> Delete</Button>
          </>
        )}
        {isPosted && (
          <>
            <Button size="sm" variant="secondary" onClick={() => onReverse(entry.id)}><RotateCcw className="h-4 w-4" /> Reverse</Button>
            <Button size="sm" variant="ghost" onClick={() => onDuplicate(entry.id)}><Copy className="h-4 w-4" /> Duplicate</Button>
          </>
        )}
        {!isDraft && !isPosted && (
          <Button size="sm" variant="ghost" onClick={() => onDuplicate(entry.id)}><Copy className="h-4 w-4" /> Duplicate</Button>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

/** Back-link from a generated entry to its originating Journal Voucher. */
function SourceVoucherLink({ reference }: { reference: string }) {
  const requestFocusVoucher = useJournalView((s) => s.requestFocusVoucher);
  const setActiveView = useStore((s) => s.setActiveView);
  const voucherNumber = reference.replace(/^JV:(REV:)?/u, '');
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="shrink-0 text-slate-400">Source voucher</span>
      <button
        type="button"
        className="focus-ring truncate rounded text-right font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
        onClick={() => { requestFocusVoucher(voucherNumber); setActiveView('journal-vouchers'); }}
      >
        {voucherNumber}
      </button>
    </div>
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
