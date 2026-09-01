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
import { useServerPayments } from '@/services/payments/paymentBackend';

/**
 * A server bill as the existing screens expect to see it.
 *
 * ══ What is deliberately empty ═══════════════════════════════════════════════
 *
 * Withholding, charges, payments, credits, attachments, template and every
 * browser-only dimension are zero or absent, because the server holds none of
 * them. A plausible-looking value here would be this mapper inventing
 * accounting the server refused to record.
 *
 * Purchase TAX is different: P3 made it server-authoritative, so it is read
 * from the bill — from each line's frozen snapshot once posted — and never
 * recomputed here. The browser calculator is not authoritative for a
 * server-held bill.
 *
 * SETTLEMENT is the same again: P4 made supplier payments server-authoritative,
 * and what a bill still owes is DERIVED there from its active allocations. It
 * arrives as `outstanding` and is never recomputed here — netting payments in
 * the browser would give a second answer to a question the server has already
 * answered, and the two would disagree the moment a reallocation landed.
 */
export function toBrowserBill(bill: ServerBill, outstanding?: string): Bill {
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
    /*
     * The SERVER's figures. A posted line reads them from its frozen snapshot;
     * a draft reads what the last save resolved. Nothing here recomputes tax —
     * the browser calculator is not authoritative for a server-held bill.
     */
    taxCodeId: line.taxCodeId ?? undefined,
    taxRate: Number(line.taxSnapshot?.rate ?? 0),
    taxableAmount: Number(line.taxableAmount),
    taxAmount: Number(line.taxAmount),
    lineSubtotal: Number(line.lineSubtotal),
    lineTotal: Number(line.grossAmount),
    sortOrder: index + 1,
  }));

  const total = Number(bill.total);
  /*
   * A bill absent from the outstanding schedule is SETTLED, not unknown: the
   * schedule lists every posted bill with something left to pay. A reversed one
   * is absent for a different reason and is handled explicitly below.
   */
  const owed = outstanding === undefined
    ? total
    : Number(outstanding);
  const paid = Number((total - owed).toFixed(6));

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
    taxTotal: Number(bill.taxTotal),
    /* Withholding has no server treatment and is refused, so it is zero as a
     * fact about the slice rather than as a placeholder. */
    withholdingTaxTotal: 0,
    additionalChargesTotal: 0,
    grandTotal: total,
    amountPaid: paid,
    /* Supplier credits have no server treatment and are refused, so this is
     * zero as a fact about the slice rather than as a placeholder. */
    supplierCreditsApplied: 0,
    balanceDue: bill.status === 'reversed' ? 0 : owed,
    accountsPayableAccountId: bill.payableAccountId ?? '',
    inputTaxAccountId: bill.inputTaxAccountId ?? undefined,
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
  const outstanding = useServerPayments((s) => s.outstanding);
  const localBills = useBillStore((s) => s.bills);

  const bills = useMemo(() => {
    if (!serverBacked) return localBills;
    /*
     * A posted bill missing from the schedule owes NOTHING — it is settled, and
     * the server leaves settled bills out. A draft is never in it either, and
     * owes its whole total until it is posted.
     */
    const owed = new Map(outstanding.map((row) => [row.billId, row.outstanding]));
    return directory.bills.map((bill) => toBrowserBill(
      bill,
      bill.status === 'posted' ? (owed.get(bill.id) ?? '0') : undefined,
    ));
  }, [serverBacked, directory.bills, outstanding, localBills]);

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
