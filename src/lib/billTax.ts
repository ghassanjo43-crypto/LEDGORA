import type { Bill } from '@/types/bill';

export type DuplicateCheck =
  | { status: 'ok' }
  | { status: 'duplicate'; billId: string; billNumber: string }
  | { status: 'other-supplier'; billId: string; billNumber: string; supplierId: string };

/**
 * Supplier-invoice-number duplicate control:
 *  - `duplicate` (blocking): same supplier invoice number for the SAME supplier + entity.
 *  - `other-supplier` (warning): the same number exists for a DIFFERENT supplier.
 * Draft/void/reversed bills are ignored. Case-insensitive, trimmed comparison.
 */
export function checkDuplicateSupplierInvoiceNumber(
  bills: Bill[],
  input: { entityId: string; supplierId: string; supplierInvoiceNumber: string; excludeBillId?: string },
): DuplicateCheck {
  const number = input.supplierInvoiceNumber.trim().toLowerCase();
  if (!number) return { status: 'ok' };
  for (const b of bills) {
    if (b.id === input.excludeBillId) continue;
    if (b.status === 'draft' || b.status === 'void' || b.status === 'reversed') continue;
    if (b.supplierInvoiceNumber.trim().toLowerCase() !== number) continue;
    if (b.entityId === input.entityId && b.supplierId === input.supplierId) {
      return { status: 'duplicate', billId: b.id, billNumber: b.billNumber };
    }
    if (b.entityId === input.entityId) {
      return { status: 'other-supplier', billId: b.id, billNumber: b.billNumber, supplierId: b.supplierId };
    }
  }
  return { status: 'ok' };
}
