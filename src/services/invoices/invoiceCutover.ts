/**
 * Moving one company's invoices from the browser into the database.
 *
 * ── The ordering, and why it is not the obvious one ──────────────────────────
 * The tempting sequence is: flip the company to the server, then push the
 * invoices up. That order has a window in which the company is reading from an
 * empty server table, and a user who loads the invoice list inside that window
 * sees every invoice they have ever issued disappear.
 *
 * So the order here is: push first, verify the server agrees on the count, and
 * only then record the migration timestamp that makes `backendFor` start
 * answering 'server'. If any step fails the company is still on the browser
 * backend, still holding every invoice, and the operation can simply be run
 * again — the import endpoint is idempotent on (organization, number).
 *
 * Nothing is deleted from localStorage. The browser copy stays as it is, as a
 * fallback that costs nothing and as the only way back if the cutover turns out
 * to have been premature. Reclaiming that space is a separate decision, made
 * once the server copy has been trusted for a while, not a step of this one.
 */
import type { Invoice } from '@/types/invoice';
import {
  invoicesApi,
  type ImportedInvoice,
  type ImportedInvoiceLine,
  type ImportOutcome,
  type ServerInvoiceStatus,
} from '@/services/api/invoicesApi';
import { assessEligibility, type Ineligibility } from './invoiceBackend';
import { numberToDecimal } from './serverInvoiceMapping';

export interface CutoverResult {
  ok: boolean;
  /** Set on success — the value to store as the company's `invoicesMigratedAt`. */
  migratedAt?: string;
  outcome?: ImportOutcome;
  blockers?: Ineligibility[];
  error?: string;
}

/** Resolve a line's account code, which is what the import endpoint matches on. */
export type AccountCodeLookup = (accountId: string) => string | undefined;

/*
 * An account the browser references but the server has never heard of. The
 * import endpoint parks these on a visible suspense account rather than
 * failing, but the code still has to be SENT for it to do that -- an empty
 * string here would silently strand the line's value.
 */
const UNKNOWN_ACCOUNT_CODE = 'UNMAPPED';

function toImportedLine(
  line: Invoice['lines'][number],
  decimals: number,
  lookup: AccountCodeLookup,
): ImportedInvoiceLine {
  return {
    accountCode: lookup(line.accountId) ?? UNKNOWN_ACCOUNT_CODE,
    description: line.description,
    quantity: numberToDecimal(line.quantity, 6),
    unitPrice: numberToDecimal(line.unitPrice, decimals),
    lineSubtotal: numberToDecimal(line.lineSubtotal, decimals),
    lineTotal: numberToDecimal(line.lineTotal, decimals),
    taxRate: numberToDecimal(line.taxRate ?? 0, 6),
    taxAmount: numberToDecimal(line.taxAmount ?? 0, decimals),
    unit: line.unit,
    itemId: line.inventoryItemId ?? null,
    projectId: line.projectId ?? null,
    costCenterId: line.costCenterId ?? null,
  };
}

export function toImportedInvoice(
  invoice: Invoice,
  decimals: number,
  lookup: AccountCodeLookup,
): ImportedInvoice {
  return {
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status as ServerInvoiceStatus,
    issuingEntityId: invoice.entityId,
    customerId: invoice.customerId,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    transactionCurrency: invoice.currency,
    exchangeRate: numberToDecimal(invoice.exchangeRate, 10),
    subtotal: numberToDecimal(invoice.subtotal, decimals),
    additionalChargesTotal: numberToDecimal(invoice.additionalChargesTotal ?? 0, decimals),
    payments: (invoice.payments ?? []).map((payment) => ({
      paidOn: payment.date,
      amount: numberToDecimal(payment.amount, decimals),
      method: payment.method,
      reference: payment.reference,
    })),
    discountTotal: numberToDecimal(invoice.discountTotal, decimals),
    taxTotal: numberToDecimal(invoice.taxTotal, decimals),
    grandTotal: numberToDecimal(invoice.grandTotal, decimals),
    amountPaid: numberToDecimal(invoice.amountPaid, decimals),
    creditsApplied: numberToDecimal(invoice.creditsApplied, decimals),
    notes: invoice.notes,
    terms: invoice.terms,
    paymentTerms: invoice.paymentTerms,
    purchaseOrderReference: invoice.purchaseOrderReference,
    customerReference: invoice.customerReference,
    voidReason: invoice.voidReason,
    issuedAt: invoice.issuedAt,
    voidedAt: invoice.voidedAt,
    lines: invoice.lines.map((line) => toImportedLine(line, decimals, lookup)),
  };
}

export interface CutoverRequest {
  /** Every invoice this company holds in the browser. */
  invoices: Invoice[];
  /** The company's monetary precision, from Currency Master. */
  decimals: number;
  lookup: AccountCodeLookup;
}

/**
 * Run the cutover for one company.
 *
 * Returns rather than throws, because every failure mode here is one the
 * operator needs to read and act on, not a stack trace.
 */
export async function migrateCompanyInvoices(request: CutoverRequest): Promise<CutoverResult> {
  const eligibility = assessEligibility(request.invoices);
  if (!eligibility.eligible) {
    return { ok: false, blockers: eligibility.blockers };
  }

  const payload = request.invoices.map((invoice) =>
    toImportedInvoice(invoice, request.decimals, request.lookup));

  let outcome: ImportOutcome;
  try {
    outcome = await invoicesApi.import(payload);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  /*
   * A partial import must NOT flip the company. Landing 900 of 1000 invoices
   * and switching the backend would present a book with a hundred documents
   * missing as if it were complete.
   */
  if (outcome.failures.length > 0) {
    return {
      ok: false,
      outcome,
      error: `${outcome.failures.length} of ${payload.length} invoices could not be migrated. `
        + 'The company is unchanged; fix the reported invoices and run the migration again.',
    };
  }

  /*
   * Verify against the server rather than trusting the response we just parsed.
   * `imported + skipped` counts what this call did; the list is what is
   * actually there, which is the thing the screens will read after the flip.
   */
  try {
    const onServer = await invoicesApi.list();
    const expected = new Set(payload.map((invoice) => invoice.invoiceNumber));
    const present = new Set(onServer.map((invoice) => invoice.invoiceNumber));
    const missing = [...expected].filter((number) => !present.has(number));
    if (missing.length > 0) {
      return {
        ok: false,
        outcome,
        error: `The server is missing ${missing.length} migrated invoice(s) (for example ${missing[0]}). `
          + 'The company is unchanged.',
      };
    }
  } catch (cause) {
    return {
      ok: false,
      outcome,
      error: `The invoices were sent but could not be verified: ${
        cause instanceof Error ? cause.message : String(cause)
      }. The company is unchanged; run the migration again.`,
    };
  }

  return { ok: true, migratedAt: new Date().toISOString(), outcome };
}
