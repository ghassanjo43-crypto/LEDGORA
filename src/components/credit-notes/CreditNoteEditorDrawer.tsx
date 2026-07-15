import { useMemo, useState } from 'react';
import { Plus, Trash2, Send, Save, Eye, X, Printer, CheckCircle2, Info, Replace } from 'lucide-react';
import type { CreditNote, CreditNoteLine, CreditNoteReasonCode, CreditType } from '@/types/creditNote';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { calculateCreditNoteLine, calculateCreditNoteTotals } from '@/lib/creditNoteCalculations';
import { calculateInvoiceCreditSummary, calculateRemainingCreditableQuantity, makeEmptyCreditLine } from '@/lib/creditNoteCreditable';
import { CREDIT_NOTE_REASON_LABELS, CREDIT_TYPE_LABELS } from '@/lib/creditNoteLabels';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { CostCenterLineControl } from '@/components/cost-centers/CostCenterLineControl';
import { ProjectPicker } from '@/components/projects/ProjectPicker';
import { useProjectStore } from '@/store/projectStore';
import { useHasModule } from '@/store/entitlementHooks';
import { CreditNoteReturnControl } from '@/components/inventory/CreditNoteReturnControl';
import { PrintDocument } from '@/components/ui/PrintDocument';
import { CreditNoteRenderer } from './CreditNoteRenderer';

interface Props {
  open: boolean;
  creditNoteId: string | null;
  onClose: () => void;
  /** Called after "Correct & replace" voids this note and creates a replacement draft. */
  onReplace?: (newCreditNoteId: string) => void;
}

const REASON_OPTIONS = (Object.keys(CREDIT_NOTE_REASON_LABELS) as CreditNoteReasonCode[]).map((k) => ({ value: k, label: CREDIT_NOTE_REASON_LABELS[k] }));
const TYPE_OPTIONS = (Object.keys(CREDIT_TYPE_LABELS) as CreditType[]).map((k) => ({ value: k, label: CREDIT_TYPE_LABELS[k] }));

export function CreditNoteEditorDrawer({ open, creditNoteId, onClose, onReplace }: Props) {
  const accounts = useStore((s) => s.accounts);
  const projects = useProjectStore((s) => s.projects);
  const showCostCenter = useHasModule('cost_centers');
  const showProject = useHasModule('projects');
  const showInventory = useHasModule('inventory_basic');
  const showDimensions = showCostCenter || showProject || showInventory;
  const entities = useEntityStore((s) => s.entities);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes);
  const cn = useCreditNoteStore((s) => (creditNoteId ? s.creditNotes.find((c) => c.id === creditNoteId) : undefined));
  const updateCreditNote = useCreditNoteStore((s) => s.updateCreditNote);
  const approveCreditNote = useCreditNoteStore((s) => s.approveCreditNote);
  const issueCreditNote = useCreditNoteStore((s) => s.issueCreditNote);
  const correctCreditNote = useCreditNoteStore((s) => s.correctCreditNote);
  const previewSnapshot = useCreditNoteStore((s) => s.previewSnapshot);
  const templates = useInvoiceTemplateStore();
  const invoice = useInvoiceStore((s) => (cn?.originalInvoiceId ? s.invoices.find((i) => i.id === cn.originalInvoiceId) : undefined));
  const { notify } = useToast();
  const [showPreview, setShowPreview] = useState(false);

  const [lines, setLines] = useState<CreditNoteLine[]>(cn?.lines ?? []);
  const [issueDate, setIssueDate] = useState(cn?.issueDate ?? '');
  const [reasonCode, setReasonCode] = useState<CreditNoteReasonCode>(cn?.reasonCode ?? 'goods-returned');
  const [reasonDescription, setReasonDescription] = useState(cn?.reasonDescription ?? '');
  const [creditType, setCreditType] = useState<CreditType>(cn?.creditType ?? 'selected-lines');
  const [notes, setNotes] = useState(cn?.notes ?? '');
  const [overrideVersionId, setOverrideVersionId] = useState('');

  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (cn && cn.id !== loadedId) {
    setLoadedId(cn.id);
    setLines(cn.lines.length ? cn.lines : [makeEmptyCreditLine(cn.id, 1)]);
    setIssueDate(cn.issueDate);
    setReasonCode(cn.reasonCode);
    setReasonDescription(cn.reasonDescription);
    setCreditType(cn.creditType);
    setNotes(cn.notes ?? '');
    setOverrideVersionId(cn.templateResolutionSource === 'invoice-override' ? cn.templateVersionId : '');
  }

  const currency = cn?.currency ?? 'USD';
  const money = (n: number): string => formatCurrency(n, currency);
  const customerName = entities.find((e) => e.id === cn?.customerId)?.legalName ?? '—';
  const totals = useMemo(() => calculateCreditNoteTotals(lines), [lines]);

  const summary = useMemo(
    () => (invoice ? calculateInvoiceCreditSummary(invoice, creditNotes, cn?.id) : null),
    [invoice, creditNotes, cn?.id],
  );
  const remainingQtyByLine = useMemo(() => {
    const map = new Map<string, number>();
    if (invoice && cn) for (const l of invoice.lines) map.set(l.id, calculateRemainingCreditableQuantity(l, creditNotes, invoice.id, cn.id));
    return map;
  }, [invoice, creditNotes, cn]);

  const versionOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Inherit from invoice' }];
    for (const t of templates.templates.filter((x) => !x.isArchived)) {
      for (const v of templates.versions.filter((x) => x.templateId === t.id && x.status === 'published').sort((a, b) => b.versionNumber - a.versionNumber)) {
        opts.push({ value: v.id, label: `${t.name} — v${v.versionNumber}` });
      }
    }
    return opts;
  }, [templates.templates, templates.versions]);

  if (!cn) return null;
  // Drafts and approved-but-not-yet-issued notes stay editable and postable.
  const readOnly = cn.status !== 'draft' && cn.status !== 'approved';

  const setLine = (id: string, patch: Partial<CreditNoteLine>): void => setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = (): void => setLines((prev) => [...prev, makeEmptyCreditLine(cn.id, prev.length + 1)]);
  const removeLine = (id: string): void => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));

  const collect = (): Partial<CreditNote> => {
    const base: Partial<CreditNote> = { issueDate, reasonCode, reasonDescription, creditType, notes, lines };
    if (overrideVersionId) {
      const v = templates.getVersion(overrideVersionId);
      if (v) { base.templateId = v.templateId; base.templateVersionId = v.id; base.templateResolutionSource = 'invoice-override'; }
    }
    return base;
  };

  const persist = (): boolean => {
    if (!creditNoteId) return false;
    const res = updateCreditNote(creditNoteId, collect());
    if (!res.ok) { notify(res.error ?? 'Could not save the credit note.', 'error'); return false; }
    return true;
  };

  const onSaveDraft = (): void => { if (persist()) { notify('Credit note draft saved.', 'success'); onClose(); } };
  const onApprove = (): void => { if (!persist()) return; const r = approveCreditNote(creditNoteId!); if (r.ok) notify('Credit note approved.', 'success'); else notify(r.error ?? 'Could not approve.', 'error'); };
  const onIssue = (): void => {
    if (!persist()) return;
    const res = issueCreditNote(creditNoteId!);
    if (res.ok) { notify(`Credit note ${cn.creditNoteNumber} issued and posted.`, 'success'); onClose(); }
    else notify(res.error ?? 'Could not issue the credit note.', 'error');
  };
  const onPreview = (): void => { if (persist()) setShowPreview(true); };
  const onCorrect = (): void => {
    const res = correctCreditNote(creditNoteId!);
    if (res.ok && res.id) { notify(`${cn.creditNoteNumber} voided — editing the replacement draft.`, 'success'); onReplace?.(res.id); }
    else notify(res.error ?? 'Could not correct the credit note.', 'error');
  };

  const remainingAfter = summary ? Math.max(0, Math.round((summary.availableToCredit - totals.grandTotal) * 100) / 100) : null;
  const invoiceBalanceAfter = invoice ? Math.max(0, Math.round((invoice.balanceDue - Math.min(totals.grandTotal, invoice.balanceDue)) * 100) / 100) : null;
  const snap = showPreview && creditNoteId ? previewSnapshot(creditNoteId) : null;
  const previewCn = showPreview && creditNoteId ? useCreditNoteStore.getState().getCreditNoteById(creditNoteId) : undefined;
  const previewReference = showPreview && creditNoteId ? useCreditNoteStore.getState().invoiceReference(creditNoteId) : null;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        widthClassName="max-w-5xl"
        title={`Credit note ${cn.creditNoteNumber}`}
        description={readOnly ? `${cn.status} — read only` : cn.status === 'approved' ? 'Approved — edit or issue & post to the ledger' : 'Draft — edit, then issue to post the credit to the ledger'}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <div className="text-sm">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total credit</span>
              <span className="ml-2 font-mono text-base font-bold">{money(totals.grandTotal)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onClose}>Close</Button>
              {!readOnly && <Button variant="ghost" size="sm" onClick={onPreview}><Eye className="h-4 w-4" /> Preview</Button>}
              {!readOnly && <Button variant="secondary" onClick={onSaveDraft}><Save className="h-4 w-4" /> Save</Button>}
              {cn.status === 'draft' && <Button variant="secondary" onClick={onApprove}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}
              {readOnly && cn.journalEntryId && cn.status !== 'void' && <Button variant="secondary" onClick={onCorrect}><Replace className="h-4 w-4" /> Correct &amp; replace</Button>}
              {!readOnly && <Button onClick={onIssue}><Send className="h-4 w-4" /> Issue &amp; post</Button>}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {/* Header */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Customer (locked)"><Input value={customerName} disabled readOnly /></Field>
            <Field label="Original invoice"><Input value={cn.originalInvoiceNumber ?? '—'} disabled readOnly /></Field>
            <Field label="Currency (locked)"><Input value={currency} disabled readOnly /></Field>
            <Field label="Issue date" required><Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} disabled={readOnly} /></Field>
            <Field label="Credit type"><Select options={TYPE_OPTIONS} value={creditType} onChange={(e) => setCreditType(e.target.value as CreditType)} disabled={readOnly} /></Field>
            <Field label="Credit-note format"><Select options={versionOptions} value={overrideVersionId} onChange={(e) => setOverrideVersionId(e.target.value)} disabled={readOnly} /></Field>
            <Field label="Reason" required><Select options={REASON_OPTIONS} value={reasonCode} onChange={(e) => setReasonCode(e.target.value as CreditNoteReasonCode)} disabled={readOnly} /></Field>
            <Field label={reasonCode === 'other' ? 'Reason description (required)' : 'Reason description'} className="sm:col-span-2">
              <Input value={reasonDescription} onChange={(e) => setReasonDescription(e.target.value)} disabled={readOnly} placeholder="Explain the reason for this credit" />
            </Field>
          </section>

          {/* Creditable summary */}
          {summary && (
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-800/40 sm:grid-cols-3 lg:grid-cols-6">
              <SummaryStat label="Original total" value={money(summary.originalTotal)} />
              <SummaryStat label="Previous credits" value={money(summary.previouslyCredited)} />
              <SummaryStat label="Available to credit" value={money(summary.availableToCredit)} strong />
              <SummaryStat label="This credit note" value={money(totals.grandTotal)} strong />
              <SummaryStat label="Remaining after" value={remainingAfter !== null ? money(remainingAfter) : '—'} />
              <SummaryStat label="Invoice balance after" value={invoiceBalanceAfter !== null ? money(invoiceBalanceAfter) : '—'} />
            </div>
          )}

          {/* Line items */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Credited lines</h3>
              {!readOnly && <Button type="button" variant="outline" size="sm" onClick={addLine}><Plus className="h-4 w-4" /> Add line</Button>}
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                  <tr>
                    <th className="px-2 py-2 text-left">Revenue account</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-right">Avail. qty</th>
                    <th className="px-2 py-2 text-right">Credit qty</th>
                    <th className="px-2 py-2 text-right">Unit price</th>
                    <th className="px-2 py-2 text-right">Disc %</th>
                    <th className="px-2 py-2 text-right">Tax %</th>
                    <th className="px-2 py-2 text-right">Credit total</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {lines.map((line) => {
                    const c = calculateCreditNoteLine(line);
                    const avail = line.originalInvoiceLineId ? remainingQtyByLine.get(line.originalInvoiceLineId) : undefined;
                    const over = avail !== undefined && Number(line.quantity) > avail + 0.0001;
                    return (
                      <tr key={line.id}>
                        <td className="px-2 py-1.5 min-w-[12rem]"><AccountSelect value={line.revenueAccountId} accounts={accounts} onChange={(a) => setLine(line.id, { revenueAccountId: a.id })} disabled={readOnly} /></td>
                        <td className="px-2 py-1.5 min-w-[10rem]"><Input value={line.description} onChange={(e) => setLine(line.id, { description: e.target.value })} disabled={readOnly} className="h-8" placeholder="Description" /></td>
                        <td className="px-2 py-1.5 text-right text-slate-400">{avail !== undefined ? avail : '—'}</td>
                        <td className="px-2 py-1.5 w-20"><Input type="number" step="0.01" value={line.quantity} onChange={(e) => setLine(line.id, { quantity: Number(e.target.value) })} disabled={readOnly} className={cx('h-8 text-right', over && 'border-red-400 text-red-600')} /></td>
                        <td className="px-2 py-1.5 w-24"><Input type="number" step="0.01" value={line.unitPrice} onChange={(e) => setLine(line.id, { unitPrice: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                        <td className="px-2 py-1.5 w-20"><Input type="number" step="0.01" value={line.discountValue ?? 0} onChange={(e) => setLine(line.id, { discountType: 'percentage', discountValue: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                        <td className="px-2 py-1.5 w-20"><Input type="number" step="0.01" value={line.taxRate} onChange={(e) => setLine(line.id, { taxRate: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(c.lineTotal)}</td>
                        <td className="px-2 py-1.5">{!readOnly && <button type="button" onClick={() => removeLine(line.id)} className="text-slate-400 hover:text-red-600" aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>}</td>
                      </tr>
                    );
                  }).flatMap((row, i) => showDimensions ? [row, (
                    <tr key={`${lines[i]!.id}-cc`}>
                      <td colSpan={9} className="px-2 pb-2">
                        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                          {showCostCenter && <CostCenterLineControl amount={calculateCreditNoteLine(lines[i]!).taxableAmount} costCenterId={lines[i]!.costCenterId} assignments={lines[i]!.costCenterAssignments} postingDate={issueDate} currency={currency} disabled={readOnly} onChange={(patch) => setLine(lines[i]!.id, patch)} />}
                          {showProject && <div className="flex items-center gap-2"><span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Project</span><div className="w-52"><ProjectPicker value={lines[i]!.projectId ?? ''} projects={projects} postingDate={issueDate} disabled={readOnly} onChange={(id) => setLine(lines[i]!.id, { projectId: id || undefined })} /></div></div>}
                          {showInventory && <CreditNoteReturnControl line={lines[i]!} originalInvoiceId={cn.originalInvoiceId} disabled={readOnly} onChange={(patch) => setLine(lines[i]!.id, patch)} />}
                        </div>
                      </td>
                    </tr>
                  )] : [row])}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 dark:border-slate-700">
                    <td colSpan={7} className="px-2 py-1.5 text-right text-slate-500">Subtotal · Tax · Total credit</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(totals.subtotal)} · {money(totals.taxTotal)} · {money(totals.grandTotal)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={readOnly} placeholder="Optional notes shown on the credit note" /></Field>

          {readOnly ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              This credit note is {cn.status}. Issued credit notes are immutable — void it and create a replacement to make changes.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
              Issuing posts a balanced entry (Dr sales returns + Dr tax, Cr receivables) and, by default, applies the credit to the original invoice when it still has a balance.
            </p>
          )}
        </div>
      </Drawer>

      {showPreview && snap && previewCn && (
        <>
          <div className="fixed inset-0 z-[60] flex flex-col bg-slate-900/50 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
              <div className="text-sm font-medium">{snap.templateName} — v{snap.versionNumber}</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
                <button onClick={() => setShowPreview(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><CreditNoteRenderer creditNote={previewCn} snapshot={snap} reference={previewReference} /></div></div>
          </div>
          <PrintDocument><CreditNoteRenderer creditNote={previewCn} snapshot={snap} reference={previewReference} /></PrintDocument>
        </>
      )}
    </>
  );
}

function SummaryStat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cx('font-mono', strong ? 'text-sm font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{value}</p>
    </div>
  );
}
