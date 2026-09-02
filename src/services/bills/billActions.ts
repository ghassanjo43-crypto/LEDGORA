/**
 * Bill writes: the server for a durable subscriber, the local store for Free
 * Demo, and never both.
 *
 * ══ Why the screens call this and not a store ════════════════════════════════
 *
 * P2 and P3 put a durable subscriber's bills on the server and left the browser
 * store refusing every durable write. That was correct and incomplete: a screen
 * that only ever meets the refusal is a screen a durable subscriber cannot use.
 * This is the seam the pages and drawers call instead, so no component decides
 * for itself which ledger it is writing to.
 *
 * ══ What the durable path deliberately drops ═════════════════════════════════
 *
 * `toBillWriteInput` copies the supplier reference, the dates, the memo and the
 * lines' account, description, quantity, unit price, percentage discount and
 * tax CODE. It does not copy withholding, additional charges, projects, cost
 * centres, inventory receipts, attachments or a tax RATE — not because it is
 * careful, but because they are not in the object it builds. A durable bill
 * therefore cannot carry a figure the server refuses, even if a form is later
 * given one by mistake.
 *
 * ══ Submit and approve have no server equivalent ═════════════════════════════
 *
 * There is no approval workflow on the server, and a status it could set but
 * never honour would be worse than none. Both are refused in durable mode with
 * a message saying so, rather than quietly writing a status into the browser.
 */
import type { Bill, BillLine } from '@/types/bill';
import type { BillWriteInput, ServerBillLineInput, ServerBill } from '@/services/api/billsApi';
import { useBillStore } from '@/store/billStore';
import { INVOICE_ENTITY_ID } from '@/store/invoiceTemplateStore';
import { billGateway, billsAreServerAuthoritative, serverBillById } from './billBackend';
import { loadPayments } from '@/services/payments/paymentBackend';

export interface BillActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** True when the server refused because somebody else edited first. */
  conflict?: boolean;
  /**
   * True when posting was refused ONLY because the supplier's own reference is
   * already on a posted bill. The screen may then offer the deliberate
   * override; nothing here decides that on the user's behalf.
   */
  duplicateReference?: boolean;
}

/** What the screen collects, in the browser's own shape. */
export interface BillDraftValues {
  supplierId: string;
  supplierInvoiceNumber: string;
  billDate: string;
  dueDate: string;
  notes?: string;
  lines: BillLine[];
}

const DECIMAL = (value: number | undefined | null): string => {
  if (value === undefined || value === null || Number.isNaN(value)) return '0';
  /* Fixed notation, never exponential: `1e-7` is not a decimal the server
   * accepts, and `toString()` produces one for small numbers. */
  return Number(value).toFixed(10).replace(/0+$/, '').replace(/\.$/, '') || '0';
};

export function toBillWriteInput(values: BillDraftValues): BillWriteInput {
  const lines: ServerBillLineInput[] = values.lines.map((line) => ({
    accountId: line.accountId,
    description: line.description,
    quantity: DECIMAL(line.quantity),
    unit: line.unit,
    unitPrice: DECIMAL(line.unitPrice),
    /*
     * Percentage only. The browser model also has an amount discount, but the
     * drawer offers a percentage and sending a type the form cannot produce
     * would be inventing an input.
     */
    discountType: line.discountValue ? 'percentage' : null,
    discountValue: line.discountValue ? DECIMAL(line.discountValue) : null,
    /* The CODE, and nothing else about the tax. */
    taxCodeId: line.taxCodeId ?? null,
  }));

  return {
    supplierInvoiceNumber: values.supplierInvoiceNumber,
    billDate: values.billDate,
    dueDate: values.dueDate,
    memo: values.notes,
    lines,
  };
}

/** A blank line in the shape the durable drawer edits. */
export function emptyDurableLine(index: number): BillLine {
  return {
    id: `new-line-${index}-${Math.random().toString(36).slice(2, 8)}`,
    billId: 'new',
    description: '',
    accountId: '',
    quantity: 1,
    unitPrice: 0,
    discountAmount: 0,
    taxRate: 0,
    taxableAmount: 0,
    taxAmount: 0,
    lineSubtotal: 0,
    lineTotal: 0,
    sortOrder: index,
  } as BillLine;
}

const GONE = 'That bill is no longer in these books. Reload and try again.';

/**
 * The server's own words, kept.
 *
 * A stale version, a locked period, a missing payable account and a blocking
 * payment say different things, and a generic message would hide which. The
 * only interpretation added here is a flag for the two cases a screen must
 * react to differently — a conflict, and the duplicate-reference refusal that
 * has a deliberate override.
 */
function asResult(cause: unknown): BillActionResult {
  const message = cause instanceof Error ? cause.message : 'Could not save this bill.';
  return {
    ok: false,
    error: message,
    conflict: /changed by another user|reload/i.test(message),
    duplicateReference: /already recorded on|already on a posted bill|supplier's own reference/i.test(message),
  };
}

export const APPROVAL_UNSUPPORTED =
  'Submitting and approving a bill is not available for server-held books. There is no approval '
  + 'workflow on the server, and a status it could set but never honour would be worse than none. '
  + 'Post the bill when it is ready.';

export const CREDITS_UNSUPPORTED =
  'Supplier credits against a server-held bill are not available yet. A credit reverses part of a '
  + 'posted purchase and needs its own accounting, which is a later Purchasing step.';

export const ATTACHMENTS_UNSUPPORTED =
  'Attachments on a server-held bill are not available yet: there is no durable storage for them, '
  + 'so a file kept in this browser would vanish the moment it was cleared.';

export interface BillActions {
  /** True when these actions go to the server. */
  serverBacked: boolean;
  create: (values: BillDraftValues) => Promise<BillActionResult>;
  update: (id: string, values: BillDraftValues) => Promise<BillActionResult>;
  post: (id: string, options?: { overrideDuplicate?: boolean }) => Promise<BillActionResult>;
  reverse: (id: string, reason: string) => Promise<BillActionResult>;
  remove: (id: string) => Promise<BillActionResult>;
  /** False in durable mode: no server operation exists. See the constants. */
  canApprove: boolean;
  canRaiseCredit: boolean;
  canAttach: boolean;
}

/**
 * The issuing entity a durable bill is recorded against.
 *
 * The browser's own entity id, exactly as the invoice cutover sends
 * `invoice.entityId`. The server scopes every document by the company selector
 * header, so this identifies the numbering series within that company and
 * nothing more.
 */
export const ISSUING_ENTITY = INVOICE_ENTITY_ID;

export function billActions(): BillActions {
  if (!billsAreServerAuthoritative()) {
    /* Free Demo: the local store, exactly as before this slice. */
    const store = useBillStore.getState();
    return {
      serverBacked: false,
      create: async (values) => {
        const created = store.createDraft({ supplierId: values.supplierId });
        if (!created.ok || !created.id) return created;
        return store.updateDraft(created.id, values as Partial<Bill>);
      },
      update: async (id, values) => store.updateDraft(id, values as Partial<Bill>),
      post: async (id, options) => store.postBill(id, options),
      reverse: async (id, reason) => store.reverseBill(id, reason),
      remove: async (id) => store.deleteDraft(id),
      canApprove: true,
      canRaiseCredit: true,
      canAttach: true,
    };
  }

  return {
    serverBacked: true,

    create: async (values) => {
      try {
        const created = await billGateway.create({
          issuingEntityId: ISSUING_ENTITY,
          supplierId: values.supplierId,
          ...toBillWriteInput(values),
        });
        return { ok: true, id: created.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    /*
     * The version comes from the cached SERVER row, not from the form. A form
     * that carried its own version would happily send back the one it was
     * opened with after somebody else had saved, which is the merge this
     * refuses.
     */
    update: async (id, values) => {
      const current = serverBillById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const updated = await billGateway.update(id, current.version, {
          supplierId: values.supplierId,
          ...toBillWriteInput(values),
        });
        return { ok: true, id: updated.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    /*
     * Posting or reversing a bill changes what is OWED, so the outstanding
     * schedule is refreshed as well. Done here rather than inside
     * `billGateway`, because the two backends must not import each other — a
     * cycle between them resolves differently depending on which module the
     * bundler reaches first, and this codebase has already paid for one of
     * those (see `booksGenerationCounter`).
     */
    post: async (id, options = {}) => {
      const current = serverBillById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const posted = await billGateway.post(id, current.version, options);
        await loadPayments();
        return { ok: true, id: posted.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    reverse: async (id, reason) => {
      const current = serverBillById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const reversed = await billGateway.reverse(id, current.version, reason);
        await loadPayments();
        return { ok: true, id: reversed.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    remove: async (id) => {
      const current = serverBillById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        await billGateway.remove(id, current.version);
        return { ok: true, id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    canApprove: false,
    canRaiseCredit: false,
    canAttach: false,
  };
}

/** The server bill behind a row, for a screen that needs its version. */
export function durableBill(id: string): ServerBill | undefined {
  return serverBillById(id);
}
