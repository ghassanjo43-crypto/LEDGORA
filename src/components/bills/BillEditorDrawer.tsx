import { useMemo, useState } from 'react';
import { Plus, Trash2, Send, Save, Eye, X, Printer, CheckCircle2, Info, Upload } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import type { Bill, BillLine, BillType } from '@/types/bill';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useBillStore, makeEmptyBillLine } from '@/store/billStore';
import { calculateBillLine, calculateBillTotals } from '@/lib/billCalculations';
import { checkDuplicateSupplierInvoiceNumber } from '@/lib/billTax';
import { buildBillSettlementSummary } from '@/lib/billSettlement';
import { BILL_TYPE_LABELS, BILL_PAYMENT_METHOD_LABELS, BILL_STATUS_TONE } from '@/lib/billLabels';
import { formatCurrency } from '@/lib/money';
import { ReadOnlyValue } from '@/components/ui/ReadOnlyValue';
import { describeCurrency, useTransactionCurrency } from '@/lib/transactionCurrency';
import { cn as cx } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { CostCenterLineControl } from '@/components/cost-centers/CostCenterLineControl';
import { ProjectPicker } from '@/components/projects/ProjectPicker';
import { useHasModule } from '@/store/entitlementHooks';
import { InventoryLineControl } from '@/components/inventory/InventoryLineControl';
import { ItemSelector } from '@/components/items/ItemSelector';
import { purchaseItemDefaults } from '@/lib/itemCatalogue';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { resolveInventoryAccounts } from '@/lib/inventoryAccounts';
import { useProjectStore } from '@/store/projectStore';
import { PrintDocument } from '@/components/ui/PrintDocument';
import { BillRenderer } from './BillRenderer';
import { roundToCompanyPrecision } from '@/lib/monetaryPrecision';
import { useMonetaryStep } from '@/lib/useMonetaryPrecision';
import { getCurrentUser } from '@/store/authStore';
import { roleCanEditBills } from '@/lib/transactionDocumentPermissions';
import { isPlatformAdminFullAccess } from '@/store/platformFullAccess';

interface Props {
  open: boolean;
  billId: string | null;
  onClose: () => void;
}

const TYPE_OPTIONS = (Object.keys(BILL_TYPE_LABELS) as BillType[]).map((k) => ({ value: k, label: BILL_TYPE_LABELS[k] }));

export function BillEditorDrawer({ open, billId, onClose }: Props) {
  /*
   * The company's smallest monetary unit — 0.001 for JOD, 0.01 for USD, 1 for
   * JPY — so the stepper on every money field agrees with the ledger.
   */
  const moneyStep = useMonetaryStep();

  const accounts = useStore((s) => s.accounts);
  const projects = useProjectStore((s) => s.projects);
  const showCostCenter = useHasModule('cost_centers');
  const showProject = useHasModule('projects');
  const showInventory = useHasModule('inventory_basic');
  const catalogueItems = useInventoryStore((s) => s.items);
  const taxCodes = useTaxCodeStore((s) => s.taxCodes);
  const showDimensions = showCostCenter || showProject || showInventory;
  const entities = useEntityStore((s) => s.entities);
  const bills = useBillStore((s) => s.bills);
  const bill = useBillStore((s) => (billId ? s.bills.find((b) => b.id === billId) : undefined));
  const updateDraft = useBillStore((s) => s.updateDraft);
  const submitBill = useBillStore((s) => s.submitBill);
  const approveBill = useBillStore((s) => s.approveBill);
  const postBill = useBillStore((s) => s.postBill);
  const previewSnapshot = useBillStore((s) => s.previewSnapshot);
  const { notify } = useToast();
  /** The company's own currency — what a NEW bill is recorded in. */
  const companyCurrency = useTransactionCurrency();
  const [showPreview, setShowPreview] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const suppliers = useMemo(() => entities.filter((e) => e.entityType === 'supplier' || e.entityType === 'both'), [entities]);

  const [lines, setLines] = useState<BillLine[]>(bill?.lines ?? []);
  const [supplierId, setSupplierId] = useState(bill?.supplierId ?? '');
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState(bill?.supplierInvoiceNumber ?? '');
  const [billType, setBillType] = useState<BillType>(bill?.billType ?? 'expense');
  const [billDate, setBillDate] = useState(bill?.billDate ?? '');
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? '');
  const [poRef, setPoRef] = useState(bill?.purchaseOrderId ?? '');
  const [notes, setNotes] = useState(bill?.notes ?? '');

  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | undefined>(undefined);
  if (bill && bill.id !== loadedId) {
    setLoadedId(bill.id);
    setLines(bill.lines.length ? bill.lines : [makeEmptyBillLine(bill.id, 1)]);
    setSupplierId(bill.supplierId); setSupplierInvoiceNumber(bill.supplierInvoiceNumber); setBillType(bill.billType);
    setBillDate(bill.billDate); setDueDate(bill.dueDate);
    setPoRef(bill.purchaseOrderId ?? ''); setNotes(bill.notes ?? '');
    setLoadedVersion(bill.revision ?? 0);
  }

  /*
   * Derived, never form state.
   *
   * A bill is recorded in the company's currency, so there is nothing for the
   * user to set and nothing to keep in sync. An existing record shows what it
   * actually says — a historical or imported bill may carry another currency,
   * and a read-only field must not misreport it — while a new one shows the
   * company's. Neither is sent back on save; see `collect`.
   */
  const currency = bill?.currency || companyCurrency.code;
  const companyCurrencyForBill = describeCurrency(currency);

  const money = (n: number): string => formatCurrency(n, currency);
  const totals = useMemo(() => calculateBillTotals(lines.map((l) => ({ ...l, discountAmount: 0, taxableAmount: 0, taxAmount: 0, lineSubtotal: 0, lineTotal: 0 })), 0), [lines]);
  const netPayable = roundToCompanyPrecision(totals.grandTotal - totals.withholdingTaxTotal);

  const duplicate = useMemo(
    () => (bill && supplierId && supplierInvoiceNumber ? checkDuplicateSupplierInvoiceNumber(bills, { entityId: bill.entityId, supplierId, supplierInvoiceNumber, excludeBillId: bill.id }) : { status: 'ok' as const }),
    [bills, bill, supplierId, supplierInvoiceNumber],
  );

  if (!bill) return null;
  const mayEdit = isPlatformAdminFullAccess() || roleCanEditBills(getCurrentUser()?.role ?? 'owner');
  const readOnly = bill.status !== 'draft' || !mayEdit;

  const setLine = (id: string, patch: Partial<BillLine>): void => setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const selectItem = (lineId: string, itemId?: string): void => {
    if (!itemId) { setLine(lineId, { itemId: undefined }); return; }
    const item = catalogueItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const defaults = purchaseItemDefaults(item);
    const tax = defaults.taxCodeId ? taxCodes.find((candidate) => candidate.id === defaults.taxCodeId) : undefined;
    setLine(lineId, { ...defaults, taxRate: tax?.rate ?? 0 });
  };
  const addLine = (): void => setLines((prev) => [...prev, makeEmptyBillLine(bill.id, prev.length + 1)]);
  const removeLine = (id: string): void => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));

  // `currency` and `exchangeRate` are deliberately absent: an edit must not be
  // able to re-denominate a bill, so the stored values are simply left alone.
  const collect = (): Partial<Bill> => ({ supplierId, supplierInvoiceNumber, billType, billDate, dueDate, purchaseOrderId: poRef || undefined, notes, lines });
  const persist = (): boolean => { const res = updateDraft(bill.id, collect(), { expectedRevision: loadedVersion }); if (!res.ok) { const message = res.error ?? 'Could not save the bill.'; setFormError(message); notify(message, 'error'); requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-modal="true"] [aria-invalid="true"]')?.focus()); return false; } setLoadedVersion(useBillStore.getState().getBill(bill.id)?.revision ?? 0); setFormError(null); return true; };

  const dirty = !readOnly && JSON.stringify(collect()) !== JSON.stringify({ supplierId: bill.supplierId, supplierInvoiceNumber: bill.supplierInvoiceNumber, billType: bill.billType, billDate: bill.billDate, dueDate: bill.dueDate, purchaseOrderId: bill.purchaseOrderId, notes: bill.notes, lines: bill.lines });
  const requestClose = (): void => { if (!dirty || window.confirm('Discard unsaved changes to this bill?')) onClose(); };

  const onSave = (): void => { if (persist()) { notify('Bill draft saved.', 'success'); onClose(); } };
  const onSubmit = (): void => { if (!persist()) return; const r = submitBill(bill.id); if (r.ok) notify('Bill submitted.', 'success'); else notify(r.error ?? 'Could not submit.', 'error'); };
  const onApprove = (): void => { if (!persist()) return; const r = approveBill(bill.id); if (r.ok) notify('Bill approved.', 'success'); else notify(r.error ?? 'Could not approve.', 'error'); };
  const onPost = (): void => {
    if (!persist()) return;
    const res = postBill(bill.id);
    if (res.ok) { notify(`Bill ${bill.billNumber} posted to Trade Payables.`, 'success'); onClose(); }
    else notify(res.error ?? 'Could not post the bill.', 'error');
  };
  const onPreview = (): void => { if (persist()) setShowPreview(true); };

  const settlement = buildBillSettlementSummary(bill);
  const snap = showPreview && billId ? previewSnapshot(billId) : null;
  const previewBill = showPreview && billId ? useBillStore.getState().getBill(billId) : undefined;
  const supplier = suppliers.find((s) => s.id === bill.supplierId);

  return (
    <>
      <Drawer open={open} onClose={requestClose} widthClassName="max-w-5xl" title={`Bill ${bill.billNumber}`}
        description={readOnly ? `${bill.status} — read only` : 'Enter the supplier invoice, then submit/approve and post to Trade Payables'}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="text-sm"><span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Bill total</span><span className="ml-2 font-mono text-base font-bold">{money(totals.grandTotal)}</span></div>
            {formError && <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">Please review the form: {formError}</p>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" onClick={requestClose}>Close</Button>
              {!readOnly && <Button variant="ghost" size="sm" onClick={onPreview}><Eye className="h-4 w-4" /> Preview</Button>}
              {!readOnly && <Button variant="secondary" onClick={onSave}><Save className="h-4 w-4" /> Save</Button>}
              {bill.status === 'draft' && <Button variant="secondary" onClick={onSubmit}><Send className="h-4 w-4" /> Submit</Button>}
              {(bill.status === 'draft' || bill.status === 'submitted') && <Button variant="secondary" onClick={onApprove}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}
              {!readOnly && <Button onClick={onPost}><Send className="h-4 w-4" /> Post bill</Button>}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          <section aria-labelledby="bill-details-heading" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
            <h3 id="bill-details-heading" className="mb-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Supplier and bill details</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Supplier" required><EntityPicker value={supplierId} entities={suppliers} onChange={(e: BusinessEntity | null) => setSupplierId(e?.id ?? '')} placeholder="Select supplier" disabled={readOnly} /></Field>
            <Field label="Supplier invoice no." required error={!readOnly && formError && !supplierInvoiceNumber.trim() ? 'Supplier invoice number is required.' : undefined}><Input aria-label="Supplier invoice number" aria-invalid={!readOnly && !!formError && !supplierInvoiceNumber.trim()} value={supplierInvoiceNumber} onChange={(e) => setSupplierInvoiceNumber(e.target.value)} disabled={readOnly} placeholder="SUP-INV-8842" /></Field>
            <Field label="Bill type"><Select options={TYPE_OPTIONS} value={billType} onChange={(e) => setBillType(e.target.value as BillType)} disabled={readOnly} /></Field>
            <Field label="Bill date" required error={!readOnly && formError && !billDate ? 'Bill date is required.' : undefined}><Input aria-label="Bill date" aria-invalid={!readOnly && !!formError && !billDate} type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} disabled={readOnly} /></Field>
            <Field label="Due date" required error={!readOnly && formError && !dueDate ? 'Due date is required.' : undefined}><Input aria-label="Due date" aria-invalid={!readOnly && !!formError && !dueDate} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={readOnly} /></Field>
            {/*
              The company's own currency, shown and not chosen. A bill is an
              ordinary purchase transaction, so it is recorded in the company's
              functional currency at par — supplier defaults and free-text
              currency codes could both put a JOD company's books into dollars.
            */}
            <Field label="Currency">
              <ReadOnlyValue data-testid="bill-currency">{companyCurrencyForBill.label}</ReadOnlyValue>
            </Field>
            <Field label="PO reference"><Input value={poRef} onChange={(e) => setPoRef(e.target.value)} disabled={readOnly} placeholder="Purchase order" /></Field>
            </div>
          </section>

          {duplicate.status !== 'ok' && (
            <p className={cx('rounded-lg border px-3 py-2 text-xs', duplicate.status === 'duplicate' ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300')}>
              {duplicate.status === 'duplicate' ? `This supplier invoice number is already recorded on bill ${duplicate.billNumber} — posting is blocked.` : `Heads up: this supplier invoice number also appears on bill ${duplicate.billNumber} for another supplier.`}
            </p>
          )}

          <section aria-labelledby="bill-lines-heading" className="space-y-3" data-testid="bill-line-cards">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 id="bill-lines-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bill lines</h3><p className="mt-1 text-xs text-slate-500">Choose a catalogue item to copy purchasing defaults, or leave it blank for a manual line.</p></div>{!readOnly && <Button type="button" variant="outline" size="sm" onClick={addLine}><Plus className="h-4 w-4" /> Add line</Button>}</div>
            <div className="space-y-4">
              {lines.map((line, i) => { const c = calculateBillLine(line); return (
                <article key={line.id} aria-labelledby={`bill-line-${line.id}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5" data-testid="bill-line-card">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h4 id={`bill-line-${line.id}`} className="text-sm font-semibold text-slate-800 dark:text-slate-100">Line {i + 1}</h4>
                    {!readOnly && <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(line.id)} aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 1}><Trash2 className="h-4 w-4" /> Remove</Button>}
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Catalogue item"><ItemSelector mode="purchase" value={line.itemId} disabled={readOnly} onChange={(id) => selectItem(line.id, id)} /></Field>
                    <Field label="Purchase account" required><AccountSelect value={line.accountId} accounts={accounts} onChange={(a) => setLine(line.id, { accountId: a.id })} disabled={readOnly} /></Field>
                    <div className="md:col-span-2"><Field label="Description" required><Input value={line.description} onChange={(e) => setLine(line.id, { description: e.target.value })} disabled={readOnly} placeholder="What was purchased?" /></Field></div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Quantity"><Input type="number" step="0.01" value={line.quantity} onChange={(e) => setLine(line.id, { quantity: Number(e.target.value) })} disabled={readOnly} className="text-right" /></Field>
                    <Field label="Unit price"><Input type="number" step={moneyStep} data-money="true" value={line.unitPrice} onChange={(e) => setLine(line.id, { unitPrice: Number(e.target.value) })} disabled={readOnly} className="text-right" /></Field>
                    <Field label="Discount %"><Input type="number" step="0.01" value={line.discountValue ?? 0} onChange={(e) => setLine(line.id, { discountType: 'percentage', discountValue: Number(e.target.value) })} disabled={readOnly} className="text-right" /></Field>
                    <Field label="Tax %"><Input type="number" step="0.01" value={line.taxRate} onChange={(e) => setLine(line.id, { taxRate: Number(e.target.value) })} disabled={readOnly} className="text-right" /></Field>
                    <Field label="Withholding %"><Input type="number" step="0.01" value={line.withholdingTaxRate ?? 0} onChange={(e) => setLine(line.id, { withholdingTaxRate: Number(e.target.value) })} disabled={readOnly} className="text-right" /></Field>
                    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50"><p className="text-xs font-medium text-slate-500">Calculated line total</p><output aria-label={`Line ${i + 1} total`} className="mt-1 block text-right font-mono text-base font-semibold text-slate-900 dark:text-slate-100">{money(c.lineTotal)}</output></div>
                  </div>
                  {showDimensions && <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
                    <h5 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Allocation and inventory</h5>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      {showCostCenter && <CostCenterLineControl amount={c.taxableAmount} costCenterId={line.costCenterId} assignments={line.costCenterAssignments} postingDate={billDate} currency={currency} disabled={readOnly} onChange={(patch) => setLine(line.id, patch)} />}
                      {showProject && <Field label="Project"><ProjectPicker value={line.projectId ?? ''} projects={projects} postingDate={billDate} disabled={readOnly} onChange={(id) => setLine(line.id, { projectId: id || undefined })} /></Field>}
                      {showInventory && <div className="lg:col-span-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"><InventoryLineControl mode="receive" itemId={line.inventoryItemId} warehouseId={line.warehouseId} enabled={line.inventoryReceiptMode === 'receive-on-bill'} disabled={readOnly} onChange={(p) => {
                            const patch: Partial<BillLine> = { inventoryItemId: p.itemId, warehouseId: p.warehouseId, inventoryReceiptMode: p.enabled ? 'receive-on-bill' : 'none' };
                            if (p.enabled && p.itemId) {
                              const st = useInventoryStore.getState();
                              const item = st.items.find((it) => it.id === p.itemId);
                              const category = item ? st.categories.find((c) => c.id === item.categoryId) : undefined;
                              const accId = item ? resolveInventoryAccounts({ accounts, item, category, settings: st.settings }).inventory : undefined;
                              if (accId) patch.accountId = accId; // bill journal debits inventory
                            }
                            setLine(line.id, patch);
                          }} /><p className="mt-2 text-xs text-slate-500"><strong>Receive to stock</strong> records a physical inventory receipt. It is separate from the catalogue item above and never creates a duplicate receipt automatically.</p></div>}
                    </div>
                  </div>}
                </article>
              ); })}
            </div>
          </section>

          <section aria-labelledby="bill-totals-heading" className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-800/40"><h3 id="bill-totals-heading" className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Totals</h3><div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Subtotal" value={money(totals.subtotal)} />
            <Stat label="Input tax" value={money(totals.taxTotal)} />
            <Stat label="Withholding" value={money(totals.withholdingTaxTotal)} />
            <Stat label="Bill total" value={money(totals.grandTotal)} strong />
            <Stat label="Net payable" value={money(netPayable)} strong />
            <Stat label="Balance due" value={money(settlement.balanceDue)} />
          </div></section>

          <section aria-labelledby="bill-notes-heading" className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><h3 id="bill-notes-heading" className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Notes and accounting explanation</h3><Field label="Internal notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={readOnly} placeholder="Optional internal notes" /></Field></section>

          {readOnly ? (
            <BillSettlementSection billId={bill.id} money={money} />
          ) : (
            <p className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" /> Posting creates a balanced entry (Dr expense/asset/inventory + Dr input tax, Cr trade payables). No cash moves until you record a payment.</p>
          )}
          {bill.attachments.length > 0 && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Upload className="h-3.5 w-3.5" /> {bill.attachments.length} attachment(s)</p>}
        </div>
      </Drawer>

      {showPreview && snap && previewBill && (
        <>
          <div className="fixed inset-0 z-[60] flex flex-col bg-slate-900/50 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900"><div className="text-sm font-medium">{snap.templateName} — v{snap.versionNumber}</div><div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button><button onClick={() => setShowPreview(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button></div></div>
            <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><BillRenderer bill={previewBill} snapshot={snap} supplierName={supplier?.legalName ?? 'Supplier'} supplierAddress={[supplier?.addressLine1, supplier?.city, supplier?.country].filter(Boolean).join(', ')} supplierTaxNumber={supplier?.taxRegistrationNumber} /></div></div>
          </div>
          <PrintDocument><BillRenderer bill={previewBill} snapshot={snap} supplierName={supplier?.legalName ?? 'Supplier'} supplierAddress={[supplier?.addressLine1, supplier?.city, supplier?.country].filter(Boolean).join(', ')} supplierTaxNumber={supplier?.taxRegistrationNumber} /></PrintDocument>
        </>
      )}
    </>
  );
}

function BillSettlementSection({ billId, money }: { billId: string; money: (n: number) => string }) {
  const bill = useBillStore((s) => s.bills.find((b) => b.id === billId));
  if (!bill) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Payments & supplier credits</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
          <Row label="Bill total" value={money(bill.grandTotal)} />
          {bill.withholdingTaxTotal > 0 && <Row label="Less withholding" value={`- ${money(bill.withholdingTaxTotal)}`} />}
          <Row label="Less supplier credits" value={`- ${money(bill.supplierCreditsApplied)}`} />
          <Row label="Less payments" value={`- ${money(bill.amountPaid)}`} />
          <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700"><Row label="Balance due" value={money(bill.balanceDue)} strong /></div>
        </div>
        <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
          <div><p className="mb-1 font-semibold text-slate-500">Payments</p>{bill.payments.length === 0 ? <p className="text-slate-400">No payments yet.</p> : <ul className="space-y-1">{bill.payments.map((p) => <li key={p.id} className="flex items-center justify-between gap-2"><span className="font-mono">{p.date}</span><span className="text-slate-500">{BILL_PAYMENT_METHOD_LABELS[p.method]}</span><span className="font-mono">{money(p.amount)}</span></li>)}</ul>}</div>
          {bill.supplierCredits.length > 0 && <div className="border-t border-slate-200 pt-2 dark:border-slate-700"><p className="mb-1 font-semibold text-slate-500">Supplier credits</p><ul className="space-y-1">{bill.supplierCredits.map((c) => <li key={c.id} className="flex items-center justify-between gap-2"><span className="font-mono">{c.creditNumber}</span><span className="font-mono">{money(c.amount)}</span><Badge tone={BILL_STATUS_TONE[bill.status]}>{bill.status}</Badge></li>)}</ul></div>}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (<div><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className={cx('font-mono', strong ? 'text-sm font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{value}</p></div>);
}
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (<div className="flex items-center justify-between py-0.5"><span className="text-slate-500">{label}</span><span className={cx('font-mono', strong && 'font-semibold text-slate-900 dark:text-slate-100')}>{value}</span></div>);
}
