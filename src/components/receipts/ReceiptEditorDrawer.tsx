import { useMemo, useState } from 'react';
import { Send, Save, Eye, X, Printer, CheckCircle2, Info, Wand2, Eraser } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import type { Receipt, ReceiptAllocation, ReceiptMethod, ReceiptType } from '@/types/receipt';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useReceiptStore } from '@/store/receiptStore';
import { calculateReceiptTotals } from '@/lib/receiptCalculations';
import { getEligibleInvoicesForReceipt, autoAllocateReceipt } from '@/lib/receiptAllocations';
import { RECEIPT_TYPE_LABELS, RECEIPT_METHOD_LABELS, isCustomerReceipt } from '@/lib/receiptLabels';
import { amountToWords } from '@/lib/amountToWords';
import { formatCurrency } from '@/lib/money';
import { cn as cx, generateId, nowIso } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { ReceiptRenderer } from './ReceiptRenderer';

interface Props {
  open: boolean;
  receiptId: string | null;
  onClose: () => void;
}

const TYPE_OPTIONS = (Object.keys(RECEIPT_TYPE_LABELS) as ReceiptType[]).map((k) => ({ value: k, label: RECEIPT_TYPE_LABELS[k] }));
const METHOD_OPTIONS = (Object.keys(RECEIPT_METHOD_LABELS) as ReceiptMethod[]).map((k) => ({ value: k, label: RECEIPT_METHOD_LABELS[k] }));

export function ReceiptEditorDrawer({ open, receiptId, onClose }: Props) {
  const accounts = useStore((s) => s.accounts);
  const entities = useEntityStore((s) => s.entities);
  const invoices = useInvoiceStore((s) => s.invoices);
  const receipt = useReceiptStore((s) => (receiptId ? s.receipts.find((r) => r.id === receiptId) : undefined));
  const updateDraft = useReceiptStore((s) => s.updateDraft);
  const approveReceipt = useReceiptStore((s) => s.approveReceipt);
  const postReceipt = useReceiptStore((s) => s.postReceipt);
  const previewSnapshot = useReceiptStore((s) => s.previewSnapshot);
  const { notify } = useToast();
  const [showPreview, setShowPreview] = useState(false);

  const customers = useMemo(() => entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both'), [entities]);
  const cashAccounts = useMemo(() => accounts.filter((a) => a.isPostingAccount && a.type === 'ASSET' && /cash and cash equivalents/i.test(a.ifrsSubcategory)), [accounts]);

  const [receiptType, setReceiptType] = useState<ReceiptType>(receipt?.receiptType ?? 'customer-payment');
  const [customerId, setCustomerId] = useState(receipt?.customerId ?? '');
  const [payerName, setPayerName] = useState(receipt?.payerName ?? '');
  const [receiptDate, setReceiptDate] = useState(receipt?.receiptDate ?? '');
  const [method, setMethod] = useState<ReceiptMethod>(receipt?.method ?? 'bank-transfer');
  const [amount, setAmount] = useState(receipt?.amount ?? 0);
  const [exchangeRate, setExchangeRate] = useState(receipt?.exchangeRate ?? 1);
  const [bankAccountId, setBankAccountId] = useState(receipt?.bankAccountId ?? receipt?.cashAccountId ?? '');
  const [creditAccountId, setCreditAccountId] = useState(receipt?.creditAccountId ?? '');
  const [transactionReference, setTransactionReference] = useState(receipt?.transactionReference ?? '');
  const [chequeNumber, setChequeNumber] = useState(receipt?.chequeNumber ?? '');
  const [chequeDate, setChequeDate] = useState(receipt?.chequeDate ?? '');
  const [chequeBankName, setChequeBankName] = useState(receipt?.chequeBankName ?? '');
  const [bankFeeAmount, setBankFeeAmount] = useState(receipt?.bankFeeAmount ?? 0);
  const [bankFeeAccountId, setBankFeeAccountId] = useState(receipt?.bankFeeAccountId ?? '');
  const [withholdingTaxAmount, setWithholdingTaxAmount] = useState(receipt?.withholdingTaxAmount ?? 0);
  const [withholdingTaxAccountId, setWithholdingTaxAccountId] = useState(receipt?.withholdingTaxAccountId ?? '');
  const [narration, setNarration] = useState(receipt?.narration ?? '');
  const [alloc, setAlloc] = useState<Record<string, number>>({});

  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (receipt && receipt.id !== loadedId) {
    setLoadedId(receipt.id);
    setReceiptType(receipt.receiptType);
    setCustomerId(receipt.customerId ?? '');
    setPayerName(receipt.payerName ?? '');
    setReceiptDate(receipt.receiptDate);
    setMethod(receipt.method);
    setAmount(receipt.amount);
    setExchangeRate(receipt.exchangeRate);
    setBankAccountId(receipt.bankAccountId ?? receipt.cashAccountId ?? '');
    setCreditAccountId(receipt.creditAccountId ?? '');
    setTransactionReference(receipt.transactionReference ?? '');
    setChequeNumber(receipt.chequeNumber ?? '');
    setChequeDate(receipt.chequeDate ?? '');
    setChequeBankName(receipt.chequeBankName ?? '');
    setBankFeeAmount(receipt.bankFeeAmount ?? 0);
    setBankFeeAccountId(receipt.bankFeeAccountId ?? '');
    setWithholdingTaxAmount(receipt.withholdingTaxAmount ?? 0);
    setWithholdingTaxAccountId(receipt.withholdingTaxAccountId ?? '');
    setNarration(receipt.narration ?? '');
    setAlloc(Object.fromEntries(receipt.allocations.filter((a) => a.invoiceId && !a.reversed).map((a) => [a.invoiceId!, a.amount])));
  }

  const currency = receipt?.currency ?? 'USD';
  const money = (n: number): string => formatCurrency(n, currency);
  const isCustomer = isCustomerReceipt(receiptType);
  const eligible = useMemo(
    () => (isCustomer && customerId ? getEligibleInvoicesForReceipt(invoices, { entityId: receipt?.entityId ?? 'primary', customerId, currency }) : []),
    [isCustomer, customerId, invoices, receipt?.entityId, currency],
  );

  if (!receipt) return null;
  // Drafts and approved-but-not-yet-posted receipts stay editable and postable.
  const readOnly = receipt.status !== 'draft' && receipt.status !== 'approved';

  const allocationTotal = Math.round(Object.values(alloc).reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;
  const totals = calculateReceiptTotals({ amount, exchangeRate, allocations: [], bankFeeAmount, withholdingTaxAmount } as never);
  const unapplied = Math.round(Math.max(0, amount - allocationTotal) * 100) / 100;

  const setAllocFor = (invoiceId: string, value: number): void => setAlloc((p) => ({ ...p, [invoiceId]: value }));
  const autoAllocate = (): void => {
    const map = autoAllocateReceipt(eligible, amount, 'oldest-due');
    setAlloc(Object.fromEntries(map));
  };
  const clearAlloc = (): void => setAlloc({});

  const buildAllocations = (): ReceiptAllocation[] => {
    if (!isCustomer) return [];
    const now = nowIso();
    return Object.entries(alloc)
      .filter(([, amt]) => Number(amt) > 0)
      .map(([invoiceId, amt]) => {
        const inv = invoices.find((i) => i.id === invoiceId);
        return {
          id: generateId('ralloc'), entityId: receipt.entityId, receiptId: receipt.id, customerId,
          invoiceId, invoiceNumber: inv?.invoiceNumber, allocationType: 'invoice' as const,
          amount: Math.round(Number(amt) * 100) / 100, baseCurrencyAmount: Math.round(Number(amt) * exchangeRate * 100) / 100,
          allocationDate: receiptDate, createdAt: now, updatedAt: now,
        };
      });
  };

  const collect = (): Partial<Receipt> => ({
    receiptType, customerId: isCustomer ? customerId : undefined, payerName: !isCustomer ? payerName : undefined,
    receiptDate, method, amount, exchangeRate,
    bankAccountId: method === 'cash' ? undefined : bankAccountId, cashAccountId: method === 'cash' ? bankAccountId : undefined,
    creditAccountId: !isCustomer ? creditAccountId : undefined,
    transactionReference, chequeNumber, chequeDate, chequeBankName,
    bankFeeAmount, bankFeeAccountId, withholdingTaxAmount, withholdingTaxAccountId,
    narration, allocations: buildAllocations(),
  });

  const persist = (): boolean => {
    if (!receiptId) return false;
    const res = updateDraft(receiptId, collect());
    if (!res.ok) { notify(res.error ?? 'Could not save the receipt.', 'error'); return false; }
    return true;
  };

  const onSaveDraft = (): void => { if (persist()) { notify('Receipt draft saved.', 'success'); onClose(); } };
  const onApprove = (): void => { if (!persist()) return; const r = approveReceipt(receiptId!); if (r.ok) notify('Receipt approved.', 'success'); else notify(r.error ?? 'Could not approve.', 'error'); };
  const onPost = (): void => {
    if (!persist()) return;
    const res = postReceipt(receiptId!);
    if (res.ok) { notify(`Receipt ${receipt.receiptNumber} posted.`, 'success'); onClose(); }
    else notify(res.error ?? 'Could not post the receipt.', 'error');
  };
  const onPreview = (): void => { if (persist()) setShowPreview(true); };

  const snap = showPreview && receiptId ? previewSnapshot(receiptId) : null;
  const previewReceipt = showPreview && receiptId ? useReceiptStore.getState().getReceiptById(receiptId) : undefined;
  const accName = (id: string | undefined): string => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : ''; };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        widthClassName="max-w-5xl"
        title={`Receipt ${receipt.receiptNumber}`}
        description={readOnly ? `${receipt.status} — read only` : 'Draft — record the money received, then post to the ledger'}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <div className="text-sm">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Amount</span>
              <span className="ml-2 font-mono text-base font-bold">{money(amount)}</span>
              {unapplied > 0.005 && <span className="ml-3 text-xs text-slate-500">Unapplied {money(unapplied)}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onClose}>Close</Button>
              {!readOnly && <Button variant="ghost" size="sm" onClick={onPreview}><Eye className="h-4 w-4" /> Preview</Button>}
              {!readOnly && <Button variant="secondary" onClick={onSaveDraft}><Save className="h-4 w-4" /> Save</Button>}
              {receipt.status === 'draft' && <Button variant="secondary" onClick={onApprove}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}
              {!readOnly && <Button onClick={onPost}><Send className="h-4 w-4" /> Post receipt</Button>}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {/* Header */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Receipt type" required><Select options={TYPE_OPTIONS} value={receiptType} onChange={(e) => setReceiptType(e.target.value as ReceiptType)} disabled={readOnly} /></Field>
            {isCustomer ? (
              <Field label="Customer" required className="sm:col-span-1">
                <EntityPicker value={customerId} entities={customers} onChange={(e: BusinessEntity | null) => setCustomerId(e?.id ?? '')} placeholder="Select customer" disabled={readOnly} />
              </Field>
            ) : (
              <Field label="Payer name"><Input value={payerName} onChange={(e) => setPayerName(e.target.value)} disabled={readOnly} placeholder="Who paid?" /></Field>
            )}
            <Field label="Receipt date" required><Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} disabled={readOnly} /></Field>
            <Field label="Amount" required><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            <Field label="Currency"><Input value={currency} disabled readOnly /></Field>
            <Field label="Exchange rate"><Input type="number" step="0.0001" value={exchangeRate} onChange={(e) => setExchangeRate(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            <Field label="Method" required><Select options={METHOD_OPTIONS} value={method} onChange={(e) => setMethod(e.target.value as ReceiptMethod)} disabled={readOnly} /></Field>
            <Field label={method === 'cash' ? 'Cash account' : 'Deposit to (bank)'} required className="sm:col-span-1">
              <AccountSelect value={bankAccountId} accounts={cashAccounts} onChange={(a) => setBankAccountId(a.id)} disabled={readOnly} />
            </Field>
            <Field label="Transaction reference"><Input value={transactionReference} onChange={(e) => setTransactionReference(e.target.value)} disabled={readOnly} placeholder="TRX / transfer ref" /></Field>
          </section>

          {/* Method-specific fields */}
          {method === 'cheque' && (
            <section className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-3">
              <Field label="Cheque number" required><Input value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} disabled={readOnly} /></Field>
              <Field label="Cheque date" required><Input type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} disabled={readOnly} /></Field>
              <Field label="Cheque bank"><Input value={chequeBankName} onChange={(e) => setChequeBankName(e.target.value)} disabled={readOnly} /></Field>
            </section>
          )}

          {/* Credit account for non-customer receipts */}
          {!isCustomer && (
            <Field label="Credit account" required>
              <AccountSelect value={creditAccountId} accounts={accounts} onChange={(a) => setCreditAccountId(a.id)} disabled={readOnly} />
            </Field>
          )}

          {/* Bank fee & withholding tax */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Bank fee"><Input type="number" step="0.01" value={bankFeeAmount} onChange={(e) => setBankFeeAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="Bank fee account"><AccountSelect value={bankFeeAccountId} accounts={accounts} onChange={(a) => setBankFeeAccountId(a.id)} disabled={readOnly || bankFeeAmount <= 0} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Withholding tax"><Input type="number" step="0.01" value={withholdingTaxAmount} onChange={(e) => setWithholdingTaxAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="WHT account"><AccountSelect value={withholdingTaxAccountId} accounts={accounts} onChange={(a) => setWithholdingTaxAccountId(a.id)} disabled={readOnly || withholdingTaxAmount <= 0} /></Field>
            </div>
          </section>

          {/* Allocation table */}
          {isCustomer && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Allocate to open invoices</h3>
                {!readOnly && (
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={autoAllocate}><Wand2 className="h-4 w-4" /> Auto-allocate (oldest first)</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={clearAlloc}><Eraser className="h-4 w-4" /> Clear</Button>
                  </div>
                )}
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                    <tr>
                      <th className="px-2 py-2 text-left">Invoice</th>
                      <th className="px-2 py-2 text-left">Due</th>
                      <th className="px-2 py-2 text-right">Total</th>
                      <th className="px-2 py-2 text-right">Outstanding</th>
                      <th className="px-2 py-2 text-right">Allocate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {eligible.length === 0 ? (
                      <tr><td colSpan={5} className="px-2 py-4 text-center text-slate-400">No open invoices for this customer.</td></tr>
                    ) : eligible.map((inv) => {
                      const val = alloc[inv.id] ?? 0;
                      const over = Number(val) > inv.balanceDue + 0.0001;
                      return (
                        <tr key={inv.id}>
                          <td className="px-2 py-1.5 font-mono">{inv.invoiceNumber}</td>
                          <td className="px-2 py-1.5 text-slate-500">{inv.dueDate}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-slate-500">{money(inv.grandTotal)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(inv.balanceDue)}</td>
                          <td className="px-2 py-1.5 w-28"><Input type="number" step="0.01" value={val} onChange={(e) => setAllocFor(inv.id, Number(e.target.value))} disabled={readOnly} className={cx('h-8 text-right', over && 'border-red-400 text-red-600')} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Summary */}
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-800/40 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryStat label="Receipt amount" value={money(amount)} strong />
            <SummaryStat label="Allocated" value={money(allocationTotal)} />
            <SummaryStat label="Unapplied" value={money(unapplied)} strong />
            <SummaryStat label="Bank fee" value={money(totals.bankFeeAmount)} />
            <SummaryStat label="Withholding" value={money(totals.withholdingTaxAmount)} />
            <SummaryStat label="Net bank" value={money(totals.netBankAmount)} strong />
          </div>

          <p className="rounded-md px-3 py-2 text-xs italic text-slate-500" style={{ border: '1px solid var(--tw-prose-hr,#e2e8f0)' }}>{amountToWords(amount, currency)}</p>

          <Field label="Narration / notes"><Input value={narration} onChange={(e) => setNarration(e.target.value)} disabled={readOnly} placeholder="Optional narration shown on the receipt" /></Field>

          {readOnly ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              This receipt is {receipt.status}. Posted receipts are immutable — reverse it and create a replacement to make changes.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
              Posting creates one balanced journal (Dr bank/cash, Cr receivables or the selected account) and applies allocations to invoices in the subledger.
            </p>
          )}
        </div>
      </Drawer>

      {showPreview && snap && previewReceipt && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-slate-900/50 backdrop-blur-sm print:static print:bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 print:hidden dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-medium">{snap.templateName} — v{snap.versionNumber}</div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
              <button onClick={() => setShowPreview(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><ReceiptRenderer receipt={previewReceipt} snapshot={snap} accountName={accName} /></div></div>
        </div>
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
