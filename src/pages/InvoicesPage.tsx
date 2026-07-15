import { useMemo, useState } from 'react';
import { Plus, ChevronDown, Eye, Printer, Send, Banknote, Ban, Copy, Pencil, Trash2, FileText, ReceiptText, ScrollText } from 'lucide-react';
import type { Invoice, InvoiceStatus } from '@/types/invoice';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useCreditNoteEditor } from '@/store/creditNoteEditorStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useReceiptEditor } from '@/store/receiptEditorStore';
import { useStatementStore } from '@/store/statementStore';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { InvoiceEditorDrawer } from '@/components/invoices/InvoiceEditorDrawer';
import { InvoicePreviewModal } from '@/components/invoices/InvoicePreviewModal';

const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: 'slate', approved: 'indigo', issued: 'blue', sent: 'cyan', 'partially-paid': 'amber', paid: 'green', void: 'red',
};

function today(): string { return new Date().toISOString().slice(0, 10); }
function isOverdue(inv: Invoice): boolean {
  return inv.dueDate < today() && inv.balanceDue > 0.005 && inv.status !== 'paid' && inv.status !== 'void' && inv.status !== 'draft';
}

export function InvoicesPage() {
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const invoices = useInvoiceStore((s) => s.invoices);
  const createDraft = useInvoiceStore((s) => s.createDraft);
  const store = useInvoiceStore();
  const createCreditNote = useCreditNoteStore((s) => s.createCreditNoteFromInvoice);
  const requestOpenCreditNote = useCreditNoteEditor((s) => s.requestOpen);
  const createReceiptForInvoice = useReceiptStore((s) => s.createReceiptForInvoice);
  const requestOpenReceipt = useReceiptEditor((s) => s.requestOpen);
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [voidId, setVoidId] = useState<string | null>(null);

  const [customerFilter, setCustomerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'ALL'>('ALL');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [search, setSearch] = useState('');

  const customerName = (id: string): string => entities.find((e) => e.id === id)?.legalName ?? '—';
  const money = (n: number, cur: string): string => formatCurrency(n, cur);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invoices
      .filter((i) => (customerFilter ? i.customerId === customerFilter : true))
      .filter((i) => (statusFilter === 'ALL' ? true : i.status === statusFilter))
      .filter((i) => (overdueOnly ? isOverdue(i) : true))
      .filter((i) => (unpaidOnly ? i.balanceDue > 0.005 && i.status !== 'void' : true))
      .filter((i) => (q ? `${i.invoiceNumber} ${customerName(i.customerId)}`.toLowerCase().includes(q) : true))
      .sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, customerFilter, statusFilter, overdueOnly, unpaidOnly, search, entities]);

  const customerOptions = [{ value: '', label: 'All customers' }, ...entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both').map((e) => ({ value: e.id, label: e.legalName }))];
  const statusOptions = [{ value: 'ALL', label: 'All statuses' }, ...(['draft', 'issued', 'sent', 'partially-paid', 'paid', 'void'] as const).map((s) => ({ value: s, label: s }))];

  const onNew = (): void => {
    const res = createDraft({ customerId: customerFilter || undefined, issueDate: today(), dueDate: today() });
    if (res.ok && res.id) setEditorId(res.id);
  };

  const act = (fn: () => { ok: boolean; error?: string }, success: string): void => {
    const res = fn();
    if (res.ok) notify(success, 'success'); else notify(res.error ?? 'Action failed.', 'error');
  };

  const onCreateCreditNote = (invoiceId: string): void => {
    const res = createCreditNote(invoiceId);
    if (res.ok && res.id) { requestOpenCreditNote(res.id); setActiveView('credit-notes'); notify('Credit note draft created.', 'success'); }
    else notify(res.error ?? 'Could not create the credit note.', 'error');
  };

  const canCredit = (inv: Invoice): boolean => inv.status !== 'draft' && inv.status !== 'void';

  const onRecordReceipt = (invoiceId: string): void => {
    const res = createReceiptForInvoice(invoiceId);
    if (res.ok && res.id) { requestOpenReceipt(res.id); setActiveView('receipts'); notify('Receipt draft created.', 'success'); }
    else notify(res.error ?? 'Could not create the receipt.', 'error');
  };

  const canReceive = (inv: Invoice): boolean => inv.status !== 'draft' && inv.status !== 'void' && inv.balanceDue > 0.005;

  const onViewStatement = (customerId: string): void => {
    useStatementStore.getState().selectCustomer(customerId);
    setActiveView('statements');
  };

  return (
    <>
      <PageActions>
        <Button onClick={onNew}><Plus className="h-4 w-4" /> New invoice</Button>
      </PageActions>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto max-w-[200px]" options={customerOptions} value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} aria-label="Customer" />
        <Select className="h-9 w-auto" options={statusOptions} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as InvoiceStatus | 'ALL')} aria-label="Status" />
        <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
        <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"><input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} /> Unpaid only</label>
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number or customer…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={FileText} title="No invoices yet" description="Create your first invoice — it stays a draft until you issue it, which posts the sale to the ledger." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
                <tr>
                  {['Invoice', 'Customer', 'Issue', 'Due', 'Total', 'Paid', 'Balance', 'Status', 'Template', 'Journal', ''].map((h) => (
                    <th key={h} className={cn('px-3 py-2 font-semibold', ['Total', 'Paid', 'Balance'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((inv) => {
                  const overdue = isOverdue(inv);
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                      <td className="px-3 py-2 font-mono text-xs font-semibold">{inv.invoiceNumber}</td>
                      <td className="px-3 py-2">{customerName(inv.customerId)}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{inv.issueDate}</td>
                      <td className={cn('px-3 py-2 text-xs', overdue ? 'font-semibold text-red-600' : 'text-slate-500')}>{inv.dueDate}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(inv.grandTotal, inv.currency)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{money(inv.amountPaid, inv.currency)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">{money(inv.balanceDue, inv.currency)}</td>
                      <td className="px-3 py-2"><Badge tone={overdue ? 'red' : STATUS_TONE[inv.status]}>{overdue ? 'overdue' : inv.status}</Badge></td>
                      <td className="px-3 py-2 text-xs text-slate-500">{inv.templateSnapshot?.templateName ?? '—'}</td>
                      <td className="px-3 py-2 text-xs">{inv.journalEntryId ? <Badge tone="green">posted</Badge> : <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2 text-right">
                        <Dropdown label="Actions" align="right" trigger={(o) => (
                          <span className={cn('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>
                        )}>
                          <MenuItem onClick={() => setPreviewId(inv.id)}><Eye className="h-4 w-4" /> Preview</MenuItem>
                          {inv.status === 'draft' && <MenuItem onClick={() => setEditorId(inv.id)}><Pencil className="h-4 w-4" /> Edit</MenuItem>}
                          {inv.status === 'draft' && <MenuItem onClick={() => act(() => store.issueInvoice(inv.id), 'Invoice issued & posted.')}><Send className="h-4 w-4" /> Issue &amp; post</MenuItem>}
                          {inv.status === 'issued' && <MenuItem onClick={() => act(() => store.markSent(inv.id), 'Marked as sent.')}><Send className="h-4 w-4" /> Mark as sent</MenuItem>}
                          {canReceive(inv) && <MenuItem onClick={() => onRecordReceipt(inv.id)}><Banknote className="h-4 w-4" /> Record receipt</MenuItem>}
                          <MenuItem onClick={() => setPreviewId(inv.id)}><Printer className="h-4 w-4" /> Print / PDF</MenuItem>
                          {canCredit(inv) && <MenuItem onClick={() => onCreateCreditNote(inv.id)}><ReceiptText className="h-4 w-4" /> Create credit note</MenuItem>}
                          {inv.customerId && <MenuItem onClick={() => onViewStatement(inv.customerId)}><ScrollText className="h-4 w-4" /> View customer statement</MenuItem>}
                          <MenuItem onClick={() => act(() => store.duplicateInvoice(inv.id), 'Invoice duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                          {inv.journalEntryId && inv.status !== 'void' && <MenuItem onClick={() => setVoidId(inv.id)}><Ban className="h-4 w-4" /> Void</MenuItem>}
                          {inv.status === 'draft' && <MenuItem onClick={() => act(() => store.deleteDraft(inv.id), 'Draft deleted.')}><Trash2 className="h-4 w-4" /> Delete draft</MenuItem>}
                        </Dropdown>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editorId && <InvoiceEditorDrawer open invoiceId={editorId} onClose={() => setEditorId(null)} />}

      {/* Preview / print modal (shared component: copy-mode toggle + live settlement) */}
      {previewId && <InvoicePreviewModal invoiceId={previewId} onClose={() => setPreviewId(null)} />}

      {/* Void modal */}
      {voidId && <VoidModal onCancel={() => setVoidId(null)} onConfirm={(reason) => { act(() => store.voidInvoice(voidId, reason), 'Invoice voided & reversed.'); setVoidId(null); }} />}

      <p className="mt-3 text-center text-[11px] text-slate-400 print:hidden">Company: {settings.companyName}</p>
    </>
  );
}

function VoidModal({ onConfirm, onCancel }: { onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">Void this invoice?</h2>
        <p className="mt-1 text-xs text-slate-500">Voiding posts a reversing journal entry and preserves the original invoice and its number.</p>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for voiding (required)" className="mt-3" autoFocus />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}><Ban className="h-4 w-4" /> Void invoice</Button>
        </div>
      </div>
    </div>
  );
}

