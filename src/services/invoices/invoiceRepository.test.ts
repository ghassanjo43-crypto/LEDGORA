/**
 * Routing between the two invoice backends.
 *
 * The property under test is that the CHOICE is made from the company's
 * migration state and nothing else, and that a server-backed write always
 * carries the concurrency token — the two ways this seam could silently do the
 * wrong thing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

/* The verdict comes from the books engine now, not from a migration flag. */
const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));
import type { Invoice } from '@/types/invoice';
import { repositoryFor, type BrowserInvoiceAdapter } from './invoiceRepository';
import { invoicesApi } from '@/services/api/invoicesApi';

vi.mock('@/services/api/invoicesApi', () => ({
  invoicesApi: { list: vi.fn(), get: vi.fn(), recordPayment: vi.fn(), reversePayment: vi.fn() },
}));

const api = vi.mocked(invoicesApi);

const serverRecord = (over: Record<string, unknown> = {}) => ({
  id: 'srv-1', invoiceNumber: 'INV-1', status: 'issued',
  issuingEntityId: 'e1', customerId: 'c1',
  issueDate: '2026-03-01', dueDate: '2026-03-31',
  transactionCurrency: 'JOD', functionalCurrency: 'JOD', exchangeRate: '1',
  purchaseOrderReference: '', customerReference: '', notes: '', terms: '', paymentTerms: '',
  subtotal: '100.000', discountTotal: '0', taxTotal: '16.000', additionalChargesTotal: '0',
  grandTotal: '116.000', amountPaid: '0', creditsApplied: '0', balanceDue: '116.000',
  journalEntryId: 'j1', reversalJournalEntryId: null, voidReason: null,
  issuedAt: '2026-03-01T00:00:00.000Z', voidedAt: null,
  version: 7, lines: [],
  ...over,
});

const browserInvoice = { id: 'loc-1', invoiceNumber: 'LOCAL-1' } as unknown as Invoice;

const adapter: BrowserInvoiceAdapter = {
  list: vi.fn(() => [browserInvoice]),
  get: vi.fn(() => browserInvoice),
  recordPayment: vi.fn(() => browserInvoice),
  reversePayment: vi.fn(() => browserInvoice),
};

/* The verdict now comes from the books engine, not from an argument. */
const repo = () => repositoryFor({ browser: adapter, decimals: 3 });

beforeEach(() => { engine.current = 'server'; vi.clearAllMocks(); });

describe('which backend answers', () => {
  it('uses the browser store in a DEMO workspace', async () => {
    engine.current = 'demo';
    const result = await repo().list();
    expect(adapter.list).toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
    expect(result).toEqual([browserInvoice]);
  });

  it('uses the API when the books are on the server', async () => {
    api.list.mockResolvedValue([serverRecord()] as never);
    const result = await repo().list();

    expect(api.list).toHaveBeenCalled();
    expect(adapter.list).not.toHaveBeenCalled();
    expect(result[0]!.invoiceNumber).toBe('INV-1');
  });

  it('reports which backend it is, so a screen can say so', () => {
    engine.current = 'demo';
    expect(repo().backend).toBe('browser');
    engine.current = 'server';
    expect(repo().backend).toBe('server');
  });
});

describe('what the server path sends', () => {
  const migrated = () => repo();

  it('carries the invoice version as the concurrency token', async () => {
    api.list.mockResolvedValue([serverRecord()] as never);
    api.recordPayment.mockResolvedValue(serverRecord({ amountPaid: '50.000', balanceDue: '66.000', version: 8 }) as never);

    const [invoice] = await migrated().list();
    await migrated().recordPayment(invoice!, { paidOn: '2026-03-10', amount: 50, bankAccountId: 'bank-1' });

    // 7 is the version that came back with the invoice the caller is holding.
    expect(api.recordPayment).toHaveBeenCalledWith('srv-1', 7, expect.objectContaining({
      amount: '50.000', bankAccountId: 'bank-1', paidOn: '2026-03-10',
    }));
  });

  it('sends money as a decimal string at the company precision', async () => {
    api.list.mockResolvedValue([serverRecord()] as never);
    api.recordPayment.mockResolvedValue(serverRecord() as never);

    const [invoice] = await migrated().list();
    await migrated().recordPayment(invoice!, { paidOn: '2026-03-10', amount: 12.5, bankAccountId: 'b' });

    expect(api.recordPayment).toHaveBeenCalledWith('srv-1', 7, expect.objectContaining({ amount: '12.500' }));
  });

  it('refuses to write an invoice that did not come from the server', async () => {
    // No version means the record came from localStorage; sending 0 would draw
    // a conflict that reads like someone else edited it.
    await expect(migrated().recordPayment(browserInvoice, {
      paidOn: '2026-03-10', amount: 5, bankAccountId: 'b',
    })).rejects.toThrow(/not loaded from the server/i);
  });
});

describe('totals are copied, never recomputed', () => {
  it('keeps the server total even when the lines do not add up to it', async () => {
    /*
     * A deliberately inconsistent record: no lines at all, but a grand total.
     * A recomputing read would report 0 and disagree with the posted ledger
     * entry -- and later with a cleared tax document.
     */
    api.list.mockResolvedValue([serverRecord({ lines: [], grandTotal: '116.000' })] as never);
    const [invoice] = await repo().list();
    expect(invoice!.grandTotal).toBe(116);
  });
});

describe('reading one invoice', () => {
  it('returns undefined rather than throwing when it is gone', async () => {
    api.get.mockRejectedValue(new Error('404'));
    expect(await repo().get('missing')).toBeUndefined();
  });
});
