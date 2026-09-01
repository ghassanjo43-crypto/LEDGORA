/**
 * The one place a screen asks "what does this company owe".
 *
 * Durable subscribers get the server ledger; Free Demo gets the local bill
 * store. Screens do not branch on the engine themselves — a screen that decided
 * for itself is a screen that can be forgotten when the next domain migrates.
 *
 * The server bill is mapped into the `Bill` shape every existing list, drawer
 * and renderer already consumes. That mapping is what keeps this slice small:
 * nothing downstream has to learn a second bill type, and the fields P2 does
 * not hold are left at their empty defaults rather than invented.
 */
import { useMemo } from 'react';
import type { Bill, BillLine, BillStatus } from '@/types/bill';
import type { ServerBill } from '@/services/api/billsApi';
import { useBillStore } from '@/store/billStore';
import { useServerBills, billsAreServerAuthoritative } from './billBackend';

/**
 * A server bill as the existing screens expect to see it.
 *
 * ══ What is deliberately empty ═══════════════════════════════════════════════
 *
 * Tax, withholding, charges, payments, credits, attachments, template and every
 * browser-only dimension are zero or absent, because P2 holds none of them. A
 * plausible-looking value here would be this mapper inventing accounting the
 * server refused to record.
 */
export function toBrowserBill(bill: ServerBill): Bill {
  const lines: BillLine[] = bill.lines.map((line, index) => ({
    id: line.id,
    billId: bill.id,
    description: line.description,
    accountId: line.accountId,
    quantity: Number(line.quantity),
    unit: line.unit || undefined,
    unitPrice: Number(line.unitPrice),
    discountType: (line.discountType as BillLine['discountType']) ?? undefined,
    discountValue: line.discountValue === null ? undefined : Number(line.discountValue),
    discountAmount: Number(line.discountAmount),
    /* No tax on a P2 bill: the server refuses one outright. */
    taxRate: 0,
    taxableAmount: Number(line.lineNet),
    taxAmount: 0,
    lineSubtotal: Number(line.lineSubtotal),
    lineTotal: Number(line.lineNet),
    sortOrder: index + 1,
  }));

  const total = Number(bill.total);

  return {
    id: bill.id,
    revision: bill.version,
    entityId: bill.issuingEntityId,
    supplierId: bill.supplierId,
    billNumber: bill.billNumber,
    supplierInvoiceNumber: bill.supplierInvoiceNumber,
    /* P2 records services and expenses; the browser's finer typing has no
     * server counterpart, so the honest value is the general one. */
    billType: 'expense',
    status: bill.status as BillStatus,
    billDate: bill.billDate,
    postingDate: bill.postingDate,
    dueDate: bill.dueDate,
    currency: bill.currency,
    exchangeRate: 1,
    lines,
    subtotal: Number(bill.subtotal),
    discountTotal: Number(bill.discountTotal),
    taxTotal: 0,
    withholdingTaxTotal: 0,
    additionalChargesTotal: 0,
    grandTotal: total,
    amountPaid: 0,
    supplierCreditsApplied: 0,
    /*
     * The whole total is outstanding: P2 creates no payments, so nothing has
     * cleared it. This is a fact about the slice, not a placeholder.
     */
    balanceDue: bill.status === 'reversed' ? 0 : total,
    accountsPayableAccountId: bill.payableAccountId ?? '',
    templateId: '',
    templateVersionId: '',
    templateResolutionSource: 'entity-default',
    journalEntryId: bill.journalEntryId ?? undefined,
    reversalJournalEntryId: bill.reversalJournalEntryId ?? undefined,
    reversalReason: bill.reversalReason ?? undefined,
    payments: [],
    supplierCredits: [],
    attachments: [],
    notes: bill.memo || undefined,
    auditTrail: [],
    createdAt: bill.postedAt ?? bill.billDate,
    updatedAt: bill.postedAt ?? bill.billDate,
  } as Bill;
}

export interface BillLedgerView {
  bills: Bill[];
  /** True when these came from the server rather than the browser. */
  serverBacked: boolean;
  loading: boolean;
  error: string | null;
  /** How many bills remain in this browser but not in the books. */
  stranded: number;
}

export function useBills(): BillLedgerView {
  const serverBacked = billsAreServerAuthoritative();
  const directory = useServerBills();
  const localBills = useBillStore((s) => s.bills);

  const bills = useMemo(
    () => (serverBacked ? directory.bills.map(toBrowserBill) : localBills),
    [serverBacked, directory.bills, localBills],
  );

  return {
    bills,
    serverBacked,
    loading: serverBacked && directory.state === 'loading',
    error: serverBacked ? directory.error : null,
    /*
     * A CENSUS, not a migration. Bills left in this browser cannot be imported
     * automatically: the server would have to decide which supplier and which
     * expense account each names, whether its tax can be dropped, and whether a
     * posted one should post again. Every one of those would invent accounting.
     */
    stranded: serverBacked ? localBills.length : 0,
  };
}
