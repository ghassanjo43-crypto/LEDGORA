import { useEffect, useMemo, useState } from 'react';
import { Plus, ChevronDown, Eye, Printer, Ban, Copy, Pencil, Trash2, X, ReceiptText, Link2, Banknote, CheckCircle2, Replace } from 'lucide-react';
import type { CreditNoteStatus } from '@/types/creditNote';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useCreditNoteEditor } from '@/store/creditNoteEditorStore';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { CREDIT_NOTE_REASON_LABELS, CREDIT_NOTE_STATUS_TONE } from '@/lib/creditNoteLabels';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { PrintDocument } from '@/components/ui/PrintDocument';
import { CreditNoteEditorDrawer } from '@/components/credit-notes/CreditNoteEditorDrawer';
import { CreditNoteRenderer } from '@/components/credit-notes/CreditNoteRenderer';
import { CreditNoteApplicationDialog } from '@/components/credit-notes/CreditNoteApplicationDialog';
import { CreditNoteRefundDialog } from '@/components/credit-notes/CreditNoteRefundDialog';
import { CreditNoteVoidDialog } from '@/components/credit-notes/CreditNoteVoidDialog';

export function CreditNotesPage() {
  const entities = useEntityStore((s) => s.entities);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes);
  const store = useCreditNoteStore();
  const consumeEditorRequest = useCreditNoteEditor((s) => s.consume);
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [applyId, setApplyId] = useState<string | null>(null);
  const [refundId, setRefundId] = useState<string | null>(null);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const [customerFilter, setCustomerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<CreditNoteStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  // Honour a cross-page "open this credit note" request from the Invoices page.
  useEffect(() => {
    const requested = consumeEditorRequest();
    if (requested) setEditorId(requested);
  }, [consumeEditorRequest]);

  const customerName = (id: string): string => entities.find((e) => e.id === id)?.legalName ?? '—';
  const money = (n: number, cur: string): string => formatCurrency(n, cur);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return creditNotes
      .filter((c) => (customerFilter ? c.customerId === customerFilter : true))
      .filter((c) => (statusFilter === 'ALL' ? true : c.status === statusFilter))
      .filter((c) => (q ? `${c.creditNoteNumber} ${c.originalInvoiceNumber ?? ''} ${customerName(c.customerId)}`.toLowerCase().includes(q) : true))
      .sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditNotes, customerFilter, statusFilter, search, entities]);

  const customerOptions = [{ value: '', label: 'All customers' }, ...entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both').map((e) => ({ value: e.id, label: e.legalName }))];
  const statusOptions = [{ value: 'ALL', label: 'All statuses' }, ...(['draft', 'approved', 'issued', 'applied', 'partially-applied', 'refunded', 'void'] as const).map((s) => ({ value: s, label: s }))];

  const act = (fn: () => { ok: boolean; error?: string; id?: string }, success: string): void => {
    const res = fn();
    if (res.ok) notify(success, 'success'); else notify(res.error ?? 'Action failed.', 'error');
  };

  const onCorrect = (id: string): void => {
    const res = store.correctCreditNote(id);
    if (res.ok && res.id) { setEditorId(res.id); notify('Original voided — editing the replacement draft.', 'success'); }
    else notify(res.error ?? 'Could not correct the credit note.', 'error');
  };

  const previewCn = previewId ? store.getCreditNoteById(previewId) : undefined;
  const previewSnap = previewId ? store.previewSnapshot(previewId) : null;
  const previewReference = previewId ? store.invoiceReference(previewId) : null;
  const applyCn = applyId ? store.getCreditNoteById(applyId) : undefined;
  const refundCn = refundId ? store.getCreditNoteById(refundId) : undefined;

  return (
    <>
      <PageActions>
        <Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> New credit note</Button>
      </PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto max-w-[200px]" options={customerOptions} value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} aria-label="Customer" />
        <Select className="h-9 w-auto" options={statusOptions} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CreditNoteStatus | 'ALL')} aria-label="Status" />
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, invoice or customer…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={ReceiptText} title="No credit notes yet" description="Create a credit note from an issued invoice — it stays a draft until you issue it, which posts the reversal to the ledger." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
                <tr>
                  {['Credit note', 'Invoice', 'Customer', 'Issue', 'Reason', 'Total', 'Applied', 'Remaining', 'Status', 'Journal', ''].map((h) => (
                    <th key={h} className={cx('px-3 py-2 font-semibold', ['Total', 'Applied', 'Remaining'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{c.creditNoteNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.originalInvoiceNumber ?? '—'}</td>
                    <td className="px-3 py-2">{customerName(c.customerId)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{c.issueDate}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{CREDIT_NOTE_REASON_LABELS[c.reasonCode]}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(c.grandTotal, c.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(c.amountApplied, c.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{money(c.remainingCredit, c.currency)}</td>
                    <td className="px-3 py-2"><Badge tone={CREDIT_NOTE_STATUS_TONE[c.status]}>{c.status}</Badge></td>
                    <td className="px-3 py-2 text-xs">{c.journalEntryId ? <Badge tone="green">posted</Badge> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-2 text-right">
                      <Dropdown label="Actions" align="right" trigger={(o) => (
                        <span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>
                      )}>
                        {(() => { const editable = c.status === 'draft' || c.status === 'approved'; return (
                          <MenuItem onClick={() => (editable ? setEditorId(c.id) : setPreviewId(c.id))}>{editable ? <><Pencil className="h-4 w-4" /> {c.status === 'approved' ? 'Edit' : 'Edit draft'}</> : <><Eye className="h-4 w-4" /> View</>}</MenuItem>
                        ); })()}
                        <MenuItem onClick={() => setPreviewId(c.id)}><Printer className="h-4 w-4" /> Preview / print</MenuItem>
                        {c.status === 'draft' && <MenuItem onClick={() => act(() => store.approveCreditNote(c.id), 'Credit note approved.')}><CheckCircle2 className="h-4 w-4" /> Approve</MenuItem>}
                        {(c.status === 'draft' || c.status === 'approved') && <MenuItem onClick={() => act(() => store.issueCreditNote(c.id), 'Credit note issued & posted.')}><Link2 className="h-4 w-4" /> Issue &amp; post</MenuItem>}
                        {['issued', 'applied', 'partially-applied'].includes(c.status) && c.remainingCredit > 0.005 && <MenuItem onClick={() => setApplyId(c.id)}><Link2 className="h-4 w-4" /> Apply credit</MenuItem>}
                        {['issued', 'applied', 'partially-applied'].includes(c.status) && c.remainingCredit > 0.005 && <MenuItem onClick={() => setRefundId(c.id)}><Banknote className="h-4 w-4" /> Refund</MenuItem>}
                        <MenuItem onClick={() => act(() => store.duplicateCreditNote(c.id), 'Credit note duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                        {c.journalEntryId && c.status !== 'void' && <MenuItem onClick={() => onCorrect(c.id)}><Replace className="h-4 w-4" /> Correct / replace</MenuItem>}
                        {c.journalEntryId && c.status !== 'void' && <MenuItem onClick={() => setVoidId(c.id)}><Ban className="h-4 w-4" /> Void</MenuItem>}
                        {c.status === 'draft' && <MenuItem onClick={() => act(() => store.deleteDraft(c.id), 'Draft deleted.')}><Trash2 className="h-4 w-4" /> Delete draft</MenuItem>}
                      </Dropdown>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editorId && <CreditNoteEditorDrawer open creditNoteId={editorId} onClose={() => setEditorId(null)} onReplace={(newId) => setEditorId(newId)} />}
      {newOpen && <NewCreditNoteDialog onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setEditorId(id); }} />}

      {previewId && previewCn && previewSnap && (
        <>
          <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/50 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
              <div className="text-sm font-medium">{previewSnap.templateName} — v{previewSnap.versionNumber} · <span className="text-slate-500">{previewCn.status}</span></div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
                <button onClick={() => setPreviewId(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><CreditNoteRenderer creditNote={previewCn} snapshot={previewSnap} reference={previewReference} /></div></div>
          </div>
          {/* Print-only copy at <body> level → the PDF is just the A4 document. */}
          <PrintDocument><CreditNoteRenderer creditNote={previewCn} snapshot={previewSnap} reference={previewReference} /></PrintDocument>
        </>
      )}

      {applyId && applyCn && <CreditNoteApplicationDialog creditNote={applyCn} onClose={() => setApplyId(null)} />}
      {refundId && refundCn && <CreditNoteRefundDialog creditNote={refundCn} onClose={() => setRefundId(null)} />}
      {voidId && <CreditNoteVoidDialog onCancel={() => setVoidId(null)} onConfirm={(reason) => { act(() => store.voidCreditNote(voidId, reason), 'Credit note voided & reversed.'); setVoidId(null); }} />}
    </>
  );
}

/** Pick an issued invoice to credit, then create the draft. */
function NewCreditNoteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const invoices = useInvoiceStore((s) => s.invoices);
  const entities = useEntityStore((s) => s.entities);
  const createFromInvoice = useCreditNoteStore((s) => s.createCreditNoteFromInvoice);
  const { notify } = useToast();

  const creditable = useMemo(() => invoices.filter((i) => i.status !== 'draft' && i.status !== 'void'), [invoices]);
  const [invoiceId, setInvoiceId] = useState(creditable[0]?.id ?? '');
  const customerName = (id: string): string => entities.find((e) => e.id === id)?.legalName ?? '—';

  const submit = (): void => {
    const res = createFromInvoice(invoiceId);
    if (res.ok && res.id) onCreated(res.id);
    else notify(res.error ?? 'Could not create the credit note.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">New credit note</h2>
        <p className="mt-0.5 text-xs text-slate-500">A credit note reduces or reverses an issued invoice. Draft and void invoices cannot be credited.</p>
        {creditable.length === 0 ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            There are no issued invoices to credit yet. Issue an invoice first.
          </p>
        ) : (
          <label className="mt-3 block text-xs text-slate-500">Original invoice
            <Select className="mt-1" options={creditable.map((i) => ({ value: i.id, label: `${i.invoiceNumber} · ${customerName(i.customerId)} · ${formatCurrency(i.grandTotal, i.currency)}` }))} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!invoiceId} onClick={submit}><Plus className="h-4 w-4" /> Create draft</Button>
        </div>
      </div>
    </div>
  );
}
