/**
 * The server's supplier payments, over HTTP.
 *
 * ══ What this deliberately cannot express ════════════════════════════════════
 *
 * There is no bank fee, settlement discount, withholding, realised exchange
 * difference, write-off, project, cost centre, template, attachment, cheque
 * clearing account, unapplied balance, status, payment number or payable
 * account on the write type. Each is refused by the server, and leaving them
 * out of the client type is what stops a screen being written against them by
 * accident and discovering the refusal in production.
 *
 * ══ Allocations are not optional ═════════════════════════════════════════════
 *
 * `post` and `reallocate` both REQUIRE a complete set. A posted payment names
 * the bills it settled, to the fils: unapplied cash, supplier advances and
 * overpayments have no controlled accounting, so there is no shape here that
 * could ask for one.
 *
 * Money is a STRING. A JSON number is a double, and these are the figures a
 * ledger is built from.
 */
import { api, apiRequest } from './client';

export type ServerPaymentStatus = 'draft' | 'posted' | 'reversed';

export interface ServerPaymentAllocation {
  id: string;
  billId: string;
  billNumber: string;
  amount: string;
  status: string;
  createdAt: string | null;
}

export interface ServerPayment {
  id: string;
  paymentNumber: string;
  status: ServerPaymentStatus;
  issuingEntityId: string;
  supplierId: string;
  /** The payment date IS the posting date: the money left the bank that day. */
  paymentDate: string;
  currency: string;
  amount: string;
  method: string;
  reference: string;
  memo: string;
  cashAccountId: string | null;
  /** Frozen at posting, so a later profile change cannot restate the payment. */
  payableAccountId: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
  /** ACTIVE rows only. Superseded and reversed history stays on the audit trail. */
  allocations: ServerPaymentAllocation[];
}

export interface PaymentAllocationInput {
  billId: string;
  amount: string;
}

export interface PaymentWriteInput {
  paymentDate: string;
  amount: string;
  method?: string;
  reference?: string;
  memo?: string;
  cashAccountId?: string;
}

export interface PaymentAuditEvent {
  action: string;
  actorName: string;
  at: string;
  detail: Record<string, unknown>;
}

export type AgingBucketId = 'current' | '1-30' | '31-60' | '61-90' | '91-120' | '120-plus';

export interface ServerOutstandingBill {
  billId: string;
  billNumber: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNumber: string;
  billDate: string;
  dueDate: string;
  currency: string;
  total: string;
  paid: string;
  outstanding: string;
  daysOverdue: number;
  agingBucket: AgingBucketId;
}

export interface ServerAgedPayables {
  asOfDate: string;
  currency: string;
  buckets: Array<{ id: AgingBucketId; label: string; amount: string; billIds: string[] }>;
  total: string;
  suppliers: Array<{
    supplierId: string;
    supplierName: string;
    buckets: Record<AgingBucketId, string>;
    total: string;
  }>;
}

export interface ServerStatementLine {
  id: string;
  type: 'opening-balance' | 'bill' | 'bill-reversal' | 'payment' | 'payment-reversal';
  date: string;
  documentNumber: string;
  reference: string;
  description: string;
  /** Reduces what is owed. */
  debit: string;
  /** Increases what is owed. */
  credit: string;
  runningBalance: string;
  journalEntryId: string | null;
}

export interface ServerSupplierStatement {
  supplierId: string;
  supplierName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  openingBalance: string;
  periodCharges: string;
  periodPayments: string;
  closingBalance: string;
  lines: ServerStatementLine[];
  aging: ServerAgedPayables;
  outstandingBills: ServerOutstandingBill[];
  subledgerBalance: string;
  reconciliationDifference: string;
  isReconciled: boolean;
}

export const paymentsApi = {
  list: async (query: {
    status?: ServerPaymentStatus;
    supplierId?: string;
    search?: string;
    limit?: number;
  } = {}): Promise<ServerPayment[]> => {
    const parts: string[] = [];
    if (query.status) parts.push(`status=${query.status}`);
    if (query.supplierId) parts.push(`supplierId=${encodeURIComponent(query.supplierId)}`);
    if (query.search) parts.push(`search=${encodeURIComponent(query.search)}`);
    if (query.limit) parts.push(`limit=${query.limit}`);
    const suffix = parts.length > 0 ? `?${parts.join('&')}` : '';
    return (await api.get<{ payments: ServerPayment[] }>(`/api/payments${suffix}`)).payments;
  },

  get: async (id: string): Promise<ServerPayment> =>
    (await api.get<{ payment: ServerPayment }>(`/api/payments/${id}`)).payment,

  history: async (id: string): Promise<PaymentAuditEvent[]> =>
    (await api.get<{ events: PaymentAuditEvent[] }>(`/api/payments/${id}/history`)).events,

  create: async (
    input: PaymentWriteInput & { issuingEntityId: string; supplierId: string },
  ): Promise<ServerPayment> =>
    (await api.post<{ payment: ServerPayment }>('/api/payments', input)).payment,

  /** `expectedVersion` is required: a stale edit is refused, never merged. */
  update: async (
    id: string,
    expectedVersion: number,
    input: PaymentWriteInput & { supplierId?: string },
  ): Promise<ServerPayment> =>
    (await api.patch<{ payment: ServerPayment }>(`/api/payments/${id}`, {
      ...input, expectedVersion,
    })).payment,

  /*
   * DELETE carries a body, because the service refuses a delete with no
   * concurrency token and `api.del` sends none.
   */
  remove: async (id: string, expectedVersion: number): Promise<void> => {
    await apiRequest<void>(`/api/payments/${id}`, { method: 'DELETE', body: { expectedVersion } });
  },

  /**
   * Post the payment, with the bills it settles.
   *
   * The allocations travel WITH the post because a payment is not postable
   * until it is fully allocated — they are part of the same decision, not a
   * follow-up somebody might forget.
   */
  post: async (
    id: string,
    expectedVersion: number,
    allocations: PaymentAllocationInput[],
  ): Promise<ServerPayment> =>
    (await api.post<{ payment: ServerPayment }>(`/api/payments/${id}/post`, {
      expectedVersion, allocations,
    })).payment,

  /**
   * Replace a posted payment's allocations, atomically.
   *
   * There is no unallocate call. Detaching an allocation without replacing it
   * would leave unapplied cash, which has no account: the corrections are a
   * complete replacement that still totals the payment, or a reversal.
   */
  reallocate: async (
    id: string,
    expectedVersion: number,
    allocations: PaymentAllocationInput[],
  ): Promise<ServerPayment> =>
    (await api.post<{ payment: ServerPayment }>(`/api/payments/${id}/reallocate`, {
      expectedVersion, allocations,
    })).payment,

  reverse: async (id: string, expectedVersion: number, reason: string): Promise<ServerPayment> =>
    (await api.post<{ payment: ServerPayment }>(`/api/payments/${id}/reverse`, {
      expectedVersion, reason,
    })).payment,

  /** What is still owed, and how overdue it is. Derived on the server. */
  payables: async (query: { asOfDate?: string; supplierId?: string } = {}): Promise<{
    outstanding: ServerOutstandingBill[];
    aging: ServerAgedPayables;
  }> => {
    const parts: string[] = [];
    if (query.asOfDate) parts.push(`asOfDate=${query.asOfDate}`);
    if (query.supplierId) parts.push(`supplierId=${encodeURIComponent(query.supplierId)}`);
    const suffix = parts.length > 0 ? `?${parts.join('&')}` : '';
    return api.get<{ outstanding: ServerOutstandingBill[]; aging: ServerAgedPayables }>(
      `/api/payments/payables${suffix}`,
    );
  },

  statement: async (query: {
    supplierId: string; periodStart?: string; periodEnd?: string;
  }): Promise<ServerSupplierStatement> => {
    const parts = [`supplierId=${encodeURIComponent(query.supplierId)}`];
    if (query.periodStart) parts.push(`periodStart=${query.periodStart}`);
    if (query.periodEnd) parts.push(`periodEnd=${query.periodEnd}`);
    return (await api.get<{ statement: ServerSupplierStatement }>(
      `/api/payments/statement?${parts.join('&')}`,
    )).statement;
  },
};
