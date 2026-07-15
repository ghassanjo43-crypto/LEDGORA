import type {
  InvoiceCompanySnapshot,
  InvoiceCustomerSnapshot,
  InvoiceTemplate,
  InvoiceTemplateSnapshot,
  InvoiceTemplateVersion,
  ResolvedInvoiceTemplate,
} from '@/types/invoice';
import type { PaymentTemplateSnapshot } from '@/types/payment';
import { createInvoiceTemplateSnapshot, resolveInvoiceTemplateVersion, type ResolveParams, type TemplateData } from '@/lib/invoiceTemplates';

const PAYMENT_TITLE = 'Payment Voucher';

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Resolve the effective payment voucher template. Payments reuse the invoice
 * template infrastructure; priority is: explicit override → entity default →
 * system default (a payee-preferred template is deferred for now).
 */
export function resolvePaymentTemplate(params: ResolveParams, data: TemplateData): ResolvedInvoiceTemplate {
  return resolveInvoiceTemplateVersion(params, data);
}

/** Adapt an invoice template snapshot into a payment voucher (title → "Payment Voucher"). */
export function adaptSnapshotToPayment(snapshot: InvoiceTemplateSnapshot): PaymentTemplateSnapshot {
  const copy = structuredCloneSafe(snapshot);
  copy.contentConfig = { ...copy.contentConfig, title: PAYMENT_TITLE };
  return copy;
}

/**
 * Freeze the effective payment voucher snapshot at posting. Later template, logo
 * or company/payee edits never alter an already-posted payment.
 */
export function createPaymentTemplateSnapshot(
  template: InvoiceTemplate,
  version: InvoiceTemplateVersion,
  company: InvoiceCompanySnapshot,
  payee: InvoiceCustomerSnapshot,
): PaymentTemplateSnapshot {
  return adaptSnapshotToPayment(createInvoiceTemplateSnapshot(template, version, company, payee));
}
