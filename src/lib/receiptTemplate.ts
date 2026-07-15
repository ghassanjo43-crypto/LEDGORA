import type {
  InvoiceCompanySnapshot,
  InvoiceCustomerSnapshot,
  InvoiceTemplate,
  InvoiceTemplateSnapshot,
  InvoiceTemplateVersion,
  ResolvedInvoiceTemplate,
} from '@/types/invoice';
import type { ReceiptTemplateSnapshot } from '@/types/receipt';
import { createInvoiceTemplateSnapshot } from '@/lib/invoiceTemplates';
import { resolveInvoiceTemplateVersion, type ResolveParams, type TemplateData } from '@/lib/invoiceTemplates';

const RECEIPT_TITLE = 'Official Receipt';

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Resolve the effective receipt template. Receipts reuse the invoice template
 * infrastructure; priority is: explicit override → entity default → system
 * default (a customer-preferred receipt template is deferred for now).
 */
export function resolveReceiptTemplate(params: ResolveParams, data: TemplateData): ResolvedInvoiceTemplate {
  return resolveInvoiceTemplateVersion(params, data);
}

/**
 * Adapt an invoice template snapshot into a receipt: preserve logo, colours,
 * fonts and company/customer identity, but change the title to "Official
 * Receipt".
 */
export function adaptSnapshotToReceipt(snapshot: InvoiceTemplateSnapshot): ReceiptTemplateSnapshot {
  const copy = structuredCloneSafe(snapshot);
  copy.contentConfig = { ...copy.contentConfig, title: RECEIPT_TITLE };
  return copy;
}

/**
 * Freeze the effective receipt template snapshot at posting. Later template,
 * logo or company/customer edits never alter an already-posted receipt.
 */
export function createReceiptTemplateSnapshot(
  template: InvoiceTemplate,
  version: InvoiceTemplateVersion,
  company: InvoiceCompanySnapshot,
  customer: InvoiceCustomerSnapshot,
): ReceiptTemplateSnapshot {
  return adaptSnapshotToReceipt(createInvoiceTemplateSnapshot(template, version, company, customer));
}
