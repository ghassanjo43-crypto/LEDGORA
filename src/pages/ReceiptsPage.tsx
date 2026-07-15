import { useEffect, useMemo, useState } from 'react';
import { Plus, ChevronDown, Eye, Printer, Ban, Copy, Pencil, Trash2, X, Banknote, Link2, Send } from 'lucide-react';
import type { ReceiptStatus, ReceiptType } from '@/types/receipt';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useReceiptEditor } from '@/store/receiptEditorStore';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { RECEIPT_TYPE_LABELS, RECEIPT_METHOD_LABELS, RECEIPT_STATUS_TONE } from '@/lib/receiptLabels';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { ReceiptEditorDrawer } from '@/components/receipts/ReceiptEditorDrawer';
import { ReceiptRenderer } from '@/components/receipts/ReceiptRenderer';
import { ReceiptApplyDialog } from '@/components/receipts/ReceiptApplyDialog';
import { ReceiptReverseDialog } from '@/components/receipts/ReceiptReverseDialog';

export function ReceiptsPage() {
  const accounts = useStore((s) => s.accounts);
  const entities = useEntityStore((s) => s.entities);
  const receipts = useReceiptStore((s) => s.receipts);
  const store = useReceiptStore();
  const createDraft = useReceiptStore((s) => s.createDraft);
  const consumeEditorRequest = useReceiptEditor((s) => s.consume);
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [applyId, setApplyId] = useState<string | null>(null);
  const [reverseId, setReverseId] = useState<string | null>(null);

  const [customerFilter, setCustomerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReceiptStatus | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<ReceiptType | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const requested = consumeEditorRequest();
    if (requested) setEditorId(requested);
  }, [consumeEditorRequest]);

  const partyName = (id: string | undefined): string => (id ? entities.find((e) => e.id === id)?.legalName ?? '—' : '—');
  const accName = (id: string | undefined): string => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : ''; };
  const money = (n: number, cur: string): string => formatCurrency(n, cur);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return receipts
      .filter((r) => (customerFilter ? r.customerId === customerFilter : true))
      .filter((r) => (statusFilter === 'ALL' ? true : r.status === statusFilter))
      .filter((r) => (typeFilter === 'ALL' ? true : r.receiptType === typeFilter))
      .filter((r) => (q ? `${r.receiptNumber} ${partyName(r.customerId)} ${r.payerName ?? ''} ${r.transactionReference ?? ''}`.toLowerCase().includes(q) : true))
      .sort((a, b) => (a.receiptDate < b.receiptDate ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipts, customerFilter, statusFilter, typeFilter, search, entities]);

  const customerOptions = [{ value: '', label: 'All customers' }, ...entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both').map((e) => ({ value: e.id, label: e.legalName }))];
  const statusOptions = [{ value: 'ALL', label: 'All statuses' }, ...(['draft', 'approved', 'posted', 'partially-allocated', 'fully-allocated', 'reversed'] as const).map((s) => ({ value: s, label: s }))];
  const typeOptions = [{ value: 'ALL', label: 'All types' }, ...(Object.keys(RECEIPT_TYPE_LABELS) as ReceiptType[]).map((t) => ({ value: t, label: RECEIPT_TYPE_LABELS[t] }))];

  const onNew = (): void => {
    const res = createDraft({ customerId: customerFilter || undefined });
    if (res.ok && res.id) setEditorId(res.id);
  };
  const act = (fn: () => { ok: boolean; error?: string }, success: string): void => {
    const res = fn();
    if (res.ok) notify(success, 'success'); else notify(res.error ?? 'Action failed.', 'error');
  };

  const previewReceipt = previewId ? store.getReceiptById(previewId) : undefined;
  const previewSnap = previewId ? store.previewSnapshot(previewId) : null;
  const applyReceipt = applyId ? store.getReceiptById(applyId) : undefined;

  return (
    <>
      <PageActions>
        <Button onClick={onNew}><Plus className="h-4 w-4" /> New receipt</Button>
      </PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto max-w-[180px]" options={customerOptions} value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} aria-label="Customer" />
        <Select className="h-9 w-auto" options={typeOptions} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ReceiptType | 'ALL')} aria-label="Type" />
        <Select className="h-9 w-auto" options={statusOptions} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ReceiptStatus | 'ALL')} aria-label="Status" />
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, payer or reference…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={Banknote} title="No receipts yet" description="Record money received — a receipt stays a draft until you post it, which posts the cash journal and settles the allocated invoices." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
                <tr>
                  {['Receipt', 'Date', 'Payer', 'Type', 'Method', 'Amount', 'Allocated', 'Unapplied', 'Status', 'Journal', 'Account', ''].map((h) => (
                    <th key={h} className={cx('px-3 py-2 font-semibold', ['Amount', 'Allocated', 'Unapplied'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{r.receiptNumber}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.receiptDate}</td>
                    <td className="px-3 py-2">{r.customerId ? partyName(r.customerId) : r.payerName || '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{RECEIPT_TYPE_LABELS[r.receiptType]}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{RECEIPT_METHOD_LABELS[r.method]}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.amount, r.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">{money(r.allocationTotal, r.currency)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{money(r.unappliedAmount, r.currency)}</td>
                    <td className="px-3 py-2"><Badge tone={RECEIPT_STATUS_TONE[r.status]}>{r.status}</Badge></td>
                    <td className="px-3 py-2 text-xs">{r.journalEntryId ? <Badge tone="green">posted</Badge> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{accName(r.bankAccountId || r.cashAccountId)}</td>
                    <td className="px-3 py-2 text-right">
                      <Dropdown label="Actions" align="right" trigger={(o) => (
                        <span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>
                      )}>
                        {(() => { const editable = r.status === 'draft' || r.status === 'approved'; return (
                          <MenuItem onClick={() => (editable ? setEditorId(r.id) : setPreviewId(r.id))}>{editable ? <><Pencil className="h-4 w-4" /> {r.status === 'approved' ? 'Edit' : 'Edit draft'}</> : <><Eye className="h-4 w-4" /> View</>}</MenuItem>
                        ); })()}
                        <MenuItem onClick={() => setPreviewId(r.id)}><Printer className="h-4 w-4" /> Preview / print</MenuItem>
                        {(r.status === 'draft' || r.status === 'approved') && <MenuItem onClick={() => act(() => store.postReceipt(r.id), 'Receipt posted.')}><Send className="h-4 w-4" /> Post</MenuItem>}
                        {['posted', 'partially-allocated'].includes(r.status) && r.unappliedAmount > 0.005 && r.customerId && <MenuItem onClick={() => setApplyId(r.id)}><Link2 className="h-4 w-4" /> Apply receipt</MenuItem>}
                        <MenuItem onClick={() => act(() => store.duplicateReceipt(r.id), 'Receipt duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                        {r.journalEntryId && r.status !== 'reversed' && <MenuItem onClick={() => setReverseId(r.id)}><Ban className="h-4 w-4" /> Reverse</MenuItem>}
                        {r.status === 'draft' && <MenuItem onClick={() => act(() => store.deleteDraft(r.id), 'Draft deleted.')}><Trash2 className="h-4 w-4" /> Delete draft</MenuItem>}
                      </Dropdown>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editorId && <ReceiptEditorDrawer open receiptId={editorId} onClose={() => setEditorId(null)} />}

      {previewId && previewReceipt && previewSnap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/50 backdrop-blur-sm print:static print:bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 print:hidden dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-medium">{previewSnap.templateName} — v{previewSnap.versionNumber} · <span className="text-slate-500">{previewReceipt.status}</span></div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
              <button onClick={() => setPreviewId(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6 print:overflow-visible print:p-0"><div className="mx-auto shadow-xl print:shadow-none"><ReceiptRenderer receipt={previewReceipt} snapshot={previewSnap} accountName={accName} /></div></div>
        </div>
      )}

      {applyId && applyReceipt && <ReceiptApplyDialog receipt={applyReceipt} onClose={() => setApplyId(null)} />}
      {reverseId && <ReceiptReverseDialog onCancel={() => setReverseId(null)} onConfirm={(reason) => { act(() => store.reverseReceipt(reverseId, reason), 'Receipt reversed.'); setReverseId(null); }} />}
    </>
  );
}
