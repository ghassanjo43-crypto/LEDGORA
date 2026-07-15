import type { Invoice, InvoiceLine } from '@/types/invoice';
import type { CreditNote, CreditNoteLine, CreditType } from '@/types/creditNote';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { roundMoney } from '@/lib/journalValidation';
import { generateId } from '@/lib/utils';

/**
 * Credit notes that COUNT against an invoice's creditable balance: every status
 * except draft and void. Drafts have no accounting effect yet and voided notes
 * were reversed, so neither reduces what remains creditable.
 */
export function reducesCreditable(cn: Pick<CreditNote, 'status'>): boolean {
  return cn.status !== 'draft' && cn.status !== 'void';
}

function relevantNotes(creditNotes: CreditNote[], invoiceId: string, excludeId?: string): CreditNote[] {
  return creditNotes.filter(
    (cn) => cn.originalInvoiceId === invoiceId && cn.id !== excludeId && reducesCreditable(cn),
  );
}

/** Quantity of an invoice line already credited by issued, non-void credit notes. */
export function quantityCreditedForLine(invoiceLineId: string, notes: CreditNote[]): number {
  let qty = 0;
  for (const cn of notes) {
    for (const line of cn.lines) {
      if (line.originalInvoiceLineId === invoiceLineId) qty += Number(line.quantity) || 0;
    }
  }
  return roundMoney(qty);
}

/** Gross amount of an invoice line already credited by issued, non-void credit notes. */
export function amountCreditedForLine(invoiceLineId: string, notes: CreditNote[]): number {
  let amount = 0;
  for (const cn of notes) {
    for (const line of cn.lines) {
      if (line.originalInvoiceLineId === invoiceLineId) amount += Number(line.lineTotal) || 0;
    }
  }
  return roundMoney(amount);
}

/**
 * Remaining creditable quantity for a single invoice line:
 *   original invoiced quantity − quantity already credited (issued, non-void).
 */
export function calculateRemainingCreditableQuantity(
  invoiceLine: InvoiceLine,
  creditNotes: CreditNote[],
  invoiceId: string,
  excludeCreditNoteId?: string,
): number {
  const notes = relevantNotes(creditNotes, invoiceId, excludeCreditNoteId);
  return roundMoney(Math.max(0, (Number(invoiceLine.quantity) || 0) - quantityCreditedForLine(invoiceLine.id, notes)));
}

/**
 * Remaining creditable gross amount for a single invoice line:
 *   original invoice line total − amount already credited (issued, non-void).
 */
export function calculateRemainingCreditableAmount(
  invoiceLine: InvoiceLine,
  creditNotes: CreditNote[],
  invoiceId: string,
  excludeCreditNoteId?: string,
): number {
  const notes = relevantNotes(creditNotes, invoiceId, excludeCreditNoteId);
  const c = calculateInvoiceLine(invoiceLine);
  return roundMoney(Math.max(0, c.lineTotal - amountCreditedForLine(invoiceLine.id, notes)));
}

export interface InvoiceCreditSummary {
  originalTotal: number;
  previouslyCredited: number;
  availableToCredit: number;
}

/**
 * Invoice-level creditable position:
 *   available = invoice grand total − total issued non-void credits.
 * `excludeCreditNoteId` lets the editor discount the note being edited so its
 * own draft value is not double-counted.
 */
export function calculateInvoiceCreditSummary(
  invoice: Invoice,
  creditNotes: CreditNote[],
  excludeCreditNoteId?: string,
): InvoiceCreditSummary {
  const notes = relevantNotes(creditNotes, invoice.id, excludeCreditNoteId);
  const previouslyCredited = roundMoney(notes.reduce((sum, cn) => sum + (Number(cn.grandTotal) || 0), 0));
  const originalTotal = roundMoney(invoice.grandTotal);
  return {
    originalTotal,
    previouslyCredited,
    availableToCredit: roundMoney(Math.max(0, originalTotal - previouslyCredited)),
  };
}

/**
 * Build prefilled credit-note lines from an invoice, copying ONLY the remaining
 * creditable portion of each line (so earlier partial credits are never copied
 * twice). Percentage discounts and tax rates carry over unchanged; a fixed
 * discount is pro-rated to the credited quantity. `general-credit` starts blank.
 */
export function buildPrefilledCreditLines(
  invoice: Invoice,
  creditNotes: CreditNote[],
  creditType: CreditType,
  creditNoteId: string,
): CreditNoteLine[] {
  if (creditType === 'general-credit') {
    return [makeEmptyCreditLine(creditNoteId, 1)];
  }

  const notes = relevantNotes(creditNotes, invoice.id);
  const lines: CreditNoteLine[] = [];
  let sortOrder = 1;

  for (const inv of invoice.lines) {
    const remainingQty = roundMoney(Math.max(0, (Number(inv.quantity) || 0) - quantityCreditedForLine(inv.id, notes)));
    if (remainingQty <= 0) continue; // fully credited already — nothing left

    const originalQty = Number(inv.quantity) || 0;
    const qtyRatio = originalQty > 0 ? remainingQty / originalQty : 1;
    // Pro-rate only fixed-amount discounts; percentage discounts are rate-based.
    const discountValue =
      inv.discountType === 'amount'
        ? roundMoney((Number(inv.discountValue) || 0) * qtyRatio)
        : inv.discountValue;

    const base: CreditNoteLine = {
      id: generateId('cnline'),
      creditNoteId,
      originalInvoiceLineId: inv.id,
      itemId: inv.itemId,
      description: inv.description,
      revenueAccountId: inv.accountId,
      quantity: remainingQty,
      unit: inv.unit,
      unitPrice: inv.unitPrice,
      discountType: inv.discountType,
      discountValue,
      discountAmount: 0,
      taxCodeId: inv.taxCodeId,
      taxRate: inv.taxRate,
      taxableAmount: 0,
      taxAmount: 0,
      lineTotal: 0,
      projectId: inv.projectId,
      // Inherit the ORIGINAL invoice line's cost center(s) so a historical reversal
      // reflects the original allocation — never the customer's current default.
      costCenterId: inv.costCenterId,
      costCenterAssignments: inv.costCenterAssignments ? inv.costCenterAssignments.map((a) => ({ ...a })) : undefined,
      entityId: inv.entityId,
      returnToInventory: false,
      sortOrder: sortOrder++,
    };
    const c = calculateInvoiceLine(base);
    lines.push({ ...base, discountAmount: c.discountAmount, taxableAmount: c.taxableAmount, taxAmount: c.taxAmount, lineTotal: c.lineTotal });
  }

  return lines.length ? lines : [makeEmptyCreditLine(creditNoteId, 1)];
}

export function makeEmptyCreditLine(creditNoteId: string, sortOrder: number): CreditNoteLine {
  return {
    id: generateId('cnline'),
    creditNoteId,
    description: '',
    revenueAccountId: '',
    quantity: 1,
    unitPrice: 0,
    discountAmount: 0,
    taxRate: 0,
    taxableAmount: 0,
    taxAmount: 0,
    lineTotal: 0,
    returnToInventory: false,
    sortOrder,
  };
}
