import { useMemo, useState } from 'react';
import { Plus, Trash2, Send, Save, Info, Eye, Palette, LayoutTemplate, Wand2 } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import type { Invoice, InvoiceLine } from '@/types/invoice';
import { useStore } from '@/store/useStore';
import { useEntityStore, entityToFormValues } from '@/store/useEntityStore';
import { useInvoiceStore, makeEmptyInvoiceLine } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useCreditNoteEditor } from '@/store/creditNoteEditorStore';
import { useReceiptEditor } from '@/store/receiptEditorStore';
import { CREDIT_NOTE_STATUS_TONE, CREDIT_NOTE_REASON_LABELS } from '@/lib/creditNoteLabels';
import { RECEIPT_STATUS_TONE, RECEIPT_METHOD_LABELS } from '@/lib/receiptLabels';
import { buildInvoiceSettlementSummary, creditNoteAppliedToInvoice, receiptAppliedToInvoice, creditNotesForInvoice, receiptsForInvoice } from '@/lib/invoiceSettlement';
import { Badge } from '@/components/ui/Badge';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from '@/store/invoiceTemplateStore';
import { useInvoiceTemplateEditor } from '@/store/invoiceTemplateEditorStore';
import { InvoicePreviewModal } from '@/components/invoices/InvoicePreviewModal';
import { calculateInvoiceLine, calculateInvoiceTotals } from '@/lib/invoiceCalculations';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { CostCenterLineControl } from '@/components/cost-centers/CostCenterLineControl';
import { ProjectPicker } from '@/components/projects/ProjectPicker';
import { useProjectStore } from '@/store/projectStore';
import { useHasModule } from '@/store/entitlementHooks';
import { InventoryLineControl } from '@/components/inventory/InventoryLineControl';

interface Props {
  open: boolean;
  invoiceId: string | null;
  onClose: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  'invoice-override': 'Manual override for this invoice',
  'customer-preference': 'Customer preference',
  'entity-default': 'Entity default',
  'system-default': 'System default',
};

export function InvoiceEditorDrawer({ open, invoiceId, onClose }: Props) {
  const accounts = useStore((s) => s.accounts);
  const projects = useProjectStore((s) => s.projects);
  const showCostCenter = useHasModule('cost_centers');
  const showProject = useHasModule('projects');
  const showInventory = useHasModule('inventory_basic');
  const showDimensions = showCostCenter || showProject || showInventory;
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const invoice = useInvoiceStore((s) => (invoiceId ? s.invoices.find((i) => i.id === invoiceId) : undefined));
  const updateDraft = useInvoiceStore((s) => s.updateDraft);
  const issueInvoice = useInvoiceStore((s) => s.issueInvoice);
  const templates = useInvoiceTemplateStore();
  const templateEditor = useInvoiceTemplateEditor();
  const { notify } = useToast();
  const [showPreview, setShowPreview] = useState(false);

  const customers = useMemo(() => entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both'), [entities]);

  // Local editable copy of the draft.
  const [lines, setLines] = useState<InvoiceLine[]>(invoice?.lines ?? [makeEmptyInvoiceLine(1)]);
  const [customerId, setCustomerId] = useState(invoice?.customerId ?? '');
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? '');
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? '');
  const [poRef, setPoRef] = useState(invoice?.purchaseOrderReference ?? '');
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [overrideVersionId, setOverrideVersionId] = useState('');
  const [saveAsCustomerDefault, setSaveAsCustomerDefault] = useState(false);

  // Re-sync local state when a different invoice opens.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (invoice && invoice.id !== loadedId) {
    setLoadedId(invoice.id);
    setLines(invoice.lines.length ? invoice.lines : [makeEmptyInvoiceLine(1)]);
    setCustomerId(invoice.customerId);
    setIssueDate(invoice.issueDate);
    setDueDate(invoice.dueDate);
    setPoRef(invoice.purchaseOrderReference ?? '');
    setNotes(invoice.notes ?? '');
    setOverrideVersionId(invoice.templateResolutionSource === 'invoice-override' ? invoice.templateVersionId : '');
    setSaveAsCustomerDefault(false);
  }

  const customerEntity = customers.find((c) => c.id === customerId);
  const resolved = useMemo(
    () => templates.resolve({ entityId: INVOICE_ENTITY_ID, customerDefaultTemplateId: customerEntity?.defaultInvoiceTemplateId, invoiceDate: issueDate, invoiceTemplateVersionId: overrideVersionId || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customerId, customerEntity?.defaultInvoiceTemplateId, issueDate, overrideVersionId, templates.templates, templates.versions],
  );
  const resolvedTemplate = templates.getTemplate(resolved.templateId);
  const resolvedVersion = templates.getVersion(resolved.templateVersionId);

  const totals = useMemo(() => calculateInvoiceTotals(lines, 0, invoice?.amountPaid ?? 0), [lines, invoice?.amountPaid]);
  const currency = invoice?.currency ?? 'USD';
  const money = (n: number): string => formatCurrency(n, currency);

  // Published version options for the override picker.
  const versionOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: `Auto — ${resolvedTemplate?.name ?? 'default'} (${SOURCE_LABEL[resolved.resolutionSource]})` }];
    for (const t of templates.templates.filter((x) => !x.isArchived)) {
      for (const v of templates.versions.filter((x) => x.templateId === t.id && x.status === 'published').sort((a, b) => b.versionNumber - a.versionNumber)) {
        opts.push({ value: v.id, label: `${t.name} — v${v.versionNumber}` });
      }
    }
    return opts;
  }, [templates.templates, templates.versions, resolvedTemplate, resolved.resolutionSource]);

  const setLine = (id: string, patch: Partial<InvoiceLine>): void => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const addLine = (): void => setLines((prev) => [...prev, makeEmptyInvoiceLine(prev.length + 1)]);
  const removeLine = (id: string): void => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));

  const collect = (): Partial<Invoice> => ({
    customerId, issueDate, dueDate, purchaseOrderReference: poRef, notes, lines,
    templateId: resolved.templateId, templateVersionId: resolved.templateVersionId, templateResolutionSource: resolved.resolutionSource,
  });

  const persist = (): boolean => {
    if (!invoiceId) return false;
    const res = updateDraft(invoiceId, collect());
    if (!res.ok) { notify(res.error ?? 'Could not save the invoice.', 'error'); return false; }
    if (saveAsCustomerDefault && customerEntity && !resolvedTemplate?.isSystemDefault) {
      // Store the preferred TEMPLATE on the customer record (not on the template).
      const es = useEntityStore.getState();
      es.updateEntity(customerEntity.id, { ...entityToFormValues(customerEntity), defaultInvoiceTemplateId: resolved.templateId });
      notify('Saved as the customer’s default invoice format.', 'success');
    }
    return true;
  };

  const onPreviewInvoice = (): void => { if (persist()) setShowPreview(true); };
  const onEditTemplate = (): void => {
    if (!resolvedTemplate) return;
    templateEditor.setTab('branding'); // open straight on Branding → Company Logo
    if (resolvedTemplate.isSystemDefault) {
      const dup = templates.duplicateTemplate(resolvedTemplate.id);
      if (dup.ok && dup.id) { templateEditor.requestOpen(dup.id); notify('Template duplicated — opening the editor.', 'success'); }
      else { notify(dup.error ?? 'Could not duplicate.', 'error'); return; }
    } else {
      templateEditor.requestOpen(resolvedTemplate.id);
    }
    setActiveView('invoice-templates');
    onClose();
  };

  const onSaveDraft = (): void => {
    if (persist()) { notify('Invoice draft saved.', 'success'); onClose(); }
  };
  const onIssue = (): void => {
    if (!persist()) return;
    const res = issueInvoice(invoiceId!);
    if (res.ok) { notify(`Invoice ${invoice?.invoiceNumber} issued and posted.`, 'success'); onClose(); }
    else notify(res.error ?? 'Could not issue the invoice.', 'error');
  };

  if (!invoice) return null;
  const readOnly = invoice.status !== 'draft';

  return (
    <>
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-5xl"
      title={`Invoice ${invoice.invoiceNumber}`}
      description={readOnly ? `${invoice.status} — read only` : 'Draft — edit, then issue to post to the ledger'}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total</span>
            <span className="ml-2 font-mono text-base font-bold">{money(totals.grandTotal)}</span>
            {totals.balanceDue !== totals.grandTotal && <span className="ml-3 text-xs text-slate-500">Balance {money(totals.balanceDue)}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {!readOnly && <Button variant="secondary" onClick={onSaveDraft}><Save className="h-4 w-4" /> Save draft</Button>}
            {!readOnly && <Button onClick={onIssue}><Send className="h-4 w-4" /> Issue &amp; post</Button>}
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Header */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Customer" required className="sm:col-span-1">
            <EntityPicker value={customerId} entities={customers} onChange={(e: BusinessEntity | null) => setCustomerId(e?.id ?? '')} placeholder="Select customer" disabled={readOnly} />
          </Field>
          <Field label="Issue date" required><Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} disabled={readOnly} /></Field>
          <Field label="Due date" required><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={readOnly} /></Field>
          <Field label="PO reference"><Input value={poRef} onChange={(e) => setPoRef(e.target.value)} disabled={readOnly} placeholder="Customer PO" /></Field>
          <Field label="Invoice format" className="sm:col-span-2">
            <Select options={versionOptions} value={overrideVersionId} onChange={(e) => setOverrideVersionId(e.target.value)} disabled={readOnly} />
          </Field>
        </section>

        {/* Template resolution note + management entry points */}
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300">
          <div className="flex flex-wrap items-center gap-2">
            <Info className="h-3.5 w-3.5 shrink-0 text-brand-500" />
            <span><span className="font-semibold">{resolvedTemplate?.name}{resolvedVersion ? ` — v${resolvedVersion.versionNumber}` : ''}</span> · selected because: {SOURCE_LABEL[resolved.resolutionSource]}</span>
            <div className="ml-auto flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={onPreviewInvoice}><Eye className="h-3.5 w-3.5" /> Preview</Button>
              <Button type="button" variant="ghost" size="sm" onClick={onEditTemplate}>
                {resolvedTemplate?.isSystemDefault ? <><Wand2 className="h-3.5 w-3.5" /> Duplicate &amp; customize</> : <><Palette className="h-3.5 w-3.5" /> Customize template</>}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setActiveView('invoice-templates'); onClose(); }}><LayoutTemplate className="h-3.5 w-3.5" /> Manage templates</Button>
            </div>
          </div>
          {!readOnly && customerId && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={saveAsCustomerDefault} onChange={(e) => setSaveAsCustomerDefault(e.target.checked)} />
              Save this format as the customer’s default
            </label>
          )}
        </div>

        {/* Line items */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Line items</h3>
            {!readOnly && <Button type="button" variant="outline" size="sm" onClick={addLine}><Plus className="h-4 w-4" /> Add line</Button>}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                <tr>
                  <th className="px-2 py-2 text-left">Revenue account</th>
                  <th className="px-2 py-2 text-left">Description</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Unit price</th>
                  <th className="px-2 py-2 text-right">Disc %</th>
                  <th className="px-2 py-2 text-right">Tax %</th>
                  <th className="px-2 py-2 text-right">Line total</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {lines.map((line) => {
                  const c = calculateInvoiceLine(line);
                  return (
                    <tr key={line.id}>
                      <td className="px-2 py-1.5 min-w-[12rem]"><AccountSelect value={line.accountId} accounts={accounts} onChange={(a) => setLine(line.id, { accountId: a.id })} disabled={readOnly} /></td>
                      <td className="px-2 py-1.5 min-w-[10rem]"><Input value={line.description} onChange={(e) => setLine(line.id, { description: e.target.value })} disabled={readOnly} className="h-8" placeholder="Description" /></td>
                      <td className="px-2 py-1.5 w-20"><Input type="number" step="0.01" value={line.quantity} onChange={(e) => setLine(line.id, { quantity: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                      <td className="px-2 py-1.5 w-24"><Input type="number" step="0.01" value={line.unitPrice} onChange={(e) => setLine(line.id, { unitPrice: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                      <td className="px-2 py-1.5 w-20"><Input type="number" step="0.01" value={line.discountValue ?? 0} onChange={(e) => setLine(line.id, { discountType: 'percentage', discountValue: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                      <td className="px-2 py-1.5 w-20"><Input type="number" step="0.01" value={line.taxRate} onChange={(e) => setLine(line.id, { taxRate: Number(e.target.value) })} disabled={readOnly} className="h-8 text-right" /></td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(c.lineTotal)}</td>
                      <td className="px-2 py-1.5">{!readOnly && <button type="button" onClick={() => removeLine(line.id)} className="text-slate-400 hover:text-red-600" aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>}</td>
                    </tr>
                  );
                }).flatMap((row, i) => showDimensions ? [row, (
                  <tr key={`${lines[i]!.id}-cc`}>
                    <td colSpan={8} className="px-2 pb-2">
                      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                        {showCostCenter && <CostCenterLineControl amount={calculateInvoiceLine(lines[i]!).taxableAmount} costCenterId={lines[i]!.costCenterId} assignments={lines[i]!.costCenterAssignments} postingDate={issueDate} currency={currency} disabled={readOnly} onChange={(patch) => setLine(lines[i]!.id, patch)} />}
                        {showProject && <div className="flex items-center gap-2"><span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Project</span><div className="w-52"><ProjectPicker value={lines[i]!.projectId ?? ''} projects={projects} postingDate={issueDate} disabled={readOnly} onChange={(id) => setLine(lines[i]!.id, { projectId: id || undefined })} /></div></div>}
                        {showInventory && <InventoryLineControl mode="issue" itemId={lines[i]!.inventoryItemId} warehouseId={lines[i]!.warehouseId} enabled={lines[i]!.inventoryFulfillmentMode === 'issue-on-invoice'} disabled={readOnly} onChange={(p) => setLine(lines[i]!.id, { inventoryItemId: p.itemId, warehouseId: p.warehouseId, inventoryFulfillmentMode: p.enabled ? 'issue-on-invoice' : 'none' })} />}
                      </div>
                    </td>
                  </tr>
                )] : [row])}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 dark:border-slate-700">
                  <td colSpan={6} className="px-2 py-1.5 text-right text-slate-500">Subtotal · Tax · Total</td>
                  <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(totals.subtotal)} · {money(totals.taxTotal)} · {money(totals.grandTotal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={readOnly} placeholder="Optional notes shown on the invoice" /></Field>

        {readOnly && invoice.status !== 'void' && (
          <CreditNotesSection
            invoiceId={invoice.id}
            money={money}
            onViewCreditNote={(id) => { useCreditNoteEditor.getState().requestOpen(id); setActiveView('credit-notes'); onClose(); }}
            onViewReceipt={(id) => { useReceiptEditor.getState().requestOpen(id); setActiveView('receipts'); onClose(); }}
          />
        )}

        {readOnly && (
          <p className={cn('rounded-lg border px-3 py-2 text-xs', 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300')}>
            This invoice is {invoice.status}. Issued invoices are immutable — void it or raise a credit note to make changes.
          </p>
        )}
      </div>
    </Drawer>

    {/* Shared preview modal — copy-mode toggle + live settlement panel. */}
    {showPreview && invoiceId && <InvoicePreviewModal invoiceId={invoiceId} onClose={() => setShowPreview(false)} zClass="z-[60]" />}
    </>
  );
}

/**
 * Read-only "Adjustments and payments" on an issued invoice (§21/§1-5): the live
 * settlement summary (original total − each applied credit note − payments =
 * balance due) plus itemised Credit Notes and Payments tables with a View action
 * that opens the linked document. The original invoice total is never modified —
 * the balance is derived from credit-note applications and receipt allocations.
 */
function CreditNotesSection({
  invoiceId, money, onViewCreditNote, onViewReceipt,
}: {
  invoiceId: string;
  money: (n: number) => string;
  onViewCreditNote: (id: string) => void;
  onViewReceipt: (id: string) => void;
}) {
  const invoice = useInvoiceStore((s) => s.invoices.find((i) => i.id === invoiceId));
  const allNotes = useCreditNoteStore((s) => s.creditNotes);
  const allReceipts = useReceiptStore((s) => s.receipts);
  if (!invoice) return null;

  const notes = creditNotesForInvoice(invoiceId, allNotes);
  const receipts = receiptsForInvoice(invoiceId, allReceipts);
  const summary = buildInvoiceSettlementSummary(invoice, allNotes, allReceipts);
  const neg = (n: number): string => (n > 0.005 ? `(${money(n)})` : money(0));

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Adjustments and payments</h3>

      {/* Settlement summary — one deduction row per applied credit note */}
      <div className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
        <Row label="Original invoice total" value={money(summary.originalTotal)} />
        {notes.map((c) => (
          <Row key={c.id} label={`Credit Note ${c.creditNoteNumber}`} value={neg(creditNoteAppliedToInvoice(c, invoiceId))} />
        ))}
        <Row label="Payments received" value={neg(summary.paymentsApplied)} />
        <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700"><Row label="Balance due" value={money(summary.balanceDue)} strong /></div>
      </div>

      {/* Credit Notes table */}
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Credit notes</p>
        {notes.length === 0 ? (
          <p className="text-xs text-slate-400">No credit notes applied to this invoice.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                <tr>
                  <th className="px-2 py-1.5 text-left">Number</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">Reason</th>
                  <th className="px-2 py-1.5 text-right">Total</th>
                  <th className="px-2 py-1.5 text-right">Applied</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {notes.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/20" onClick={() => onViewCreditNote(c.id)}>
                    <td className="px-2 py-1.5 font-mono font-semibold text-brand-600 dark:text-brand-300">{c.creditNoteNumber}</td>
                    <td className="px-2 py-1.5 text-slate-500">{c.issueDate}</td>
                    <td className="px-2 py-1.5 text-slate-500">{CREDIT_NOTE_REASON_LABELS[c.reasonCode]}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-500">{money(c.grandTotal)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{money(creditNoteAppliedToInvoice(c, invoiceId))}</td>
                    <td className="px-2 py-1.5"><Badge tone={CREDIT_NOTE_STATUS_TONE[c.status]}>{c.status}</Badge></td>
                    <td className="px-2 py-1.5 text-right"><button type="button" className="text-brand-600 hover:underline dark:text-brand-300" onClick={(e) => { e.stopPropagation(); onViewCreditNote(c.id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Payments table */}
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Payments</p>
        {receipts.length === 0 ? (
          <p className="text-xs text-slate-400">No payments received against this invoice.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                <tr>
                  <th className="px-2 py-1.5 text-left">Receipt</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">Method</th>
                  <th className="px-2 py-1.5 text-right">Allocated</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {receipts.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/20" onClick={() => onViewReceipt(r.id)}>
                    <td className="px-2 py-1.5 font-mono font-semibold text-brand-600 dark:text-brand-300">{r.receiptNumber}</td>
                    <td className="px-2 py-1.5 text-slate-500">{r.receiptDate}</td>
                    <td className="px-2 py-1.5 text-slate-500">{RECEIPT_METHOD_LABELS[r.method]}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{money(receiptAppliedToInvoice(r, invoiceId))}</td>
                    <td className="px-2 py-1.5"><Badge tone={RECEIPT_STATUS_TONE[r.status]}>{r.status}</Badge></td>
                    <td className="px-2 py-1.5 text-right"><button type="button" className="text-brand-600 hover:underline dark:text-brand-300" onClick={(e) => { e.stopPropagation(); onViewReceipt(r.id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-slate-500">{label}</span>
      <span className={cn('font-mono', strong && 'font-semibold text-slate-900 dark:text-slate-100')}>{value}</span>
    </div>
  );
}
