import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type { InvoiceCompanySnapshot, InvoiceCustomerSnapshot, InvoiceTemplateSnapshot } from '@/types/invoice';
import type {
  Payment,
  PaymentAllocation,
  PaymentAuditEvent,
  PaymentMethod,
  PaymentNumberingConfig,
  PaymentType,
  PaymentWithholdingPolicy,
} from '@/types/payment';
import { calculatePaymentTotals, toBaseCurrency, derivePaymentStatus, resolveGrossAmount } from '@/lib/paymentCalculations';
import { generatePaymentNumber, makeDefaultPaymentNumberingConfig } from '@/lib/paymentNumbering';
import { buildPaymentJournalEntry } from '@/lib/paymentPosting';
import { validatePaymentForPosting } from '@/lib/paymentValidation';
import { buildPaymentPostingConfig } from '@/lib/paymentSettlement';
import { createPaymentTemplateSnapshot } from '@/lib/paymentTemplate';
import { buildPaymentReversalPlan } from '@/lib/paymentReversal';
import { isSupplierPaymentType, isCustomerRefundType } from '@/lib/paymentLabels';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useBillStore } from './billStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';

const ACTOR = 'Finance Manager';
const WHT_POLICY: PaymentWithholdingPolicy = { recognition: 'payment' };

export interface PaymentActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/* ─────────────────────────── Directory lookups ──────────────────────────── */

function accountsMap(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function supplierById(id: string | undefined): BusinessEntity | undefined {
  return id ? useEntityStore.getState().entities.find((e) => e.id === id) : undefined;
}
function customerById(id: string | undefined): BusinessEntity | undefined {
  return id ? useEntityStore.getState().entities.find((e) => e.id === id) : undefined;
}
function postingConfig(supplierId?: string) {
  return buildPaymentPostingConfig(useStore.getState().accounts, supplierById(supplierId));
}

function companySnapshot(settings: CompanySettings): InvoiceCompanySnapshot {
  const address = [settings.addressLine1, settings.addressLine2, settings.city, settings.stateProvince, settings.postalCode, settings.country].filter(Boolean).join(', ');
  return {
    legalName: settings.companyName,
    tradingName: settings.tradingName || undefined,
    address: address || undefined,
    taxNumber: settings.taxRegistrationNumber || undefined,
    registrationNumber: settings.registrationNumber || undefined,
    phone: settings.phone || undefined,
    email: settings.email || undefined,
    website: settings.website || undefined,
    logoUrl: settings.logoUrl || undefined,
  };
}
function payeeSnapshot(entity: BusinessEntity | undefined, payeeName?: string): InvoiceCustomerSnapshot {
  if (!entity) return { name: payeeName || 'Payee' };
  const address = [entity.addressLine1, entity.addressLine2, entity.city, entity.country, entity.postalCode].filter(Boolean).join(', ');
  return { name: entity.legalName, billingAddress: address || undefined, taxNumber: entity.taxRegistrationNumber || undefined, phone: entity.phone || undefined, email: entity.email || undefined };
}
function payeeEntity(payment: Payment): BusinessEntity | undefined {
  if (isSupplierPaymentType(payment.paymentType)) return supplierById(payment.supplierId);
  if (isCustomerRefundType(payment.paymentType)) return customerById(payment.customerId);
  return undefined;
}

function audit(action: string, detail?: string): PaymentAuditEvent {
  return { id: generateId('paud'), at: nowIso(), action, detail };
}

/** Map a payment method onto the bill subledger's narrower method set. */
function toBillMethod(method: PaymentMethod): import('@/types/bill').BillPaymentMethod {
  return method === 'direct-debit' ? 'other' : method;
}

/** Recompute the derived monetary fields from the current amount & allocations. */
function withTotals(payment: Payment): Payment {
  const t = calculatePaymentTotals(payment);
  const allocations = payment.allocations.map((a) => ({ ...a, baseCurrencyAmount: toBaseCurrency(a.amount, payment.exchangeRate) }));
  return {
    ...payment,
    allocations,
    grossAmount: t.grossAmount,
    bankFeeAmount: t.bankFeeAmount,
    withholdingTaxAmount: t.withholdingTaxAmount,
    discountTakenAmount: t.discountTakenAmount,
    netCashAmount: t.netCashAmount,
    baseCurrencyAmount: t.baseCurrencyAmount,
    allocationTotal: t.allocationTotal,
    unappliedAmount: t.unappliedAmount,
    updatedAt: nowIso(),
  };
}

const EDITABLE: Payment['status'][] = ['draft', 'submitted', 'approved'];

/* ───────────────────────────────── Store ────────────────────────────────── */

interface PaymentState {
  payments: Payment[];
  numbering: Record<string, PaymentNumberingConfig>;

  getPayment: (id: string) => Payment | undefined;
  getPaymentsForBill: (billId: string) => Payment[];
  getPaymentsForSupplier: (supplierId: string) => Payment[];
  usedNumbers: () => Set<string>;
  previewSnapshot: (id: string) => InvoiceTemplateSnapshot | null;

  getNumbering: (entityId: string) => PaymentNumberingConfig;
  takePaymentNumber: (entityId: string, usedNumbers: Set<string>, date: string) => string;

  createDraft: (input?: { paymentType?: PaymentType; supplierId?: string; customerId?: string; paymentDate?: string; currency?: string; grossAmount?: number; method?: PaymentMethod }) => PaymentActionResult;
  createPaymentForBill: (billId: string) => PaymentActionResult;
  createPaymentForSupplier: (supplierId: string) => PaymentActionResult;
  updateDraft: (id: string, patch: Partial<Payment>) => PaymentActionResult;
  deleteDraft: (id: string) => PaymentActionResult;
  duplicatePayment: (id: string) => PaymentActionResult;

  submitPayment: (id: string) => PaymentActionResult;
  approvePayment: (id: string) => PaymentActionResult;
  returnToDraft: (id: string) => PaymentActionResult;
  postPayment: (id: string, opts?: { requireApproval?: boolean }) => PaymentActionResult;
  applyPaymentToBills: (id: string, allocations: { billId: string; amount: number }[], date?: string) => PaymentActionResult;
  unapplyPaymentAllocation: (id: string, allocationId: string) => PaymentActionResult;
  reversePayment: (id: string, reason: string) => PaymentActionResult;
  voidDraft: (id: string) => PaymentActionResult;

  replaceAll: (payments: Payment[]) => void;
  resetToDefault: () => void;
}

export const usePaymentStore = create<PaymentState>()(
  persist(
    (set, get) => ({
      payments: [],
      numbering: { [INVOICE_ENTITY_ID]: makeDefaultPaymentNumberingConfig(INVOICE_ENTITY_ID) },

      getPayment: (id) => get().payments.find((p) => p.id === id),
      getPaymentsForBill: (billId) => get().payments.filter((p) => p.allocations.some((a) => a.billId === billId && !a.reversed)),
      getPaymentsForSupplier: (supplierId) => get().payments.filter((p) => p.supplierId === supplierId),
      usedNumbers: () => new Set(get().payments.map((p) => p.paymentNumber).filter(Boolean)),

      previewSnapshot: (id) => {
        const p = get().payments.find((x) => x.id === id);
        if (!p) return null;
        if (p.templateSnapshot) return p.templateSnapshot;
        const ts = useInvoiceTemplateStore.getState();
        const resolved = ts.resolve({ entityId: INVOICE_ENTITY_ID, invoiceTemplateVersionId: p.templateVersionId });
        const template = ts.getTemplate(p.templateId || resolved.templateId);
        const version = ts.getVersion(p.templateVersionId || resolved.templateVersionId);
        if (!template || !version) return null;
        return createPaymentTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), payeeSnapshot(payeeEntity(p), p.payeeName));
      },

      getNumbering: (entityId) => get().numbering[entityId] ?? makeDefaultPaymentNumberingConfig(entityId),
      takePaymentNumber: (entityId, usedNumbers, date) => {
        const cfg = get().getNumbering(entityId);
        const { number, nextConfig } = generatePaymentNumber(cfg, usedNumbers, date);
        set((s) => ({ numbering: { ...s.numbering, [entityId]: nextConfig } }));
        return number;
      },

      createDraft: (input) => {
        const settings = useStore.getState().settings;
        const paymentDate = input?.paymentDate ?? new Date().toISOString().slice(0, 10);
        const supplier = supplierById(input?.supplierId);
        const ts = useInvoiceTemplateStore.getState();
        const resolved = ts.resolve({ entityId: INVOICE_ENTITY_ID, invoiceDate: paymentDate });
        const number = get().takePaymentNumber(INVOICE_ENTITY_ID, get().usedNumbers(), paymentDate);
        const config = postingConfig(input?.supplierId);
        const now = nowIso();
        const id = generateId('pay');
        const gross = input?.grossAmount ?? 0;
        const payment: Payment = {
          id,
          entityId: INVOICE_ENTITY_ID,
          paymentNumber: number,
          paymentType: input?.paymentType ?? 'supplier-payment',
          status: 'draft',
          supplierId: input?.supplierId,
          customerId: input?.customerId,
          paymentDate,
          currency: input?.currency ?? supplier?.defaultCurrency ?? settings.baseCurrency,
          exchangeRate: 1,
          grossAmount: gross,
          bankFeeAmount: 0,
          withholdingTaxAmount: 0,
          discountTakenAmount: 0,
          netCashAmount: gross,
          baseCurrencyAmount: gross,
          method: input?.method ?? 'bank-transfer',
          bankAccountId: config.defaultBankAccountId,
          bankFeeAccountId: config.bankFeeAccountId,
          withholdingTaxAccountId: config.withholdingTaxPayableAccountId,
          discountAccountId: config.purchaseDiscountAccountId,
          realizedFxAccountId: config.realizedFxAccountId,
          allocations: [],
          allocationTotal: 0,
          unappliedAmount: gross,
          templateId: resolved.templateId,
          templateVersionId: resolved.templateVersionId,
          templateResolutionSource: resolved.resolutionSource,
          auditTrail: [audit('payment-created')],
          createdAt: now, updatedAt: now,
        };
        set({ payments: [...get().payments, withTotals(payment)] });
        return { ok: true, id };
      },

      createPaymentForBill: (billId) => {
        const bill = useBillStore.getState().getBill(billId);
        if (!bill) return { ok: false, error: 'Bill not found.' };
        if (bill.status !== 'posted' && bill.status !== 'partially-paid') return { ok: false, error: 'Only a posted bill can receive a payment.' };
        if (bill.balanceDue <= 0.005) return { ok: false, error: 'This bill is already fully settled.' };

        const created = get().createDraft({ paymentType: 'supplier-payment', supplierId: bill.supplierId, currency: bill.currency, grossAmount: bill.balanceDue });
        if (!created.ok || !created.id) return created;
        const now = nowIso();
        const allocation: PaymentAllocation = {
          id: generateId('palloc'), entityId: bill.entityId, paymentId: created.id, supplierId: bill.supplierId,
          billId: bill.id, billNumber: bill.billNumber, allocationType: 'bill',
          amount: bill.balanceDue, baseCurrencyAmount: bill.balanceDue, allocationDate: now.slice(0, 10), createdAt: now, updatedAt: now,
        };
        get().updateDraft(created.id, { allocations: [allocation], auditTrail: [audit('payment-created'), audit('bill-selected', bill.billNumber)] });
        return created;
      },

      createPaymentForSupplier: (supplierId) => get().createDraft({ paymentType: 'supplier-payment', supplierId }),

      updateDraft: (id, patch) => {
        const { payments } = get();
        const existing = payments.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Payment not found.' };
        if (!EDITABLE.includes(existing.status)) return { ok: false, error: 'Only draft, submitted or approved payments can be edited. Reverse a posted payment instead.' };
        const merged = withTotals({ ...existing, ...patch, allocations: (patch.allocations ?? existing.allocations).map((a) => ({ ...a, paymentId: id })) });
        set({ payments: payments.map((p) => (p.id === id ? merged : p)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { payments } = get();
        const existing = payments.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Payment not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft payments can be deleted. Reverse a posted payment instead.' };
        set({ payments: payments.filter((p) => p.id !== id) });
        return { ok: true, id };
      },

      duplicatePayment: (id) => {
        const { payments } = get();
        const src = payments.find((p) => p.id === id);
        if (!src) return { ok: false, error: 'Payment not found.' };
        const paymentDate = new Date().toISOString().slice(0, 10);
        const number = get().takePaymentNumber(INVOICE_ENTITY_ID, get().usedNumbers(), paymentDate);
        const newId = generateId('pay');
        const now = nowIso();
        const copy: Payment = {
          ...structuredCopy(src),
          id: newId, paymentNumber: number, status: 'draft', paymentDate,
          templateSnapshot: undefined, journalEntryId: undefined, reversalJournalEntryId: undefined,
          allocations: src.allocations.map((a) => ({ ...a, id: generateId('palloc'), paymentId: newId, reversed: false })),
          submittedAt: undefined, approvedAt: undefined, postedAt: undefined, reversedAt: undefined, voidedAt: undefined, approvedBy: undefined, reversalReason: undefined, voidReason: undefined,
          auditTrail: [audit('payment-created', `duplicated from ${src.paymentNumber}`)],
          createdAt: now, updatedAt: now,
        };
        set({ payments: [...payments, withTotals(copy)] });
        return { ok: true, id: newId };
      },

      submitPayment: (id) => transition(get, set, id, 'draft', 'submitted', 'submittedAt', 'payment-submitted'),
      approvePayment: (id) => {
        const { payments } = get();
        const p = payments.find((x) => x.id === id);
        if (!p) return { ok: false, error: 'Payment not found.' };
        if (p.status !== 'draft' && p.status !== 'submitted') return { ok: false, error: 'Only a draft or submitted payment can be approved.' };
        const now = nowIso();
        set({ payments: payments.map((x) => (x.id === id ? { ...x, status: 'approved', approvedAt: now, approvedBy: ACTOR, auditTrail: [...x.auditTrail, audit('payment-approved')], updatedAt: now } : x)) });
        return { ok: true, id };
      },
      returnToDraft: (id) => {
        const { payments } = get();
        const p = payments.find((x) => x.id === id);
        if (!p) return { ok: false, error: 'Payment not found.' };
        if (p.status !== 'submitted' && p.status !== 'approved') return { ok: false, error: 'Only a submitted or approved payment can return to draft.' };
        const now = nowIso();
        set({ payments: payments.map((x) => (x.id === id ? { ...x, status: 'draft', approvedAt: undefined, approvedBy: undefined, submittedAt: undefined, auditTrail: [...x.auditTrail, audit('returned-to-draft')], updatedAt: now } : x)) });
        return { ok: true, id };
      },

      postPayment: (id, opts) => {
        const { payments } = get();
        const existing = payments.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Payment not found.' };
        if (!EDITABLE.includes(existing.status)) return { ok: false, error: 'Only a draft/submitted/approved payment can be posted.' };

        const payment = withTotals(existing);
        const config = postingConfig(payment.supplierId);
        const billsById = new Map(useBillStore.getState().bills.map((b) => [b.id, b]));
        const issues = validatePaymentForPosting(payment, {
          accountsById: accountsMap(),
          config,
          billsById,
          numberUnique: payments.filter((p) => p.paymentNumber === payment.paymentNumber).length <= 1,
          requireApproval: opts?.requireApproval,
        });
        if (issues.length > 0) return { ok: false, error: issues[0]!.message };

        // Post the ONE balanced bank journal through the existing General Journal service.
        const journal = useJournalStore.getState();
        const je = buildPaymentJournalEntry(payment, { accountsById: accountsMap(), config, withholdingPolicy: WHT_POLICY, supplier: supplierById(payment.supplierId), customer: customerById(payment.customerId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the payment journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the payment journal entry.' };

        // Apply each bill allocation to the payables subledger (no extra cash journal).
        const billStore = useBillStore.getState();
        for (const a of payment.allocations.filter((x) => !x.reversed && x.billId)) {
          billStore.applyPaymentAllocation(a.billId!, {
            amount: a.amount, date: payment.paymentDate, method: toBillMethod(payment.method), reference: payment.paymentNumber,
            bankAccountId: payment.bankAccountId ?? payment.cashAccountId, paymentId: payment.id, journalEntryId: added.id,
          });
        }

        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(payment.templateId ?? '');
        const version = ts.getVersion(payment.templateVersionId ?? '');
        const snapshot = template && version
          ? createPaymentTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), payeeSnapshot(payeeEntity(payment), payment.payeeName))
          : undefined;

        const now = nowIso();
        const postedPayment: Payment = {
          ...payment,
          status: derivePaymentStatus(resolveGrossAmount(payment), payment.allocationTotal),
          journalEntryId: added.id,
          templateSnapshot: snapshot,
          postedAt: now,
          auditTrail: [...payment.auditTrail, audit('payment-posted', payment.paymentNumber), audit('journal-created', added.id)],
          updatedAt: now,
        };
        set({ payments: payments.map((p) => (p.id === id ? postedPayment : p)) });
        return { ok: true, id };
      },

      applyPaymentToBills: (id, allocations, date) => {
        const { payments } = get();
        const payment = payments.find((p) => p.id === id);
        if (!payment) return { ok: false, error: 'Payment not found.' };
        if (!['posted', 'partially-allocated'].includes(payment.status)) return { ok: false, error: 'Only a posted payment with an unapplied balance can be applied.' };
        const total = Math.round(allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0) * 100) / 100;
        if (total <= 0) return { ok: false, error: 'Enter an allocation amount.' };
        if (total > payment.unappliedAmount + 0.005) return { ok: false, error: 'Allocation exceeds the unapplied payment amount.' };

        const billStore = useBillStore.getState();
        const now = nowIso();
        const newAllocations: PaymentAllocation[] = [];
        for (const alloc of allocations) {
          const bill = billStore.getBill(alloc.billId);
          if (!bill) return { ok: false, error: 'Target bill not found.' };
          if (bill.supplierId !== payment.supplierId) return { ok: false, error: `Bill ${bill.billNumber} belongs to a different supplier.` };
          if (bill.entityId !== payment.entityId) return { ok: false, error: `Bill ${bill.billNumber} belongs to a different entity.` };
          if (bill.currency !== payment.currency) return { ok: false, error: `Bill ${bill.billNumber} is in a different currency.` };
          const applied = billStore.applyPaymentAllocation(alloc.billId, {
            amount: alloc.amount, date: date ?? payment.paymentDate, method: toBillMethod(payment.method), reference: payment.paymentNumber,
            bankAccountId: payment.bankAccountId ?? payment.cashAccountId, paymentId: payment.id, journalEntryId: payment.journalEntryId,
          });
          if (!applied.ok) return { ok: false, error: applied.error };
          newAllocations.push({
            id: generateId('palloc'), entityId: payment.entityId, paymentId: payment.id, supplierId: payment.supplierId,
            billId: bill.id, billNumber: bill.billNumber, allocationType: 'bill',
            amount: Math.round((Number(alloc.amount) || 0) * 100) / 100, baseCurrencyAmount: toBaseCurrency(alloc.amount, payment.exchangeRate),
            allocationDate: date ?? payment.paymentDate, createdAt: now, updatedAt: now,
          });
        }
        const merged = { ...payment, allocations: [...payment.allocations, ...newAllocations] };
        const t = calculatePaymentTotals(merged);
        set({ payments: payments.map((p) => (p.id === id ? { ...merged, allocationTotal: t.allocationTotal, unappliedAmount: t.unappliedAmount, status: derivePaymentStatus(t.grossAmount, t.allocationTotal), auditTrail: [...p.auditTrail, audit('unapplied-amount-allocated', `${total.toFixed(2)}`)], updatedAt: now } : p)) });
        return { ok: true, id };
      },

      unapplyPaymentAllocation: (id, allocationId) => {
        const { payments } = get();
        const payment = payments.find((p) => p.id === id);
        if (!payment) return { ok: false, error: 'Payment not found.' };
        const alloc = payment.allocations.find((a) => a.id === allocationId && !a.reversed);
        if (!alloc) return { ok: false, error: 'Allocation not found.' };
        if (payment.status === 'reversed' || payment.status === 'void') return { ok: false, error: 'This payment cannot be modified.' };

        // Remove just this allocation's settlement from the bill, then re-apply the others.
        if (alloc.billId) {
          const billStore = useBillStore.getState();
          billStore.removePaymentAllocations(alloc.billId, payment.id);
          for (const other of payment.allocations.filter((a) => a.billId === alloc.billId && a.id !== allocationId && !a.reversed)) {
            billStore.applyPaymentAllocation(alloc.billId, { amount: other.amount, date: other.allocationDate, method: toBillMethod(payment.method), reference: payment.paymentNumber, bankAccountId: payment.bankAccountId ?? payment.cashAccountId, paymentId: payment.id, journalEntryId: payment.journalEntryId });
          }
        }
        const allocations = payment.allocations.map((a) => (a.id === allocationId ? { ...a, reversed: true } : a));
        const t = calculatePaymentTotals({ ...payment, allocations });
        const now = nowIso();
        set({ payments: payments.map((p) => (p.id === id ? { ...p, allocations, allocationTotal: t.allocationTotal, unappliedAmount: t.unappliedAmount, status: derivePaymentStatus(t.grossAmount, t.allocationTotal), auditTrail: [...p.auditTrail, audit('allocation-removed', alloc.billNumber)], updatedAt: now } : p)) });
        return { ok: true, id };
      },

      reversePayment: (id, reason) => {
        const { payments } = get();
        const payment = payments.find((p) => p.id === id);
        if (!payment) return { ok: false, error: 'Payment not found.' };
        if (payment.status === 'reversed' || payment.status === 'void') return { ok: false, error: 'Payment is already reversed.' };
        if (payment.status === 'draft') return { ok: false, error: 'Delete a draft rather than reversing it.' };
        if (!payment.journalEntryId) return { ok: false, error: 'Only a posted payment can be reversed.' };
        if (!reason.trim()) return { ok: false, error: 'A reversal reason is required.' };

        // Reverse the exact original journal lines.
        const reversal = useJournalStore.getState().reverseEntry(payment.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal entry.' };

        // Restore every bill's balance and status off the subledger.
        const billStore = useBillStore.getState();
        for (const r of buildPaymentReversalPlan(payment)) billStore.removePaymentAllocations(r.billId, payment.id);

        const now = nowIso();
        set({
          payments: payments.map((p) => (p.id === id ? {
            ...p, status: 'reversed', reversalReason: reason.trim(), reversalJournalEntryId: reversal.id, reversedAt: now,
            allocations: p.allocations.map((a) => ({ ...a, reversed: true })), allocationTotal: 0, unappliedAmount: resolveGrossAmount(p),
            auditTrail: [...p.auditTrail, audit('payment-reversed', reason.trim()), audit('journal-created', `reversal ${reversal.id}`)],
            updatedAt: now,
          } : p)),
        });
        return { ok: true, id };
      },

      voidDraft: (id) => {
        const { payments } = get();
        const p = payments.find((x) => x.id === id);
        if (!p) return { ok: false, error: 'Payment not found.' };
        if (p.status !== 'draft' && p.status !== 'submitted' && p.status !== 'approved') return { ok: false, error: 'Only an unposted payment can be voided.' };
        const now = nowIso();
        set({ payments: payments.map((x) => (x.id === id ? { ...x, status: 'void', voidedAt: now, auditTrail: [...x.auditTrail, audit('payment-voided')], updatedAt: now } : x)) });
        return { ok: true, id };
      },

      replaceAll: (payments) => set({ payments }),
      resetToDefault: () => set({ payments: [], numbering: { [INVOICE_ENTITY_ID]: makeDefaultPaymentNumberingConfig(INVOICE_ENTITY_ID) } }),
    }),
    { name: 'ledgerly-payments', version: 1 },
  ),
);

function transition(
  get: () => PaymentState,
  set: (partial: Partial<PaymentState>) => void,
  id: string,
  from: Payment['status'],
  to: Payment['status'],
  stampKey: 'submittedAt',
  action: string,
): PaymentActionResult {
  const { payments } = get();
  const p = payments.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'Payment not found.' };
  if (p.status !== from) return { ok: false, error: `Only a ${from} payment can be ${to}.` };
  const now = nowIso();
  set({ payments: payments.map((x) => (x.id === id ? { ...x, status: to, [stampKey]: now, auditTrail: [...x.auditTrail, audit(action)], updatedAt: now } : x)) });
  return { ok: true, id };
}

function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
