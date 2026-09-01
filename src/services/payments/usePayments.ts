/**
 * The one place a screen asks "what has this company paid its suppliers".
 *
 * Durable subscribers get the server ledger; Free Demo gets the local payment
 * store. Screens do not branch on the engine themselves — a screen that decided
 * for itself is a screen that can be forgotten when the next domain migrates.
 *
 * The server payment is mapped into the `Payment` shape every existing list,
 * drawer and renderer already consumes. That mapping is what keeps this slice
 * small: nothing downstream has to learn a second payment type, and the fields
 * P4 does not hold are left at their empty defaults rather than invented.
 */
import { useMemo } from 'react';
import type { Payment, PaymentAllocation, PaymentMethod, PaymentStatus } from '@/types/payment';
import type { ServerPayment } from '@/services/api/paymentsApi';
import { usePaymentStore } from '@/store/paymentStore';
import { useServerPayments, paymentsAreServerAuthoritative } from './paymentBackend';

/**
 * A server payment as the existing screens expect to see it.
 *
 * ══ What is deliberately zero ════════════════════════════════════════════════
 *
 * Bank fees, withholding, settlement discounts, realised exchange differences,
 * templates, attachments and every browser-only dimension are zero or absent,
 * because the server holds none of them and refuses each by name. A
 * plausible-looking value here would be this mapper inventing accounting the
 * server declined to record.
 *
 * `unappliedAmount` is zero for a structural reason rather than a convenient
 * one: a posted payment IS fully allocated, and there is no state in which it
 * is not.
 */
export function toBrowserPayment(payment: ServerPayment): Payment {
  const amount = Number(payment.amount);

  const allocations: PaymentAllocation[] = payment.allocations.map((allocation) => ({
    id: allocation.id,
    entityId: payment.issuingEntityId,
    paymentId: payment.id,
    supplierId: payment.supplierId,
    billId: allocation.billId,
    billNumber: allocation.billNumber,
    allocationType: 'bill',
    amount: Number(allocation.amount),
    /* Functional currency only, so the base amount IS the amount. Anything
     * else would be a conversion the server refused to make. */
    baseCurrencyAmount: Number(allocation.amount),
    allocationDate: payment.paymentDate,
    createdAt: allocation.createdAt ?? payment.paymentDate,
    updatedAt: allocation.createdAt ?? payment.paymentDate,
  }));

  const allocated = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

  /*
   * A posted payment is FULLY allocated, so it is never `partially-allocated`.
   * That status exists in the browser model for unapplied cash, which this
   * slice refuses outright.
   */
  const status: PaymentStatus = payment.status === 'posted' ? 'fully-allocated' : payment.status;

  return {
    id: payment.id,
    entityId: payment.issuingEntityId,
    paymentNumber: payment.paymentNumber,
    paymentType: 'supplier-payment',
    status,
    supplierId: payment.supplierId,
    paymentDate: payment.paymentDate,
    currency: payment.currency,
    /* Functional currency only: a rate other than one would be a conversion
     * with no realised difference to book it against. */
    exchangeRate: 1,
    grossAmount: amount,
    bankFeeAmount: 0,
    withholdingTaxAmount: 0,
    discountTakenAmount: 0,
    netCashAmount: amount,
    baseCurrencyAmount: amount,
    method: (payment.method as PaymentMethod) ?? 'bank-transfer',
    bankAccountId: payment.cashAccountId ?? undefined,
    transactionReference: payment.reference || undefined,
    narration: payment.memo || undefined,
    allocations,
    allocationTotal: allocated,
    /* Structural, not a placeholder: an unapplied balance cannot exist. */
    unappliedAmount: 0,
    journalEntryId: payment.journalEntryId ?? undefined,
    reversalJournalEntryId: payment.reversalJournalEntryId ?? undefined,
    reversalReason: payment.reversalReason ?? undefined,
    postedAt: payment.postedAt ?? undefined,
    reversedAt: payment.reversedAt ?? undefined,
    auditTrail: [],
    createdAt: payment.postedAt ?? payment.paymentDate,
    updatedAt: payment.postedAt ?? payment.paymentDate,
  } as Payment;
}

export interface PaymentLedgerView {
  payments: Payment[];
  /** True when these came from the server rather than the browser. */
  serverBacked: boolean;
  loading: boolean;
  error: string | null;
  /** How many payments remain in this browser but not in the books. */
  stranded: number;
}

export function usePayments(): PaymentLedgerView {
  const serverBacked = paymentsAreServerAuthoritative();
  const directory = useServerPayments();
  const localPayments = usePaymentStore((s) => s.payments);

  const payments = useMemo(
    () => (serverBacked ? directory.payments.map(toBrowserPayment) : localPayments),
    [serverBacked, directory.payments, localPayments],
  );

  return {
    payments,
    serverBacked,
    loading: serverBacked && directory.state === 'loading',
    error: serverBacked ? directory.error : null,
    /*
     * A CENSUS, not a migration. Payments left in this browser cannot be
     * imported automatically: the server would have to decide which bank
     * account each left, which posted bills it settled, and what to do with
     * the bank fees, withholding and unapplied balances it may carry — every
     * one of which this slice refuses. Each would invent accounting.
     */
    stranded: serverBacked ? localPayments.length : 0,
  };
}
