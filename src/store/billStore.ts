import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type { InvoiceCompanySnapshot, InvoiceCustomerSnapshot, InvoiceTemplateSnapshot } from '@/types/invoice';
import type {
  Bill,
  BillAttachment,
  BillAuditEvent,
  BillLine,
  BillNumberingConfig,
  BillPayment,
  BillPaymentMethod,
  BillPostingConfig,
  BillSupplierCredit,
  BillType,
  WithholdingTaxPolicy,
} from '@/types/bill';
import { calculateBillBalance, calculateBillTotals, recalcBillLine, calculateBillLine } from '@/lib/billCalculations';
import { validateDocumentCostCenters } from '@/lib/costCenterDocumentValidation';
import { validateDocumentProjects } from '@/lib/projectDocumentValidation';
import { generateBillNumber, makeDefaultBillNumberingConfig } from '@/lib/billNumbering';
import { buildBillJournalEntry, buildBillPaymentJournalEntry, buildSupplierCreditJournalEntry } from '@/lib/billPosting';
import { validateBillForPosting } from '@/lib/billValidation';
import { resolveAccountsPayableAccount } from '@/lib/billSettlement';
import { checkDuplicateSupplierInvoiceNumber } from '@/lib/billTax';
import { createBillTemplateSnapshot } from '@/lib/billTemplate';
import { useInventoryStore, inventoryEnabled } from '@/store/inventoryStore';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';

const ACTOR = 'Finance Manager';

export interface BillActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const WHT_POLICY: WithholdingTaxPolicy = { recognition: 'bill-posting' };

function accountsMap(): Map<string, Account> { return new Map(useStore.getState().accounts.map((a) => [a.id, a])); }
function accountByCode(code: string): Account | undefined { return useStore.getState().accounts.find((a) => a.code === code); }
function supplierById(id: string | undefined): BusinessEntity | undefined { return id ? useEntityStore.getState().entities.find((e) => e.id === id) : undefined; }
function costCentersMap() { return new Map(useCostCenterStore.getState().costCenters.map((c) => [c.id, c])); }
function projectsMap() { return new Map(useProjectStore.getState().projects.map((p) => [p.id, p])); }

function companySnapshot(settings: CompanySettings): InvoiceCompanySnapshot {
  const address = [settings.addressLine1, settings.addressLine2, settings.city, settings.stateProvince, settings.postalCode, settings.country].filter(Boolean).join(', ');
  return { legalName: settings.companyName, tradingName: settings.tradingName || undefined, address: address || undefined, taxNumber: settings.taxRegistrationNumber || undefined, phone: settings.phone || undefined, email: settings.email || undefined, website: settings.website || undefined, logoUrl: settings.logoUrl || undefined };
}
function supplierSnapshot(entity: BusinessEntity | undefined): InvoiceCustomerSnapshot {
  if (!entity) return { name: 'Unknown supplier' };
  const address = [entity.addressLine1, entity.addressLine2, entity.city, entity.country, entity.postalCode].filter(Boolean).join(', ');
  return { name: entity.legalName, billingAddress: address || undefined, taxNumber: entity.taxRegistrationNumber || undefined, phone: entity.phone || undefined, email: entity.email || undefined };
}

/** Chart-of-accounts routing for a bill. */
export function billPostingConfig(supplierId: string): BillPostingConfig {
  const supplier = supplierById(supplierId);
  return {
    accountsPayableAccountId: resolveAccountsPayableAccount(supplier, useStore.getState().accounts),
    inputTaxAccountId: accountByCode('2270')?.id, // shared VAT control (debited for input tax)
    withholdingTaxPayableAccountId: accountByCode('2260')?.id,
    supplierAdvancesAccountId: accountByCode('1240')?.id,
    realizedFxAccountId: accountByCode('7300')?.id,
  };
}

function audit(action: string, detail?: string): BillAuditEvent { return { id: generateId('baud'), at: nowIso(), action, detail }; }

/** Recompute derived totals + balance from the current lines. */
function withTotals(bill: Bill): Bill {
  const lines = bill.lines.map(recalcBillLine);
  const t = calculateBillTotals(lines, bill.additionalChargesTotal);
  const balanceDue = calculateBillBalance({ grandTotal: t.grandTotal, withholdingTaxTotal: t.withholdingTaxTotal, supplierCreditsApplied: bill.supplierCreditsApplied, amountPaid: bill.amountPaid });
  return { ...bill, lines, subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, withholdingTaxTotal: t.withholdingTaxTotal, grandTotal: t.grandTotal, balanceDue, updatedAt: nowIso() };
}

export function makeEmptyBillLine(billId: string, sortOrder: number): BillLine {
  return { id: generateId('bline'), billId, description: '', accountId: '', quantity: 1, unitPrice: 0, discountAmount: 0, taxRate: 0, taxableAmount: 0, taxAmount: 0, lineSubtotal: 0, lineTotal: 0, sortOrder };
}

const EDITABLE: Bill['status'][] = ['draft', 'submitted', 'approved'];

interface BillState {
  bills: Bill[];
  numbering: Record<string, BillNumberingConfig>;

  getBill: (id: string) => Bill | undefined;
  getBillsForSupplier: (supplierId: string) => Bill[];
  usedNumbers: () => Set<string>;
  previewSnapshot: (id: string) => InvoiceTemplateSnapshot | null;

  getNumbering: (entityId: string) => BillNumberingConfig;
  takeBillNumber: (entityId: string, usedNumbers: Set<string>, date: string) => string;

  createDraft: (input?: { supplierId?: string; billType?: BillType; billDate?: string; dueDate?: string; currency?: string }) => BillActionResult;
  updateDraft: (id: string, patch: Partial<Bill>) => BillActionResult;
  deleteDraft: (id: string) => BillActionResult;
  duplicateBill: (id: string) => BillActionResult;

  submitBill: (id: string) => BillActionResult;
  approveBill: (id: string) => BillActionResult;
  returnToDraft: (id: string) => BillActionResult;
  postBill: (id: string, opts?: { overrideDuplicate?: boolean }) => BillActionResult;
  recordPayment: (id: string, input: { amount: number; date: string; bankAccountId: string; method?: BillPaymentMethod; reference?: string; bankFeeAmount?: number; bankFeeAccountId?: string; realizedFxAmount?: number }) => BillActionResult;
  /** Apply a Payments-module allocation to a bill WITHOUT posting a journal (the payment owns the bank entry). */
  applyPaymentAllocation: (id: string, input: { amount: number; date: string; method?: BillPaymentMethod; reference?: string; bankAccountId?: string; paymentId: string; journalEntryId?: string }) => BillActionResult;
  /** Remove every allocation a given payment made to a bill (reversal / unapply), restoring the balance and status. */
  removePaymentAllocations: (id: string, paymentId: string) => BillActionResult;
  createSupplierCredit: (id: string, input: { netAmount: number; taxAmount?: number; creditAccountId: string; reason?: string; date?: string; returnInventory?: boolean; returnItemId?: string; returnWarehouseId?: string; returnQuantity?: number; returnUnitCost?: number }) => BillActionResult;
  reverseBill: (id: string, reason: string) => BillActionResult;

  addAttachment: (id: string, att: Omit<BillAttachment, 'id' | 'billId' | 'uploadedAt'>) => BillActionResult;
  removeAttachment: (id: string, attachmentId: string) => BillActionResult;

  replaceAll: (bills: Bill[]) => void;
  resetToDefault: () => void;
}

export const useBillStore = create<BillState>()(
  persist(
    (set, get) => ({
      bills: [],
      numbering: { [INVOICE_ENTITY_ID]: makeDefaultBillNumberingConfig(INVOICE_ENTITY_ID) },

      getBill: (id) => get().bills.find((b) => b.id === id),
      getBillsForSupplier: (supplierId) => get().bills.filter((b) => b.supplierId === supplierId),
      usedNumbers: () => new Set(get().bills.map((b) => b.billNumber).filter(Boolean)),

      previewSnapshot: (id) => {
        const bill = get().bills.find((b) => b.id === id);
        if (!bill) return null;
        if (bill.templateSnapshot) return bill.templateSnapshot;
        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(bill.templateId);
        const version = ts.getVersion(bill.templateVersionId);
        if (!template || !version) return null;
        return createBillTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), supplierSnapshot(supplierById(bill.supplierId)));
      },

      getNumbering: (entityId) => get().numbering[entityId] ?? makeDefaultBillNumberingConfig(entityId),
      takeBillNumber: (entityId, usedNumbers, date) => {
        const cfg = get().getNumbering(entityId);
        const { number, nextConfig } = generateBillNumber(cfg, usedNumbers, date);
        set((s) => ({ numbering: { ...s.numbering, [entityId]: nextConfig } }));
        return number;
      },

      createDraft: (input) => {
        const ts = useInvoiceTemplateStore.getState();
        const settings = useStore.getState().settings;
        const billDate = input?.billDate ?? new Date().toISOString().slice(0, 10);
        const supplier = supplierById(input?.supplierId);
        const resolved = ts.resolve({ entityId: INVOICE_ENTITY_ID });
        const number = get().takeBillNumber(INVOICE_ENTITY_ID, get().usedNumbers(), billDate);
        const id = generateId('bill');
        const now = nowIso();
        const bill: Bill = {
          id, entityId: INVOICE_ENTITY_ID, supplierId: input?.supplierId ?? '',
          billNumber: number, supplierInvoiceNumber: '',
          billType: input?.billType ?? 'expense', status: 'draft',
          billDate, dueDate: input?.dueDate ?? billDate,
          currency: input?.currency ?? supplier?.defaultCurrency ?? settings.baseCurrency, exchangeRate: 1,
          lines: [makeEmptyBillLine(id, 1)],
          subtotal: 0, discountTotal: 0, taxTotal: 0, withholdingTaxTotal: 0, additionalChargesTotal: 0, grandTotal: 0,
          amountPaid: 0, supplierCreditsApplied: 0, balanceDue: 0,
          accountsPayableAccountId: resolveAccountsPayableAccount(supplier, useStore.getState().accounts),
          inputTaxAccountId: accountByCode('2270')?.id, withholdingTaxPayableAccountId: accountByCode('2260')?.id,
          templateId: resolved.templateId, templateVersionId: resolved.templateVersionId, templateResolutionSource: resolved.resolutionSource,
          payments: [], supplierCredits: [], attachments: [],
          auditTrail: [audit('bill-created')],
          createdAt: now, updatedAt: now,
        };
        set({ bills: [...get().bills, bill] });
        return { ok: true, id };
      },

      updateDraft: (id, patch) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (!EDITABLE.includes(existing.status)) return { ok: false, error: 'Only draft, submitted or approved bills can be edited. Reverse a posted bill instead.' };
        const merged = withTotals({ ...existing, ...patch, lines: (patch.lines ?? existing.lines).map((l) => ({ ...l, billId: id })) });
        set({ bills: bills.map((b) => (b.id === id ? merged : b)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft bills can be deleted. Reverse a posted bill instead.' };
        set({ bills: bills.filter((b) => b.id !== id) });
        return { ok: true, id };
      },

      duplicateBill: (id) => {
        const { bills } = get();
        const src = bills.find((b) => b.id === id);
        if (!src) return { ok: false, error: 'Bill not found.' };
        const billDate = new Date().toISOString().slice(0, 10);
        const number = get().takeBillNumber(INVOICE_ENTITY_ID, get().usedNumbers(), billDate);
        const newId = generateId('bill');
        const now = nowIso();
        const copy: Bill = {
          ...structuredCopy(src),
          id: newId, billNumber: number, supplierInvoiceNumber: '', status: 'draft', billDate, dueDate: billDate,
          templateSnapshot: undefined, journalEntryId: undefined, reversalJournalEntryId: undefined,
          amountPaid: 0, supplierCreditsApplied: 0, payments: [], supplierCredits: [], attachments: [],
          submittedAt: undefined, approvedAt: undefined, postedAt: undefined, paidAt: undefined, voidedAt: undefined, reversedAt: undefined, approvedBy: undefined, voidReason: undefined, reversalReason: undefined,
          lines: src.lines.map((l) => ({ ...l, id: generateId('bline'), billId: newId })),
          auditTrail: [audit('bill-created', `duplicated from ${src.billNumber}`)],
          createdAt: now, updatedAt: now,
        };
        set({ bills: [...bills, withTotals(copy)] });
        return { ok: true, id: newId };
      },

      submitBill: (id) => transition(get, set, id, 'draft', 'submitted', 'submittedAt', 'bill-submitted'),
      approveBill: (id) => {
        const { bills } = get();
        const b = bills.find((x) => x.id === id);
        if (!b) return { ok: false, error: 'Bill not found.' };
        if (b.status !== 'draft' && b.status !== 'submitted') return { ok: false, error: 'Only a draft or submitted bill can be approved.' };
        const now = nowIso();
        set({ bills: bills.map((x) => (x.id === id ? { ...x, status: 'approved', approvedAt: now, approvedBy: ACTOR, auditTrail: [...x.auditTrail, audit('bill-approved')], updatedAt: now } : x)) });
        return { ok: true, id };
      },
      returnToDraft: (id) => {
        const { bills } = get();
        const b = bills.find((x) => x.id === id);
        if (!b) return { ok: false, error: 'Bill not found.' };
        if (b.status !== 'submitted' && b.status !== 'approved') return { ok: false, error: 'Only a submitted or approved bill can return to draft.' };
        const now = nowIso();
        set({ bills: bills.map((x) => (x.id === id ? { ...x, status: 'draft', approvedAt: undefined, approvedBy: undefined, submittedAt: undefined, auditTrail: [...x.auditTrail, audit('returned-to-draft')], updatedAt: now } : x)) });
        return { ok: true, id };
      },

      postBill: (id, opts) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (!EDITABLE.includes(existing.status)) return { ok: false, error: 'Only a draft/submitted/approved bill can be posted.' };

        const bill = withTotals(existing);
        const dup = checkDuplicateSupplierInvoiceNumber(bills, { entityId: bill.entityId, supplierId: bill.supplierId, supplierInvoiceNumber: bill.supplierInvoiceNumber, excludeBillId: bill.id });
        if (dup.status === 'duplicate' && !opts?.overrideDuplicate) return { ok: false, error: `Supplier invoice "${bill.supplierInvoiceNumber}" is already recorded on bill ${dup.billNumber}.` };

        const config = billPostingConfig(bill.supplierId);
        const issues = validateBillForPosting(bill, {
          accountsById: accountsMap(),
          billNumberUnique: bills.filter((b) => b.billNumber === bill.billNumber).length <= 1,
          supplierInvoiceUnique: dup.status !== 'duplicate' || !!opts?.overrideDuplicate,
          hasApAccount: !!config.accountsPayableAccountId,
          hasInputTaxAccount: !!config.inputTaxAccountId,
          approvalRequired: false,
          isApproved: bill.status === 'approved',
        });
        if (issues.length > 0) return { ok: false, error: issues[0]!.message };

        // Cost-center rules must pass before the expense journal is created.
        const ccIssues = validateDocumentCostCenters(
          bill.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, amount: calculateBillLine(l).taxableAmount, costCenterId: l.costCenterId, costCenterAssignments: l.costCenterAssignments, label: l.description })),
          { entityId: bill.entityId, postingDate: bill.postingDate || bill.billDate, transactionType: 'Supplier Bill', accountsById: accountsMap(), costCentersById: costCentersMap(), requirementRules: useCostCenterStore.getState().requirementRules },
        );
        if (ccIssues.length > 0) return { ok: false, error: ccIssues[0]!.message };
        const prjIssues = validateDocumentProjects(
          bill.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, projectId: l.projectId, label: l.description })),
          { entityId: bill.entityId, postingDate: bill.postingDate || bill.billDate, transactionType: 'Supplier Bill', accountsById: accountsMap(), projectsById: projectsMap(), requirementRules: useProjectStore.getState().requirementRules },
        );
        if (prjIssues.length > 0) return { ok: false, error: prjIssues[0]!.message };

        const journal = useJournalStore.getState();
        const je = buildBillJournalEntry(bill, { accountsById: accountsMap(), config, withholdingPolicy: WHT_POLICY, supplier: supplierById(bill.supplierId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the bill journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the bill journal entry.' };

        // Inventory: for receive-on-bill lines, the bill journal already debits
        // the inventory account (ex-tax); record the inbound stock movements
        // linked to that journal (no second journal, tax excluded from value).
        if (inventoryEnabled()) {
          const recvLines = bill.lines.filter((l) => l.inventoryReceiptMode === 'receive-on-bill' && l.inventoryItemId && l.warehouseId && l.quantity > 0);
          if (recvLines.length > 0) {
            const invRes = useInventoryStore.getState().recordLinkedMovements({
              date: bill.postingDate || bill.billDate,
              reference: bill.billNumber,
              journalEntryId: added.id,
              kind: 'bill-receipt',
              lines: recvLines.map((l) => ({ id: l.id, itemId: l.inventoryItemId!, warehouseId: l.warehouseId!, quantity: l.quantity, direction: 'in' as const, unitCost: l.quantity ? calculateBillLine(l).taxableAmount / l.quantity : 0 })),
            });
            if (!invRes.ok) {
              const rev = journal.reverseEntry(added.id);
              if (rev.ok && rev.id) journal.postEntry(rev.id);
              return { ok: false, error: invRes.error ?? 'Could not record the inventory receipt.' };
            }
          }
        }

        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(bill.templateId);
        const version = ts.getVersion(bill.templateVersionId);
        const snapshot = template && version ? createBillTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), supplierSnapshot(supplierById(bill.supplierId))) : undefined;

        const now = nowIso();
        const postedBill: Bill = {
          ...bill, status: 'posted', accountsPayableAccountId: config.accountsPayableAccountId, journalEntryId: added.id, templateSnapshot: snapshot,
          postingDate: bill.postingDate || bill.billDate, postedAt: now,
          auditTrail: [...bill.auditTrail, audit('bill-posted', bill.billNumber), audit('journal-created', added.id)], updatedAt: now,
        };
        set({ bills: bills.map((b) => (b.id === id ? postedBill : b)) });
        return { ok: true, id };
      },

      recordPayment: (id, input) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (!['posted', 'partially-paid'].includes(existing.status)) return { ok: false, error: 'Only a posted bill can receive payments.' };
        const amt = Math.round((Number(input.amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: false, error: 'Payment amount must be positive.' };
        if (amt > existing.balanceDue + 0.005) return { ok: false, error: 'Payment exceeds the balance due.' };
        if (!input.bankAccountId) return { ok: false, error: 'Select the bank/cash account.' };

        const payment: BillPayment = {
          id: generateId('bpay'), billId: id, date: input.date, amount: amt, method: input.method ?? 'bank-transfer', reference: input.reference,
          bankAccountId: input.bankAccountId, bankFeeAmount: input.bankFeeAmount, bankFeeAccountId: input.bankFeeAccountId, realizedFxAmount: input.realizedFxAmount, createdAt: nowIso(),
        };
        const journal = useJournalStore.getState();
        const je = buildBillPaymentJournalEntry(existing, payment, { accountsById: accountsMap(), config: billPostingConfig(existing.supplierId), withholdingPolicy: WHT_POLICY, supplier: supplierById(existing.supplierId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the payment journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the payment.' };
        payment.journalEntryId = added.id;

        const amountPaid = Math.round((existing.amountPaid + amt) * 100) / 100;
        const balanceDue = calculateBillBalance({ grandTotal: existing.grandTotal, withholdingTaxTotal: existing.withholdingTaxTotal, supplierCreditsApplied: existing.supplierCreditsApplied, amountPaid });
        const status = balanceDue <= 0.005 ? 'paid' : 'partially-paid';
        const now = nowIso();
        set({ bills: bills.map((b) => (b.id === id ? { ...b, amountPaid, balanceDue, status, payments: [...b.payments, payment], paidAt: status === 'paid' ? now : b.paidAt, auditTrail: [...b.auditTrail, audit('payment-recorded', `${amt.toFixed(2)} — ${added.id}`)], updatedAt: now } : b)) });
        return { ok: true, id };
      },

      applyPaymentAllocation: (id, input) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (!['posted', 'partially-paid'].includes(existing.status)) return { ok: false, error: 'Payments can only be allocated to a posted bill.' };
        const amt = Math.round((Number(input.amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: false, error: 'Allocation amount must be positive.' };
        if (amt > existing.balanceDue + 0.005) return { ok: false, error: 'Allocation exceeds the bill balance due.' };

        const payment: BillPayment = {
          id: generateId('bpay'), billId: id, date: input.date, amount: amt, method: input.method ?? 'bank-transfer',
          reference: input.reference, bankAccountId: input.bankAccountId ?? '', journalEntryId: input.journalEntryId, paymentId: input.paymentId, createdAt: nowIso(),
        };
        const amountPaid = Math.round((existing.amountPaid + amt) * 100) / 100;
        const balanceDue = calculateBillBalance({ grandTotal: existing.grandTotal, withholdingTaxTotal: existing.withholdingTaxTotal, supplierCreditsApplied: existing.supplierCreditsApplied, amountPaid });
        const status = balanceDue <= 0.005 ? 'paid' : 'partially-paid';
        const now = nowIso();
        set({ bills: bills.map((b) => (b.id === id ? { ...b, amountPaid, balanceDue, status, payments: [...b.payments, payment], paidAt: status === 'paid' ? now : b.paidAt, auditTrail: [...b.auditTrail, audit('payment-allocated', `${amt.toFixed(2)} — ${input.reference ?? input.paymentId}`)], updatedAt: now } : b)) });
        return { ok: true, id };
      },

      removePaymentAllocations: (id, paymentId) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        const linked = existing.payments.filter((p) => p.paymentId === paymentId);
        if (linked.length === 0) return { ok: true, id };
        const removed = Math.round(linked.reduce((s, p) => s + p.amount, 0) * 100) / 100;
        const amountPaid = Math.round(Math.max(0, existing.amountPaid - removed) * 100) / 100;
        const balanceDue = calculateBillBalance({ grandTotal: existing.grandTotal, withholdingTaxTotal: existing.withholdingTaxTotal, supplierCreditsApplied: existing.supplierCreditsApplied, amountPaid });
        const status = balanceDue <= 0.005 && amountPaid > 0.005 ? 'paid' : amountPaid <= 0.005 && existing.supplierCreditsApplied <= 0.005 ? 'posted' : 'partially-paid';
        const now = nowIso();
        set({ bills: bills.map((b) => (b.id === id ? { ...b, amountPaid, balanceDue, status, payments: b.payments.filter((p) => p.paymentId !== paymentId), auditTrail: [...b.auditTrail, audit('payment-allocation-reversed', `${removed.toFixed(2)}`)], updatedAt: now } : b)) });
        return { ok: true, id };
      },

      createSupplierCredit: (id, input) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (!['posted', 'partially-paid'].includes(existing.status)) return { ok: false, error: 'A supplier credit can only be raised against a posted bill.' };
        const net = Math.round((Number(input.netAmount) || 0) * 100) / 100;
        const tax = Math.round((Number(input.taxAmount) || 0) * 100) / 100;
        const amount = Math.round((net + tax) * 100) / 100;
        if (amount <= 0) return { ok: false, error: 'Supplier credit amount must be positive.' };
        if (amount > existing.balanceDue + 0.005) return { ok: false, error: 'Supplier credit exceeds the balance due.' };
        if (!input.creditAccountId) return { ok: false, error: 'Select the account the credit reverses.' };

        const credit: BillSupplierCredit = {
          id: generateId('bcr'), billId: id, supplierId: existing.supplierId, creditNumber: `SC-${existing.billNumber}-${existing.supplierCredits.length + 1}`,
          amount, netAmount: net, taxAmount: tax, reason: input.reason, date: input.date ?? nowIso().slice(0, 10), createdAt: nowIso(),
        };
        const journal = useJournalStore.getState();
        const je = buildSupplierCreditJournalEntry(existing, credit, input.creditAccountId, { accountsById: accountsMap(), config: billPostingConfig(existing.supplierId), withholdingPolicy: WHT_POLICY, supplier: supplierById(existing.supplierId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the supplier-credit journal entry.' };
        const postedRes = journal.postEntry(added.id);
        if (!postedRes.ok) return { ok: false, error: postedRes.error ?? 'Could not post the supplier credit.' };
        credit.journalEntryId = added.id;

        // Inventory: physical return to supplier. The SC journal already credits
        // the inventory account (creditAccountId); record the outbound movement
        // at the original receipt cost, linked to that journal.
        if (inventoryEnabled() && input.returnInventory && input.returnItemId && input.returnWarehouseId && (input.returnQuantity ?? 0) > 0) {
          const invRes = useInventoryStore.getState().recordLinkedMovements({
            date: credit.date, reference: credit.creditNumber, journalEntryId: added.id, kind: 'supplier-return',
            lines: [{ id: credit.id, itemId: input.returnItemId, warehouseId: input.returnWarehouseId, quantity: input.returnQuantity!, direction: 'out', unitCost: input.returnUnitCost ?? 0 }],
          });
          if (!invRes.ok) {
            const rev = journal.reverseEntry(added.id);
            if (rev.ok && rev.id) journal.postEntry(rev.id);
            return { ok: false, error: invRes.error ?? 'Could not record the inventory return.' };
          }
        }

        const supplierCreditsApplied = Math.round((existing.supplierCreditsApplied + amount) * 100) / 100;
        const balanceDue = calculateBillBalance({ grandTotal: existing.grandTotal, withholdingTaxTotal: existing.withholdingTaxTotal, supplierCreditsApplied, amountPaid: existing.amountPaid });
        const status = balanceDue <= 0.005 ? 'paid' : existing.amountPaid > 0 ? 'partially-paid' : 'partially-paid';
        const now = nowIso();
        set({ bills: bills.map((b) => (b.id === id ? { ...b, supplierCreditsApplied, balanceDue, status, supplierCredits: [...b.supplierCredits, credit], auditTrail: [...b.auditTrail, audit('supplier-credit-created', `${amount.toFixed(2)} — ${credit.creditNumber}`)], updatedAt: now } : b)) });
        return { ok: true, id };
      },

      reverseBill: (id, reason) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        if (existing.status === 'reversed' || existing.status === 'void') return { ok: false, error: 'Bill is already reversed.' };
        if (!existing.journalEntryId) return { ok: false, error: 'Only a posted bill can be reversed.' };
        if (!reason.trim()) return { ok: false, error: 'A reversal reason is required.' };

        const reversal = useJournalStore.getState().reverseEntry(existing.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal entry.' };
        const now = nowIso();
        set({ bills: bills.map((b) => (b.id === id ? { ...b, status: 'reversed', reversalReason: reason.trim(), reversalJournalEntryId: reversal.id, reversedAt: now, balanceDue: 0, auditTrail: [...b.auditTrail, audit('bill-reversed', reason.trim()), audit('journal-created', `reversal ${reversal.id}`)], updatedAt: now } : b)) });
        return { ok: true, id };
      },

      addAttachment: (id, att) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        const attachment: BillAttachment = { ...att, id: generateId('batt'), billId: id, uploadedAt: nowIso() };
        set({ bills: bills.map((b) => (b.id === id ? { ...b, attachments: [...b.attachments, attachment], auditTrail: [...b.auditTrail, audit('attachment-added', att.fileName)], updatedAt: nowIso() } : b)) });
        return { ok: true, id: attachment.id };
      },
      removeAttachment: (id, attachmentId) => {
        const { bills } = get();
        const existing = bills.find((b) => b.id === id);
        if (!existing) return { ok: false, error: 'Bill not found.' };
        set({ bills: bills.map((b) => (b.id === id ? { ...b, attachments: b.attachments.filter((a) => a.id !== attachmentId), updatedAt: nowIso() } : b)) });
        return { ok: true, id };
      },

      replaceAll: (bills) => set({ bills }),
      resetToDefault: () => set({ bills: [], numbering: { [INVOICE_ENTITY_ID]: makeDefaultBillNumberingConfig(INVOICE_ENTITY_ID) } }),
    }),
    { name: 'ledgerly-bills', version: 1 },
  ),
);

function transition(get: () => BillState, set: (partial: Partial<BillState>) => void, id: string, from: Bill['status'], to: Bill['status'], stampKey: 'submittedAt', action: string): BillActionResult {
  const { bills } = get();
  const b = bills.find((x) => x.id === id);
  if (!b) return { ok: false, error: 'Bill not found.' };
  if (b.status !== from) return { ok: false, error: `Only a ${from} bill can be ${to}.` };
  const now = nowIso();
  set({ bills: bills.map((x) => (x.id === id ? { ...x, status: to, [stampKey]: now, auditTrail: [...x.auditTrail, audit(action)], updatedAt: now } : x)) });
  return { ok: true, id };
}

function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
