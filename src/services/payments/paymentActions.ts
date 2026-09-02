/**
 * Payment writes: the server for a durable subscriber, the local store for Free
 * Demo, and never both.
 *
 * ══ Posting carries the allocations ══════════════════════════════════════════
 *
 * `post` takes the bills the money settles, because a posted payment is fully
 * allocated and the two are one decision rather than a step somebody might
 * forget. There is no path here that posts a payment and leaves it to be
 * applied later — that state does not exist.
 *
 * ══ There is no unallocate ═══════════════════════════════════════════════════
 *
 * `reallocate` replaces the WHOLE set atomically and the new total must still
 * equal the payment. Detaching an allocation without replacing it would leave
 * unapplied cash, which the product has no account for. The absence of a
 * partial operation here is the refusal expressed as a shape.
 *
 * ══ What the durable path deliberately drops ═════════════════════════════════
 *
 * `toPaymentWriteInput` copies the date, the amount, the method, the reference,
 * the memo and the paying account. It does not copy bank fees, withholding,
 * settlement discounts, realised exchange differences, write-offs, projects,
 * cost centres, templates, attachments or cheque clearing — not because it is
 * careful, but because they are not in the object it builds.
 */
import type { PaymentWriteInput, PaymentAllocationInput } from '@/services/api/paymentsApi';
import { usePaymentStore } from '@/store/paymentStore';
import { INVOICE_ENTITY_ID } from '@/store/invoiceTemplateStore';
import {
  paymentGateway,
  paymentsAreServerAuthoritative,
  serverPaymentById,
} from './paymentBackend';
import { loadBills } from '@/services/bills/billBackend';

export interface PaymentActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** True when the server refused because somebody else edited first. */
  conflict?: boolean;
}

/** What the screen collects, in the browser's own shape. */
export interface PaymentDraftValues {
  supplierId: string;
  paymentDate: string;
  /** A browser number; converted to an exact decimal string on the way out. */
  amount: number;
  method?: string;
  reference?: string;
  memo?: string;
  cashAccountId?: string;
}

export interface AllocationDraft {
  billId: string;
  amount: number;
}

const DECIMAL = (value: number | undefined | null): string => {
  if (value === undefined || value === null || Number.isNaN(value)) return '0';
  /* Fixed notation, never exponential: `1e-7` is not a decimal the server
   * accepts, and `toString()` produces one for small numbers. */
  return Number(value).toFixed(10).replace(/0+$/, '').replace(/\.$/, '') || '0';
};

export function toPaymentWriteInput(values: PaymentDraftValues): PaymentWriteInput {
  return {
    paymentDate: values.paymentDate,
    amount: DECIMAL(values.amount),
    method: values.method,
    reference: values.reference,
    memo: values.memo,
    cashAccountId: values.cashAccountId,
  };
}

export function toAllocationInput(allocations: AllocationDraft[]): PaymentAllocationInput[] {
  return allocations
    .filter((allocation) => allocation.billId && Number(allocation.amount) > 0)
    .map((allocation) => ({ billId: allocation.billId, amount: DECIMAL(allocation.amount) }));
}

const GONE = 'That payment is no longer in these books. Reload and try again.';

/**
 * The server's own words, kept.
 *
 * Over-allocation, an under-allocated total, a bill belonging to another
 * supplier, a locked period and a missing payable account each say something
 * different, and a generic message would hide which.
 */
function asResult(cause: unknown): PaymentActionResult {
  const message = cause instanceof Error ? cause.message : 'Could not save this payment.';
  return { ok: false, error: message, conflict: /changed by another user|reload/i.test(message) };
}

export const APPROVAL_UNSUPPORTED =
  'Submitting and approving a payment is not available for server-held books. There is no approval '
  + 'workflow on the server, and a status it could set but never honour would be worse than none.';

export const OTHER_TYPES_UNSUPPORTED =
  'Only supplier payments are held on the server. Customer refunds, payroll, tax, loan and lease '
  + 'payments each need their own controlled accounting, which is a later step.';

export interface PaymentActions {
  /** True when these actions go to the server. */
  serverBacked: boolean;
  create: (values: PaymentDraftValues) => Promise<PaymentActionResult>;
  update: (id: string, values: PaymentDraftValues) => Promise<PaymentActionResult>;
  /** Posting carries the allocations: a payment is not postable part-applied. */
  post: (id: string, allocations: AllocationDraft[]) => Promise<PaymentActionResult>;
  /** The complete replacement — the only correction short of a reversal. */
  reallocate: (id: string, allocations: AllocationDraft[]) => Promise<PaymentActionResult>;
  reverse: (id: string, reason: string) => Promise<PaymentActionResult>;
  remove: (id: string) => Promise<PaymentActionResult>;
  /** False in durable mode: no server operation exists. See the constants. */
  canApprove: boolean;
  canPayOtherTypes: boolean;
}

/** The entity a durable payment is numbered within. See `billActions`. */
export const ISSUING_ENTITY = INVOICE_ENTITY_ID;

export function paymentActions(): PaymentActions {
  if (!paymentsAreServerAuthoritative()) {
    /* Free Demo: the local store, exactly as before this slice. */
    const store = usePaymentStore.getState();
    return {
      serverBacked: false,
      create: async (values) => store.createDraft({
        paymentType: 'supplier-payment',
        supplierId: values.supplierId,
        paymentDate: values.paymentDate,
        grossAmount: values.amount,
      }),
      update: async (id, values) => store.updateDraft(id, {
        supplierId: values.supplierId,
        paymentDate: values.paymentDate,
        grossAmount: values.amount,
        bankAccountId: values.cashAccountId,
        transactionReference: values.reference,
        narration: values.memo,
      } as never),
      post: async (id) => store.postPayment(id),
      reallocate: async (id, allocations) => store.applyPaymentToBills(
        id,
        allocations.map((allocation) => ({ billId: allocation.billId, amount: allocation.amount })),
      ),
      reverse: async (id, reason) => store.reversePayment(id, reason),
      remove: async (id) => store.deleteDraft(id),
      canApprove: true,
      canPayOtherTypes: true,
    };
  }

  return {
    serverBacked: true,

    create: async (values) => {
      try {
        const created = await paymentGateway.create({
          issuingEntityId: ISSUING_ENTITY,
          supplierId: values.supplierId,
          ...toPaymentWriteInput(values),
        });
        return { ok: true, id: created.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    /*
     * The version comes from the cached SERVER row, not from the form. A form
     * that carried its own version would happily send back the one it was
     * opened with after somebody else had saved, which is the merge this
     * refuses.
     */
    update: async (id, values) => {
      const current = serverPaymentById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const updated = await paymentGateway.update(id, current.version, {
          supplierId: values.supplierId,
          ...toPaymentWriteInput(values),
        });
        return { ok: true, id: updated.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    post: async (id, allocations) => {
      const current = serverPaymentById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const posted = await paymentGateway.post(
          id, current.version, toAllocationInput(allocations),
        );
        /* What each bill still owes has changed. Refreshed from the ACTIONS
         * layer, so the two backends never import each other. */
        await loadBills();
        return { ok: true, id: posted.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    reallocate: async (id, allocations) => {
      const current = serverPaymentById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const moved = await paymentGateway.reallocate(
          id, current.version, toAllocationInput(allocations),
        );
        await loadBills();
        return { ok: true, id: moved.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    reverse: async (id, reason) => {
      const current = serverPaymentById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const reversed = await paymentGateway.reverse(id, current.version, reason);
        await loadBills();
        return { ok: true, id: reversed.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    remove: async (id) => {
      const current = serverPaymentById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        await paymentGateway.remove(id, current.version);
        return { ok: true, id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    canApprove: false,
    canPayOtherTypes: false,
  };
}
