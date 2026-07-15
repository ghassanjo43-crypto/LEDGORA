import { useMemo, useState } from 'react';
import { Send, Save, Eye, X, Printer, CheckCircle2, Info } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import type { Payment, PaymentAllocation, PaymentMethod, PaymentType } from '@/types/payment';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { calculatePaymentTotals } from '@/lib/paymentCalculations';
import { getEligibleBillsForPayment, autoAllocatePayment } from '@/lib/paymentAllocations';
import {
  PAYMENT_TYPE_LABELS, PAYMENT_METHOD_LABELS, isSupplierPaymentType, isCustomerRefundType, requiresDebitAccount,
} from '@/lib/paymentLabels';
import { amountToWords } from '@/lib/amountToWords';
import { formatCurrency } from '@/lib/money';
import { generateId, nowIso } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { PaymentAllocationTable } from './PaymentAllocationTable';
import { PaymentMethodFields } from './PaymentMethodFields';
import { PaymentSummary } from './PaymentSummary';
import { PaymentRenderer } from './PaymentRenderer';

interface Props {
  open: boolean;
  paymentId: string | null;
  onClose: () => void;
}

const TYPE_OPTIONS = (Object.keys(PAYMENT_TYPE_LABELS) as PaymentType[]).map((k) => ({ value: k, label: PAYMENT_TYPE_LABELS[k] }));
const METHOD_OPTIONS = (Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((k) => ({ value: k, label: PAYMENT_METHOD_LABELS[k] }));

export function PaymentEditorDrawer({ open, paymentId, onClose }: Props) {
  const accounts = useStore((s) => s.accounts);
  const entities = useEntityStore((s) => s.entities);
  const bills = useBillStore((s) => s.bills);
  const payment = usePaymentStore((s) => (paymentId ? s.payments.find((p) => p.id === paymentId) : undefined));
  const updateDraft = usePaymentStore((s) => s.updateDraft);
  const submitPayment = usePaymentStore((s) => s.submitPayment);
  const approvePayment = usePaymentStore((s) => s.approvePayment);
  const postPayment = usePaymentStore((s) => s.postPayment);
  const previewSnapshot = usePaymentStore((s) => s.previewSnapshot);
  const { notify } = useToast();
  const [showPreview, setShowPreview] = useState(false);

  const suppliers = useMemo(() => entities.filter((e) => e.entityType === 'supplier' || e.entityType === 'both'), [entities]);
  const customers = useMemo(() => entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both'), [entities]);
  const cashAccounts = useMemo(() => accounts.filter((a) => a.isPostingAccount && a.type === 'ASSET' && /cash and cash equivalents/i.test(a.ifrsSubcategory)), [accounts]);

  const [paymentType, setPaymentType] = useState<PaymentType>(payment?.paymentType ?? 'supplier-payment');
  const [supplierId, setSupplierId] = useState(payment?.supplierId ?? '');
  const [customerId, setCustomerId] = useState(payment?.customerId ?? '');
  const [payeeName, setPayeeName] = useState(payment?.payeeName ?? '');
  const [paymentDate, setPaymentDate] = useState(payment?.paymentDate ?? '');
  const [method, setMethod] = useState<PaymentMethod>(payment?.method ?? 'bank-transfer');
  const [grossAmount, setGrossAmount] = useState(payment?.grossAmount ?? 0);
  const [exchangeRate, setExchangeRate] = useState(payment?.exchangeRate ?? 1);
  const [bankAccountId, setBankAccountId] = useState(payment?.bankAccountId ?? payment?.cashAccountId ?? '');
  const [debitAccountId, setDebitAccountId] = useState(payment?.debitAccountId ?? '');
  const [transactionReference, setTransactionReference] = useState(payment?.transactionReference ?? '');
  const [chequeNumber, setChequeNumber] = useState(payment?.chequeNumber ?? '');
  const [chequeDate, setChequeDate] = useState(payment?.chequeDate ?? '');
  const [chequeBankName, setChequeBankName] = useState(payment?.chequeBankName ?? '');
  const [cardReference, setCardReference] = useState(payment?.cardReference ?? '');
  const [directDebitReference, setDirectDebitReference] = useState(payment?.directDebitReference ?? '');
  const [bankFeeAmount, setBankFeeAmount] = useState(payment?.bankFeeAmount ?? 0);
  const [bankFeeAccountId, setBankFeeAccountId] = useState(payment?.bankFeeAccountId ?? '');
  const [withholdingTaxAmount, setWithholdingTaxAmount] = useState(payment?.withholdingTaxAmount ?? 0);
  const [withholdingTaxAccountId, setWithholdingTaxAccountId] = useState(payment?.withholdingTaxAccountId ?? '');
  const [discountTakenAmount, setDiscountTakenAmount] = useState(payment?.discountTakenAmount ?? 0);
  const [discountAccountId, setDiscountAccountId] = useState(payment?.discountAccountId ?? '');
  const [realizedFxAmount, setRealizedFxAmount] = useState(payment?.realizedFxAmount ?? 0);
  const [realizedFxAccountId, setRealizedFxAccountId] = useState(payment?.realizedFxAccountId ?? '');
  const [loanAccountId, setLoanAccountId] = useState(payment?.loanAccountId ?? '');
  const [principalAmount, setPrincipalAmount] = useState(payment?.principalAmount ?? 0);
  const [interestAmount, setInterestAmount] = useState(payment?.interestAmount ?? 0);
  const [interestAccountId, setInterestAccountId] = useState(payment?.interestAccountId ?? '');
  const [leaseLiabilityAccountId, setLeaseLiabilityAccountId] = useState(payment?.leaseLiabilityAccountId ?? '');
  const [leasePrincipalAmount, setLeasePrincipalAmount] = useState(payment?.leasePrincipalAmount ?? 0);
  const [financeCostAmount, setFinanceCostAmount] = useState(payment?.financeCostAmount ?? 0);
  const [financeCostAccountId, setFinanceCostAccountId] = useState(payment?.financeCostAccountId ?? '');
  const [taxAuthorityId, setTaxAuthorityId] = useState(payment?.taxAuthorityId ?? '');
  const [taxPeriod, setTaxPeriod] = useState(payment?.taxPeriod ?? '');
  const [filingReference, setFilingReference] = useState(payment?.filingReference ?? '');
  const [payrollPeriod, setPayrollPeriod] = useState(payment?.payrollPeriod ?? '');
  const [refundReason, setRefundReason] = useState(payment?.refundReason ?? '');
  const [narration, setNarration] = useState(payment?.narration ?? '');
  const [alloc, setAlloc] = useState<Record<string, number>>({});

  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (payment && payment.id !== loadedId) {
    setLoadedId(payment.id);
    setPaymentType(payment.paymentType);
    setSupplierId(payment.supplierId ?? '');
    setCustomerId(payment.customerId ?? '');
    setPayeeName(payment.payeeName ?? '');
    setPaymentDate(payment.paymentDate);
    setMethod(payment.method);
    setGrossAmount(payment.grossAmount);
    setExchangeRate(payment.exchangeRate);
    setBankAccountId(payment.bankAccountId ?? payment.cashAccountId ?? '');
    setDebitAccountId(payment.debitAccountId ?? '');
    setTransactionReference(payment.transactionReference ?? '');
    setChequeNumber(payment.chequeNumber ?? ''); setChequeDate(payment.chequeDate ?? ''); setChequeBankName(payment.chequeBankName ?? '');
    setCardReference(payment.cardReference ?? ''); setDirectDebitReference(payment.directDebitReference ?? '');
    setBankFeeAmount(payment.bankFeeAmount ?? 0); setBankFeeAccountId(payment.bankFeeAccountId ?? '');
    setWithholdingTaxAmount(payment.withholdingTaxAmount ?? 0); setWithholdingTaxAccountId(payment.withholdingTaxAccountId ?? '');
    setDiscountTakenAmount(payment.discountTakenAmount ?? 0); setDiscountAccountId(payment.discountAccountId ?? '');
    setRealizedFxAmount(payment.realizedFxAmount ?? 0); setRealizedFxAccountId(payment.realizedFxAccountId ?? '');
    setLoanAccountId(payment.loanAccountId ?? ''); setPrincipalAmount(payment.principalAmount ?? 0); setInterestAmount(payment.interestAmount ?? 0); setInterestAccountId(payment.interestAccountId ?? '');
    setLeaseLiabilityAccountId(payment.leaseLiabilityAccountId ?? ''); setLeasePrincipalAmount(payment.leasePrincipalAmount ?? 0); setFinanceCostAmount(payment.financeCostAmount ?? 0); setFinanceCostAccountId(payment.financeCostAccountId ?? '');
    setTaxAuthorityId(payment.taxAuthorityId ?? ''); setTaxPeriod(payment.taxPeriod ?? ''); setFilingReference(payment.filingReference ?? ''); setPayrollPeriod(payment.payrollPeriod ?? '');
    setRefundReason(payment.refundReason ?? '');
    setNarration(payment.narration ?? '');
    setAlloc(Object.fromEntries(payment.allocations.filter((a) => a.billId && !a.reversed).map((a) => [a.billId!, a.amount])));
  }

  const currency = payment?.currency ?? 'USD';
  const money = (n: number): string => formatCurrency(n, currency);
  const isSupplier = isSupplierPaymentType(paymentType);
  const isRefund = isCustomerRefundType(paymentType);
  const isLoan = paymentType === 'loan-repayment';
  const isLease = paymentType === 'lease-payment';
  const isTax = paymentType === 'tax-payment';
  const isPayroll = paymentType === 'payroll-payment';
  const needsDebit = requiresDebitAccount(paymentType) || paymentType === 'supplier-advance' || isRefund;

  const eligible = useMemo(
    () => (isSupplier && supplierId ? getEligibleBillsForPayment(bills, { entityId: payment?.entityId ?? 'primary', supplierId, currency }) : []),
    [isSupplier, supplierId, bills, payment?.entityId, currency],
  );

  // Live gross depends on the type (loan/lease derive from splits).
  const effectiveGross = isLoan
    ? Math.round(((Number(principalAmount) || 0) + (Number(interestAmount) || 0)) * 100) / 100
    : isLease
      ? Math.round(((Number(leasePrincipalAmount) || 0) + (Number(financeCostAmount) || 0)) * 100) / 100
      : Math.round((Number(grossAmount) || 0) * 100) / 100;

  const allocationTotal = Math.round(Object.values(alloc).reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;
  const totals = calculatePaymentTotals({
    paymentType, grossAmount, exchangeRate, allocations: [], bankFeeAmount, withholdingTaxAmount, discountTakenAmount,
    principalAmount, interestAmount, leasePrincipalAmount, financeCostAmount,
  } as never);
  const summaryTotals = { ...totals, allocationTotal, unappliedAmount: Math.round(Math.max(0, effectiveGross - allocationTotal) * 100) / 100 };

  if (!payment) return null;
  const readOnly = !['draft', 'submitted', 'approved'].includes(payment.status);

  const setAllocFor = (billId: string, value: number): void => setAlloc((p) => ({ ...p, [billId]: value }));
  const autoAllocate = (): void => setAlloc(Object.fromEntries(autoAllocatePayment(eligible, effectiveGross, 'oldest-due')));
  const clearAlloc = (): void => setAlloc({});

  const buildAllocations = (): PaymentAllocation[] => {
    if (!isSupplier) return [];
    const now = nowIso();
    return Object.entries(alloc)
      .filter(([, amt]) => Number(amt) > 0)
      .map(([billId, amt]) => {
        const bill = bills.find((b) => b.id === billId);
        return {
          id: generateId('palloc'), entityId: payment.entityId, paymentId: payment.id, supplierId,
          billId, billNumber: bill?.billNumber, allocationType: 'bill' as const,
          amount: Math.round(Number(amt) * 100) / 100, baseCurrencyAmount: Math.round(Number(amt) * exchangeRate * 100) / 100,
          allocationDate: paymentDate, createdAt: now, updatedAt: now,
        };
      });
  };

  const collect = (): Partial<Payment> => ({
    paymentType,
    supplierId: isSupplier ? supplierId : undefined,
    customerId: isRefund ? customerId : undefined,
    payeeName: !isSupplier && !isRefund ? payeeName : (isRefund && !customerId ? payeeName : undefined),
    paymentDate, method, grossAmount: isLoan || isLease ? effectiveGross : grossAmount, exchangeRate,
    bankAccountId: method === 'cash' ? undefined : bankAccountId, cashAccountId: method === 'cash' ? bankAccountId : undefined,
    debitAccountId: needsDebit ? debitAccountId : undefined,
    transactionReference, chequeNumber, chequeDate, chequeBankName, cardReference, directDebitReference,
    bankFeeAmount, bankFeeAccountId, withholdingTaxAmount, withholdingTaxAccountId, discountTakenAmount, discountAccountId,
    realizedFxAmount, realizedFxAccountId,
    loanAccountId: isLoan ? loanAccountId : undefined, principalAmount: isLoan ? principalAmount : undefined, interestAmount: isLoan ? interestAmount : undefined, interestAccountId: isLoan ? interestAccountId : undefined,
    leaseLiabilityAccountId: isLease ? leaseLiabilityAccountId : undefined, leasePrincipalAmount: isLease ? leasePrincipalAmount : undefined, financeCostAmount: isLease ? financeCostAmount : undefined, financeCostAccountId: isLease ? financeCostAccountId : undefined,
    taxAuthorityId: isTax ? taxAuthorityId : undefined, taxPeriod: isTax ? taxPeriod : undefined, filingReference: isTax ? filingReference : undefined,
    payrollPeriod: isPayroll ? payrollPeriod : undefined,
    refundReason: isRefund ? refundReason : undefined,
    narration, allocations: buildAllocations(),
  });

  const persist = (): boolean => {
    if (!paymentId) return false;
    const res = updateDraft(paymentId, collect());
    if (!res.ok) { notify(res.error ?? 'Could not save the payment.', 'error'); return false; }
    return true;
  };

  const onSaveDraft = (): void => { if (persist()) { notify('Payment draft saved.', 'success'); onClose(); } };
  const onSubmit = (): void => { if (!persist()) return; const r = submitPayment(paymentId!); if (r.ok) notify('Payment submitted.', 'success'); else notify(r.error ?? 'Could not submit.', 'error'); };
  const onApprove = (): void => { if (!persist()) return; const r = approvePayment(paymentId!); if (r.ok) notify('Payment approved.', 'success'); else notify(r.error ?? 'Could not approve.', 'error'); };
  const onPost = (): void => {
    if (!persist()) return;
    const res = postPayment(paymentId!);
    if (res.ok) { notify(`Payment ${payment.paymentNumber} posted.`, 'success'); onClose(); }
    else notify(res.error ?? 'Could not post the payment.', 'error');
  };
  const onPreview = (): void => { if (persist()) setShowPreview(true); };

  const snap = showPreview && paymentId ? previewSnapshot(paymentId) : null;
  const previewPayment = showPreview && paymentId ? usePaymentStore.getState().getPayment(paymentId) : undefined;
  const accName = (id: string | undefined): string => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : ''; };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        widthClassName="max-w-5xl"
        title={`Payment ${payment.paymentNumber}`}
        description={readOnly ? `${payment.status} — read only` : 'Draft — record the money paid, then post to the ledger'}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <div className="text-sm">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Net cash</span>
              <span className="ml-2 font-mono text-base font-bold">{money(summaryTotals.netCashAmount)}</span>
              {summaryTotals.unappliedAmount > 0.005 && isSupplier && <span className="ml-3 text-xs text-slate-500">Unapplied {money(summaryTotals.unappliedAmount)}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onClose}>Close</Button>
              {!readOnly && <Button variant="ghost" size="sm" onClick={onPreview}><Eye className="h-4 w-4" /> Preview</Button>}
              {!readOnly && <Button variant="secondary" onClick={onSaveDraft}><Save className="h-4 w-4" /> Save</Button>}
              {payment.status === 'draft' && <Button variant="secondary" onClick={onSubmit}><Send className="h-4 w-4" /> Submit</Button>}
              {(payment.status === 'draft' || payment.status === 'submitted') && <Button variant="secondary" onClick={onApprove}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}
              {!readOnly && <Button onClick={onPost}><Send className="h-4 w-4" /> Post payment</Button>}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {/* Header */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Payment type" required><Select options={TYPE_OPTIONS} value={paymentType} onChange={(e) => setPaymentType(e.target.value as PaymentType)} disabled={readOnly} /></Field>
            {isSupplier ? (
              <Field label="Supplier" required><EntityPicker value={supplierId} entities={suppliers} onChange={(e: BusinessEntity | null) => setSupplierId(e?.id ?? '')} placeholder="Select supplier" disabled={readOnly} /></Field>
            ) : isRefund ? (
              <Field label="Customer" required><EntityPicker value={customerId} entities={customers} onChange={(e: BusinessEntity | null) => setCustomerId(e?.id ?? '')} placeholder="Select customer" disabled={readOnly} /></Field>
            ) : (
              <Field label="Payee"><Input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} disabled={readOnly} placeholder="Who is being paid?" /></Field>
            )}
            <Field label="Payment date" required><Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} disabled={readOnly} /></Field>
            {!isLoan && !isLease && (
              <Field label={isSupplier ? 'Payment amount' : 'Amount'} required><Input type="number" step="0.01" value={grossAmount} onChange={(e) => setGrossAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            )}
            <Field label="Currency"><Input value={currency} disabled readOnly /></Field>
            <Field label="Exchange rate"><Input type="number" step="0.0001" value={exchangeRate} onChange={(e) => setExchangeRate(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
            <Field label="Method" required><Select options={METHOD_OPTIONS} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} disabled={readOnly} /></Field>
            <Field label={method === 'cash' ? 'Cash account' : 'Pay from (bank)'} required><AccountSelect value={bankAccountId} accounts={cashAccounts} onChange={(a) => setBankAccountId(a.id)} disabled={readOnly} /></Field>
            <Field label="Transaction reference"><Input value={transactionReference} onChange={(e) => setTransactionReference(e.target.value)} disabled={readOnly} placeholder="TRX / transfer ref" /></Field>
          </section>

          <PaymentMethodFields
            method={method} readOnly={readOnly}
            chequeNumber={chequeNumber} setChequeNumber={setChequeNumber}
            chequeDate={chequeDate} setChequeDate={setChequeDate}
            chequeBankName={chequeBankName} setChequeBankName={setChequeBankName}
            cardReference={cardReference} setCardReference={setCardReference}
            directDebitReference={directDebitReference} setDirectDebitReference={setDirectDebitReference}
          />

          {/* Debit account for expense / tax / payroll / advance / equity / refund / other */}
          {needsDebit && (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={isRefund ? 'Refund from (Dr receivables/credit)' : paymentType === 'supplier-advance' ? 'Advance account (Dr)' : 'Debit account'} required className="sm:col-span-2">
                <AccountSelect value={debitAccountId} accounts={accounts} onChange={(a) => setDebitAccountId(a.id)} disabled={readOnly} />
              </Field>
              {isRefund && <Field label="Refund reason"><Input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} disabled={readOnly} /></Field>}
            </section>
          )}

          {/* Tax metadata */}
          {isTax && (
            <section className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-3">
              <Field label="Tax authority" required><Input value={taxAuthorityId} onChange={(e) => setTaxAuthorityId(e.target.value)} disabled={readOnly} placeholder="e.g. HMRC / IRS" /></Field>
              <Field label="Tax period"><Input value={taxPeriod} onChange={(e) => setTaxPeriod(e.target.value)} disabled={readOnly} placeholder="2026-Q1" /></Field>
              <Field label="Filing / reference"><Input value={filingReference} onChange={(e) => setFilingReference(e.target.value)} disabled={readOnly} /></Field>
            </section>
          )}

          {/* Payroll metadata */}
          {isPayroll && (
            <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Payroll period" required><Input value={payrollPeriod} onChange={(e) => setPayrollPeriod(e.target.value)} disabled={readOnly} placeholder="e.g. January 2026" /></Field>
            </section>
          )}

          {/* Loan split */}
          {isLoan && (
            <section className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-2">
              <Field label="Loan liability account" required><AccountSelect value={loanAccountId} accounts={accounts} onChange={(a) => setLoanAccountId(a.id)} disabled={readOnly} /></Field>
              <Field label="Interest expense account"><AccountSelect value={interestAccountId} accounts={accounts} onChange={(a) => setInterestAccountId(a.id)} disabled={readOnly || interestAmount <= 0} /></Field>
              <Field label="Principal" required><Input type="number" step="0.01" value={principalAmount} onChange={(e) => setPrincipalAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="Interest"><Input type="number" step="0.01" value={interestAmount} onChange={(e) => setInterestAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <p className="sm:col-span-2 text-xs text-slate-500">Principal + interest + fees must equal net cash ({money(summaryTotals.netCashAmount)}).</p>
            </section>
          )}

          {/* Lease split */}
          {isLease && (
            <section className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-2">
              <Field label="Lease liability account" required><AccountSelect value={leaseLiabilityAccountId} accounts={accounts} onChange={(a) => setLeaseLiabilityAccountId(a.id)} disabled={readOnly} /></Field>
              <Field label="Finance cost account"><AccountSelect value={financeCostAccountId} accounts={accounts} onChange={(a) => setFinanceCostAccountId(a.id)} disabled={readOnly || financeCostAmount <= 0} /></Field>
              <Field label="Lease principal" required><Input type="number" step="0.01" value={leasePrincipalAmount} onChange={(e) => setLeasePrincipalAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="Finance cost"><Input type="number" step="0.01" value={financeCostAmount} onChange={(e) => setFinanceCostAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <p className="sm:col-span-2 text-xs italic text-slate-500">Use actual lease-schedule figures — the payment module does not fabricate a schedule.</p>
            </section>
          )}

          {/* Bank fee, withholding, discount, FX */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Bank fee"><Input type="number" step="0.01" value={bankFeeAmount} onChange={(e) => setBankFeeAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="Bank fee account"><AccountSelect value={bankFeeAccountId} accounts={accounts} onChange={(a) => setBankFeeAccountId(a.id)} disabled={readOnly || bankFeeAmount <= 0} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Withholding tax"><Input type="number" step="0.01" value={withholdingTaxAmount} onChange={(e) => setWithholdingTaxAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="WHT payable account"><AccountSelect value={withholdingTaxAccountId} accounts={accounts} onChange={(a) => setWithholdingTaxAccountId(a.id)} disabled={readOnly || withholdingTaxAmount <= 0} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Discount taken"><Input type="number" step="0.01" value={discountTakenAmount} onChange={(e) => setDiscountTakenAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="Discount account"><AccountSelect value={discountAccountId} accounts={accounts} onChange={(a) => setDiscountAccountId(a.id)} disabled={readOnly || discountTakenAmount <= 0} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <Field label="Realised FX (+gain/−loss)"><Input type="number" step="0.01" value={realizedFxAmount} onChange={(e) => setRealizedFxAmount(Number(e.target.value))} disabled={readOnly} className="text-right" /></Field>
              <Field label="Realised FX account"><AccountSelect value={realizedFxAccountId} accounts={accounts} onChange={(a) => setRealizedFxAccountId(a.id)} disabled={readOnly || realizedFxAmount === 0} /></Field>
            </div>
          </section>

          {/* Allocation table (supplier payments only) */}
          {isSupplier && (
            <PaymentAllocationTable bills={eligible} currency={currency} alloc={alloc} onChange={setAllocFor} onAutoAllocate={readOnly ? undefined : autoAllocate} onClear={readOnly ? undefined : clearAlloc} readOnly={readOnly} />
          )}

          <PaymentSummary totals={summaryTotals} currency={currency} />

          <p className="rounded-md px-3 py-2 text-xs italic text-slate-500" style={{ border: '1px solid var(--tw-prose-hr,#e2e8f0)' }}>{amountToWords(summaryTotals.netCashAmount, currency)}</p>

          <Field label="Narration / notes"><Input value={narration} onChange={(e) => setNarration(e.target.value)} disabled={readOnly} placeholder="Optional narration shown on the voucher" /></Field>

          {readOnly ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              This payment is {payment.status}. Posted payments are immutable — reverse it and create a replacement to make changes.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
              Posting creates one balanced journal (Dr liability/expense, Cr bank/cash) and applies allocations to bills in the subledger — no second cash journal.
            </p>
          )}
        </div>
      </Drawer>

      {showPreview && snap && previewPayment && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-slate-900/50 backdrop-blur-sm print:static print:bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 print:hidden dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-medium">{snap.templateName} — v{snap.versionNumber}</div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
              <button onClick={() => setShowPreview(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><PaymentRenderer payment={previewPayment} snapshot={snap} accountName={accName} /></div></div>
        </div>
      )}
    </>
  );
}
