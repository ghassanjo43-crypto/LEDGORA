import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type {
  Invoice,
  InvoiceAuditEvent,
  InvoiceCompanySnapshot,
  InvoiceCustomerSnapshot,
  InvoiceLine,
  InvoicePayment,
} from '@/types/invoice';
import type { CostCenter } from '@/types/costCenter';
import { calculateInvoiceTotals, recalcInvoiceLine, calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { roundTo } from '@/lib/currencyConversion';
// Call-time-only import (cycle-safe: currencyStore also reads this store lazily
// for its usage guards — neither touches the other during module evaluation).
import { useCurrencyStore } from './currencyStore';
import { buildInvoiceJournalEntry, buildInvoicePaymentJournalEntry } from '@/lib/invoicePosting';
import { validateInvoiceForIssue } from '@/lib/invoiceValidation';
import { validateDocumentCostCenters } from '@/lib/costCenterDocumentValidation';
import { validateDocumentProjects } from '@/lib/projectDocumentValidation';
import { createInvoiceTemplateSnapshot } from '@/lib/invoiceTemplates';
import { useInventoryStore, inventoryEnabled } from '@/store/inventoryStore';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';

const ACTOR = 'Finance Manager';

export interface InvoiceActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function accountsMap(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function accountByCode(code: string): Account | undefined {
  return useStore.getState().accounts.find((a) => a.code === code);
}
function customerById(id: string): BusinessEntity | undefined {
  return useEntityStore.getState().entities.find((e) => e.id === id);
}
function costCentersMap(): Map<string, CostCenter> {
  return new Map(useCostCenterStore.getState().costCenters.map((c) => [c.id, c]));
}
function projectsMap() {
  return new Map(useProjectStore.getState().projects.map((p) => [p.id, p]));
}

function companySnapshot(settings: CompanySettings): InvoiceCompanySnapshot {
  const address = [settings.addressLine1, settings.addressLine2, settings.city, settings.stateProvince, settings.postalCode, settings.country]
    .filter(Boolean)
    .join(', ');
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
function customerSnapshot(entity: BusinessEntity | undefined): InvoiceCustomerSnapshot {
  if (!entity) return { name: 'Unknown customer' };
  const billingAddress = [entity.addressLine1, entity.addressLine2, entity.city, entity.country, entity.postalCode].filter(Boolean).join(', ');
  return {
    name: entity.legalName,
    billingAddress: billingAddress || undefined,
    taxNumber: entity.taxRegistrationNumber || undefined,
    phone: entity.phone || undefined,
    email: entity.email || undefined,
  };
}

function audit(action: string, detail?: string): InvoiceAuditEvent {
  return { id: generateId('iaud'), at: nowIso(), action, detail };
}

/** The document currency's configured monetary precision (Currency Master). */
function documentDecimals(currencyCode: string): number {
  return useCurrencyStore.getState().getCurrency(currencyCode)?.decimalPlaces ?? 2;
}

/** Recompute derived totals from the current lines at the DOCUMENT currency's precision. */
function withTotals(inv: Invoice): Invoice {
  const dp = documentDecimals(inv.currency);
  const lines = inv.lines.map((l) => recalcInvoiceLine(l, dp));
  const t = calculateInvoiceTotals(lines, inv.additionalChargesTotal, inv.amountPaid, dp);
  const creditsApplied = roundTo(inv.creditsApplied ?? 0, dp);
  const balanceDue = roundTo(t.grandTotal - t.amountPaid - creditsApplied, dp);
  return { ...inv, lines, subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal, creditsApplied, balanceDue, updatedAt: nowIso() };
}

export function makeEmptyInvoiceLine(sortOrder: number): InvoiceLine {
  return { id: generateId('iline'), accountId: '', description: '', quantity: 1, unitPrice: 0, taxRate: 0, taxAmount: 0, lineSubtotal: 0, lineTotal: 0, sortOrder };
}

interface InvoiceState {
  invoices: Invoice[];

  getInvoice: (id: string) => Invoice | undefined;
  usedNumbers: () => Set<string>;
  /** A snapshot for rendering: the frozen one if issued, else built live from the resolved version. */
  previewSnapshot: (id: string) => import('@/types/invoice').InvoiceTemplateSnapshot | null;

  createDraft: (input: { customerId?: string; issueDate?: string; dueDate?: string; currency?: string; overrideTemplateVersionId?: string }) => InvoiceActionResult;
  updateDraft: (id: string, patch: Partial<Invoice>) => InvoiceActionResult;
  deleteDraft: (id: string) => InvoiceActionResult;
  duplicateInvoice: (id: string) => InvoiceActionResult;

  issueInvoice: (id: string) => InvoiceActionResult;
  markSent: (id: string) => InvoiceActionResult;
  recordPayment: (id: string, input: { amount: number; date: string; bankAccountId: string; method?: string; reference?: string }) => InvoiceActionResult;
  /** Allocate credit-note value against this invoice (subledger; no cash journal). */
  applyCredit: (id: string, amount: number, creditNoteNumber?: string) => InvoiceActionResult;
  /** Undo a previously-applied credit (used when a credit note is voided). */
  reverseCredit: (id: string, amount: number, creditNoteNumber?: string) => InvoiceActionResult;
  /** Record a posted Receipt allocation against this invoice (subledger; the receipt posts the cash journal). */
  applyReceiptAllocation: (id: string, input: { amount: number; date: string; method: string; reference?: string; bankAccountId?: string; receiptId: string; journalEntryId?: string }) => InvoiceActionResult;
  /** Remove every payment linked to a receipt (used when a receipt is reversed). */
  removeReceiptAllocations: (id: string, receiptId: string) => InvoiceActionResult;
  voidInvoice: (id: string, reason: string) => InvoiceActionResult;

  replaceAll: (invoices: Invoice[]) => void;
  resetToDefault: () => void;
}

export const useInvoiceStore = create<InvoiceState>()(
  persist(
    (set, get) => ({
      invoices: [],

      getInvoice: (id) => get().invoices.find((i) => i.id === id),
      usedNumbers: () => new Set(get().invoices.map((i) => i.invoiceNumber).filter(Boolean)),

      previewSnapshot: (id) => {
        const invoice = get().invoices.find((i) => i.id === id);
        if (!invoice) return null;
        if (invoice.templateSnapshot) return invoice.templateSnapshot;
        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(invoice.templateId);
        const version = ts.getVersion(invoice.templateVersionId);
        if (!template || !version) return null;
        return createInvoiceTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), customerSnapshot(customerById(invoice.customerId)));
      },

      createDraft: (input) => {
        const templates = useInvoiceTemplateStore.getState();
        const settings = useStore.getState().settings;
        const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10);
        const customer = input.customerId ? customerById(input.customerId) : undefined;

        const resolved = templates.resolve({
          entityId: INVOICE_ENTITY_ID,
          customerDefaultTemplateId: customer?.defaultInvoiceTemplateId,
          invoiceDate: issueDate,
          invoiceTemplateVersionId: input.overrideTemplateVersionId,
        });

        const number = templates.takeInvoiceNumber(INVOICE_ENTITY_ID, get().usedNumbers(), issueDate);
        const dueDate = input.dueDate ?? issueDate;
        const now = nowIso();
        const invoice: Invoice = {
          id: generateId('inv'),
          entityId: INVOICE_ENTITY_ID,
          customerId: input.customerId ?? '',
          invoiceNumber: number,
          status: 'draft',
          issueDate,
          dueDate,
          currency: input.currency ?? customer?.defaultCurrency ?? settings.baseCurrency,
          exchangeRate: 1,
          templateId: resolved.templateId,
          templateVersionId: resolved.templateVersionId,
          templateResolutionSource: resolved.resolutionSource,
          lines: [makeEmptyInvoiceLine(1)],
          subtotal: 0, discountTotal: 0, taxTotal: 0, additionalChargesTotal: 0, grandTotal: 0, amountPaid: 0, creditsApplied: 0, balanceDue: 0,
          payments: [],
          auditTrail: [audit('invoice-created'), audit('template-resolved', `${resolved.resolutionSource}`)],
          createdAt: now, updatedAt: now,
        };
        set({ invoices: [...get().invoices, invoice] });
        return { ok: true, id: invoice.id };
      },

      updateDraft: (id, patch) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft invoices can be edited.' };
        const merged = withTotals({ ...existing, ...patch });
        set({ invoices: invoices.map((i) => (i.id === id ? merged : i)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft invoices can be deleted. Void issued invoices instead.' };
        set({ invoices: invoices.filter((i) => i.id !== id) });
        return { ok: true, id };
      },

      duplicateInvoice: (id) => {
        const { invoices } = get();
        const src = invoices.find((i) => i.id === id);
        if (!src) return { ok: false, error: 'Invoice not found.' };
        const issueDate = new Date().toISOString().slice(0, 10);
        const number = useInvoiceTemplateStore.getState().takeInvoiceNumber(INVOICE_ENTITY_ID, get().usedNumbers(), issueDate);
        const now = nowIso();
        const copy: Invoice = {
          ...structuredCopy(src),
          id: generateId('inv'), invoiceNumber: number, status: 'draft', issueDate, dueDate: issueDate,
          templateSnapshot: undefined, journalEntryId: undefined, reversalJournalEntryId: undefined, voidReason: undefined,
          amountPaid: 0, creditsApplied: 0, payments: [], issuedAt: undefined, sentAt: undefined, paidAt: undefined, voidedAt: undefined,
          auditTrail: [audit('invoice-created', `duplicated from ${src.invoiceNumber}`)], createdAt: now, updatedAt: now,
        };
        set({ invoices: [...invoices, withTotals(copy)] });
        return { ok: true, id: copy.id };
      },

      issueInvoice: (id) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'draft' && existing.status !== 'approved') return { ok: false, error: 'Only draft invoices can be issued.' };

        const templatesStore = useInvoiceTemplateStore.getState();
        const version = templatesStore.getVersion(existing.templateVersionId);
        const template = templatesStore.getTemplate(existing.templateId);
        const customer = customerById(existing.customerId);
        const receivable = customer?.defaultReceivableAccount || accountByCode('1221')?.id || '';

        const invoice = withTotals(existing);
        const issues = validateInvoiceForIssue(invoice, {
          templateVersionPublished: version?.status === 'published',
          hasReceivableAccount: !!receivable,
          invoiceNumberUnique: invoices.filter((i) => i.invoiceNumber === invoice.invoiceNumber).length <= 1,
        });
        if (issues.length > 0) return { ok: false, error: issues[0]!.message };
        if (!template || !version) return { ok: false, error: 'Template version unavailable.' };

        // Cost-center rules must pass before the revenue journal is created.
        const ccIssues = validateDocumentCostCenters(
          invoice.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, amount: calculateInvoiceLine(l).taxableAmount, costCenterId: l.costCenterId, costCenterAssignments: l.costCenterAssignments, label: l.description })),
          { entityId: invoice.entityId, postingDate: invoice.issueDate, transactionType: 'Sales Invoice', accountsById: accountsMap(), costCentersById: costCentersMap(), requirementRules: useCostCenterStore.getState().requirementRules },
        );
        if (ccIssues.length > 0) return { ok: false, error: ccIssues[0]!.message };
        const prjIssues = validateDocumentProjects(
          invoice.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, projectId: l.projectId, label: l.description })),
          { entityId: invoice.entityId, postingDate: invoice.issueDate, transactionType: 'Sales Invoice', accountsById: accountsMap(), projectsById: projectsMap(), requirementRules: useProjectStore.getState().requirementRules },
        );
        if (prjIssues.length > 0) return { ok: false, error: prjIssues[0]!.message };

        // Inventory: issue stock (Dr COGS / Cr Inventory + outbound movements)
        // for issue-on-invoice lines BEFORE the revenue journal, so insufficient
        // stock blocks the whole issue atomically. Service lines create nothing.
        let inventoryDocId: string | undefined;
        if (inventoryEnabled()) {
          const issueLines = invoice.lines.filter((l) => l.inventoryFulfillmentMode === 'issue-on-invoice' && l.inventoryItemId && l.warehouseId);
          if (issueLines.length > 0) {
            const invRes = useInventoryStore.getState().postInvoiceIssue({
              date: invoice.issueDate,
              reference: invoice.invoiceNumber,
              lines: issueLines.map((l) => ({ id: l.id, itemId: l.inventoryItemId!, warehouseId: l.warehouseId!, quantity: l.quantity, unitId: '' })),
            });
            if (!invRes.ok) return { ok: false, error: invRes.error };
            inventoryDocId = invRes.id;
          }
        }

        // Post through the existing General Journal service (never the ledger directly).
        const journal = useJournalStore.getState();
        const je = buildInvoiceJournalEntry(invoice, {
          accountsById: accountsMap(),
          receivableAccountId: receivable,
          taxPayableAccountId: accountByCode('2270')?.id,
          customer,
          createdBy: ACTOR,
        });
        const rollbackInventory = (): void => { if (inventoryDocId) useInventoryStore.getState().reverseDocument(inventoryDocId); };
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) { rollbackInventory(); return { ok: false, error: added.error ?? 'Could not create the sales journal entry.' }; }
        const posted = journal.postEntry(added.id);
        if (!posted.ok) { rollbackInventory(); return { ok: false, error: posted.error ?? 'Could not post the sales journal entry.' }; }

        // Preserve the weighted-average cost each inventory line was issued at.
        if (inventoryDocId) {
          const movements = useInventoryStore.getState().movements.filter((m) => m.sourceDocumentId === inventoryDocId);
          invoice.lines = invoice.lines.map((l) => {
            const mv = movements.find((m) => m.sourceLineId === l.id);
            return mv ? { ...l, issuedUnitCost: mv.unitCostBase } : l;
          });
        }

        const snapshot = createInvoiceTemplateSnapshot(
          template,
          version,
          companySnapshot(useStore.getState().settings),
          customerSnapshot(customer),
        );
        const now = nowIso();
        const issued: Invoice = {
          ...invoice,
          status: 'issued',
          templateSnapshot: snapshot,
          journalEntryId: added.id,
          issuedAt: now,
          auditTrail: [...invoice.auditTrail, audit('invoice-issued', invoice.invoiceNumber), audit('journal-entry-created', added.id)],
          updatedAt: now,
        };
        set({ invoices: invoices.map((i) => (i.id === id ? issued : i)) });
        return { ok: true, id };
      },

      markSent: (id) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'issued') return { ok: false, error: 'Only issued invoices can be marked as sent.' };
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, status: 'sent', sentAt: nowIso(), auditTrail: [...i.auditTrail, audit('invoice-sent')], updatedAt: nowIso() } : i)) });
        return { ok: true, id };
      },

      recordPayment: (id, input) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (!['issued', 'sent', 'partially-paid'].includes(existing.status)) return { ok: false, error: 'Only an issued invoice can receive payments.' };
        if (input.amount <= 0) return { ok: false, error: 'Payment amount must be positive.' };
        if (input.amount > existing.balanceDue + 0.005) return { ok: false, error: 'Payment exceeds the balance due.' };
        if (!input.bankAccountId) return { ok: false, error: 'Select the bank/cash account.' };

        const payment: InvoicePayment = {
          id: generateId('ipay'), invoiceId: id, date: input.date, amount: input.amount, method: input.method ?? 'bank',
          reference: input.reference, bankAccountId: input.bankAccountId, createdAt: nowIso(),
        };
        const journal = useJournalStore.getState();
        const je = buildInvoicePaymentJournalEntry(existing, payment, { accountsById: accountsMap(), receivableAccountId: customerById(existing.customerId)?.defaultReceivableAccount || accountByCode('1221')?.id || '', customer: customerById(existing.customerId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the receipt journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the receipt.' };
        payment.journalEntryId = added.id;

        const amountPaid = Math.round((existing.amountPaid + input.amount) * 100) / 100;
        const balanceDue = Math.round((existing.grandTotal - amountPaid - (existing.creditsApplied ?? 0)) * 100) / 100;
        const status = balanceDue <= 0.005 ? 'paid' : 'partially-paid';
        const now = nowIso();
        set({
          invoices: invoices.map((i) => (i.id === id ? {
            ...i, amountPaid, balanceDue, status,
            payments: [...i.payments, payment],
            paidAt: status === 'paid' ? now : i.paidAt,
            auditTrail: [...i.auditTrail, audit('payment-recorded', `${input.amount.toFixed(2)} — ${added.id}`)],
            updatedAt: now,
          } : i)),
        });
        return { ok: true, id };
      },

      applyCredit: (id, amount, creditNoteNumber) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status === 'void' || existing.status === 'draft') return { ok: false, error: 'Credit can only be applied to an issued invoice.' };
        const amt = Math.round((Number(amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: false, error: 'Credit amount must be positive.' };
        if (amt > existing.balanceDue + 0.005) return { ok: false, error: 'Credit exceeds the invoice balance due.' };

        const creditsApplied = Math.round((existing.creditsApplied + amt) * 100) / 100;
        const balanceDue = Math.round((existing.grandTotal - existing.amountPaid - creditsApplied) * 100) / 100;
        const status = balanceDue <= 0.005 ? 'paid' : existing.amountPaid > 0 || creditsApplied > 0 ? 'partially-paid' : existing.status;
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, creditsApplied, balanceDue, status, auditTrail: [...i.auditTrail, audit('credit-applied', `${amt.toFixed(2)}${creditNoteNumber ? ` — ${creditNoteNumber}` : ''}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      reverseCredit: (id, amount, creditNoteNumber) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        const amt = Math.round((Number(amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: true, id };
        const creditsApplied = Math.round(Math.max(0, existing.creditsApplied - amt) * 100) / 100;
        const balanceDue = Math.round((existing.grandTotal - existing.amountPaid - creditsApplied) * 100) / 100;
        const status =
          balanceDue <= 0.005 ? 'paid' : existing.amountPaid <= 0.005 && creditsApplied <= 0.005 ? 'issued' : 'partially-paid';
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, creditsApplied, balanceDue, status, auditTrail: [...i.auditTrail, audit('credit-reversed', `${amt.toFixed(2)}${creditNoteNumber ? ` — ${creditNoteNumber}` : ''}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      applyReceiptAllocation: (id, input) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status === 'void' || existing.status === 'draft') return { ok: false, error: 'Receipts can only be allocated to an issued invoice.' };
        const amt = Math.round((Number(input.amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: false, error: 'Allocation amount must be positive.' };
        if (amt > existing.balanceDue + 0.005) return { ok: false, error: 'Allocation exceeds the invoice balance due.' };

        const payment: InvoicePayment = {
          id: generateId('ipay'), invoiceId: id, date: input.date, amount: amt, method: input.method,
          reference: input.reference, bankAccountId: input.bankAccountId ?? '', journalEntryId: input.journalEntryId, receiptId: input.receiptId, createdAt: nowIso(),
        };
        const amountPaid = Math.round((existing.amountPaid + amt) * 100) / 100;
        const balanceDue = Math.round((existing.grandTotal - amountPaid - existing.creditsApplied) * 100) / 100;
        const status = balanceDue <= 0.005 ? 'paid' : 'partially-paid';
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, amountPaid, balanceDue, status, payments: [...i.payments, payment], paidAt: status === 'paid' ? now : i.paidAt, auditTrail: [...i.auditTrail, audit('receipt-allocated', `${amt.toFixed(2)} — ${input.reference ?? input.receiptId}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      removeReceiptAllocations: (id, receiptId) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        const linked = existing.payments.filter((p) => p.receiptId === receiptId);
        if (linked.length === 0) return { ok: true, id };
        const removed = Math.round(linked.reduce((s, p) => s + p.amount, 0) * 100) / 100;
        const amountPaid = Math.round(Math.max(0, existing.amountPaid - removed) * 100) / 100;
        const balanceDue = Math.round((existing.grandTotal - amountPaid - existing.creditsApplied) * 100) / 100;
        const status = balanceDue <= 0.005 ? 'paid' : amountPaid <= 0.005 && existing.creditsApplied <= 0.005 ? 'issued' : 'partially-paid';
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, amountPaid, balanceDue, status, payments: i.payments.filter((p) => p.receiptId !== receiptId), auditTrail: [...i.auditTrail, audit('receipt-allocation-reversed', `${removed.toFixed(2)}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      voidInvoice: (id, reason) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status === 'void') return { ok: false, error: 'Invoice is already void.' };
        if (!existing.journalEntryId) return { ok: false, error: 'Only a posted (issued) invoice can be voided.' };
        if (!reason.trim()) return { ok: false, error: 'A void reason is required.' };

        const reversal = useJournalStore.getState().reverseEntry(existing.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal entry.' };
        const now = nowIso();
        set({
          invoices: invoices.map((i) => (i.id === id ? {
            ...i, status: 'void', voidReason: reason.trim(), reversalJournalEntryId: reversal.id, voidedAt: now,
            auditTrail: [...i.auditTrail, audit('invoice-voided', reason.trim()), audit('journal-entry-created', `reversal ${reversal.id}`)],
            updatedAt: now,
          } : i)),
        });
        return { ok: true, id };
      },

      replaceAll: (invoices) => set({ invoices }),
      resetToDefault: () => set({ invoices: [] }),
    }),
    {
      name: 'ledgerly-invoices', storage: businessJSONStorage,
      version: 2,
      // v2 adds `creditsApplied` (credit-note subledger allocation). Backfill 0
      // and recompute balanceDue so persisted invoices load consistently.
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as { invoices?: Invoice[] };
        const invoices = (p.invoices ?? []).map((i) => {
          const creditsApplied = i.creditsApplied ?? 0;
          return { ...i, creditsApplied, balanceDue: Math.round((i.grandTotal - i.amountPaid - creditsApplied) * 100) / 100 };
        });
        return { invoices };
      },
    },
  ),
);

function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
