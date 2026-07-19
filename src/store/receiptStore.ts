import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type { InvoiceCompanySnapshot, InvoiceCustomerSnapshot, InvoiceTemplateSnapshot } from '@/types/invoice';
import type {
  Receipt,
  ReceiptAllocation,
  ReceiptAuditEvent,
  ReceiptMethod,
  ReceiptNumberingConfig,
  ReceiptPostingConfig,
  ReceiptType,
} from '@/types/receipt';
import { calculateReceiptTotals, toBaseCurrency } from '@/lib/receiptCalculations';
import { generateReceiptNumber, makeDefaultReceiptNumberingConfig } from '@/lib/receiptNumbering';
import { buildReceiptJournalEntry } from '@/lib/receiptPosting';
import { validateReceiptForPosting } from '@/lib/receiptValidation';
import { createReceiptTemplateSnapshot } from '@/lib/receiptTemplate';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';

const ACTOR = 'Finance Manager';

export interface ReceiptActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/* ─────────────────────────── Directory lookups ──────────────────────────── */

function accountsMap(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function accountByCode(code: string): Account | undefined {
  return useStore.getState().accounts.find((a) => a.code === code);
}
function customerById(id: string | undefined): BusinessEntity | undefined {
  return id ? useEntityStore.getState().entities.find((e) => e.id === id) : undefined;
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
function customerSnapshot(entity: BusinessEntity | undefined, payerName?: string): InvoiceCustomerSnapshot {
  if (!entity) return { name: payerName || 'Payer' };
  const billingAddress = [entity.addressLine1, entity.addressLine2, entity.city, entity.country, entity.postalCode].filter(Boolean).join(', ');
  return { name: entity.legalName, billingAddress: billingAddress || undefined, taxNumber: entity.taxRegistrationNumber || undefined, phone: entity.phone || undefined, email: entity.email || undefined };
}

/** Cash & cash-equivalent posting accounts, split into bank vs cash-on-hand. */
function cashAccounts(): { bank: Account[]; cash: Account[] } {
  const all = useStore.getState().accounts.filter((a) => a.type === 'ASSET' && a.isPostingAccount && /cash and cash equivalents/i.test(a.ifrsSubcategory));
  const cash = all.filter((a) => /cash on hand/i.test(a.name));
  const bank = all.filter((a) => !/cash on hand/i.test(a.name));
  return { bank, cash };
}

/** Resolve the chart-of-accounts routing for a receipt posting. */
export function receiptPostingConfig(customerId?: string): ReceiptPostingConfig {
  const customer = customerById(customerId);
  const { bank, cash } = cashAccounts();
  return {
    tradeReceivablesAccountId: customer?.defaultReceivableAccount || accountByCode('1221')?.id || '',
    customerAdvanceAccountId: accountByCode('2230')?.id,
    otherIncomeAccountId: accountByCode('4300')?.id,
    bankAccountIds: bank.map((a) => a.id),
    cashAccountIds: cash.map((a) => a.id),
    defaultBankAccountId: accountByCode('1252')?.id ?? bank[0]?.id,
    defaultCashAccountId: accountByCode('1251')?.id ?? cash[0]?.id,
  };
}

function audit(action: string, detail?: string): ReceiptAuditEvent {
  return { id: generateId('raud'), at: nowIso(), action, detail };
}

/** The status of a posted receipt implied by how much of it is allocated. */
function deriveAllocatedStatus(amount: number, allocationTotal: number): Receipt['status'] {
  if (allocationTotal <= 0.005) return 'posted';
  if (allocationTotal >= amount - 0.005) return 'fully-allocated';
  return 'partially-allocated';
}

/** Recompute the derived monetary fields from the current allocations & amount. */
function withTotals(receipt: Receipt): Receipt {
  const t = calculateReceiptTotals(receipt);
  const allocations = receipt.allocations.map((a) => ({ ...a, baseCurrencyAmount: toBaseCurrency(a.amount, receipt.exchangeRate) }));
  return {
    ...receipt,
    allocations,
    amount: t.amount,
    baseCurrencyAmount: t.baseCurrencyAmount,
    allocationTotal: t.allocationTotal,
    unappliedAmount: t.unappliedAmount,
    netBankAmount: t.netBankAmount,
    grossReceiptAmount: t.amount,
    updatedAt: nowIso(),
  };
}

/* ───────────────────────────────── Store ────────────────────────────────── */

interface ReceiptState {
  receipts: Receipt[];
  numbering: Record<string, ReceiptNumberingConfig>;

  getReceiptById: (id: string) => Receipt | undefined;
  getReceiptsForInvoice: (invoiceId: string) => Receipt[];
  getReceiptsForCustomer: (customerId: string) => Receipt[];
  usedNumbers: () => Set<string>;
  previewSnapshot: (id: string) => InvoiceTemplateSnapshot | null;

  getNumbering: (entityId: string) => ReceiptNumberingConfig;
  takeReceiptNumber: (entityId: string, usedNumbers: Set<string>, date: string) => string;

  createDraft: (input?: { receiptType?: ReceiptType; customerId?: string; receiptDate?: string; currency?: string; amount?: number; method?: ReceiptMethod }) => ReceiptActionResult;
  createReceiptForInvoice: (invoiceId: string) => ReceiptActionResult;
  createReceiptForCustomer: (customerId: string) => ReceiptActionResult;
  updateDraft: (id: string, patch: Partial<Receipt>) => ReceiptActionResult;
  deleteDraft: (id: string) => ReceiptActionResult;
  duplicateReceipt: (id: string) => ReceiptActionResult;

  approveReceipt: (id: string) => ReceiptActionResult;
  postReceipt: (id: string) => ReceiptActionResult;
  applyReceiptToInvoices: (id: string, allocations: { invoiceId: string; amount: number }[], date?: string) => ReceiptActionResult;
  unapplyReceiptAllocation: (id: string, allocationId: string) => ReceiptActionResult;
  reverseReceipt: (id: string, reason: string) => ReceiptActionResult;

  replaceAll: (receipts: Receipt[]) => void;
  resetToDefault: () => void;
}

export const useReceiptStore = create<ReceiptState>()(
  persist(
    (set, get) => ({
      receipts: [],
      numbering: { [INVOICE_ENTITY_ID]: makeDefaultReceiptNumberingConfig(INVOICE_ENTITY_ID) },

      getReceiptById: (id) => get().receipts.find((r) => r.id === id),
      getReceiptsForInvoice: (invoiceId) => get().receipts.filter((r) => r.allocations.some((a) => a.invoiceId === invoiceId && !a.reversed)),
      getReceiptsForCustomer: (customerId) => get().receipts.filter((r) => r.customerId === customerId),
      usedNumbers: () => new Set(get().receipts.map((r) => r.receiptNumber).filter(Boolean)),

      previewSnapshot: (id) => {
        const r = get().receipts.find((x) => x.id === id);
        if (!r) return null;
        if (r.templateSnapshot) return r.templateSnapshot;
        const ts = useInvoiceTemplateStore.getState();
        const resolved = ts.resolve({ entityId: INVOICE_ENTITY_ID, invoiceTemplateVersionId: r.templateVersionId });
        const template = ts.getTemplate(r.templateId || resolved.templateId);
        const version = ts.getVersion(r.templateVersionId || resolved.templateVersionId);
        if (!template || !version) return null;
        return createReceiptTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), customerSnapshot(customerById(r.customerId), r.payerName));
      },

      getNumbering: (entityId) => get().numbering[entityId] ?? makeDefaultReceiptNumberingConfig(entityId),
      takeReceiptNumber: (entityId, usedNumbers, date) => {
        const cfg = get().getNumbering(entityId);
        const { number, nextConfig } = generateReceiptNumber(cfg, usedNumbers, date);
        set((s) => ({ numbering: { ...s.numbering, [entityId]: nextConfig } }));
        return number;
      },

      createDraft: (input) => {
        const settings = useStore.getState().settings;
        const receiptDate = input?.receiptDate ?? new Date().toISOString().slice(0, 10);
        const customer = customerById(input?.customerId);
        const ts = useInvoiceTemplateStore.getState();
        const resolved = ts.resolve({ entityId: INVOICE_ENTITY_ID, customerDefaultTemplateId: customer?.defaultInvoiceTemplateId, invoiceDate: receiptDate });
        const number = get().takeReceiptNumber(INVOICE_ENTITY_ID, get().usedNumbers(), receiptDate);
        const config = receiptPostingConfig(input?.customerId);
        const now = nowIso();
        const id = generateId('rct');
        const receipt: Receipt = {
          id,
          entityId: INVOICE_ENTITY_ID,
          receiptNumber: number,
          receiptType: input?.receiptType ?? 'customer-payment',
          status: 'draft',
          customerId: input?.customerId,
          receiptDate,
          currency: input?.currency ?? customer?.defaultCurrency ?? settings.baseCurrency,
          exchangeRate: 1,
          amount: input?.amount ?? 0,
          baseCurrencyAmount: input?.amount ?? 0,
          method: input?.method ?? 'bank-transfer',
          bankAccountId: config.defaultBankAccountId,
          allocations: [],
          allocationTotal: 0,
          unappliedAmount: input?.amount ?? 0,
          templateId: resolved.templateId,
          templateVersionId: resolved.templateVersionId,
          templateResolutionSource: resolved.resolutionSource,
          auditTrail: [audit('receipt-created')],
          createdAt: now, updatedAt: now,
        };
        set({ receipts: [...get().receipts, withTotals(receipt)] });
        return { ok: true, id };
      },

      createReceiptForInvoice: (invoiceId) => {
        const invoice = useInvoiceStore.getState().getInvoice(invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status === 'draft' || invoice.status === 'void') return { ok: false, error: 'Only an issued invoice can receive a receipt.' };
        if (invoice.balanceDue <= 0.005) return { ok: false, error: 'This invoice is already fully settled.' };

        const created = get().createDraft({ receiptType: 'customer-payment', customerId: invoice.customerId, currency: invoice.currency, amount: invoice.balanceDue });
        if (!created.ok || !created.id) return created;
        const now = nowIso();
        const allocation: ReceiptAllocation = {
          id: generateId('ralloc'), entityId: invoice.entityId, receiptId: created.id, customerId: invoice.customerId,
          invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, allocationType: 'invoice',
          amount: invoice.balanceDue, baseCurrencyAmount: invoice.balanceDue, allocationDate: now.slice(0, 10), createdAt: now, updatedAt: now,
        };
        get().updateDraft(created.id, { allocations: [allocation], auditTrail: [audit('receipt-created'), audit('invoice-selected', invoice.invoiceNumber)] });
        return created;
      },

      createReceiptForCustomer: (customerId) => get().createDraft({ receiptType: 'customer-payment', customerId }),

      updateDraft: (id, patch) => {
        const { receipts } = get();
        const existing = receipts.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Receipt not found.' };
        if (existing.status !== 'draft' && existing.status !== 'approved') return { ok: false, error: 'Only draft or approved receipts can be edited. Reverse a posted receipt instead.' };
        const merged = withTotals({ ...existing, ...patch, allocations: (patch.allocations ?? existing.allocations).map((a) => ({ ...a, receiptId: id })) });
        set({ receipts: receipts.map((r) => (r.id === id ? merged : r)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { receipts } = get();
        const existing = receipts.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Receipt not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft receipts can be deleted. Reverse a posted receipt instead.' };
        set({ receipts: receipts.filter((r) => r.id !== id) });
        return { ok: true, id };
      },

      duplicateReceipt: (id) => {
        const { receipts } = get();
        const src = receipts.find((r) => r.id === id);
        if (!src) return { ok: false, error: 'Receipt not found.' };
        const receiptDate = new Date().toISOString().slice(0, 10);
        const number = get().takeReceiptNumber(INVOICE_ENTITY_ID, get().usedNumbers(), receiptDate);
        const newId = generateId('rct');
        const now = nowIso();
        const copy: Receipt = {
          ...structuredCopy(src),
          id: newId, receiptNumber: number, status: 'draft', receiptDate,
          templateSnapshot: undefined, journalEntryId: undefined, reversalJournalEntryId: undefined,
          allocations: src.allocations.map((a) => ({ ...a, id: generateId('ralloc'), receiptId: newId, reversed: false })),
          postedAt: undefined, approvedAt: undefined, reversedAt: undefined, voidedAt: undefined, reverseReason: undefined,
          auditTrail: [audit('receipt-created', `duplicated from ${src.receiptNumber}`)],
          createdAt: now, updatedAt: now,
        };
        set({ receipts: [...receipts, withTotals(copy)] });
        return { ok: true, id: newId };
      },

      approveReceipt: (id) => {
        const { receipts } = get();
        const existing = receipts.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Receipt not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only a draft receipt can be approved.' };
        set({ receipts: receipts.map((r) => (r.id === id ? { ...r, status: 'approved', approvedAt: nowIso(), auditTrail: [...r.auditTrail, audit('approved')], updatedAt: nowIso() } : r)) });
        return { ok: true, id };
      },

      postReceipt: (id) => {
        const { receipts } = get();
        const existing = receipts.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Receipt not found.' };
        if (existing.status !== 'draft' && existing.status !== 'approved') return { ok: false, error: 'Only a draft receipt can be posted.' };

        const receipt = withTotals(existing);
        const config = receiptPostingConfig(receipt.customerId);
        const invoicesById = new Map(useInvoiceStore.getState().invoices.map((i) => [i.id, i]));
        const issues = validateReceiptForPosting(receipt, {
          accountsById: accountsMap(),
          config,
          invoicesById,
          numberUnique: receipts.filter((r) => r.receiptNumber === receipt.receiptNumber).length <= 1,
        });
        if (issues.length > 0) return { ok: false, error: issues[0]!.message };

        // Post the balanced cash journal through the existing General Journal service.
        const journal = useJournalStore.getState();
        const je = buildReceiptJournalEntry(receipt, { accountsById: accountsMap(), config, customer: customerById(receipt.customerId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the receipt journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the receipt journal entry.' };

        // Apply each invoice allocation to the subledger (no extra cash journal).
        const invoiceStore = useInvoiceStore.getState();
        for (const a of receipt.allocations.filter((x) => !x.reversed && x.invoiceId)) {
          invoiceStore.applyReceiptAllocation(a.invoiceId!, {
            amount: a.amount, date: receipt.receiptDate, method: receipt.method, reference: receipt.receiptNumber,
            bankAccountId: receipt.bankAccountId ?? receipt.cashAccountId, receiptId: receipt.id, journalEntryId: added.id,
          });
        }

        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(receipt.templateId ?? '');
        const version = ts.getVersion(receipt.templateVersionId ?? '');
        const snapshot = template && version
          ? createReceiptTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), customerSnapshot(customerById(receipt.customerId), receipt.payerName))
          : undefined;

        const now = nowIso();
        const postedReceipt: Receipt = {
          ...receipt,
          status: deriveAllocatedStatus(receipt.amount, receipt.allocationTotal),
          journalEntryId: added.id,
          templateSnapshot: snapshot,
          postedAt: now,
          auditTrail: [...receipt.auditTrail, audit('posted', receipt.receiptNumber), audit('journal-created', added.id)],
          updatedAt: now,
        };
        set({ receipts: receipts.map((r) => (r.id === id ? postedReceipt : r)) });
        return { ok: true, id };
      },

      applyReceiptToInvoices: (id, allocations, date) => {
        const { receipts } = get();
        const receipt = receipts.find((r) => r.id === id);
        if (!receipt) return { ok: false, error: 'Receipt not found.' };
        if (!['posted', 'partially-allocated'].includes(receipt.status)) return { ok: false, error: 'Only a posted receipt with an unapplied balance can be applied.' };
        const total = Math.round(allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0) * 100) / 100;
        if (total <= 0) return { ok: false, error: 'Enter an allocation amount.' };
        if (total > receipt.unappliedAmount + 0.005) return { ok: false, error: 'Allocation exceeds the unapplied receipt amount.' };

        const invoiceStore = useInvoiceStore.getState();
        const now = nowIso();
        const newAllocations: ReceiptAllocation[] = [];
        for (const alloc of allocations) {
          const inv = invoiceStore.getInvoice(alloc.invoiceId);
          if (!inv) return { ok: false, error: 'Target invoice not found.' };
          if (inv.customerId !== receipt.customerId) return { ok: false, error: `Invoice ${inv.invoiceNumber} belongs to a different customer.` };
          if (inv.entityId !== receipt.entityId) return { ok: false, error: `Invoice ${inv.invoiceNumber} belongs to a different entity.` };
          if (inv.currency !== receipt.currency) return { ok: false, error: `Invoice ${inv.invoiceNumber} is in a different currency.` };
          const applied = invoiceStore.applyReceiptAllocation(alloc.invoiceId, {
            amount: alloc.amount, date: date ?? receipt.receiptDate, method: receipt.method, reference: receipt.receiptNumber,
            bankAccountId: receipt.bankAccountId ?? receipt.cashAccountId, receiptId: receipt.id, journalEntryId: receipt.journalEntryId,
          });
          if (!applied.ok) return { ok: false, error: applied.error };
          newAllocations.push({
            id: generateId('ralloc'), entityId: receipt.entityId, receiptId: receipt.id, customerId: receipt.customerId,
            invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, allocationType: 'invoice',
            amount: Math.round((Number(alloc.amount) || 0) * 100) / 100, baseCurrencyAmount: toBaseCurrency(alloc.amount, receipt.exchangeRate),
            allocationDate: date ?? receipt.receiptDate, createdAt: now, updatedAt: now,
          });
        }
        const merged = { ...receipt, allocations: [...receipt.allocations, ...newAllocations] };
        const t = calculateReceiptTotals(merged);
        set({ receipts: receipts.map((r) => (r.id === id ? { ...merged, allocationTotal: t.allocationTotal, unappliedAmount: t.unappliedAmount, status: deriveAllocatedStatus(t.amount, t.allocationTotal), auditTrail: [...r.auditTrail, audit('unapplied-amount-allocated', `${total.toFixed(2)}`)], updatedAt: now } : r)) });
        return { ok: true, id };
      },

      unapplyReceiptAllocation: (id, allocationId) => {
        const { receipts } = get();
        const receipt = receipts.find((r) => r.id === id);
        if (!receipt) return { ok: false, error: 'Receipt not found.' };
        const alloc = receipt.allocations.find((a) => a.id === allocationId && !a.reversed);
        if (!alloc) return { ok: false, error: 'Allocation not found.' };
        if (receipt.status === 'reversed' || receipt.status === 'void') return { ok: false, error: 'This receipt cannot be modified.' };

        // Remove just this allocation's payment from the invoice.
        if (alloc.invoiceId) {
          const inv = useInvoiceStore.getState().getInvoice(alloc.invoiceId);
          if (inv) {
            const remaining = inv.payments.filter((p) => p.receiptId === receipt.id && p.id !== undefined);
            // Rebuild the invoice's receipt payments minus this one allocation amount.
            useInvoiceStore.getState().removeReceiptAllocations(alloc.invoiceId, receipt.id);
            for (const other of receipt.allocations.filter((a) => a.invoiceId === alloc.invoiceId && a.id !== allocationId && !a.reversed)) {
              useInvoiceStore.getState().applyReceiptAllocation(alloc.invoiceId, { amount: other.amount, date: other.allocationDate, method: receipt.method, reference: receipt.receiptNumber, bankAccountId: receipt.bankAccountId ?? receipt.cashAccountId, receiptId: receipt.id, journalEntryId: receipt.journalEntryId });
            }
            void remaining;
          }
        }
        const allocations = receipt.allocations.map((a) => (a.id === allocationId ? { ...a, reversed: true } : a));
        const t = calculateReceiptTotals({ ...receipt, allocations });
        const now = nowIso();
        set({ receipts: receipts.map((r) => (r.id === id ? { ...r, allocations, allocationTotal: t.allocationTotal, unappliedAmount: t.unappliedAmount, status: deriveAllocatedStatus(t.amount, t.allocationTotal), auditTrail: [...r.auditTrail, audit('allocation-removed', alloc.invoiceNumber)], updatedAt: now } : r)) });
        return { ok: true, id };
      },

      reverseReceipt: (id, reason) => {
        const { receipts } = get();
        const receipt = receipts.find((r) => r.id === id);
        if (!receipt) return { ok: false, error: 'Receipt not found.' };
        if (receipt.status === 'reversed' || receipt.status === 'void') return { ok: false, error: 'Receipt is already reversed.' };
        if (receipt.status === 'draft') return { ok: false, error: 'Delete a draft rather than reversing it.' };
        if (!receipt.journalEntryId) return { ok: false, error: 'Only a posted receipt can be reversed.' };
        if (!reason.trim()) return { ok: false, error: 'A reversal reason is required.' };

        // Reverse the exact original journal lines.
        const reversal = useJournalStore.getState().reverseEntry(receipt.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal entry.' };

        // Reverse every invoice allocation back off the subledger.
        const invoiceStore = useInvoiceStore.getState();
        const invoiceIds = new Set(receipt.allocations.filter((a) => !a.reversed && a.invoiceId).map((a) => a.invoiceId!));
        for (const invId of invoiceIds) invoiceStore.removeReceiptAllocations(invId, receipt.id);

        const now = nowIso();
        set({
          receipts: receipts.map((r) => (r.id === id ? {
            ...r, status: 'reversed', reverseReason: reason.trim(), reversalJournalEntryId: reversal.id, reversedAt: now,
            allocations: r.allocations.map((a) => ({ ...a, reversed: true })), allocationTotal: 0, unappliedAmount: r.amount,
            auditTrail: [...r.auditTrail, audit('reversed', reason.trim()), audit('journal-created', `reversal ${reversal.id}`)],
            updatedAt: now,
          } : r)),
        });
        return { ok: true, id };
      },

      replaceAll: (receipts) => set({ receipts }),
      resetToDefault: () => set({ receipts: [], numbering: { [INVOICE_ENTITY_ID]: makeDefaultReceiptNumberingConfig(INVOICE_ENTITY_ID) } }),
    }),
    { name: 'ledgerly-receipts', storage: businessJSONStorage, version: 1 },
  ),
);

function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
