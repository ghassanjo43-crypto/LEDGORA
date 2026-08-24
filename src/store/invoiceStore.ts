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
import type { OrganizationRole } from '@/types/roles';
import { assertTransactionDocumentPermission } from '@/lib/transactionDocumentPermissions';
import { getCurrentUser } from '@/store/authStore';
import { isPlatformAdminFullAccess } from '@/store/platformFullAccess';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';
import {
  ORDINARY_TRANSACTION_EXCHANGE_RATE,
  transactionCurrencyCode,
} from '@/lib/transactionCurrency';
import { roundToCompanyPrecision } from '@/lib/monetaryPrecision';
import { invoicesApi } from '@/services/api/invoicesApi';
import { toBrowserInvoice } from '@/services/invoices/serverInvoiceMapping';
import { backendFor, type InvoiceBackend, type InvoiceBackendState } from '@/services/invoices/invoiceBackend';
import * as serverActions from '@/services/invoices/serverInvoiceActions';

const ACTOR = 'Finance Manager';

export interface InvoiceActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * The role acting, resolved the same way every other document store resolves it.
 *
 * A platform administrator working inside a subscriber workspace acts with admin
 * authority; otherwise it is the signed-in user's organization role, defaulting
 * to `owner` for the single-user local workspace.
 */
function currentRole(): OrganizationRole {
  if (isPlatformAdminFullAccess()) return 'admin';
  return getCurrentUser()?.role ?? 'owner';
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

  /**
   * Where this company's invoices actually live.
   *
   * Every screen reads `invoices` off this store — nineteen of them — so the
   * cutover hydrates the store rather than converting each consumer. A screen
   * therefore needs no knowledge of the backend to show the right data.
   *
   * Writes are a different matter: see `syncFromServer` and the refusal guard
   * below for why a browser write path must not run for a migrated company.
   */
  backend: InvoiceBackend;
  /** True while `syncFromServer` is in flight, so a list can say so. */
  syncing: boolean;
  syncError?: string;

  /**
   * Load this company's invoices from the server and hold them here.
   *
   * Deliberately REPLACES rather than merges. The server is authoritative for a
   * migrated company, and a merge would resurrect a locally-cached invoice that
   * was voided elsewhere.
   */
  syncFromServer: (company: InvoiceBackendState | undefined) => Promise<void>;

  getInvoice: (id: string) => Invoice | undefined;
  usedNumbers: () => Set<string>;
  /** A snapshot for rendering: the frozen one if issued, else built live from the resolved version. */
  previewSnapshot: (id: string) => import('@/types/invoice').InvoiceTemplateSnapshot | null;

  /*
   * The six lifecycle actions are ASYNC because a server-backed company posts
   * over the network. They stay one API rather than two so no screen has to
   * know which backend it is talking to -- the reason the store hydrates at all.
   *
   * The remaining actions stay synchronous: they are browser-only features
   * (credit-note allocation, receipt allocation, template duplication) with no
   * server endpoint, and they refuse outright for a migrated company.
   */
  createDraft: (input: { customerId?: string; issueDate?: string; dueDate?: string; currency?: string; overrideTemplateVersionId?: string }) => Promise<InvoiceActionResult>;
  updateDraft: (id: string, patch: Partial<Invoice>) => Promise<InvoiceActionResult>;
  deleteDraft: (id: string) => Promise<InvoiceActionResult>;
  duplicateInvoice: (id: string) => InvoiceActionResult;

  issueInvoice: (id: string) => Promise<InvoiceActionResult>;
  markSent: (id: string) => InvoiceActionResult;
  recordPayment: (id: string, input: { amount: number; date: string; bankAccountId: string; method?: string; reference?: string }) => Promise<InvoiceActionResult>;
  /** Allocate credit-note value against this invoice (subledger; no cash journal). */
  applyCredit: (id: string, amount: number, creditNoteNumber?: string) => InvoiceActionResult;
  /** Undo a previously-applied credit (used when a credit note is voided). */
  reverseCredit: (id: string, amount: number, creditNoteNumber?: string) => InvoiceActionResult;
  /** Record a posted Receipt allocation against this invoice (subledger; the receipt posts the cash journal). */
  applyReceiptAllocation: (id: string, input: { amount: number; date: string; method: string; reference?: string; bankAccountId?: string; receiptId: string; journalEntryId?: string }) => InvoiceActionResult;
  /** Remove every payment linked to a receipt (used when a receipt is reversed). */
  removeReceiptAllocations: (id: string, receiptId: string) => InvoiceActionResult;
  voidInvoice: (id: string, reason: string) => Promise<InvoiceActionResult>;

  replaceAll: (invoices: Invoice[]) => void;
  resetToDefault: () => void;
}

/**
 * A browser write attempted against a company whose books are on the server.
 *
 * Refused rather than allowed: the browser path would write to localStorage,
 * the server would never hear about it, and the two copies would diverge — with
 * the localStorage one silently winning on the next read until a sync replaced
 * it, losing the write entirely. A visible refusal is the lesser failure, and
 * it is temporary: these paths gain server routing as each is converted.
 */
/**
 * How a server action writes its result back into this store.
 *
 * The server is authoritative, so the returned record REPLACES the local one
 * rather than being merged into it — a merge would keep a stale local total
 * next to a server one that had already been posted.
 */
function serverContext(
  set: (fn: (state: { invoices: Invoice[] }) => { invoices: Invoice[] }) => void,
  get: () => { invoices: Invoice[] },
): serverActions.ServerActionContext {
  return {
    decimals: documentDecimals(transactionCurrencyCode()),
    upsert: (invoice) =>
      set((state) => ({
        invoices: state.invoices.some((i) => i.id === invoice.id)
          ? state.invoices.map((i) => (i.id === invoice.id ? invoice : i))
          : [...state.invoices, invoice],
      })),
    remove: (id) => set((state) => ({ invoices: state.invoices.filter((i) => i.id !== id) })),
    find: (id) => get().invoices.find((i) => i.id === id),
  };
}

function serverBackedRefusal(action: string): InvoiceActionResult {
  return {
    ok: false,
    error: `This company's invoices are held on the server, where ${action} is not available yet. `
      + 'No change was made.',
  };
}

export const useInvoiceStore = create<InvoiceState>()(
  persist(
    (set, get) => ({
      invoices: [],
      backend: 'browser',
      syncing: false,

      syncFromServer: async (company) => {
        const backend = backendFor(company);
        if (backend !== 'server') {
          set({ backend: 'browser', syncing: false, syncError: undefined });
          return;
        }
        set({ syncing: true, syncError: undefined });
        try {
          const records = await invoicesApi.list();
          set({
            invoices: records.map(toBrowserInvoice),
            backend: 'server',
            syncing: false,
          });
        } catch (cause) {
          /*
           * The previously-held invoices are LEFT IN PLACE on failure. Emptying
           * the list would present "you have no invoices" as though it were a
           * fact, when the truth is that we could not reach the server.
           */
          set({
            syncing: false,
            backend: 'server',
            syncError: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },

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

      createDraft: async (input) => {
        /*
         * The authorization point for starting a invoice.
         *
         * Here rather than in the buttons that offer it, so every caller passes
         * through the same rule — the invoice page, the Dashboard quick-create,
         * and anything added later. A menu that merely hides itself is an
         * affordance, not a gate.
         *
         * Checked BEFORE the backend branch, so the permission rule is the same
         * whichever backend the company is on. A gate that only one path applies
         * is not a gate.
         */
        const permitted = assertTransactionDocumentPermission(currentRole(), 'invoice.create');
        if (!permitted.ok) return { ok: false, error: permitted.error };

        if (get().backend === 'server') {
          const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10);
          return serverActions.createDraft(serverContext(set, get), {
            customerId: input.customerId,
            issueDate,
            dueDate: input.dueDate ?? issueDate,
            entityId: INVOICE_ENTITY_ID,
          });
        }
        const templates = useInvoiceTemplateStore.getState();
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
          /*
           * The company's currency by default.
           *
           * What has gone from this chain is `customer?.defaultCurrency` — the
           * seeded customers carry USD, so a JOD company raised dollar invoices
           * without anyone choosing to. A customer's preferred currency is
           * context for a quote, not authority over the company's books.
           *
           * `input.currency` survives for the explicit foreign-currency paths
           * (imports, and the multi-currency module). No editor passes it: the
           * Invoice form shows the currency read-only, and the server refuses a
           * foreign currency outright.
           */
          currency: input.currency || transactionCurrencyCode(),
          exchangeRate: ORDINARY_TRANSACTION_EXCHANGE_RATE,
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

      updateDraft: async (id, patch) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft invoices can be edited.' };

        if (get().backend === 'server') {
          /*
           * The merge is done locally to assemble the payload, but its TOTALS
           * are discarded: the server recomputes them and returns the result.
           * Sending a locally-computed total would let a float rounding
           * difference become the figure on a tax document.
           */
          return serverActions.updateDraft(serverContext(set, get), id, { ...existing, ...patch });
        }

        const merged = withTotals({ ...existing, ...patch });
        set({ invoices: invoices.map((i) => (i.id === id ? merged : i)) });
        return { ok: true, id };
      },

      deleteDraft: async (id) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft invoices can be deleted. Void issued invoices instead.' };
        if (get().backend === 'server') return serverActions.deleteDraft(serverContext(set, get), id);
        set({ invoices: invoices.filter((i) => i.id !== id) });
        return { ok: true, id };
      },

      duplicateInvoice: (id) => {
        if (get().backend === 'server') return serverBackedRefusal('duplicating an invoice');
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

      issueInvoice: async (id) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'draft' && existing.status !== 'approved') return { ok: false, error: 'Only draft invoices can be issued.' };

        if (get().backend === 'server') {
          /*
           * Stock is NOT moved here.
           *
           * The browser path posts inventory movements before the revenue
           * journal so insufficient stock blocks the issue atomically; the
           * server has no equivalent yet. Rather than issue and silently leave
           * stock overstated, `assessEligibility` refuses to migrate a company
           * whose invoices carry inventory lines at all — so reaching this point
           * with one means the invoice changed after the cutover.
           */
          const stocked = existing.lines.some((line) => line.inventoryItemId);
          if (stocked && inventoryEnabled()) {
            return {
              ok: false,
              error: 'This invoice sells inventory items, which cannot be issued server-side yet '
                + 'because stock would not be depleted. Issue it from a browser-backed company.',
            };
          }
          /*
           * The customer's default receivable is a BROWSER account id, and the
           * server needs its own. The account CODE is the only identifier the
           * two charts share, so it is what crosses the boundary.
           */
          const preferred = customerById(existing.customerId)?.defaultReceivableAccount;
          return serverActions.issueInvoice(serverContext(set, get), id, {
            preferredReceivableCode: preferred ? accountsMap().get(preferred)?.code : undefined,
          });
        }

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
        const added = journal.addEntry(je, { inheritCurrency: true });
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
        if (get().backend === 'server') return serverBackedRefusal('marking an invoice sent');
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status !== 'issued') return { ok: false, error: 'Only issued invoices can be marked as sent.' };
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, status: 'sent', sentAt: nowIso(), auditTrail: [...i.auditTrail, audit('invoice-sent')], updatedAt: nowIso() } : i)) });
        return { ok: true, id };
      },

      recordPayment: async (id, input) => {
        if (get().backend === 'server') return serverActions.recordPayment(serverContext(set, get), id, input);
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
        const added = journal.addEntry(je, { inheritCurrency: true });
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the receipt journal entry.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the receipt.' };
        payment.journalEntryId = added.id;

        const amountPaid = roundToCompanyPrecision(existing.amountPaid + input.amount);
        const balanceDue = roundToCompanyPrecision(existing.grandTotal - amountPaid - (existing.creditsApplied ?? 0));
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
        if (get().backend === 'server') return serverBackedRefusal('applying a credit note');
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status === 'void' || existing.status === 'draft') return { ok: false, error: 'Credit can only be applied to an issued invoice.' };
        const amt = roundToCompanyPrecision(Number(amount) || 0);
        if (amt <= 0) return { ok: false, error: 'Credit amount must be positive.' };
        if (amt > existing.balanceDue + 0.005) return { ok: false, error: 'Credit exceeds the invoice balance due.' };

        const creditsApplied = roundToCompanyPrecision(existing.creditsApplied + amt);
        const balanceDue = roundToCompanyPrecision(existing.grandTotal - existing.amountPaid - creditsApplied);
        const status = balanceDue <= 0.005 ? 'paid' : existing.amountPaid > 0 || creditsApplied > 0 ? 'partially-paid' : existing.status;
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, creditsApplied, balanceDue, status, auditTrail: [...i.auditTrail, audit('credit-applied', `${amt.toFixed(2)}${creditNoteNumber ? ` — ${creditNoteNumber}` : ''}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      reverseCredit: (id, amount, creditNoteNumber) => {
        if (get().backend === 'server') return serverBackedRefusal('reversing a credit note');
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        const amt = roundToCompanyPrecision(Number(amount) || 0);
        if (amt <= 0) return { ok: true, id };
        const creditsApplied = roundToCompanyPrecision(Math.max(0, existing.creditsApplied - amt));
        const balanceDue = roundToCompanyPrecision(existing.grandTotal - existing.amountPaid - creditsApplied);
        const status =
          balanceDue <= 0.005 ? 'paid' : existing.amountPaid <= 0.005 && creditsApplied <= 0.005 ? 'issued' : 'partially-paid';
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, creditsApplied, balanceDue, status, auditTrail: [...i.auditTrail, audit('credit-reversed', `${amt.toFixed(2)}${creditNoteNumber ? ` — ${creditNoteNumber}` : ''}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      applyReceiptAllocation: (id, input) => {
        if (get().backend === 'server') return serverBackedRefusal('allocating a receipt');
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status === 'void' || existing.status === 'draft') return { ok: false, error: 'Receipts can only be allocated to an issued invoice.' };
        const amt = roundToCompanyPrecision(Number(input.amount) || 0);
        if (amt <= 0) return { ok: false, error: 'Allocation amount must be positive.' };
        if (amt > existing.balanceDue + 0.005) return { ok: false, error: 'Allocation exceeds the invoice balance due.' };

        const payment: InvoicePayment = {
          id: generateId('ipay'), invoiceId: id, date: input.date, amount: amt, method: input.method,
          reference: input.reference, bankAccountId: input.bankAccountId ?? '', journalEntryId: input.journalEntryId, receiptId: input.receiptId, createdAt: nowIso(),
        };
        const amountPaid = roundToCompanyPrecision(existing.amountPaid + amt);
        const balanceDue = roundToCompanyPrecision(existing.grandTotal - amountPaid - existing.creditsApplied);
        const status = balanceDue <= 0.005 ? 'paid' : 'partially-paid';
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, amountPaid, balanceDue, status, payments: [...i.payments, payment], paidAt: status === 'paid' ? now : i.paidAt, auditTrail: [...i.auditTrail, audit('receipt-allocated', `${amt.toFixed(2)} — ${input.reference ?? input.receiptId}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      removeReceiptAllocations: (id, receiptId) => {
        if (get().backend === 'server') return serverBackedRefusal('removing a receipt allocation');
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        const linked = existing.payments.filter((p) => p.receiptId === receiptId);
        if (linked.length === 0) return { ok: true, id };
        const removed = roundToCompanyPrecision(linked.reduce((s, p) => s + p.amount, 0));
        const amountPaid = roundToCompanyPrecision(Math.max(0, existing.amountPaid - removed));
        const balanceDue = roundToCompanyPrecision(existing.grandTotal - amountPaid - existing.creditsApplied);
        const status = balanceDue <= 0.005 ? 'paid' : amountPaid <= 0.005 && existing.creditsApplied <= 0.005 ? 'issued' : 'partially-paid';
        const now = nowIso();
        set({ invoices: invoices.map((i) => (i.id === id ? { ...i, amountPaid, balanceDue, status, payments: i.payments.filter((p) => p.receiptId !== receiptId), auditTrail: [...i.auditTrail, audit('receipt-allocation-reversed', `${removed.toFixed(2)}`)], updatedAt: now } : i)) });
        return { ok: true, id };
      },

      voidInvoice: async (id, reason) => {
        const { invoices } = get();
        const existing = invoices.find((i) => i.id === id);
        if (!existing) return { ok: false, error: 'Invoice not found.' };
        if (existing.status === 'void') return { ok: false, error: 'Invoice is already void.' };
        if (!existing.journalEntryId) return { ok: false, error: 'Only a posted (issued) invoice can be voided.' };
        if (!reason.trim()) return { ok: false, error: 'A void reason is required.' };

        if (get().backend === 'server') return serverActions.voidInvoice(serverContext(set, get), id, reason);

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
          return { ...i, creditsApplied, balanceDue: roundToCompanyPrecision(i.grandTotal - i.amountPaid - creditsApplied) };
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
