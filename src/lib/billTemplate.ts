import type { InvoiceCompanySnapshot, InvoiceCustomerSnapshot, InvoiceTemplate, InvoiceTemplateSnapshot, InvoiceTemplateVersion } from '@/types/invoice';
import { createInvoiceTemplateSnapshot } from '@/lib/invoiceTemplates';

const BILL_TITLE = 'Supplier Bill';

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function adaptSnapshotToBill(snapshot: InvoiceTemplateSnapshot): InvoiceTemplateSnapshot {
  const copy = structuredCloneSafe(snapshot);
  copy.contentConfig = { ...copy.contentConfig, title: BILL_TITLE };
  return copy;
}

/** Freeze the bill template snapshot at posting (title adapted to "Supplier Bill"). */
export function createBillTemplateSnapshot(
  template: InvoiceTemplate,
  version: InvoiceTemplateVersion,
  company: InvoiceCompanySnapshot,
  supplier: InvoiceCustomerSnapshot,
): InvoiceTemplateSnapshot {
  return adaptSnapshotToBill(createInvoiceTemplateSnapshot(template, version, company, supplier));
}
