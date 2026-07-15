import { useEffect, useMemo, useState } from 'react';
import { Plus, ChevronDown, Eye, Printer, Ban, Copy, Pencil, Trash2, X, Banknote, ReceiptText, Send, CheckCircle2, ReceiptEuro } from 'lucide-react';
import type { BillStatus, BillType } from '@/types/bill';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useBillStore } from '@/store/billStore';
import { useBillEditor } from '@/store/billEditorStore';
import { usePaymentStore } from '@/store/paymentStore';
import { usePaymentEditor } from '@/store/paymentEditorStore';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { BILL_TYPE_LABELS, BILL_STATUS_TONE } from '@/lib/billLabels';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { BillEditorDrawer } from '@/components/bills/BillEditorDrawer';
import { BillRenderer } from '@/components/bills/BillRenderer';
import { BillSupplierCreditDialog } from '@/components/bills/BillSupplierCreditDialog';
import { BillReverseDialog } from '@/components/bills/BillReverseDialog';
import { PrintDocument } from '@/components/ui/PrintDocument';

function today(): string { return new Date().toISOString().slice(0, 10); }
function isOverdue(b: { dueDate: string; balanceDue: number; status: BillStatus }): boolean {
  return b.dueDate < today() && b.balanceDue > 0.005 && b.status !== 'paid' && b.status !== 'void' && b.status !== 'reversed' && b.status !== 'draft';
}

export function BillsPage() {
  const entities = useEntityStore((s) => s.entities);
  const bills = useBillStore((s) => s.bills);
  const store = useBillStore();
  const createDraft = useBillStore((s) => s.createDraft);
  const consumeEditorRequest = useBillEditor((s) => s.consume);
  const createPaymentForBill = usePaymentStore((s) => s.createPaymentForBill);
  const requestPaymentEditor = usePaymentEditor((s) => s.requestOpen);
  const setActiveView = useStore((s) => s.setActiveView);
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [creditId, setCreditId] = useState<string | null>(null);
  const [reverseId, setReverseId] = useState<string | null>(null);

  const [supplierFilter, setSupplierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<BillStatus | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<BillType | 'ALL'>('ALL');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => { const r = consumeEditorRequest(); if (r) setEditorId(r); }, [consumeEditorRequest]);

  const supplierName = (id: string): string => entities.find((e) => e.id === id)?.legalName ?? '—';
  const money = (n: number, cur: string): string => formatCurrency(n, cur);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bills
      .filter((b) => (supplierFilter ? b.supplierId === supplierFilter : true))
      .filter((b) => (statusFilter === 'ALL' ? true : b.status === statusFilter))
      .filter((b) => (typeFilter === 'ALL' ? true : b.billType === typeFilter))
      .filter((b) => (overdueOnly ? isOverdue(b) : true))
      .filter((b) => (q ? `${b.billNumber} ${b.supplierInvoiceNumber} ${supplierName(b.supplierId)}`.toLowerCase().includes(q) : true))
      .sort((a, b) => (a.billDate < b.billDate ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills, supplierFilter, statusFilter, typeFilter, overdueOnly, search, entities]);

  const supplierOptions = [{ value: '', label: 'All suppliers' }, ...entities.filter((e) => e.entityType === 'supplier' || e.entityType === 'both').map((e) => ({ value: e.id, label: e.legalName }))];
  const statusOptions = [{ value: 'ALL', label: 'All statuses' }, ...(['draft', 'submitted', 'approved', 'posted', 'partially-paid', 'paid', 'reversed'] as const).map((s) => ({ value: s, label: s }))];
  const typeOptions = [{ value: 'ALL', label: 'All types' }, ...(Object.keys(BILL_TYPE_LABELS) as BillType[]).map((t) => ({ value: t, label: BILL_TYPE_LABELS[t] }))];

  const onNew = (): void => { const res = createDraft({ supplierId: supplierFilter || undefined }); if (res.ok && res.id) setEditorId(res.id); };
  const act = (fn: () => { ok: boolean; error?: string }, success: string): void => { const res = fn(); if (res.ok) notify(success, 'success'); else notify(res.error ?? 'Action failed.', 'error'); };
  /** Record Payment routes to the Payments module: prefill a payment draft for this bill and open it. */
  const onRecordPayment = (billId: string): void => {
    const res = createPaymentForBill(billId);
    if (res.ok && res.id) { requestPaymentEditor(res.id); setActiveView('payments'); }
    else notify(res.error ?? 'Could not start a payment.', 'error');
  };

  const previewBill = previewId ? store.getBill(previewId) : undefined;
  const previewSnap = previewId ? store.previewSnapshot(previewId) : null;
  const previewSupplier = previewBill ? entities.find((e) => e.id === previewBill.supplierId) : undefined;
  const creditBill = creditId ? store.getBill(creditId) : undefined;

  return (
    <>
      <PageActions><Button onClick={onNew}><Plus className="h-4 w-4" /> New bill</Button></PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto max-w-[180px]" options={supplierOptions} value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} aria-label="Supplier" />
        <Select className="h-9 w-auto" options={typeOptions} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as BillType | 'ALL')} aria-label="Type" />
        <Select className="h-9 w-auto" options={statusOptions} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as BillStatus | 'ALL')} aria-label="Status" />
        <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bill, supplier invoice or supplier…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={ReceiptEuro} title="No bills yet" description="Record a supplier bill — it stays a draft until you post it, which credits Trade Payables. Pay it or raise a supplier credit afterwards." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Bill', 'Supplier inv.', 'Supplier', 'Bill date', 'Due', 'Total', 'Paid', 'Credits', 'Balance', 'Status', 'Journal', ''].map((h) => (
                <th key={h} className={cx('px-3 py-2 font-semibold', ['Total', 'Paid', 'Credits', 'Balance'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((b) => { const overdue = isOverdue(b); return (
                <tr key={b.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{b.billNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{b.supplierInvoiceNumber || '—'}</td>
                  <td className="px-3 py-2">{supplierName(b.supplierId)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{b.billDate}</td>
                  <td className={cx('px-3 py-2 text-xs', overdue ? 'font-semibold text-red-600' : 'text-slate-500')}>{b.dueDate}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(b.grandTotal, b.currency)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{money(b.amountPaid, b.currency)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{money(b.supplierCreditsApplied, b.currency)}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">{money(b.balanceDue, b.currency)}</td>
                  <td className="px-3 py-2"><Badge tone={overdue ? 'red' : BILL_STATUS_TONE[b.status]}>{overdue ? 'overdue' : b.status}</Badge></td>
                  <td className="px-3 py-2 text-xs">{b.journalEntryId ? <Badge tone="green">posted</Badge> : <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-2 text-right">
                    <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                      {(() => { const editable = ['draft', 'submitted', 'approved'].includes(b.status); return (<MenuItem onClick={() => (editable ? setEditorId(b.id) : setPreviewId(b.id))}>{editable ? <><Pencil className="h-4 w-4" /> Edit</> : <><Eye className="h-4 w-4" /> View</>}</MenuItem>); })()}
                      <MenuItem onClick={() => setPreviewId(b.id)}><Printer className="h-4 w-4" /> Preview / print</MenuItem>
                      {b.status === 'draft' && <MenuItem onClick={() => act(() => store.submitBill(b.id), 'Bill submitted.')}><Send className="h-4 w-4" /> Submit</MenuItem>}
                      {(b.status === 'draft' || b.status === 'submitted') && <MenuItem onClick={() => act(() => store.approveBill(b.id), 'Bill approved.')}><CheckCircle2 className="h-4 w-4" /> Approve</MenuItem>}
                      {['draft', 'submitted', 'approved'].includes(b.status) && <MenuItem onClick={() => act(() => store.postBill(b.id), 'Bill posted to Trade Payables.')}><Send className="h-4 w-4" /> Post</MenuItem>}
                      {['posted', 'partially-paid'].includes(b.status) && <MenuItem onClick={() => onRecordPayment(b.id)}><Banknote className="h-4 w-4" /> Record payment</MenuItem>}
                      {['posted', 'partially-paid'].includes(b.status) && <MenuItem onClick={() => setCreditId(b.id)}><ReceiptText className="h-4 w-4" /> Create supplier credit</MenuItem>}
                      <MenuItem onClick={() => act(() => store.duplicateBill(b.id), 'Bill duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                      {b.journalEntryId && b.status !== 'reversed' && <MenuItem onClick={() => setReverseId(b.id)}><Ban className="h-4 w-4" /> Reverse</MenuItem>}
                      {b.status === 'draft' && <MenuItem onClick={() => act(() => store.deleteDraft(b.id), 'Draft deleted.')}><Trash2 className="h-4 w-4" /> Delete draft</MenuItem>}
                    </Dropdown>
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div></Card>
      )}

      {editorId && <BillEditorDrawer open billId={editorId} onClose={() => setEditorId(null)} />}

      {previewId && previewBill && previewSnap && (
        <>
          <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/50 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900"><div className="text-sm font-medium">{previewSnap.templateName} · <span className="text-slate-500">{previewBill.status}</span></div><div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button><button onClick={() => setPreviewId(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button></div></div>
            <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><BillRenderer bill={previewBill} snapshot={previewSnap} supplierName={supplierName(previewBill.supplierId)} supplierAddress={[previewSupplier?.addressLine1, previewSupplier?.city, previewSupplier?.country].filter(Boolean).join(', ')} supplierTaxNumber={previewSupplier?.taxRegistrationNumber} /></div></div>
          </div>
          <PrintDocument><BillRenderer bill={previewBill} snapshot={previewSnap} supplierName={supplierName(previewBill.supplierId)} supplierAddress={[previewSupplier?.addressLine1, previewSupplier?.city, previewSupplier?.country].filter(Boolean).join(', ')} supplierTaxNumber={previewSupplier?.taxRegistrationNumber} /></PrintDocument>
        </>
      )}

      {creditId && creditBill && <BillSupplierCreditDialog bill={creditBill} onClose={() => setCreditId(null)} />}
      {reverseId && <BillReverseDialog onCancel={() => setReverseId(null)} onConfirm={(reason) => { act(() => store.reverseBill(reverseId, reason), 'Bill reversed.'); setReverseId(null); }} />}
    </>
  );
}
