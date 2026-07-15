import { useEffect, useMemo, useState } from 'react';
import { Plus, ChevronDown, Eye, Printer, Ban, Copy, Pencil, Trash2, X, Banknote, Link2, Send, CheckCircle2 } from 'lucide-react';
import type { PaymentStatus, PaymentType } from '@/types/payment';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { usePaymentStore } from '@/store/paymentStore';
import { usePaymentEditor } from '@/store/paymentEditorStore';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { PAYMENT_TYPE_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_TONE } from '@/lib/paymentLabels';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { PaymentEditorDrawer } from '@/components/payments/PaymentEditorDrawer';
import { PaymentRenderer } from '@/components/payments/PaymentRenderer';
import { PaymentApplyDialog } from '@/components/payments/PaymentApplyDialog';
import { PaymentReverseDialog } from '@/components/payments/PaymentReverseDialog';

export function PaymentsPage() {
  const accounts = useStore((s) => s.accounts);
  const entities = useEntityStore((s) => s.entities);
  const payments = usePaymentStore((s) => s.payments);
  const store = usePaymentStore();
  const createDraft = usePaymentStore((s) => s.createDraft);
  const consumeEditorRequest = usePaymentEditor((s) => s.consume);
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [applyId, setApplyId] = useState<string | null>(null);
  const [reverseId, setReverseId] = useState<string | null>(null);

  const [supplierFilter, setSupplierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<PaymentType | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => { const r = consumeEditorRequest(); if (r) setEditorId(r); }, [consumeEditorRequest]);

  const partyName = (id: string | undefined): string => (id ? entities.find((e) => e.id === id)?.legalName ?? '—' : '—');
  const accName = (id: string | undefined): string => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : ''; };
  const money = (n: number, cur: string): string => formatCurrency(n, cur);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payments
      .filter((p) => (supplierFilter ? p.supplierId === supplierFilter : true))
      .filter((p) => (statusFilter === 'ALL' ? true : p.status === statusFilter))
      .filter((p) => (typeFilter === 'ALL' ? true : p.paymentType === typeFilter))
      .filter((p) => (q ? `${p.paymentNumber} ${partyName(p.supplierId)} ${partyName(p.customerId)} ${p.payeeName ?? ''} ${p.transactionReference ?? ''}`.toLowerCase().includes(q) : true))
      .sort((a, b) => (a.paymentDate < b.paymentDate ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, supplierFilter, statusFilter, typeFilter, search, entities]);

  const supplierOptions = [{ value: '', label: 'All suppliers' }, ...entities.filter((e) => e.entityType === 'supplier' || e.entityType === 'both').map((e) => ({ value: e.id, label: e.legalName }))];
  const statusOptions = [{ value: 'ALL', label: 'All statuses' }, ...(['draft', 'submitted', 'approved', 'posted', 'partially-allocated', 'fully-allocated', 'reversed'] as const).map((s) => ({ value: s, label: s }))];
  const typeOptions = [{ value: 'ALL', label: 'All types' }, ...(Object.keys(PAYMENT_TYPE_LABELS) as PaymentType[]).map((t) => ({ value: t, label: PAYMENT_TYPE_LABELS[t] }))];

  const onNew = (): void => { const res = createDraft({ supplierId: supplierFilter || undefined }); if (res.ok && res.id) setEditorId(res.id); };
  const act = (fn: () => { ok: boolean; error?: string }, success: string): void => { const res = fn(); if (res.ok) notify(success, 'success'); else notify(res.error ?? 'Action failed.', 'error'); };

  const previewPayment = previewId ? store.getPayment(previewId) : undefined;
  const previewSnap = previewId ? store.previewSnapshot(previewId) : null;
  const applyPayment = applyId ? store.getPayment(applyId) : undefined;

  const payeeLabel = (p: (typeof rows)[number]): string => p.supplierId ? partyName(p.supplierId) : p.customerId ? partyName(p.customerId) : p.payeeName || '—';

  return (
    <>
      <PageActions>
        <Button onClick={onNew}><Plus className="h-4 w-4" /> New payment</Button>
      </PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto max-w-[180px]" options={supplierOptions} value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} aria-label="Supplier" />
        <Select className="h-9 w-auto" options={typeOptions} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as PaymentType | 'ALL')} aria-label="Type" />
        <Select className="h-9 w-auto" options={statusOptions} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PaymentStatus | 'ALL')} aria-label="Status" />
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, payee or reference…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={Banknote} title="No payments yet" description="Record money paid out — a payment stays a draft until you post it, which posts one balanced bank journal and settles the allocated bills." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
                <tr>
                  {['Payment', 'Date', 'Payee', 'Type', 'Method', 'Gross', 'Net cash', 'Allocated', 'Unapplied', 'Status', 'Journal', 'Account', ''].map((h) => (
                    <th key={h} className={cx('px-3 py-2 font-semibold', ['Gross', 'Net cash', 'Allocated', 'Unapplied'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{p.paymentNumber}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{p.paymentDate}</td>
                    <td className="px-3 py-2">{payeeLabel(p)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{PAYMENT_TYPE_LABELS[p.paymentType]}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{PAYMENT_METHOD_LABELS[p.method]}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(p.grossAmount, p.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(p.netCashAmount, p.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(p.allocationTotal, p.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{money(p.unappliedAmount, p.currency)}</td>
                    <td className="px-3 py-2"><Badge tone={PAYMENT_STATUS_TONE[p.status]}>{p.status}</Badge></td>
                    <td className="px-3 py-2 text-xs">{p.journalEntryId ? <Badge tone="green">posted</Badge> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{accName(p.bankAccountId || p.cashAccountId)}</td>
                    <td className="px-3 py-2 text-right">
                      <Dropdown label="Actions" align="right" trigger={(o) => (
                        <span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>
                      )}>
                        {(() => { const editable = ['draft', 'submitted', 'approved'].includes(p.status); return (
                          <MenuItem onClick={() => (editable ? setEditorId(p.id) : setPreviewId(p.id))}>{editable ? <><Pencil className="h-4 w-4" /> Edit</> : <><Eye className="h-4 w-4" /> View</>}</MenuItem>
                        ); })()}
                        <MenuItem onClick={() => setPreviewId(p.id)}><Printer className="h-4 w-4" /> Preview / print</MenuItem>
                        {p.status === 'draft' && <MenuItem onClick={() => act(() => store.submitPayment(p.id), 'Payment submitted.')}><Send className="h-4 w-4" /> Submit</MenuItem>}
                        {(p.status === 'draft' || p.status === 'submitted') && <MenuItem onClick={() => act(() => store.approvePayment(p.id), 'Payment approved.')}><CheckCircle2 className="h-4 w-4" /> Approve</MenuItem>}
                        {['draft', 'submitted', 'approved'].includes(p.status) && <MenuItem onClick={() => act(() => store.postPayment(p.id), 'Payment posted.')}><Send className="h-4 w-4" /> Post</MenuItem>}
                        {['posted', 'partially-allocated'].includes(p.status) && p.unappliedAmount > 0.005 && p.supplierId && <MenuItem onClick={() => setApplyId(p.id)}><Link2 className="h-4 w-4" /> Apply payment</MenuItem>}
                        <MenuItem onClick={() => act(() => store.duplicatePayment(p.id), 'Payment duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                        {p.journalEntryId && p.status !== 'reversed' && <MenuItem onClick={() => setReverseId(p.id)}><Ban className="h-4 w-4" /> Reverse</MenuItem>}
                        {p.status === 'draft' && <MenuItem onClick={() => act(() => store.deleteDraft(p.id), 'Draft deleted.')}><Trash2 className="h-4 w-4" /> Delete draft</MenuItem>}
                      </Dropdown>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editorId && <PaymentEditorDrawer open paymentId={editorId} onClose={() => setEditorId(null)} />}

      {previewId && previewPayment && previewSnap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/50 backdrop-blur-sm print:static print:bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 print:hidden dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-medium">{previewSnap.templateName} — v{previewSnap.versionNumber} · <span className="text-slate-500">{previewPayment.status}</span></div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
              <button onClick={() => setPreviewId(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6 print:overflow-visible print:p-0"><div className="mx-auto shadow-xl print:shadow-none"><PaymentRenderer payment={previewPayment} snapshot={previewSnap} accountName={accName} /></div></div>
        </div>
      )}

      {applyId && applyPayment && <PaymentApplyDialog payment={applyPayment} onClose={() => setApplyId(null)} />}
      {reverseId && <PaymentReverseDialog onCancel={() => setReverseId(null)} onConfirm={(reason) => { act(() => store.reversePayment(reverseId, reason), 'Payment reversed.'); setReverseId(null); }} />}
    </>
  );
}
