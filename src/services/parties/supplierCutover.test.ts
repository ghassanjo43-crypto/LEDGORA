// @vitest-environment happy-dom
/**
 * A durable subscriber's suppliers live on the server, and nowhere else.
 *
 * ══ The failures this guards ═════════════════════════════════════════════════
 *
 * Falling back to `useEntityStore` when the fetch fails would put demo seed
 * suppliers in a real subscriber's picker, and the first bill raised against one
 * would name a supplier the books do not have.
 *
 * Writing to `useEntityStore` when the server owns the directory is worse: the
 * write APPEARS to succeed and the next hydration replaces the cache without a
 * word, so the record is gone with nothing to retry.
 *
 * And clearing browser storage must lose a CACHE, not a supplier — which is the
 * whole point of moving them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(), count: vi.fn(), get: vi.fn(), history: vi.fn(),
  create: vi.fn(), update: vi.fn(), setArchived: vi.fn(), grantSupplierRole: vi.fn(),
}));
vi.mock('@/services/api/suppliersApi', () => ({ suppliersApi: api }));
/* The other gateways `booksScope` reaches on a company change. */
vi.mock('@/services/api/customersApi', () => ({ customersApi: { list: vi.fn(async () => ({ parties: [], nextCursor: null })) } }));
vi.mock('@/services/api/invoicesApi', () => ({ invoicesApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/taxCodesApi', () => ({ taxCodesApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

/* booksScope FIRST: it imports the stores it clears, and importing a store
 * ahead of it leaves that clearing outside the mocked module graph. */
import { enterCompanyScope, __resetBooksScopeForTests } from '@/services/books/booksScope';
import {
  useSupplierDirectory,
  suppliersAreServerAuthoritative,
  loadSuppliers,
  supplierGateway,
} from './supplierDirectory';
import { supplierActions } from './supplierActions';
import { useEntityStore } from '@/store/useEntityStore';

const party = (over: Record<string, unknown> = {}) => ({
  id: 'sup-1', partyCode: 'ACME', legalName: 'Acme Supplies Ltd', tradingName: '',
  isCustomer: false, isSupplier: true,
  contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '', website: '',
  taxRegistrationNumber: '', commercialRegistrationNumber: '',
  paymentTerms: 'NET_30', defaultCurrency: 'JOD',
  bankName: '', bankAccountName: '', iban: '', swiftCode: '', notes: '',
  status: 'active', version: 1, addresses: [],
  customer: null,
  supplier: {
    supplierCategory: '', defaultPayableAccountId: 'acct-payable',
    defaultExpenseAccountId: null, supplierPaymentTerms: '',
    withholdingTaxApplicable: false, preferredPaymentMethod: '',
  },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  engine.current = 'server';
  Object.values(api).forEach((fn) => fn.mockReset());
  api.list.mockResolvedValue({ parties: [party()], nextCursor: null });
  api.count.mockResolvedValue(1);
  __resetBooksScopeForTests();
  localStorage.clear();
  useSupplierDirectory.setState({
    state: 'idle', suppliers: [], error: null, search: '', total: null,
  });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ The verdict ═══════════════════════════════════════════════════════════ */

describe('which directory a durable subscriber gets', () => {
  it('is the SERVER', () => {
    expect(suppliersAreServerAuthoritative()).toBe(true);
  });

  it('is the browser in a demo workspace, whose suppliers are the originals', () => {
    engine.current = 'demo';
    expect(suppliersAreServerAuthoritative()).toBe(false);
  });

  it('asks the server for nothing in a demo workspace', async () => {
    engine.current = 'demo';
    await loadSuppliers();
    expect(api.list).not.toHaveBeenCalled();
    expect(useSupplierDirectory.getState().suppliers).toHaveLength(0);
  });
});

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

describe('loading the directory', () => {
  it('replaces the list and writes NOTHING to browser storage', async () => {
    const before = JSON.stringify(localStorage);

    await loadSuppliers();

    const state = useSupplierDirectory.getState();
    expect(state.state).toBe('ready');
    expect(state.suppliers).toHaveLength(1);
    expect(state.suppliers[0]!.partyCode).toBe('ACME');
    /* Clearing browser storage must lose a cache, not a supplier. */
    expect(JSON.stringify(localStorage)).toBe(before);
  });

  it('REPLACES rather than merges, so a browser-only supplier cannot survive', async () => {
    useSupplierDirectory.setState({ suppliers: [party({ id: 'local', partyCode: 'LOCAL' })] as never });

    await loadSuppliers();

    expect(useSupplierDirectory.getState().suppliers.map((p) => p.partyCode)).toEqual(['ACME']);
  });

  it('reports a failure and offers NO local fallback', async () => {
    api.list.mockRejectedValue(new Error('Network unreachable'));

    await loadSuppliers();

    const state = useSupplierDirectory.getState();
    expect(state.state).toBe('unavailable');
    expect(state.error).toContain('Network unreachable');
    /* Empty, not seeded: a demo supplier in a real picker is how a bill names a
     * supplier the books do not have. */
    expect(state.suppliers).toHaveLength(0);
  });

  it('carries the unfiltered COUNT, so an empty list can be explained', async () => {
    api.list.mockResolvedValue({ parties: [], nextCursor: null });
    api.count.mockResolvedValue(0);

    await loadSuppliers({ search: 'nothing matches' });

    /* "None match that search" and "no suppliers yet" are different sentences,
     * and neither is "the list broke". */
    expect(useSupplierDirectory.getState().total).toBe(0);
    expect(useSupplierDirectory.getState().state).toBe('ready');
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('company scope', () => {
  it('clears cached suppliers IMMEDIATELY on a company change', async () => {
    await loadSuppliers();
    expect(useSupplierDirectory.getState().suppliers).toHaveLength(1);

    enterCompanyScope('co_other');

    /* Another company's suppliers in a bill picker is how somebody bills the
     * wrong party, so the stale answer goes at once. */
    expect(useSupplierDirectory.getState().suppliers).toHaveLength(0);
    expect(useSupplierDirectory.getState().total).toBeNull();
  });

  it('DISCARDS a response that arrives after the company changed', async () => {
    let release: (value: unknown) => void = () => {};
    api.list.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = loadSuppliers();
    enterCompanyScope('co_elsewhere');
    release({ parties: [party({ partyCode: 'PREVIOUS-COMPANY' })], nextCursor: null });
    await pending;

    expect(useSupplierDirectory.getState().suppliers).toHaveLength(0);
  });
});

/* ══ Writes ════════════════════════════════════════════════════════════════ */

describe('the write path', () => {
  it('creates through the API and re-reads rather than echoing the request', async () => {
    api.create.mockResolvedValue(party({ id: 'sup-2', partyCode: 'BOLT' }));

    await supplierGateway.create({ partyCode: 'BOLT', legalName: 'Bolt Fasteners' });

    expect(api.create).toHaveBeenCalledOnce();
    /* Re-read, because the server allocates the id, bumps the version and may
     * normalise a value. */
    expect(api.list).toHaveBeenCalled();
  });

  it('carries the version from the CACHED row, not from the form', async () => {
    await loadSuppliers();
    api.update.mockResolvedValue(party({ version: 2 }));

    const actions = supplierActions();
    await actions.save({ entityCode: 'ACME', legalName: 'Renamed' } as never, 'sup-1');

    expect(api.update).toHaveBeenCalledWith('sup-1', expect.objectContaining({ expectedVersion: 1 }));
  });

  it('surfaces a stale-write conflict as a conflict, not a crash', async () => {
    await loadSuppliers();
    api.update.mockRejectedValue(new Error('This supplier was changed by someone else.'));

    const actions = supplierActions();
    const result = await actions.save({ entityCode: 'ACME', legalName: 'X' } as never, 'sup-1');

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('archives rather than deleting', async () => {
    await loadSuppliers();
    api.setArchived.mockResolvedValue(party({ status: 'archived', version: 2 }));

    const actions = supplierActions();
    const result = await actions.setArchived('sup-1', true);

    expect(result.ok).toBe(true);
    expect(api.setArchived).toHaveBeenCalledWith('sup-1', { archived: true, expectedVersion: 1 });
  });

  it('refuses role changes and imports in durable mode', () => {
    const actions = supplierActions();
    expect(actions.serverBacked).toBe(true);
    expect(actions.canChangeRoles).toBe(false);
    expect(actions.canImport).toBe(false);
  });

  it('does NOT copy the tax number when duplicating', async () => {
    await loadSuppliers();
    useSupplierDirectory.setState({
      suppliers: [party({ taxRegistrationNumber: 'JO-123' })] as never,
    });
    api.create.mockResolvedValue(party({ id: 'sup-copy' }));

    await supplierActions().duplicate('sup-1');

    /* The tax number belongs to one legal entity and is unique per company, so
     * copying it would both be refused and imply the two are the same party. */
    const sent = api.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.taxRegistrationNumber).toBeUndefined();
    expect(sent.partyCode).toBe('ACME-COPY');
  });
});

/* ══ The local store refuses durable supplier writes ═══════════════════════ */

describe('the browser entity store', () => {
  it('REFUSES to save a supplier when the server owns them', () => {
    const result = useEntityStore.getState().addEntity({
      entityCode: 'LOCAL', legalName: 'Local Supplier', entityType: 'supplier',
    } as never);

    /* A local write here appears to save and is replaced without a word by the
     * next hydration. "Could not save" is recoverable; that is not. */
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/saved on the server/i);
  });

  it('refuses a party holding BOTH roles', () => {
    const result = useEntityStore.getState().addEntity({
      entityCode: 'LOCAL', legalName: 'Both Ways', entityType: 'both',
    } as never);
    expect(result.ok).toBe(false);
  });

  it('allows the write in a demo workspace', () => {
    engine.current = 'demo';
    const before = useEntityStore.getState().entities.length;

    /* The real form shape: `addEntity` reads these fields directly, so a
     * partial fixture would fail for the wrong reason. */
    const result = useEntityStore.getState().addEntity({
      entityCode: 'DEMOSUP', legalName: 'Demo Supplier', tradingName: '',
      entityType: 'supplier',
      contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '', website: '',
      country: '', city: '', addressLine1: '', addressLine2: '', postalCode: '',
      taxRegistrationNumber: '', commercialRegistrationNumber: '',
      paymentTerms: 'NET_30', defaultCurrency: 'JOD',
      bankName: '', bankAccountName: '', iban: '', swiftCode: '',
      notes: '', isActive: true,
      customerCategory: '', creditLimit: 0,
      defaultRevenueAccount: '', defaultReceivableAccount: '',
      defaultInvoiceTemplateId: '', invoiceDeliveryMethod: '', customerPaymentTerms: '',
      supplierCategory: '', defaultExpenseAccount: '', defaultPayableAccount: '',
      supplierPaymentTerms: '', withholdingTaxApplicable: false, preferredPaymentMethod: '',
    } as never);

    expect(result.ok).toBe(true);
    expect(useEntityStore.getState().entities.length).toBe(before + 1);
  });
});
