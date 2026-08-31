/**
 * The server-side sales invoice API.
 *
 * ── Why money crosses this boundary as a string ──────────────────────────────
 * PostgreSQL returns NUMERIC as a string and the service does its arithmetic in
 * fixed-point BigInt, so nothing on the server ever holds an invoice total in a
 * float. These types keep that. The conversion to `number` happens once, in
 * `serverInvoiceMapping`, and only for values on their way to the screen — see
 * the note there about why the server path must never recompute a total it was
 * given.
 *
 * Every route here derives the organization from the caller's own membership
 * (`requireOwnOrganizationPermission`), so there is no tenant identifier to
 * pass and no way for this client to ask for somebody else's invoices.
 */
import { api, apiRequest } from './client';

export type ServerInvoiceStatus = 'draft' | 'approved' | 'issued' | 'sent' | 'paid' | 'void';

export interface ServerInvoiceLine {
  id: string;
  lineNumber: number;
  accountId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string | null;
  taxCodeId: string | null;
  taxRate: string;
  taxAmount: string;
  lineSubtotal: string;
  lineTotal: string;
  itemId: string | null;
  entityId: string | null;
  projectId: string | null;
  costCenterId: string | null;
}

export interface ServerInvoice {
  id: string;
  invoiceNumber: string;
  status: ServerInvoiceStatus;
  issuingEntityId: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  transactionCurrency: string;
  functionalCurrency: string;
  exchangeRate: string;
  purchaseOrderReference: string;
  customerReference: string;
  notes: string;
  terms: string;
  paymentTerms: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  additionalChargesTotal: string;
  grandTotal: string;
  amountPaid: string;
  creditsApplied: string;
  balanceDue: string;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  voidReason: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  version: number;
  lines: ServerInvoiceLine[];
}

export interface ServerInvoiceLineInput {
  accountId: string;
  description?: string;
  quantity: string;
  unit?: string;
  unitPrice: string;
  discountType?: string | null;
  discountValue?: string | null;
  taxCodeId?: string | null;
  taxRate?: string;
  itemId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
}

export interface ServerInvoiceInput {
  issuingEntityId: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  purchaseOrderReference?: string;
  customerReference?: string;
  notes?: string;
  terms?: string;
  paymentTerms?: string;
  projectId?: string | null;
  costCenterId?: string | null;
  salespersonId?: string | null;
  templateId?: string | null;
  templateVersionId?: string | null;
  lines: ServerInvoiceLineInput[];
}

export interface ServerPayment {
  id: string;
  invoiceId: string;
  paidOn: string;
  amount: string;
  method: string;
  reference: string;
  bankAccountId: string | null;
  journalEntryId: string | null;
  reversedAt: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
}

export interface ServerInvoiceAuditEvent {
  id: string;
  at: string;
  action: string;
  detail: string | null;
  actorName: string | null;
}

export const invoicesApi = {
  list: async (query: { status?: ServerInvoiceStatus; customerId?: string } = {}): Promise<ServerInvoice[]> => {
    const search = new URLSearchParams();
    if (query.status) search.set('status', query.status);
    if (query.customerId) search.set('customerId', query.customerId);
    const suffix = search.toString() ? `?${search}` : '';
    return (await api.get<{ invoices: ServerInvoice[] }>(`/api/invoices${suffix}`)).invoices;
  },

  get: async (id: string): Promise<ServerInvoice> =>
    (await api.get<{ invoice: ServerInvoice }>(`/api/invoices/${id}`)).invoice,

  history: async (id: string): Promise<ServerInvoiceAuditEvent[]> =>
    (await api.get<{ history: ServerInvoiceAuditEvent[] }>(`/api/invoices/${id}/history`)).history,

  create: async (input: ServerInvoiceInput): Promise<ServerInvoice> =>
    (await api.post<{ invoice: ServerInvoice }>('/api/invoices', input)).invoice,

  /*
   * `expectedVersion` is required by the service, not defaulted by it. A caller
   * that has not read the invoice cannot be allowed to overwrite it, so this
   * signature makes the token impossible to forget rather than optional.
   */
  update: async (id: string, expectedVersion: number, input: ServerInvoiceInput): Promise<ServerInvoice> =>
    (await api.patch<{ invoice: ServerInvoice }>(`/api/invoices/${id}`, { ...input, expectedVersion })).invoice,

  /*
   * DELETE carries a body here. The service refuses a delete with no
   * concurrency token, and `api.del` sends none — so this one call goes through
   * `apiRequest` directly rather than the convenience helper.
   */
  remove: async (id: string, expectedVersion: number): Promise<void> => {
    await apiRequest<void>(`/api/invoices/${id}`, { method: 'DELETE', body: { expectedVersion } });
  },

  /*
   * Issuing names no accounts.
   *
   * The receivable is read from the customer's own profile by the server, and
   * within the current boundary there is no tax or charges leg to post. A
   * caller that passed account ids was choosing where a sale landed — which is
   * the server's decision, and the one settlement later relies on.
   */
  issue: async (id: string, expectedVersion: number): Promise<ServerInvoice> =>
    (await api.post<{ invoice: ServerInvoice }>(`/api/invoices/${id}/issue`, { expectedVersion })).invoice,

  /*
   * Receipts. Both return the UPDATED INVOICE rather than the payment, because
   * what the screen needs after either is the new balance and status.
   */
  listPayments: async (id: string): Promise<ServerPayment[]> =>
    (await api.get<{ payments: ServerPayment[] }>(`/api/invoices/${id}/payments`)).payments,

  recordPayment: async (
    id: string,
    expectedVersion: number,
    payment: { paidOn: string; amount: string; bankAccountId: string; method?: string; reference?: string },
  ): Promise<ServerInvoice> =>
    (await api.post<{ invoice: ServerInvoice }>(`/api/invoices/${id}/payments`, {
      ...payment, expectedVersion,
    })).invoice,

  reversePayment: async (paymentId: string, expectedVersion: number, reason: string): Promise<ServerInvoice> =>
    (await api.post<{ invoice: ServerInvoice }>(`/api/invoices/payments/${paymentId}/reverse`, {
      expectedVersion, reason,
    })).invoice,

  void: async (id: string, expectedVersion: number, reason: string): Promise<ServerInvoice> =>
    (await api.post<{ invoice: ServerInvoice }>(`/api/invoices/${id}/void`, { expectedVersion, reason })).invoice,
};
