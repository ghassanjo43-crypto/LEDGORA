// @vitest-environment happy-dom
/**
 * A durable subscriber's bills live on the server, and nowhere else.
 *
 * ══ The failures this guards ═════════════════════════════════════════════════
 *
 * Falling back to `useBillStore` when the fetch fails would put demo seed bills
 * in a real subscriber's payables list, and posting one would credit a supplier
 * the books do not have.
 *
 * Writing to `useBillStore` when the server owns the ledger is worse: the write
 * appears to succeed and the next load replaces the cache without a word, so a
 * recorded liability is gone with nothing to retry.
 *
 * And the browser must not offer what P2 cannot honour — payments, credits,
 * attachments — because a bill that looks paid and is not is the expensive kind
 * of wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), history: vi.fn(), create: vi.fn(),
  update: vi.fn(), remove: vi.fn(), post: vi.fn(), reverse: vi.fn(),
}));
vi.mock('@/services/api/billsApi', () => ({ billsApi: api }));
/* The other gateways `booksScope` reaches on a company change. */
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
  useServerBills, billBackend, billsAreServerAuthoritative,
  loadBills, billGateway, clearBillCache,
} from './billBackend';
import { toBrowserBill } from './useBills';
import { useBillStore } from '@/store/billStore';

const serverBill = (over: Record<string, unknown> = {}) => ({
  id: 'bill-1', billNumber: 'BILL-2026-0001', supplierInvoiceNumber: 'SUP-77',
  status: 'posted', issuingEntityId: 'entity-main', supplierId: 'sup-1',
  billDate: '2026-03-01', postingDate: '2026-03-01', dueDate: '2026-03-31',
  currency: 'JOD', memo: '',
  subtotal: '1000.000', discountTotal: '100.000', total: '900.000',
  payableAccountId: 'acct-payable', journalEntryId: 'je-1',
  reversalJournalEntryId: null, reversalReason: null,
  postedAt: '2026-03-01T00:00:00.000Z', reversedAt: null, version: 2,
  lines: [{
    id: 'line-1', lineNumber: 1, description: 'Consulting', accountId: 'acct-expense',
    quantity: '1.000000', unit: '', unitPrice: '1000.000',
    discountType: 'percentage', discountValue: '10.000',
    discountAmount: '100.000', lineSubtotal: '1000.000', lineNet: '900.000',
  }],
  ...over,
});

beforeEach(() => {
  engine.current = 'server';
  Object.values(api).forEach((fn) => fn.mockReset());
  api.list.mockResolvedValue([serverBill()]);
  __resetBooksScopeForTests();
  localStorage.clear();
  clearBillCache();
  useBillStore.setState({ bills: [] });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ The verdict ═══════════════════════════════════════════════════════════ */

describe('which ledger a durable subscriber gets', () => {
  it('is the SERVER', () => {
    expect(billBackend()).toBe('server');
    expect(billsAreServerAuthoritative()).toBe(true);
  });

  it('is the browser in a demo workspace, whose bills are the originals', () => {
    engine.current = 'demo';
    expect(billBackend()).toBe('browser');
  });

  it('asks the server for nothing in a demo workspace', async () => {
    engine.current = 'demo';
    await loadBills();
    expect(api.list).not.toHaveBeenCalled();
  });
});

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

describe('loading', () => {
  it('replaces the list and writes NOTHING to browser storage', async () => {
    const before = JSON.stringify(localStorage);

    await loadBills();

    const state = useServerBills.getState();
    expect(state.state).toBe('ready');
    expect(state.bills).toHaveLength(1);
    /* Clearing browser storage must lose a cache, not a bill. */
    expect(JSON.stringify(localStorage)).toBe(before);
  });

  it('reports a failure and offers NO local fallback', async () => {
    useBillStore.setState({ bills: [{ id: 'demo-bill' } as never] });
    api.list.mockRejectedValue(new Error('Network unreachable'));

    await loadBills();

    const state = useServerBills.getState();
    expect(state.state).toBe('unavailable');
    expect(state.error).toContain('Network unreachable');
    /* Empty, not the demo seed. */
    expect(state.bills).toHaveLength(0);
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('company scope', () => {
  it('clears cached bills IMMEDIATELY on a company change', async () => {
    await loadBills();
    expect(useServerBills.getState().bills).toHaveLength(1);

    enterCompanyScope('co_other');

    expect(useServerBills.getState().bills).toHaveLength(0);
  });

  it('DISCARDS a response that arrives after the company changed', async () => {
    let release: (value: unknown) => void = () => {};
    api.list.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = loadBills();
    enterCompanyScope('co_elsewhere');
    release([serverBill({ billNumber: 'PREVIOUS-COMPANY' })]);
    await pending;

    expect(useServerBills.getState().bills).toHaveLength(0);
  });
});

/* ══ Writes ════════════════════════════════════════════════════════════════ */

describe('the write path', () => {
  it('posts through the API and re-reads', async () => {
    api.post.mockResolvedValue(serverBill());
    await billGateway.post('bill-1', 1);

    expect(api.post).toHaveBeenCalledWith('bill-1', 1, {});
    expect(api.list).toHaveBeenCalled();
  });

  it('never sends overrideDuplicate by default', async () => {
    api.post.mockResolvedValue(serverBill());
    await billGateway.post('bill-1', 1);
    /* Paying the same supplier document twice is the mistake that check is
     * for; the override is a deliberate act, never a default. */
    expect(api.post.mock.calls[0]![2]).toEqual({});
  });

  it('carries the version on an edit and on a reversal', async () => {
    api.update.mockResolvedValue(serverBill());
    api.reverse.mockResolvedValue(serverBill({ status: 'reversed' }));

    await billGateway.update('bill-1', 3, {
      billDate: '2026-03-01', dueDate: '2026-03-31', lines: [],
    });
    await billGateway.reverse('bill-1', 4, 'Duplicate');

    expect(api.update).toHaveBeenCalledWith('bill-1', 3, expect.anything());
    expect(api.reverse).toHaveBeenCalledWith('bill-1', 4, 'Duplicate');
  });
});

/* ══ The browser store refuses durable writes ══════════════════════════════ */

describe('the browser bill store', () => {
  it('REFUSES to create a bill when the server owns them', () => {
    const result = useBillStore.getState().createDraft({ supplierId: 'sup-1' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/saved on the server/i);
  });

  it('refuses to post or reverse locally', () => {
    expect(useBillStore.getState().postBill('x').ok).toBe(false);
    expect(useBillStore.getState().reverseBill('x', 'why').ok).toBe(false);
  });

  it('allows the write in a demo workspace', () => {
    engine.current = 'demo';
    const result = useBillStore.getState().createDraft({ supplierId: 'sup-1' });
    /* Free Demo's bills are the originals and live nowhere else. */
    expect(result.ok).toBe(true);
  });
});

/* ══ Mapping ═══════════════════════════════════════════════════════════════ */

describe('a server bill as the screens see it', () => {
  it('keeps the audited discount meaning: subtotal GROSS, total net', () => {
    const bill = toBrowserBill(serverBill() as never);

    expect(bill.subtotal).toBe(1000);
    expect(bill.discountTotal).toBe(100);
    expect(bill.grandTotal).toBe(900);
    expect(bill.lines[0]!.lineSubtotal).toBe(1000);
    expect(bill.lines[0]!.lineTotal).toBe(900);
  });

  it('reports NO tax, NO payments and NO credits, because P2 holds none', () => {
    const bill = toBrowserBill(serverBill() as never);

    expect(bill.taxTotal).toBe(0);
    expect(bill.withholdingTaxTotal).toBe(0);
    expect(bill.additionalChargesTotal).toBe(0);
    expect(bill.payments).toEqual([]);
    expect(bill.supplierCredits).toEqual([]);
    expect(bill.attachments).toEqual([]);
  });

  it('shows the whole total outstanding, because nothing has cleared it', () => {
    const bill = toBrowserBill(serverBill() as never);
    expect(bill.amountPaid).toBe(0);
    expect(bill.balanceDue).toBe(900);
  });

  it('shows a reversed bill as owing nothing', () => {
    const bill = toBrowserBill(serverBill({ status: 'reversed' }) as never);
    expect(bill.balanceDue).toBe(0);
  });

  it('carries the version as the concurrency token', () => {
    const bill = toBrowserBill(serverBill() as never);
    expect(bill.revision).toBe(2);
  });
});
