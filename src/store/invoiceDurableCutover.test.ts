// @vitest-environment happy-dom
/**
 * A durable subscriber's invoices live on the server, and nowhere else.
 *
 * ══ What actually changed ════════════════════════════════════════════════════
 *
 * The server invoice path existed and was unreachable. Which backend answered
 * came from a per-company `invoicesMigratedAt` timestamp set by a cutover that
 * had no caller, so the flag was never written, the verdict was always
 * `browser`, and every durable subscriber's invoices went to localStorage while
 * a complete server implementation sat unused beside them.
 *
 * The verdict now comes from the books engine — the same latched decision the
 * chart, the journal and the customer directory use. These tests pin what that
 * turns on: writes route to the server, browser storage is not written, a late
 * answer cannot cross companies, and a company change clears the cache at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
  remove: vi.fn(), issue: vi.fn(), void: vi.fn(), recordPayment: vi.fn(),
}));
vi.mock('@/services/api/invoicesApi', () => ({ invoicesApi: api }));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

import { useInvoiceStore } from './invoiceStore';
import { invoiceBackend } from '@/services/invoices/invoiceBackend';
import { enterCompanyScope, __resetBooksScopeForTests } from '@/services/books/booksScope';

const record = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', invoiceNumber: 'INV-2026-0001', status: 'issued',
  issuingEntityId: 'e1', customerId: 'c1',
  issueDate: '2026-03-01', dueDate: '2026-03-31',
  transactionCurrency: 'JOD', functionalCurrency: 'JOD', exchangeRate: '1',
  purchaseOrderReference: '', customerReference: '',
  salespersonId: null, projectId: null, costCenterId: null,
  templateId: null, templateVersionId: null, templateSnapshot: null,
  notes: '', terms: '', paymentTerms: '',
  subtotal: '100.000', discountTotal: '0', taxTotal: '0.000', additionalChargesTotal: '0',
  grandTotal: '100.000', amountPaid: '0', creditsApplied: '0', balanceDue: '100.000',
  journalEntryId: 'j1', reversalJournalEntryId: null, voidReason: null,
  issuedAt: '2026-03-01T00:00:00.000Z', voidedAt: null,
  version: 3, lines: [],
  ...over,
});

/** Everything the browser holds for invoices, so a stray write is visible. */
const browserSnapshot = () => JSON.stringify({
  stored: localStorage.getItem('ledgerly-invoices'),
});

beforeEach(() => {
  engine.current = 'server';
  Object.values(api).forEach((fn) => fn.mockReset());
  api.list.mockResolvedValue([record()]);
  __resetBooksScopeForTests();
  localStorage.clear();
  useInvoiceStore.setState({ invoices: [], backend: 'browser', syncing: false, syncError: undefined });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ The verdict ═══════════════════════════════════════════════════════════ */

describe('which backend a durable subscriber gets', () => {
  it('is the SERVER, with no migration flag to set', () => {
    /* This is the whole unblocking: the old verdict needed a timestamp nobody
     * ever wrote, so it always answered `browser`. */
    expect(invoiceBackend()).toBe('server');
  });

  it('is the browser in a demo workspace', () => {
    engine.current = 'demo';
    expect(invoiceBackend()).toBe('browser');
  });
});

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

describe('hydrating', () => {
  it('replaces the list from the server and writes nothing to the browser', async () => {
    const before = browserSnapshot();

    await useInvoiceStore.getState().syncFromServer();

    const state = useInvoiceStore.getState();
    expect(state.backend).toBe('server');
    expect(state.invoices).toHaveLength(1);
    expect(state.invoices[0]!.invoiceNumber).toBe('INV-2026-0001');
    expect(browserSnapshot()).toBe(before);
  });

  it('REPLACES rather than merges, so a browser-only invoice cannot survive', async () => {
    useInvoiceStore.setState({
      invoices: [{ id: 'local', invoiceNumber: 'LOCAL-1' } as never],
    });

    await useInvoiceStore.getState().syncFromServer();

    const numbers = useInvoiceStore.getState().invoices.map((i) => i.invoiceNumber);
    expect(numbers).toEqual(['INV-2026-0001']);
  });

  it('asks the server for nothing in a demo workspace', async () => {
    engine.current = 'demo';
    await useInvoiceStore.getState().syncFromServer();

    expect(api.list).not.toHaveBeenCalled();
    expect(useInvoiceStore.getState().backend).toBe('browser');
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('company scope', () => {
  it('clears cached invoices IMMEDIATELY on a company change', async () => {
    await useInvoiceStore.getState().syncFromServer();
    expect(useInvoiceStore.getState().invoices).toHaveLength(1);

    enterCompanyScope('co_other');

    /* Synchronous. Another company's receivables on screen, even briefly, is
     * how somebody chases a debt in the wrong set of books. */
    expect(useInvoiceStore.getState().invoices).toHaveLength(0);
  });

  it('DISCARDS a response that arrives after the company changed', async () => {
    let release: (value: unknown[]) => void = () => {};
    api.list.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = useInvoiceStore.getState().syncFromServer();
    enterCompanyScope('co_elsewhere');
    release([record({ invoiceNumber: 'PREVIOUS-COMPANY' })]);
    await pending;

    expect(useInvoiceStore.getState().invoices).toHaveLength(0);
  });

  it('leaves a DEMO workspace’s invoices alone on a company change', async () => {
    engine.current = 'demo';
    useInvoiceStore.setState({ invoices: [{ id: 'demo-1' } as never] });

    enterCompanyScope('co_other');

    /* A demo workspace's invoices are the originals, not a cache. Clearing them
     * would destroy the user's work. */
    expect(useInvoiceStore.getState().invoices).toHaveLength(1);
  });
});

/* ══ No browser fallback ═══════════════════════════════════════════════════ */

describe('when the server cannot be reached', () => {
  it('reports the failure and does NOT fall back to browser storage', async () => {
    api.list.mockRejectedValue(new Error('Network unreachable'));
    const before = browserSnapshot();

    await useInvoiceStore.getState().syncFromServer();

    const state = useInvoiceStore.getState();
    expect(state.syncError).toContain('Network unreachable');
    /* Still the server backend: a dropped connection does not move a
     * subscriber's books back into the browser. */
    expect(state.backend).toBe('server');
    expect(browserSnapshot()).toBe(before);
  });
});
