/**
 * The invoice store when a company's books have moved to the server.
 *
 * ── Why the store, rather than each screen ───────────────────────────────────
 * Nineteen components read `invoices` off this store. Converting each one would
 * mean nineteen chances for a screen to be left behind reading localStorage
 * while its neighbour reads the server — the same company showing two different
 * sets of books depending on which tab you opened. Hydrating the store instead
 * makes that impossible by construction, and these tests pin it.
 *
 * ── The two classes of write ─────────────────────────────────────────────────
 * The six lifecycle actions ROUTE to the API. The remaining six are browser-only
 * features with no server endpoint and REFUSE. Both are tested here, because
 * the dangerous failure is a write that neither routes nor refuses: it would
 * land in localStorage, the server would never hear about it, and the next sync
 * would silently discard it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { invoicesApi } from '@/services/api/invoicesApi';

vi.mock('@/services/api/invoicesApi', () => ({
  invoicesApi: {
    list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
    remove: vi.fn(), issue: vi.fn(), void: vi.fn(), recordPayment: vi.fn(),
  },
}));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

const api = vi.mocked(invoicesApi);

const record = (over: Record<string, unknown> = {}) => ({
  id: 'srv-1', invoiceNumber: 'INV-SERVER-1', status: 'issued',
  issuingEntityId: 'e1', customerId: 'c1',
  issueDate: '2026-03-01', dueDate: '2026-03-31',
  transactionCurrency: 'JOD', functionalCurrency: 'JOD', exchangeRate: '1',
  purchaseOrderReference: '', customerReference: '', notes: '', terms: '', paymentTerms: '',
  subtotal: '100.000', discountTotal: '0', taxTotal: '16.000', additionalChargesTotal: '0',
  grandTotal: '116.000', amountPaid: '0', creditsApplied: '0', balanceDue: '116.000',
  journalEntryId: 'j1', reversalJournalEntryId: null, voidReason: null,
  issuedAt: '2026-03-01T00:00:00.000Z', voidedAt: null,
  version: 3, lines: [],
  ...over,
});

const MIGRATED = { invoicesMigratedAt: '2026-03-01T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  useInvoiceStore.setState({ invoices: [], backend: 'browser', syncing: false, syncError: undefined });
});

describe('hydrating from the server', () => {
  it('replaces the local list and flips the backend', async () => {
    api.list.mockResolvedValue([record()] as never);
    await useInvoiceStore.getState().syncFromServer(MIGRATED);

    const state = useInvoiceStore.getState();
    expect(state.backend).toBe('server');
    expect(state.invoices).toHaveLength(1);
    expect(state.invoices[0]!.invoiceNumber).toBe('INV-SERVER-1');
    // Copied from the record, never recomputed from the (empty) lines.
    expect(state.invoices[0]!.grandTotal).toBe(116);
  });

  it('replaces rather than merges', async () => {
    useInvoiceStore.setState({ invoices: [{ id: 'stale', invoiceNumber: 'OLD-1' } as never] });
    api.list.mockResolvedValue([record()] as never);
    await useInvoiceStore.getState().syncFromServer(MIGRATED);

    // A merge would resurrect an invoice that was voided elsewhere.
    expect(useInvoiceStore.getState().invoices.map((i) => i.invoiceNumber)).toEqual(['INV-SERVER-1']);
  });

  it('does not call the API for a company that has not migrated', async () => {
    await useInvoiceStore.getState().syncFromServer({ invoicesMigratedAt: null });
    expect(api.list).not.toHaveBeenCalled();
    expect(useInvoiceStore.getState().backend).toBe('browser');
  });

  it('keeps what it had when the server cannot be reached', async () => {
    useInvoiceStore.setState({ invoices: [{ id: 'held', invoiceNumber: 'HELD-1' } as never] });
    api.list.mockRejectedValue(new Error('gateway timeout'));

    await useInvoiceStore.getState().syncFromServer(MIGRATED);

    const state = useInvoiceStore.getState();
    /*
     * Emptying the list would present "you have no invoices" as a fact, when
     * the truth is only that we could not reach the server.
     */
    expect(state.invoices).toHaveLength(1);
    expect(state.syncError).toMatch(/gateway timeout/);
    expect(state.syncing).toBe(false);
  });
});

describe('lifecycle writes route to the API', () => {
  beforeEach(async () => {
    api.list.mockResolvedValue([record()] as never);
    await useInvoiceStore.getState().syncFromServer(MIGRATED);
  });

  it('deletes through the API, carrying the version off the loaded record', async () => {
    useInvoiceStore.setState({ invoices: [{ ...useInvoiceStore.getState().invoices[0]!, status: 'draft' }] });
    api.remove.mockResolvedValue(undefined as never);

    const result = await useInvoiceStore.getState().deleteDraft('srv-1');

    expect(result.ok).toBe(true);
    expect(api.remove).toHaveBeenCalledWith('srv-1', 3);
    expect(useInvoiceStore.getState().invoices).toHaveLength(0);
  });

  it('voids through the API and replaces the local record with the response', async () => {
    api.void.mockResolvedValue(record({ status: 'void', voidReason: 'Duplicate', version: 4 }) as never);

    const result = await useInvoiceStore.getState().voidInvoice('srv-1', 'Duplicate');

    expect(result.ok).toBe(true);
    expect(api.void).toHaveBeenCalledWith('srv-1', 3, 'Duplicate');
    expect(useInvoiceStore.getState().invoices[0]!.status).toBe('void');
  });

  it('records a receipt through the API', async () => {
    api.recordPayment.mockResolvedValue(record({ amountPaid: '50.000', balanceDue: '66.000', version: 4 }) as never);

    const result = await useInvoiceStore.getState().recordPayment('srv-1', {
      amount: 50, date: '2026-03-10', bankAccountId: 'bank-1',
    });

    expect(result.ok).toBe(true);
    expect(api.recordPayment).toHaveBeenCalledWith('srv-1', 3, expect.objectContaining({
      paidOn: '2026-03-10', bankAccountId: 'bank-1',
    }));
    expect(useInvoiceStore.getState().invoices[0]!.amountPaid).toBe(50);
  });

  it('reports an API failure instead of throwing out of a menu handler', async () => {
    api.void.mockRejectedValue(new Error('The invoice was changed by another user.'));

    const result = await useInvoiceStore.getState().voidInvoice('srv-1', 'Duplicate');

    // A rejected promise inside a click handler leaves the user looking at a
    // control that did nothing and said nothing.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed by another user/i);
  });

  it('refuses to issue an invoice that would leave stock overstated', async () => {
    useInvoiceStore.setState({
      invoices: [{
        ...useInvoiceStore.getState().invoices[0]!,
        status: 'draft',
        lines: [{ id: 'l1', accountId: 'a', inventoryItemId: 'item-1', quantity: 1, unitPrice: 10 } as never],
      }],
    });

    const result = await useInvoiceStore.getState().issueInvoice('srv-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stock would not be depleted/i);
    expect(api.issue).not.toHaveBeenCalled();
  });
});

describe('browser-only writes still refuse', () => {
  beforeEach(() => useInvoiceStore.setState({ backend: 'server' }));

  /*
   * These have no server endpoint. Allowing the browser path would write to
   * localStorage, where the server never hears about it and the next sync
   * silently discards it — so the write would appear to succeed and then vanish.
   */
  it('refuses credit-note, receipt-allocation and template actions', () => {
    const store = useInvoiceStore.getState();
    const results = [
      store.duplicateInvoice('x'),
      store.markSent('x'),
      store.applyCredit('x', 1),
      store.reverseCredit('x', 1),
      store.applyReceiptAllocation('x', { amount: 1, date: '2026-03-01', method: 'cash', receiptId: 'r' }),
      store.removeReceiptAllocations('x', 'r'),
    ];

    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results.every((r) => /held on the server/i.test(r.error ?? ''))).toBe(true);
  });

  it('leaves the invoice list untouched when it refuses', () => {
    useInvoiceStore.setState({ invoices: [{ id: 'a', invoiceNumber: 'A' } as never] });
    useInvoiceStore.getState().markSent('a');
    expect(useInvoiceStore.getState().invoices).toHaveLength(1);
  });
});
