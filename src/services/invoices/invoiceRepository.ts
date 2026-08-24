/**
 * One interface over both invoice backends.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * The invoice screens should not know whether a company's invoices live in this
 * browser or in the database. If they did, every page would grow a branch, and
 * the branches would drift — which is exactly how a "seamless migration" turns
 * into two products with one name.
 *
 * So the pages call a repository, and `repositoryFor` picks the implementation
 * from the company's own migration state. Adding a page requires no knowledge
 * of the cutover at all.
 *
 * ── The rule that makes the two behave the same ──────────────────────────────
 * The browser implementation recomputes totals from lines on read, because in
 * the browser the lines are the only truth there is. The server implementation
 * must NOT: its totals were computed in fixed-point BigInt inside the
 * transaction that wrote the lines, and the invoice may already be posted to
 * the ledger — and, later, cleared by a tax authority — against exactly those
 * figures. See `serverInvoiceMapping` for the longer form of this.
 *
 * ── What is deliberately not here ────────────────────────────────────────────
 * Issuing. The two paths do genuinely different things at issue — the browser
 * also moves stock and freezes a template snapshot, the server posts through
 * `journalService` and does neither — and hiding that behind one method would
 * be the drift this file exists to prevent. `invoiceBackend.assessEligibility`
 * refuses to migrate a company that relies on the difference; until stock
 * movement exists server-side, issuing stays explicit at the call site.
 */
import type { Invoice } from '@/types/invoice';
import {
  invoicesApi,
  type ServerInvoiceInput,
  type ServerInvoiceStatus,
} from '@/services/api/invoicesApi';
import { toBrowserInvoice, numberToDecimal } from './serverInvoiceMapping';
import { backendFor, type InvoiceBackendState } from './invoiceBackend';

export interface PaymentDraft {
  paidOn: string;
  amount: number;
  bankAccountId: string;
  method?: string;
  reference?: string;
}

export interface InvoiceRepository {
  readonly backend: 'browser' | 'server';
  list(): Promise<Invoice[]>;
  get(id: string): Promise<Invoice | undefined>;
  recordPayment(invoice: Invoice, payment: PaymentDraft): Promise<Invoice>;
  reversePayment(invoice: Invoice, paymentId: string, reason: string): Promise<Invoice>;
}

/**
 * The browser side, delegating to the existing Zustand store.
 *
 * Passed in rather than imported so this module stays free of the store's
 * import cycle, and so tests can exercise the routing without a store.
 */
export interface BrowserInvoiceAdapter {
  list(): Invoice[];
  get(id: string): Invoice | undefined;
  recordPayment(id: string, payment: PaymentDraft): Invoice;
  reversePayment(id: string, paymentId: string, reason: string): Invoice;
}

function browserRepository(adapter: BrowserInvoiceAdapter): InvoiceRepository {
  return {
    backend: 'browser',
    list: async () => adapter.list(),
    get: async (id) => adapter.get(id),
    recordPayment: async (invoice, payment) => adapter.recordPayment(invoice.id, payment),
    reversePayment: async (invoice, paymentId, reason) =>
      adapter.reversePayment(invoice.id, paymentId, reason),
  };
}

function serverRepository(decimals: number): InvoiceRepository {
  return {
    backend: 'server',

    list: async () => (await invoicesApi.list()).map(toBrowserInvoice),

    get: async (id) => {
      try {
        return toBrowserInvoice(await invoicesApi.get(id));
      } catch {
        return undefined;
      }
    },

    /*
     * `expectedVersion` comes off the invoice the caller is holding, which is
     * the whole point of optimistic concurrency: if the screen is stale, the
     * server refuses rather than silently applying a receipt to a document that
     * has moved on.
     */
    recordPayment: async (invoice, payment) => {
      const updated = await invoicesApi.recordPayment(invoice.id, invoiceVersion(invoice), {
        paidOn: payment.paidOn,
        amount: numberToDecimal(payment.amount, decimals),
        bankAccountId: payment.bankAccountId,
        method: payment.method,
        reference: payment.reference,
      });
      return toBrowserInvoice(updated);
    },

    reversePayment: async (invoice, paymentId, reason) =>
      toBrowserInvoice(await invoicesApi.reversePayment(paymentId, invoiceVersion(invoice), reason)),
  };
}

/**
 * The concurrency token for a server-backed invoice.
 *
 * `Invoice` has no `version` field — it never needed one, because the browser
 * store had no concurrent writer. Server-backed records carry it through, and
 * its absence is a programming error rather than a reason to send `0` and let
 * the server reject it with a confusing conflict.
 */
function invoiceVersion(invoice: Invoice): number {
  const version = (invoice as Invoice & { version?: number }).version;
  if (typeof version !== 'number') {
    throw new Error('This invoice was not loaded from the server, so it cannot be updated there.');
  }
  return version;
}

export interface RepositoryContext {
  company: InvoiceBackendState | undefined;
  browser: BrowserInvoiceAdapter;
  /** The company's monetary precision, from Currency Master. */
  decimals: number;
}

export function repositoryFor(context: RepositoryContext): InvoiceRepository {
  return backendFor(context.company) === 'server'
    ? serverRepository(context.decimals)
    : browserRepository(context.browser);
}

export type { ServerInvoiceInput, ServerInvoiceStatus };
