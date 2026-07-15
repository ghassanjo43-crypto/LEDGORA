import type {
  InvoiceCompanySnapshot,
  InvoiceCustomerSnapshot,
  InvoiceTemplate,
  InvoiceTemplateSnapshot,
  InvoiceTemplateVersion,
} from '@/types/invoice';
import type { CreditNoteTemplateSnapshot } from '@/types/creditNote';
import { createInvoiceTemplateSnapshot } from '@/lib/invoiceTemplates';

const CREDIT_NOTE_TITLE = 'Credit Note';

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Adapt an invoice's frozen (or freshly built) template snapshot into a credit
 * note: preserve the logo, colours, fonts and company/customer identity, but
 * change the document title to "Credit Note". A credit note created from an
 * invoice therefore inherits the invoice's exact visual identity.
 */
export function adaptSnapshotToCreditNote(snapshot: InvoiceTemplateSnapshot): CreditNoteTemplateSnapshot {
  const copy = structuredCloneSafe(snapshot);
  copy.contentConfig = { ...copy.contentConfig, title: CREDIT_NOTE_TITLE };
  return copy;
}

/**
 * Freeze the effective credit-note template snapshot at issuance. When adapting
 * from an invoice we clone the invoice's snapshot; otherwise we build a fresh
 * snapshot from the resolved template version — either way the title becomes
 * "Credit Note" and later template edits never alter the issued document.
 */
export function createCreditNoteTemplateSnapshot(
  template: InvoiceTemplate,
  version: InvoiceTemplateVersion,
  company: InvoiceCompanySnapshot,
  customer: InvoiceCustomerSnapshot,
  inheritFrom?: InvoiceTemplateSnapshot,
): CreditNoteTemplateSnapshot {
  if (inheritFrom) return adaptSnapshotToCreditNote(inheritFrom);
  return adaptSnapshotToCreditNote(createInvoiceTemplateSnapshot(template, version, company, customer));
}
