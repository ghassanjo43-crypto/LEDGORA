import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type { InvoiceCompanySnapshot, InvoiceCustomerSnapshot, InvoiceTemplateSnapshot } from '@/types/invoice';
import type {
  CreditApplication,
  CreditNote,
  CreditNoteAuditEvent,
  CreditNoteNumberingConfig,
  CreditNotePostingConfig,
  CreditNoteRefund,
  CreditType,
} from '@/types/creditNote';
import { calculateCreditNoteTotals, recalcCreditNoteLine } from '@/lib/creditNoteCalculations';
import { buildPrefilledCreditLines, calculateInvoiceCreditSummary, calculateRemainingCreditableQuantity } from '@/lib/creditNoteCreditable';
import { generateCreditNoteNumber, makeDefaultCreditNoteNumberingConfig } from '@/lib/creditNoteNumbering';
import { buildCreditNoteJournalEntry, buildCreditNoteRefundJournalEntry, buildInventoryReturnJournalEntry } from '@/lib/creditNotePosting';
import { validateCreditNoteForIssue } from '@/lib/creditNoteValidation';
import { createCreditNoteTemplateSnapshot } from '@/lib/creditNoteTemplate';
import { buildCreditNoteInvoiceReference } from '@/lib/creditNoteInvoiceReference';
import { calculateRemainingCredit, deriveIssuedStatus } from '@/lib/creditNoteApplications';
import { useInventoryStore, inventoryEnabled } from '@/store/inventoryStore';
import type { CreditNoteInvoiceReferenceSnapshot } from '@/types/creditNote';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';

const ACTOR = 'Finance Manager';

export interface CreditNoteActionResult {
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
function customerById(id: string): BusinessEntity | undefined {
  return useEntityStore.getState().entities.find((e) => e.id === id);
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
function customerSnapshot(entity: BusinessEntity | undefined): InvoiceCustomerSnapshot {
  if (!entity) return { name: 'Unknown customer' };
  const billingAddress = [entity.addressLine1, entity.addressLine2, entity.city, entity.country, entity.postalCode].filter(Boolean).join(', ');
  return { name: entity.legalName, billingAddress: billingAddress || undefined, taxNumber: entity.taxRegistrationNumber || undefined, phone: entity.phone || undefined, email: entity.email || undefined };
}

/** Resolve the chart-of-accounts routing for a credit-note posting. */
function postingConfig(customerId: string): CreditNotePostingConfig {
  const customer = customerById(customerId);
  return {
    customerReceivablesAccountId: customer?.defaultReceivableAccount || accountByCode('1221')?.id || '',
    salesReturnsAccountId: accountByCode('4130')?.id,
    outputTaxAccountId: accountByCode('2270')?.id,
  };
}

function audit(action: string, detail?: string): CreditNoteAuditEvent {
  return { id: generateId('cnaud'), at: nowIso(), action, detail };
}

/** Recompute derived totals from the current lines. */
function withTotals(cn: CreditNote): CreditNote {
  const lines = cn.lines.map(recalcCreditNoteLine);
  const t = calculateCreditNoteTotals(lines);
  const remainingCredit = calculateRemainingCredit({ grandTotal: t.grandTotal, amountApplied: cn.amountApplied, amountRefunded: cn.amountRefunded });
  return { ...cn, lines, subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal, remainingCredit, updatedAt: nowIso() };
}

/* ───────────────────────────────── Store ────────────────────────────────── */

interface CreditNoteState {
  creditNotes: CreditNote[];
  numbering: Record<string, CreditNoteNumberingConfig>;

  getCreditNoteById: (id: string) => CreditNote | undefined;
  getCreditNotesForInvoice: (invoiceId: string) => CreditNote[];
  getCreditNotesForCustomer: (customerId: string) => CreditNote[];
  usedNumbers: () => Set<string>;
  previewSnapshot: (id: string) => InvoiceTemplateSnapshot | null;
  /** The frozen original-invoice reference if issued, else a live-computed one. */
  invoiceReference: (id: string) => CreditNoteInvoiceReferenceSnapshot | null;

  getNumbering: (entityId: string) => CreditNoteNumberingConfig;
  takeCreditNoteNumber: (entityId: string, usedNumbers: Set<string>, date: string) => string;

  createCreditNoteFromInvoice: (invoiceId: string, opts?: { creditType?: CreditType }) => CreditNoteActionResult;
  saveCreditNoteDraft: (id: string, patch: Partial<CreditNote>) => CreditNoteActionResult;
  updateCreditNote: (id: string, patch: Partial<CreditNote>) => CreditNoteActionResult;
  deleteDraft: (id: string) => CreditNoteActionResult;
  duplicateCreditNote: (id: string) => CreditNoteActionResult;

  approveCreditNote: (id: string) => CreditNoteActionResult;
  issueCreditNote: (id: string, opts?: { autoApplyToOriginal?: boolean }) => CreditNoteActionResult;
  /** Void an issued note and open a pre-filled replacement draft (returns the new id). */
  correctCreditNote: (id: string) => CreditNoteActionResult;
  applyCreditNote: (creditNoteId: string, invoiceId: string, amount: number, date?: string) => CreditNoteActionResult;
  refundCreditNote: (id: string, input: { amount: number; refundDate: string; bankAccountId: string; reference?: string; memo?: string }) => CreditNoteActionResult;
  voidCreditNote: (id: string, reason: string) => CreditNoteActionResult;

  replaceAll: (creditNotes: CreditNote[]) => void;
  resetToDefault: () => void;
}

export const useCreditNoteStore = create<CreditNoteState>()(
  persist(
    (set, get) => ({
      creditNotes: [],
      numbering: { [INVOICE_ENTITY_ID]: makeDefaultCreditNoteNumberingConfig(INVOICE_ENTITY_ID) },

      getCreditNoteById: (id) => get().creditNotes.find((c) => c.id === id),
      getCreditNotesForInvoice: (invoiceId) => get().creditNotes.filter((c) => c.originalInvoiceId === invoiceId),
      getCreditNotesForCustomer: (customerId) => get().creditNotes.filter((c) => c.customerId === customerId),
      usedNumbers: () => new Set(get().creditNotes.map((c) => c.creditNoteNumber).filter(Boolean)),

      previewSnapshot: (id) => {
        const cn = get().creditNotes.find((c) => c.id === id);
        if (!cn) return null;
        if (cn.templateSnapshot) return cn.templateSnapshot;
        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(cn.templateId);
        const version = ts.getVersion(cn.templateVersionId);
        if (!template || !version) return null;
        return createCreditNoteTemplateSnapshot(template, version, companySnapshot(useStore.getState().settings), customerSnapshot(customerById(cn.customerId)));
      },

      invoiceReference: (id) => {
        const cn = get().creditNotes.find((c) => c.id === id);
        if (!cn) return null;
        if (cn.invoiceReferenceSnapshot) return cn.invoiceReferenceSnapshot; // frozen at issue
        if (!cn.originalInvoiceId) return null;
        const invoice = useInvoiceStore.getState().getInvoice(cn.originalInvoiceId);
        if (!invoice) return null;
        return buildCreditNoteInvoiceReference(cn, invoice, get().creditNotes);
      },

      getNumbering: (entityId) => get().numbering[entityId] ?? makeDefaultCreditNoteNumberingConfig(entityId),
      takeCreditNoteNumber: (entityId, usedNumbers, date) => {
        const cfg = get().getNumbering(entityId);
        const { number, nextConfig } = generateCreditNoteNumber(cfg, usedNumbers, date);
        set((s) => ({ numbering: { ...s.numbering, [entityId]: nextConfig } }));
        return number;
      },

      createCreditNoteFromInvoice: (invoiceId, opts) => {
        const invoice = useInvoiceStore.getState().getInvoice(invoiceId);
        if (!invoice) return { ok: false, error: 'Original invoice not found.' };
        if (invoice.status === 'draft' || invoice.status === 'void') {
          return { ok: false, error: 'Only an issued invoice can be credited. Draft or void invoices cannot.' };
        }

        const creditType: CreditType = opts?.creditType ?? 'selected-lines';
        const issueDate = new Date().toISOString().slice(0, 10);
        const number = get().takeCreditNoteNumber(INVOICE_ENTITY_ID, get().usedNumbers(), issueDate);
        const id = generateId('cn');
        const lines = buildPrefilledCreditLines(invoice, get().creditNotes, creditType, id).map((l) => ({ ...l, creditNoteId: id }));
        const now = nowIso();

        const draft: CreditNote = {
          id,
          entityId: invoice.entityId,
          customerId: invoice.customerId,
          creditNoteNumber: number,
          originalInvoiceId: invoice.id,
          originalInvoiceNumber: invoice.invoiceNumber,
          originalInvoiceDate: invoice.issueDate,
          status: 'draft',
          creditType,
          issueDate,
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate || 1,
          reasonCode: 'goods-returned',
          reasonDescription: '',
          templateId: invoice.templateId,
          templateVersionId: invoice.templateVersionId,
          templateResolutionSource: invoice.templateResolutionSource,
          lines,
          subtotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0,
          amountApplied: 0, amountRefunded: 0, remainingCredit: 0,
          applications: [], refunds: [],
          auditTrail: [audit('credit-note-created'), audit('original-invoice-linked', invoice.invoiceNumber), audit('lines-selected', `${lines.length} line(s)`)],
          createdAt: now, updatedAt: now,
        };
        set({ creditNotes: [...get().creditNotes, withTotals(draft)] });
        return { ok: true, id };
      },

      updateCreditNote: (id, patch) => {
        const { creditNotes } = get();
        const existing = creditNotes.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Credit note not found.' };
        if (existing.status !== 'draft' && existing.status !== 'approved') return { ok: false, error: 'Only draft or approved credit notes can be edited. Void and replace an issued one instead.' };
        const merged = withTotals({ ...existing, ...patch, lines: (patch.lines ?? existing.lines).map((l) => ({ ...l, creditNoteId: id })) });
        set({ creditNotes: creditNotes.map((c) => (c.id === id ? merged : c)) });
        return { ok: true, id };
      },
      saveCreditNoteDraft: (id, patch) => get().updateCreditNote(id, patch),

      deleteDraft: (id) => {
        const { creditNotes } = get();
        const existing = creditNotes.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Credit note not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft credit notes can be deleted. Void issued ones instead.' };
        set({ creditNotes: creditNotes.filter((c) => c.id !== id) });
        return { ok: true, id };
      },

      duplicateCreditNote: (id) => {
        const { creditNotes } = get();
        const src = creditNotes.find((c) => c.id === id);
        if (!src) return { ok: false, error: 'Credit note not found.' };
        const issueDate = new Date().toISOString().slice(0, 10);
        const number = get().takeCreditNoteNumber(INVOICE_ENTITY_ID, get().usedNumbers(), issueDate);
        const newId = generateId('cn');
        const now = nowIso();
        const copy: CreditNote = {
          ...structuredCopy(src),
          id: newId, creditNoteNumber: number, status: 'draft', issueDate,
          templateSnapshot: undefined, journalEntryId: undefined, inventoryJournalEntryId: undefined, reversalJournalEntryId: undefined,
          amountApplied: 0, amountRefunded: 0, remainingCredit: 0, applications: [], refunds: [],
          issuedAt: undefined, appliedAt: undefined, refundedAt: undefined, voidedAt: undefined, voidReason: undefined,
          lines: src.lines.map((l) => ({ ...l, id: generateId('cnline'), creditNoteId: newId })),
          auditTrail: [audit('credit-note-created', `duplicated from ${src.creditNoteNumber}`)],
          createdAt: now, updatedAt: now,
        };
        set({ creditNotes: [...creditNotes, withTotals(copy)] });
        return { ok: true, id: newId };
      },

      approveCreditNote: (id) => {
        const { creditNotes } = get();
        const existing = creditNotes.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Credit note not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only a draft credit note can be approved.' };
        set({ creditNotes: creditNotes.map((c) => (c.id === id ? { ...c, status: 'approved', auditTrail: [...c.auditTrail, audit('approved')], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      issueCreditNote: (id, opts) => {
        const { creditNotes } = get();
        const existing = creditNotes.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Credit note not found.' };
        if (existing.status !== 'draft' && existing.status !== 'approved') return { ok: false, error: 'Only a draft credit note can be issued.' };

        const cn = withTotals(existing);
        const ts = useInvoiceTemplateStore.getState();
        const template = ts.getTemplate(cn.templateId);
        const version = ts.getVersion(cn.templateVersionId);
        const customer = customerById(cn.customerId);
        const config = postingConfig(cn.customerId);
        const invoice = cn.originalInvoiceId ? useInvoiceStore.getState().getInvoice(cn.originalInvoiceId) : undefined;
        const inheritSnapshot = invoice?.templateSnapshot;

        // Creditable context (excluding this note so its own draft value is not double-counted).
        const requiresOriginalInvoice = cn.creditType !== 'general-credit';
        const summary = invoice ? calculateInvoiceCreditSummary(invoice, creditNotes, cn.id) : { availableToCredit: Infinity, originalTotal: 0, previouslyCredited: 0 };
        const otherNotes = invoice ? creditNotes.filter((c) => c.originalInvoiceId === invoice.id && c.id !== cn.id && c.status !== 'draft' && c.status !== 'void') : [];
        const remainingTax = invoice ? Math.max(0, Math.round((invoice.taxTotal - otherNotes.reduce((s, c) => s + c.taxTotal, 0)) * 100) / 100) : Infinity;
        const remainingQuantityByInvoiceLine = new Map<string, number>();
        if (invoice) {
          for (const line of invoice.lines) {
            remainingQuantityByInvoiceLine.set(line.id, calculateRemainingCreditableQuantity(line, creditNotes, invoice.id, cn.id));
          }
        }

        const issues = validateCreditNoteForIssue(cn, {
          templateVersionPublished: version?.status === 'published' || !!inheritSnapshot,
          hasReceivableAccount: !!config.customerReceivablesAccountId,
          numberUnique: creditNotes.filter((c) => c.creditNoteNumber === cn.creditNoteNumber).length <= 1,
          originalInvoiceCreditable: !!invoice && invoice.status !== 'draft' && invoice.status !== 'void',
          requiresOriginalInvoice,
          availableToCredit: summary.availableToCredit,
          remainingTax,
          remainingQuantityByInvoiceLine,
        });
        if (issues.length > 0) return { ok: false, error: issues[0]!.message };
        if ((!template || !version) && !inheritSnapshot) return { ok: false, error: 'Template version unavailable.' };

        // Post the sales-return journal through the existing General Journal service.
        const journal = useJournalStore.getState();
        const je = buildCreditNoteJournalEntry(cn, { accountsById: accountsMap(), config, customer, createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the credit-note journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the credit-note journal entry.' };

        // Optional inventory return (only posts when cost data + accounts exist).
        let inventoryJournalEntryId: string | undefined;
        const invJe = buildInventoryReturnJournalEntry(cn, { accountsById: accountsMap(), config, customer, createdBy: ACTOR });
        if (invJe) {
          const invAdded = journal.addEntry(invJe);
          if (invAdded.ok && invAdded.id) { journal.postEntry(invAdded.id); inventoryJournalEntryId = invAdded.id; }
        }
        // Record the inbound stock movements (Dr Inventory / Cr COGS at original
        // cost) linked to that inventory-return journal so the subledger matches.
        if (inventoryEnabled() && inventoryJournalEntryId) {
          const returnLines = cn.lines.filter((l) => l.returnToInventory && l.inventoryItemId && l.returnWarehouseId && (Number(l.costAmount) || 0) > 0 && l.quantity > 0);
          if (returnLines.length > 0) {
            useInventoryStore.getState().recordLinkedMovements({
              date: cn.issueDate,
              reference: cn.creditNoteNumber,
              journalEntryId: inventoryJournalEntryId,
              kind: 'customer-return',
              lines: returnLines.map((l) => ({ id: l.id, itemId: l.inventoryItemId!, warehouseId: l.returnWarehouseId!, quantity: l.quantity, direction: 'in' as const, unitCost: (Number(l.costAmount) || 0) / l.quantity })),
            });
          }
        }

        const snapshot = createCreditNoteTemplateSnapshot(
          template!, version!, companySnapshot(useStore.getState().settings), customerSnapshot(customer), inheritSnapshot,
        );
        // Freeze the original-invoice financial context BEFORE this credit is applied,
        // so the reconciliation is computed from the invoice's pre-credit state.
        const invoiceReferenceSnapshot = invoice ? buildCreditNoteInvoiceReference(cn, invoice, creditNotes) : undefined;
        const now = nowIso();
        const issued: CreditNote = {
          ...cn,
          status: 'issued',
          templateSnapshot: snapshot,
          invoiceReferenceSnapshot,
          journalEntryId: added.id,
          inventoryJournalEntryId,
          amountApplied: 0,
          amountRefunded: 0,
          remainingCredit: cn.grandTotal,
          issuedAt: now,
          auditTrail: [
            ...cn.auditTrail,
            audit('template-resolved', cn.templateResolutionSource),
            audit('issued', cn.creditNoteNumber),
            audit('journal-created', added.id),
            ...(inventoryJournalEntryId ? [audit('inventory-return-posted', inventoryJournalEntryId)] : []),
          ],
          updatedAt: now,
        };
        set({ creditNotes: creditNotes.map((c) => (c.id === id ? issued : c)) });

        // Default: apply to the original invoice when it still has a balance (§14).
        const autoApply = opts?.autoApplyToOriginal ?? true;
        if (autoApply && invoice && invoice.status !== 'void') {
          const fresh = useInvoiceStore.getState().getInvoice(invoice.id);
          const applyAmount = Math.min(issued.remainingCredit, fresh?.balanceDue ?? 0);
          if (applyAmount > 0.005) get().applyCreditNote(id, invoice.id, Math.round(applyAmount * 100) / 100, now.slice(0, 10));
        }
        return { ok: true, id };
      },

      correctCreditNote: (id) => {
        const existing = get().getCreditNoteById(id);
        if (!existing) return { ok: false, error: 'Credit note not found.' };
        if (existing.status === 'draft' || existing.status === 'approved') return { ok: false, error: 'This credit note is still editable — just open and edit it.' };
        if (existing.status === 'void') return { ok: false, error: 'A void credit note cannot be corrected.' };

        // 1. Void the original (reverses its journal + un-applies it from the invoice).
        const voided = get().voidCreditNote(id, `Corrected & replaced`);
        if (!voided.ok) return voided;
        // 2. Create a pre-filled replacement draft (new number, same linked invoice/lines/reason).
        const dup = get().duplicateCreditNote(id);
        if (!dup.ok || !dup.id) return dup;
        // 3. Cross-link the two for the audit trail.
        const replacement = get().getCreditNoteById(dup.id)!;
        set((state) => ({
          creditNotes: state.creditNotes.map((c) => {
            if (c.id === id) return { ...c, auditTrail: [...c.auditTrail, audit('replacement-created', replacement.creditNoteNumber)], updatedAt: nowIso() };
            if (c.id === dup.id) return { ...c, auditTrail: [...c.auditTrail, audit('replacement-of', existing.creditNoteNumber)], updatedAt: nowIso() };
            return c;
          }),
        }));
        return { ok: true, id: dup.id };
      },

      applyCreditNote: (creditNoteId, invoiceId, amount, date) => {
        const { creditNotes } = get();
        const cn = creditNotes.find((c) => c.id === creditNoteId);
        if (!cn) return { ok: false, error: 'Credit note not found.' };
        if (!['issued', 'applied', 'partially-applied'].includes(cn.status)) return { ok: false, error: 'Only an issued credit note can be applied.' };
        const amt = Math.round((Number(amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: false, error: 'Application amount must be positive.' };
        if (amt > cn.remainingCredit + 0.005) return { ok: false, error: 'Application exceeds the remaining credit.' };

        const invoice = useInvoiceStore.getState().getInvoice(invoiceId);
        if (!invoice) return { ok: false, error: 'Target invoice not found.' };
        if (invoice.customerId !== cn.customerId) return { ok: false, error: 'The invoice belongs to a different customer.' };
        if (invoice.entityId !== cn.entityId) return { ok: false, error: 'The invoice belongs to a different entity.' };

        // Subledger allocation only — no revenue-reversal journal (§14).
        const applied = useInvoiceStore.getState().applyCredit(invoiceId, amt, cn.creditNoteNumber);
        if (!applied.ok) return { ok: false, error: applied.error };

        const now = nowIso();
        const application: CreditApplication = {
          id: generateId('cnapp'), entityId: cn.entityId, customerId: cn.customerId, creditNoteId, invoiceId,
          amount: amt, applicationDate: date ?? now.slice(0, 10), createdAt: now,
        };
        const amountApplied = Math.round((cn.amountApplied + amt) * 100) / 100;
        const remainingCredit = calculateRemainingCredit({ grandTotal: cn.grandTotal, amountApplied, amountRefunded: cn.amountRefunded });
        const status = deriveIssuedStatus({ grandTotal: cn.grandTotal, amountApplied, amountRefunded: cn.amountRefunded });
        const sameInvoice = invoiceId === cn.originalInvoiceId;
        set({
          creditNotes: creditNotes.map((c) => (c.id === creditNoteId ? {
            ...c, amountApplied, remainingCredit, status,
            applications: [...c.applications, application],
            appliedAt: c.appliedAt ?? now,
            auditTrail: [...c.auditTrail, audit(sameInvoice ? 'applied-to-invoice' : 'applied-to-another-invoice', `${amt.toFixed(2)} → ${invoice.invoiceNumber}`)],
            updatedAt: now,
          } : c)),
        });
        return { ok: true, id: creditNoteId };
      },

      refundCreditNote: (id, input) => {
        const { creditNotes } = get();
        const cn = creditNotes.find((c) => c.id === id);
        if (!cn) return { ok: false, error: 'Credit note not found.' };
        if (!['issued', 'applied', 'partially-applied'].includes(cn.status)) return { ok: false, error: 'Only an issued credit note can be refunded.' };
        const amt = Math.round((Number(input.amount) || 0) * 100) / 100;
        if (amt <= 0) return { ok: false, error: 'Refund amount must be positive.' };
        if (amt > cn.remainingCredit + 0.005) return { ok: false, error: 'Refund exceeds the remaining credit.' };
        if (!input.bankAccountId) return { ok: false, error: 'Select the bank/cash account for the refund.' };

        const now = nowIso();
        const refund: CreditNoteRefund = {
          id: generateId('cnref'), creditNoteId: id, entityId: cn.entityId, customerId: cn.customerId,
          amount: amt, refundDate: input.refundDate, bankAccountId: input.bankAccountId, reference: input.reference, memo: input.memo, createdAt: now,
        };
        const journal = useJournalStore.getState();
        const je = buildCreditNoteRefundJournalEntry(cn, refund, { accountsById: accountsMap(), config: postingConfig(cn.customerId), customer: customerById(cn.customerId), createdBy: ACTOR });
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the refund journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the refund.' };
        refund.journalEntryId = added.id;

        const amountRefunded = Math.round((cn.amountRefunded + amt) * 100) / 100;
        const remainingCredit = calculateRemainingCredit({ grandTotal: cn.grandTotal, amountApplied: cn.amountApplied, amountRefunded });
        const status = deriveIssuedStatus({ grandTotal: cn.grandTotal, amountApplied: cn.amountApplied, amountRefunded });
        set({
          creditNotes: creditNotes.map((c) => (c.id === id ? {
            ...c, amountRefunded, remainingCredit, status,
            refunds: [...c.refunds, refund],
            refundedAt: now,
            auditTrail: [...c.auditTrail, audit('refunded', `${amt.toFixed(2)} — ${added.id}`)],
            updatedAt: now,
          } : c)),
        });
        return { ok: true, id };
      },

      voidCreditNote: (id, reason) => {
        const { creditNotes } = get();
        const cn = creditNotes.find((c) => c.id === id);
        if (!cn) return { ok: false, error: 'Credit note not found.' };
        if (cn.status === 'void') return { ok: false, error: 'Credit note is already void.' };
        if (cn.status === 'draft') return { ok: false, error: 'Delete a draft rather than voiding it.' };
        if (!cn.journalEntryId) return { ok: false, error: 'Only a posted (issued) credit note can be voided.' };
        if (!reason.trim()) return { ok: false, error: 'A void reason is required.' };

        const journal = useJournalStore.getState();
        const reversal = journal.reverseEntry(cn.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal entry.' };
        if (cn.inventoryJournalEntryId) journal.reverseEntry(cn.inventoryJournalEntryId);

        // Reverse every credit application back onto its target invoice.
        const invoiceStore = useInvoiceStore.getState();
        const reversedApplications = cn.applications.map((app) => {
          if (!app.reversed) invoiceStore.reverseCredit(app.invoiceId, app.amount, cn.creditNoteNumber);
          return { ...app, reversed: true };
        });

        const now = nowIso();
        set({
          creditNotes: creditNotes.map((c) => (c.id === id ? {
            ...c, status: 'void', voidReason: reason.trim(), reversalJournalEntryId: reversal.id, voidedAt: now,
            applications: reversedApplications, amountApplied: 0, remainingCredit: 0,
            auditTrail: [...c.auditTrail, audit('voided', reason.trim()), audit('journal-created', `reversal ${reversal.id}`)],
            updatedAt: now,
          } : c)),
        });
        return { ok: true, id };
      },

      replaceAll: (creditNotes) => set({ creditNotes }),
      resetToDefault: () => set({ creditNotes: [], numbering: { [INVOICE_ENTITY_ID]: makeDefaultCreditNoteNumberingConfig(INVOICE_ENTITY_ID) } }),
    }),
    { name: 'ledgerly-credit-notes', storage: businessJSONStorage, version: 1 },
  ),
);

function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
