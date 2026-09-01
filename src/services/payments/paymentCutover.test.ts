// @vitest-environment happy-dom
/**
 * A durable subscriber's payments live on the server, and nowhere else.
 *
 * ══ The failures this guards ═════════════════════════════════════════════════
 *
 * Falling back to `usePaymentStore` when the fetch fails would put demo seed
 * payments in a real list, claiming bills had been settled by money that never
 * left a bank — and the payables list would understate what is owed.
 *
 * Writing to `usePaymentStore` when the server owns the ledger is worse: the
 * write appears to succeed and the next load replaces the cache without a word,
 * so a recorded payment is gone with nothing to retry, having in the meantime
 * told a bookkeeper a supplier had been paid.
 *
 * And the browser must not offer what P4 cannot honour — unapplied cash,
 * supplier advances, bank fees, withholding — because a payment that looks
 * settled and is not is the expensive kind of wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), history: vi.fn(), create: vi.fn(),
  update: vi.fn(), remove: vi.fn(), post: vi.fn(), reallocate: vi.fn(),
  reverse: vi.fn(), payables: vi.fn(), statement: vi.fn(),
}));
vi.mock('@/services/api/paymentsApi', () => ({ paymentsApi: api }));
/* The other gateways `booksScope` reaches on a company change. */
vi.mock('@/services/api/billsApi', () => ({ billsApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/suppliersApi', () => ({ suppliersApi: { list: vi.fn(async () => ({ parties: [], nextCursor: null })), count: vi.fn(async () => 0) } }));
vi.mock('@/services/api/customersApi', () => ({ customersApi: { list: vi.fn(async () => ({ parties: [], nextCursor: null })) } }));
vi.mock('@/services/api/invoicesApi', () => ({ invoicesApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/taxCodesApi', () => ({ taxCodesApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

/* booksScope FIRST: it imports the stores it clears. */
import { enterCompanyScope, __resetBooksScopeForTests } from '@/services/books/booksScope';
import {
  useServerPayments, paymentBackend, paymentsAreServerAuthoritative,
  loadPayments, paymentGateway, clearPaymentCache,
  eligibleBillsFor, outstandingForBill,
  UNAPPLIED_UNSUPPORTED, UNALLOCATE_UNSUPPORTED, BILL_REVERSAL_BLOCKED,
} from './paymentBackend';
import { toBrowserPayment } from './usePayments';
import { toBrowserBill } from '@/services/bills/useBills';
import { usePaymentStore } from '@/store/paymentStore';
import { useBillStore } from '@/store/billStore';

const serverPayment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1', paymentNumber: 'PAY-2026-0001', status: 'posted',
  issuingEntityId: 'entity-main', supplierId: 'sup-1',
  paymentDate: '2026-04-01', currency: 'JOD', amount: '1000.000',
  method: 'bank-transfer', reference: 'TRF-9', memo: '',
  cashAccountId: 'acct-bank', payableAccountId: 'acct-payable',
  journalEntryId: 'je-1', reversalJournalEntryId: null, reversalReason: null,
  postedAt: '2026-04-01T00:00:00.000Z', reversedAt: null, version: 2,
  allocations: [{
    id: 'alloc-1', billId: 'bill-1', billNumber: 'BILL-2026-0001',
    amount: '1000.000', status: 'active', createdAt: '2026-04-01T00:00:00.000Z',
  }],
  ...over,
});

const outstandingRow = (over: Record<string, unknown> = {}) => ({
  billId: 'bill-2', billNumber: 'BILL-2026-0002', supplierId: 'sup-1',
  supplierName: 'Acme Supplies Ltd', supplierInvoiceNumber: 'SUP-2',
  billDate: '2026-03-01', dueDate: '2026-03-31', currency: 'JOD',
  total: '500.000', paid: '200.000', outstanding: '300.000',
  daysOverdue: 0, agingBucket: 'current',
  ...over,
});

const payables = (rows: Record<string, unknown>[] = [outstandingRow()]) => ({
  outstanding: rows,
  aging: {
    asOfDate: '2026-06-01', currency: 'JOD', total: '300.000',
    buckets: [{ id: 'current', label: 'Current', amount: '300.000', billIds: ['bill-2'] }],
    suppliers: [],
  },
});

beforeEach(() => {
  engine.current = 'server';
  Object.values(api).forEach((fn) => fn.mockReset());
  api.list.mockResolvedValue([serverPayment()]);
  api.payables.mockResolvedValue(payables());
  __resetBooksScopeForTests();
  localStorage.clear();
  clearPaymentCache();
  usePaymentStore.setState({ payments: [] });
  useBillStore.setState({ bills: [] });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ The verdict ═══════════════════════════════════════════════════════════ */

describe('which ledger a durable subscriber gets', () => {
  it('is the SERVER', () => {
    expect(paymentBackend()).toBe('server');
    expect(paymentsAreServerAuthoritative()).toBe(true);
  });

  it('is the browser in a demo workspace, whose payments are the originals', () => {
    engine.current = 'demo';
    expect(paymentBackend()).toBe('browser');
  });

  it('asks the server for nothing in a demo workspace', async () => {
    engine.current = 'demo';
    await loadPayments();
    expect(api.list).not.toHaveBeenCalled();
    expect(api.payables).not.toHaveBeenCalled();
  });
});

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

describe('loading', () => {
  it('replaces the list AND the outstanding schedule, writing nothing to storage', async () => {
    const before = JSON.stringify(localStorage);

    await loadPayments();

    const state = useServerPayments.getState();
    expect(state.state).toBe('ready');
    expect(state.payments).toHaveLength(1);
    expect(state.outstanding).toHaveLength(1);
    expect(state.aging?.total).toBe('300.000');
    /* Clearing browser storage must lose a cache, not a payment. */
    expect(JSON.stringify(localStorage)).toBe(before);
  });

  it('reports a failure and offers NO local fallback', async () => {
    usePaymentStore.setState({ payments: [{ id: 'demo-pay' } as never] });
    api.list.mockRejectedValue(new Error('Network unreachable'));

    await loadPayments();

    const state = useServerPayments.getState();
    expect(state.state).toBe('unavailable');
    expect(state.error).toContain('Network unreachable');
    /* Empty, not the demo seed. */
    expect(state.payments).toHaveLength(0);
    expect(state.outstanding).toHaveLength(0);
  });

  it('reports a failure of the OUTSTANDING half too, rather than a half-answer', async () => {
    api.payables.mockRejectedValue(new Error('Payables unavailable'));

    await loadPayments();

    /* A list of payments beside a blank schedule would read as "nothing is
     * owed", which is the opposite of "we could not find out". */
    expect(useServerPayments.getState().state).toBe('unavailable');
    expect(useServerPayments.getState().outstanding).toHaveLength(0);
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('company scope', () => {
  it('clears cached payments and balances IMMEDIATELY on a company change', async () => {
    await loadPayments();
    expect(useServerPayments.getState().payments).toHaveLength(1);

    enterCompanyScope('co_other');

    expect(useServerPayments.getState().payments).toHaveLength(0);
    expect(useServerPayments.getState().outstanding).toHaveLength(0);
    expect(useServerPayments.getState().aging).toBeNull();
  });

  it('DISCARDS a response that arrives after the company changed', async () => {
    let release: (value: unknown) => void = () => {};
    api.list.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = loadPayments();
    enterCompanyScope('co_elsewhere');
    release([serverPayment({ paymentNumber: 'PREVIOUS-COMPANY' })]);
    await pending;

    expect(useServerPayments.getState().payments).toHaveLength(0);
  });
});

/* ══ Writes ════════════════════════════════════════════════════════════════ */

describe('the write path', () => {
  it('posts the allocations WITH the payment, then re-reads', async () => {
    api.post.mockResolvedValue(serverPayment());
    await paymentGateway.post('pay-1', 1, [{ billId: 'bill-1', amount: '1000.000' }]);

    expect(api.post).toHaveBeenCalledWith('pay-1', 1, [{ billId: 'bill-1', amount: '1000.000' }]);
    expect(api.list).toHaveBeenCalled();
    expect(api.payables).toHaveBeenCalled();
  });

  it('carries the version on an edit, a reallocation and a reversal', async () => {
    api.update.mockResolvedValue(serverPayment());
    api.reallocate.mockResolvedValue(serverPayment());
    api.reverse.mockResolvedValue(serverPayment({ status: 'reversed' }));

    await paymentGateway.update('pay-1', 3, { paymentDate: '2026-04-02', amount: '900.000' });
    await paymentGateway.reallocate('pay-1', 4, [{ billId: 'bill-2', amount: '900.000' }]);
    await paymentGateway.reverse('pay-1', 5, 'Bank returned it');

    expect(api.update).toHaveBeenCalledWith('pay-1', 3, expect.anything());
    expect(api.reallocate).toHaveBeenCalledWith('pay-1', 4, [{ billId: 'bill-2', amount: '900.000' }]);
    expect(api.reverse).toHaveBeenCalledWith('pay-1', 5, 'Bank returned it');
  });

  it('offers NO way to detach an allocation on its own', () => {
    /* The absence is the point: a shape that could ask for a partial
     * unallocation would be a shape that could ask for unapplied cash. */
    expect((paymentGateway as Record<string, unknown>).unallocate).toBeUndefined();
    expect((api as Record<string, unknown>).unallocate).toBeUndefined();
  });
});

/* ══ Eligible bills ════════════════════════════════════════════════════════ */

describe('which bills a payment may settle', () => {
  it('offers the same supplier and currency, still owing', async () => {
    api.payables.mockResolvedValue(payables([
      outstandingRow(),
      outstandingRow({ billId: 'bill-3', supplierId: 'sup-other' }),
      outstandingRow({ billId: 'bill-4', currency: 'USD' }),
    ]));
    await loadPayments();

    const eligible = eligibleBillsFor('sup-1', 'JOD');
    expect(eligible.map((row) => row.billId)).toEqual(['bill-2']);
  });

  it('reports what a bill still owes from the SERVER, never recomputed', async () => {
    await loadPayments();
    expect(outstandingForBill('bill-2')?.outstanding).toBe('300.000');
    /* A settled bill is absent from the schedule entirely. */
    expect(outstandingForBill('bill-1')).toBeUndefined();
  });
});

/* ══ The browser stores refuse durable writes ══════════════════════════════ */

describe('the browser payment store', () => {
  it('REFUSES to create a payment when the server owns them', () => {
    const result = usePaymentStore.getState().createDraft({ supplierId: 'sup-1' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/saved on the server/i);
  });

  it('refuses to post, apply, unapply or reverse locally', () => {
    const store = usePaymentStore.getState();
    expect(store.postPayment('x').ok).toBe(false);
    expect(store.applyPaymentToBills('x', [], '2026-04-01').ok).toBe(false);
    expect(store.unapplyPaymentAllocation('x', 'a').ok).toBe(false);
    expect(store.reversePayment('x', 'why').ok).toBe(false);
    expect(store.submitPayment('x').ok).toBe(false);
    expect(store.approvePayment('x').ok).toBe(false);
    expect(store.voidDraft('x').ok).toBe(false);
    expect(store.duplicatePayment('x').ok).toBe(false);
    expect(store.deleteDraft('x').ok).toBe(false);
  });

  it('allows the write in a demo workspace', () => {
    engine.current = 'demo';
    const result = usePaymentStore.getState().createDraft({ supplierId: 'sup-1' });
    /* Free Demo's payments are the originals and live nowhere else. */
    expect(result.ok).toBe(true);
  });
});

describe('the browser bill store', () => {
  it('refuses to settle a server-held bill locally', () => {
    const store = useBillStore.getState();
    const recorded = store.recordPayment('bill-1', {
      amount: 100, date: '2026-04-01', bankAccountId: 'acct-bank',
    });
    expect(recorded.ok).toBe(false);
    expect(recorded.error).toMatch(/recorded on the server/i);

    expect(store.applyPaymentAllocation('bill-1', {
      amount: 100, date: '2026-04-01', paymentId: 'pay-1',
    }).ok).toBe(false);
    expect(store.removePaymentAllocations('bill-1', 'pay-1').ok).toBe(false);
  });

  it('allows settlement in a demo workspace', () => {
    engine.current = 'demo';
    /* Refused for a MISSING bill rather than for the engine — the guard is
     * out of the way, which is what this asserts. */
    const result = useBillStore.getState().recordPayment('nope', {
      amount: 100, date: '2026-04-01', bankAccountId: 'acct-bank',
    });
    expect(result.error).toBe('Bill not found.');
  });
});

/* ══ Refusal messages ══════════════════════════════════════════════════════ */

describe('what the browser tells a user it cannot do', () => {
  it('never says merely "unallocate the payment first"', () => {
    /* That advice is unusable: P4 refuses an unapplied balance, so detaching
     * without replacing is not a step the product has. The message must name
     * the two routes that ARE complete. */
    expect(UNALLOCATE_UNSUPPORTED).not.toMatch(/unallocate the payment first/i);
    expect(UNALLOCATE_UNSUPPORTED).toMatch(/reallocate the full amount/i);
    expect(UNALLOCATE_UNSUPPORTED).toMatch(/reverse the payment/i);
  });

  it('explains the bill-reversal refusal in terms of the ledger, with both remedies', () => {
    expect(BILL_REVERSAL_BLOCKED).toMatch(/accounts payable a second time/i);
    expect(BILL_REVERSAL_BLOCKED).toMatch(/reverse the payment first/i);
    expect(BILL_REVERSAL_BLOCKED).toMatch(/reallocate its full amount/i);
  });

  it('says WHY unapplied cash is refused, not merely that it is', () => {
    expect(UNAPPLIED_UNSUPPORTED).toMatch(/advances account/i);
    expect(UNAPPLIED_UNSUPPORTED).toMatch(/refund/i);
  });
});

/* ══ What a bill still owes ════════════════════════════════════════════════ */

describe('settlement on the bill, as the screens see it', () => {
  const serverBill = (over: Record<string, unknown> = {}) => ({
    id: 'bill-2', billNumber: 'BILL-2026-0002', supplierInvoiceNumber: 'SUP-2',
    status: 'posted', issuingEntityId: 'entity-main', supplierId: 'sup-1',
    billDate: '2026-03-01', postingDate: '2026-03-01', dueDate: '2026-03-31',
    currency: 'JOD', memo: '',
    subtotal: '500.000', discountTotal: '0.000', taxTotal: '0.000', total: '500.000',
    payableAccountId: 'acct-payable', inputTaxAccountId: null, journalEntryId: 'je-9',
    reversalJournalEntryId: null, reversalReason: null,
    postedAt: '2026-03-01T00:00:00.000Z', reversedAt: null, version: 2,
    lines: [],
    ...over,
  });

  it('takes the outstanding amount from the SERVER, never by netting here', () => {
    const bill = toBrowserBill(serverBill() as never, '300.000');
    expect(bill.balanceDue).toBe(300);
    expect(bill.amountPaid).toBe(200);
    expect(bill.grandTotal).toBe(500);
  });

  it('reads a settled bill — absent from the schedule — as owing nothing', () => {
    const bill = toBrowserBill(serverBill() as never, '0');
    expect(bill.balanceDue).toBe(0);
    expect(bill.amountPaid).toBe(500);
  });

  it('owes its whole total when no schedule figure is given, as a draft does', () => {
    const bill = toBrowserBill(serverBill({ status: 'draft' }) as never);
    expect(bill.balanceDue).toBe(500);
    expect(bill.amountPaid).toBe(0);
  });

  it('shows a reversed bill as owing nothing, whatever the schedule says', () => {
    const bill = toBrowserBill(serverBill({ status: 'reversed' }) as never, '500.000');
    expect(bill.balanceDue).toBe(0);
  });

  it('reports NO supplier credits, which have no server treatment', () => {
    const bill = toBrowserBill(serverBill() as never, '300.000');
    expect(bill.supplierCreditsApplied).toBe(0);
    expect(bill.supplierCredits).toEqual([]);
  });
});

/* ══ Mapping ═══════════════════════════════════════════════════════════════ */

describe('a server payment as the screens see it', () => {
  it('reports the amount, the allocations and the bank account', () => {
    const payment = toBrowserPayment(serverPayment() as never);

    expect(payment.paymentNumber).toBe('PAY-2026-0001');
    expect(payment.grossAmount).toBe(1000);
    expect(payment.netCashAmount).toBe(1000);
    expect(payment.bankAccountId).toBe('acct-bank');
    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0]!.billNumber).toBe('BILL-2026-0001');
    expect(payment.allocationTotal).toBe(1000);
  });

  it('shows a posted payment as FULLY allocated, with nothing unapplied', () => {
    const payment = toBrowserPayment(serverPayment() as never);
    expect(payment.status).toBe('fully-allocated');
    /* Structural: there is no state in which a posted payment is not. */
    expect(payment.unappliedAmount).toBe(0);
  });

  it('reports NO bank fee, withholding, discount or exchange difference', () => {
    const payment = toBrowserPayment(serverPayment() as never);
    expect(payment.bankFeeAmount).toBe(0);
    expect(payment.withholdingTaxAmount).toBe(0);
    expect(payment.discountTakenAmount).toBe(0);
    expect(payment.realizedFxAmount).toBeUndefined();
    expect(payment.exchangeRate).toBe(1);
  });

  it('shows a reversed payment as reversed, with no allocations left', () => {
    const payment = toBrowserPayment(serverPayment({
      status: 'reversed', allocations: [],
      reversalJournalEntryId: 'je-2', reversalReason: 'Bank returned it',
    }) as never);

    expect(payment.status).toBe('reversed');
    expect(payment.allocations).toEqual([]);
    expect(payment.allocationTotal).toBe(0);
    expect(payment.reversalReason).toBe('Bank returned it');
  });

  it('carries the version as the concurrency token', () => {
    /* The browser model has no `revision` on a payment, so the version travels
     * through the gateway rather than the mapped record — which is why every
     * write above asserts it explicitly. */
    expect(serverPayment().version).toBe(2);
  });
});
