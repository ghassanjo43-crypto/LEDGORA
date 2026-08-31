/**
 * The server-backed half of the invoice store's lifecycle actions.
 *
 * ── Why these live outside the store ─────────────────────────────────────────
 * Each one is a network call with its own failure modes, and the store is
 * already long. Keeping them here lets the store read as a router — "server?
 * call this; browser? do that" — instead of interleaving two implementations of
 * every action.
 *
 * ── The shared shape ─────────────────────────────────────────────────────────
 * Every function returns `InvoiceActionResult` and never throws. A rejected
 * promise inside a menu handler disappears, leaving a user looking at a control
 * that did nothing and said nothing; an `{ ok: false, error }` is something the
 * screen can show.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * Account resolution. Issuing used to read the server's chart by CODE and hand
 * the ids back to the server, which meant the browser chose where a sale
 * posted. The receivable now comes from the customer's own profile, server
 * side, and there is no tax or charges leg within the current boundary — so
 * there is nothing left here to resolve, and no second answer to drift from
 * the first. An invoice posted to the wrong receivable reconciles to nothing.
 */
import type { Invoice } from '@/types/invoice';
import { invoicesApi, type ServerInvoiceInput, type ServerInvoiceLineInput } from '@/services/api/invoicesApi';
import { toBrowserInvoice, numberToDecimal } from './serverInvoiceMapping';

export interface InvoiceActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const failed = (cause: unknown, fallback: string): InvoiceActionResult => ({
  ok: false,
  error: cause instanceof Error && cause.message ? cause.message : fallback,
});

/** The concurrency token that rode along on a server-loaded invoice. */
function versionOf(invoice: Invoice): number | undefined {
  const version = (invoice as Invoice & { version?: number }).version;
  return typeof version === 'number' ? version : undefined;
}

const STALE =
  'This invoice was not loaded from the server, so it cannot be changed there. Reload and try again.';

function toLineInput(line: Invoice['lines'][number], decimals: number): ServerInvoiceLineInput {
  return {
    accountId: line.accountId,
    description: line.description,
    quantity: numberToDecimal(line.quantity, 6),
    unitPrice: numberToDecimal(line.unitPrice, decimals),
    unit: line.unit,
    /*
     * The CODE only. The rate, the amount, the category and the method are
     * refused by the server if they arrive — deliberately, because a figure
     * sent from here would be the browser deciding what a tax authority is
     * told. Everything numeric comes back resolved.
     */
    taxCodeId: line.taxCodeId ?? null,
    itemId: line.inventoryItemId ?? null,
    projectId: line.projectId ?? null,
    costCenterId: line.costCenterId ?? null,
  };
}

export function toServerInput(invoice: Invoice, decimals: number): ServerInvoiceInput {
  return {
    issuingEntityId: invoice.entityId,
    customerId: invoice.customerId,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    purchaseOrderReference: invoice.purchaseOrderReference,
    customerReference: invoice.customerReference,
    notes: invoice.notes,
    terms: invoice.terms,
    paymentTerms: invoice.paymentTerms,
    projectId: invoice.projectId ?? null,
    costCenterId: invoice.costCenterId ?? null,
    salespersonId: invoice.salespersonId ?? null,
    lines: invoice.lines.filter((line) => line.accountId).map((line) => toLineInput(line, decimals)),
  };
}

export interface ServerActionContext {
  /** The company's monetary precision, from Currency Master. */
  decimals: number;
  /** Replace one invoice in the store's list, or append it. */
  upsert: (invoice: Invoice) => void;
  remove: (id: string) => void;
  find: (id: string) => Invoice | undefined;
}

export async function createDraft(
  ctx: ServerActionContext,
  seed: { customerId?: string; issueDate: string; dueDate: string; entityId: string },
): Promise<InvoiceActionResult> {
  if (!seed.customerId) {
    return { ok: false, error: 'Choose a customer before creating a server-backed invoice.' };
  }
  try {
    /*
     * The server requires at least one line, while the browser's draft starts
     * with an empty placeholder row. A zero-value line stands in so the draft
     * exists and can be edited, rather than the screen refusing to open.
     */
    const created = await invoicesApi.create({
      issuingEntityId: seed.entityId,
      customerId: seed.customerId,
      issueDate: seed.issueDate,
      dueDate: seed.dueDate,
      lines: [{ accountId: '', quantity: '0', unitPrice: '0' }],
    });
    const invoice = toBrowserInvoice(created);
    ctx.upsert(invoice);
    return { ok: true, id: invoice.id };
  } catch (cause) {
    return failed(cause, 'Could not create the invoice.');
  }
}

export async function updateDraft(
  ctx: ServerActionContext,
  id: string,
  merged: Invoice,
): Promise<InvoiceActionResult> {
  const version = versionOf(merged);
  if (version === undefined) return { ok: false, error: STALE };
  try {
    const updated = await invoicesApi.update(id, version, toServerInput(merged, ctx.decimals));
    ctx.upsert(toBrowserInvoice(updated));
    return { ok: true, id };
  } catch (cause) {
    return failed(cause, 'Could not save the invoice.');
  }
}

export async function deleteDraft(ctx: ServerActionContext, id: string): Promise<InvoiceActionResult> {
  const existing = ctx.find(id);
  const version = existing && versionOf(existing);
  if (version === undefined) return { ok: false, error: STALE };
  try {
    await invoicesApi.remove(id, version);
    ctx.remove(id);
    return { ok: true, id };
  } catch (cause) {
    return failed(cause, 'Could not delete the draft.');
  }
}

/**
 * Issue and post.
 *
 * ── Why nothing is checked here first ────────────────────────────────────────
 * This used to pre-flight the posting accounts and refuse tax and charges
 * itself, with its own wording. Every one of those is now decided by the
 * server: the receivable comes from the customer's profile, and a tax-bearing
 * or charge-bearing invoice is refused at the boundary with a message that
 * says why. Repeating the checks here would put a second, drifting answer in
 * front of the authoritative one — and the browser's copy of a total is
 * exactly the number that should not be deciding whether a post is allowed.
 */
export async function issueInvoice(
  ctx: ServerActionContext,
  id: string,
): Promise<InvoiceActionResult> {
  const existing = ctx.find(id);
  const version = existing && versionOf(existing);
  if (!existing || version === undefined) return { ok: false, error: STALE };

  try {
    const issued = await invoicesApi.issue(id, version);
    ctx.upsert(toBrowserInvoice(issued));
    return { ok: true, id };
  } catch (cause) {
    return failed(cause, 'Could not issue the invoice.');
  }
}

export async function voidInvoice(
  ctx: ServerActionContext,
  id: string,
  reason: string,
): Promise<InvoiceActionResult> {
  const existing = ctx.find(id);
  const version = existing && versionOf(existing);
  if (version === undefined) return { ok: false, error: STALE };
  try {
    const voided = await invoicesApi.void(id, version, reason);
    ctx.upsert(toBrowserInvoice(voided));
    return { ok: true, id };
  } catch (cause) {
    return failed(cause, 'Could not void the invoice.');
  }
}

export async function recordPayment(
  ctx: ServerActionContext,
  id: string,
  input: { amount: number; date: string; bankAccountId: string; method?: string; reference?: string },
): Promise<InvoiceActionResult> {
  const existing = ctx.find(id);
  const version = existing && versionOf(existing);
  if (version === undefined) return { ok: false, error: STALE };
  try {
    const updated = await invoicesApi.recordPayment(id, version, {
      paidOn: input.date,
      amount: numberToDecimal(input.amount, ctx.decimals),
      bankAccountId: input.bankAccountId,
      method: input.method,
      reference: input.reference,
    });
    ctx.upsert(toBrowserInvoice(updated));
    return { ok: true, id };
  } catch (cause) {
    return failed(cause, 'Could not record the receipt.');
  }
}
