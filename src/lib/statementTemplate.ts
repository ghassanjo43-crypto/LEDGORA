import type {
  InvoiceCompanySnapshot,
  InvoiceCustomerSnapshot,
  InvoiceTemplate,
  InvoiceTemplateSnapshot,
  InvoiceTemplateVersion,
  ResolvedInvoiceTemplate,
} from '@/types/invoice';
import { createInvoiceTemplateSnapshot, resolveInvoiceTemplateVersion, type ResolveParams, type TemplateData } from '@/lib/invoiceTemplates';

const STATEMENT_TITLE = 'Statement of Account';

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Resolve the effective statement template. Statements reuse the invoice
 * template infrastructure; priority is override → entity default → system
 * default (a customer-preferred statement template is deferred).
 */
export function resolveStatementTemplate(params: ResolveParams, data: TemplateData): ResolvedInvoiceTemplate {
  return resolveInvoiceTemplateVersion(params, data);
}

/** Adapt an invoice template snapshot into a statement (branding preserved, title changed). */
export function adaptSnapshotToStatement(snapshot: InvoiceTemplateSnapshot): InvoiceTemplateSnapshot {
  const copy = structuredCloneSafe(snapshot);
  copy.contentConfig = { ...copy.contentConfig, title: STATEMENT_TITLE };
  return copy;
}

/** Build a live statement template snapshot (statements are rendered live for the MVP). */
export function createStatementTemplateSnapshot(
  template: InvoiceTemplate,
  version: InvoiceTemplateVersion,
  company: InvoiceCompanySnapshot,
  customer: InvoiceCustomerSnapshot,
): InvoiceTemplateSnapshot {
  return adaptSnapshotToStatement(createInvoiceTemplateSnapshot(template, version, company, customer));
}
