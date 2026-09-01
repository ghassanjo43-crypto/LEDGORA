/**
 * The server's supplier bills, over HTTP.
 *
 * ══ What this deliberately cannot express ════════════════════════════════════
 *
 * There is no tax field, no additional-charges field, no project, cost centre,
 * purchase order, goods receipt, template, attachment, payment or currency
 * override on the write type. Each is refused by the server, and leaving them
 * out of the client type is what stops a screen being written against them by
 * accident and discovering the refusal in production.
 *
 * Money and quantities are STRINGS. A JSON number is a double, and these are
 * the figures a ledger is built from.
 */
import { api, apiRequest } from './client';

export type ServerBillStatus = 'draft' | 'posted' | 'reversed';

export interface ServerBillLine {
  id: string;
  lineNumber: number;
  description: string;
  accountId: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string | null;
  discountAmount: string;
  /** quantity x unitPrice, BEFORE discount. */
  lineSubtotal: string;
  /** What the account is debited. */
  lineNet: string;
}

export interface ServerBill {
  id: string;
  billNumber: string;
  supplierInvoiceNumber: string;
  status: ServerBillStatus;
  issuingEntityId: string;
  supplierId: string;
  billDate: string;
  /** What the ledger posted on, and what period locks were enforced against. */
  postingDate: string;
  dueDate: string;
  currency: string;
  memo: string;
  /** The GROSS sum of the lines, before discount. */
  subtotal: string;
  discountTotal: string;
  total: string;
  payableAccountId: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
  lines: ServerBillLine[];
}

export interface ServerBillLineInput {
  description?: string;
  accountId: string;
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: string | null;
}

export interface BillWriteInput {
  supplierInvoiceNumber?: string;
  billDate: string;
  postingDate?: string;
  dueDate: string;
  memo?: string;
  lines: ServerBillLineInput[];
}

export interface BillAuditEvent {
  action: string;
  actorName: string;
  at: string;
  detail: Record<string, unknown>;
}

export const billsApi = {
  list: async (query: {
    status?: ServerBillStatus;
    supplierId?: string;
    search?: string;
    limit?: number;
  } = {}): Promise<ServerBill[]> => {
    const parts: string[] = [];
    if (query.status) parts.push(`status=${query.status}`);
    if (query.supplierId) parts.push(`supplierId=${encodeURIComponent(query.supplierId)}`);
    if (query.search) parts.push(`search=${encodeURIComponent(query.search)}`);
    if (query.limit) parts.push(`limit=${query.limit}`);
    const suffix = parts.length > 0 ? `?${parts.join('&')}` : '';
    return (await api.get<{ bills: ServerBill[] }>(`/api/bills${suffix}`)).bills;
  },

  get: async (id: string): Promise<ServerBill> =>
    (await api.get<{ bill: ServerBill }>(`/api/bills/${id}`)).bill,

  history: async (id: string): Promise<BillAuditEvent[]> =>
    (await api.get<{ events: BillAuditEvent[] }>(`/api/bills/${id}/history`)).events,

  create: async (input: BillWriteInput & { issuingEntityId: string; supplierId: string }): Promise<ServerBill> =>
    (await api.post<{ bill: ServerBill }>('/api/bills', input)).bill,

  /** `expectedVersion` is required: a stale edit is refused, never merged. */
  update: async (
    id: string,
    expectedVersion: number,
    input: BillWriteInput & { supplierId?: string },
  ): Promise<ServerBill> =>
    (await api.patch<{ bill: ServerBill }>(`/api/bills/${id}`, { ...input, expectedVersion })).bill,

  /*
   * DELETE carries a body, because the service refuses a delete with no
   * concurrency token and `api.del` sends none — so this one call goes through
   * `apiRequest` directly rather than the convenience helper.
   */
  remove: async (id: string, expectedVersion: number): Promise<void> => {
    await apiRequest<void>(`/api/bills/${id}`, { method: 'DELETE', body: { expectedVersion } });
  },

  /**
   * Post the bill — the transition that creates the accounting entry.
   *
   * `overrideDuplicate` is an explicit acknowledgement that the supplier's own
   * reference is already on a posted bill. It is never sent by default: paying
   * the same supplier document twice is the mistake that check exists for.
   */
  post: async (
    id: string,
    expectedVersion: number,
    options: { overrideDuplicate?: boolean } = {},
  ): Promise<ServerBill> =>
    (await api.post<{ bill: ServerBill }>(`/api/bills/${id}/post`, {
      expectedVersion, ...options,
    })).bill,

  reverse: async (id: string, expectedVersion: number, reason: string): Promise<ServerBill> =>
    (await api.post<{ bill: ServerBill }>(`/api/bills/${id}/reverse`, { expectedVersion, reason })).bill,
};
