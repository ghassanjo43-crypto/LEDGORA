// @vitest-environment happy-dom
/**
 * A durable subscriber's customers live on the server, and nowhere else.
 *
 * ══ The failure this closes ══════════════════════════════════════════════════
 *
 * Before this slice every Sales store, the customer directory included, wrote to
 * `localStorage` for everyone — durable subscribers included. A customer created
 * by a paying subscriber looked saved, survived until the browser was cleared,
 * and existed on no server anywhere. That is the "saved somewhere that does not
 * count" failure, and these tests hold the cutover to closing it.
 *
 * Free Demo is untouched, and so is the SUPPLIER role: suppliers have not
 * migrated, their records are still browser-resident, and a slice that quietly
 * refused their writes would break Bills and Payments.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const calls = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), setArchived: vi.fn() }));
vi.mock('@/services/api/customersApi', () => ({
  customersApi: {
    list: (...a: unknown[]) => calls.list(...a),
    create: (...a: unknown[]) => calls.create(...a),
    update: (...a: unknown[]) => calls.update(...a),
    setArchived: (...a: unknown[]) => calls.setArchived(...a),
  },
}));

import {
  loadCustomers,
  clearCustomerCache,
  customerGateway,
  useCustomerDirectory,
} from './customerDirectory';
import { useCustomers, partyToEntity } from './useCustomers';
import { useEntityStore, makeDefaultEntityValues } from '@/store/useEntityStore';
import { enterCompanyScope, __resetBooksScopeForTests } from '@/services/books/booksScope';
import type { ServerBusinessParty } from '@/services/api/customersApi';

const LOCAL_ONLY = 'Local Demo Customer';

function party(over: Partial<ServerBusinessParty> = {}): ServerBusinessParty {
  return {
    id: 'party-1', partyCode: 'ACME', legalName: 'Acme Trading LLC', tradingName: 'Acme',
    isCustomer: true, isSupplier: false,
    contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '', website: '',
    taxRegistrationNumber: 'JO-1', commercialRegistrationNumber: '',
    paymentTerms: 'NET_30', defaultCurrency: 'JOD',
    bankName: '', bankAccountName: '', iban: '', swiftCode: '', notes: '',
    status: 'active', version: 1,
    addresses: [{
      id: 'a-1', purpose: 'billing', isPrimary: true, addressLine1: 'Head office',
      addressLine2: '', city: 'Amman', postalCode: '11118', country: 'Jordan',
    }],
    customer: {
      customerCategory: 'wholesale', creditLimit: '12345678901234.1234567891',
      defaultRevenueAccountId: null, defaultReceivableAccountId: null,
      defaultInvoiceTemplateId: null, invoiceDeliveryMethod: '', customerPaymentTerms: '',
    },
    createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  engine.current = 'server';
  calls.list.mockReset().mockResolvedValue({ parties: [party()], nextCursor: null });
  calls.create.mockReset().mockResolvedValue(party());
  calls.update.mockReset().mockResolvedValue(party({ version: 2 }));
  calls.setArchived.mockReset().mockResolvedValue(party({ status: 'archived', version: 2 }));
  __resetBooksScopeForTests();
  clearCustomerCache();

  /* A local directory holding a customer AND a supplier, so the slice can be
   * shown to move one without disturbing the other. */
  useEntityStore.setState({
    entities: [
      { id: 'local-c', entityCode: 'LOCAL', legalName: LOCAL_ONLY, entityType: 'customer', isActive: true },
      { id: 'local-s', entityCode: 'SUPP', legalName: 'Local Supplier', entityType: 'supplier', isActive: true },
    ] as never,
  });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ Where the customers come from ═════════════════════════════════════════ */

describe('a durable subscriber', () => {
  it('reads customers from the server, never from browser storage', async () => {
    await act(async () => { await loadCustomers(); });
    const { result } = renderHook(() => useCustomers());

    expect(result.current.serverBacked).toBe(true);
    expect(result.current.customers.map((c) => c.legalName)).toEqual(['Acme Trading LLC']);
    /* The local demo customer must not appear for a paying subscriber. */
    expect(result.current.customers.some((c) => c.legalName === LOCAL_ONLY)).toBe(false);
  });

  it('keeps durable customers when browser storage is cleared', async () => {
    await act(async () => { await loadCustomers(); });

    /* Everything the browser holds, gone. */
    useEntityStore.setState({ entities: [] as never });
    localStorage.clear();

    const { result } = renderHook(() => useCustomers());
    /* The cache is not persisted, so this is the server's answer surviving a
     * wipe — a customer, not a cached copy of one. */
    expect(result.current.customers.map((c) => c.entityCode)).toEqual(['ACME']);

    /* And a fresh session re-reads them rather than finding nothing. */
    await act(async () => { clearCustomerCache(); await loadCustomers(); });
    expect(useCustomerDirectory.getState().customers).toHaveLength(1);
  });

  it('has NO local fallback when the server cannot be reached', async () => {
    calls.list.mockRejectedValue(new Error('Network unreachable'));

    await act(async () => { await loadCustomers(); });
    const { result } = renderHook(() => useCustomers());

    expect(result.current.error).toContain('Network unreachable');
    /* Falling back to the local store would put demo customers in a real
     * subscriber's picker, and the first invoice raised against one would name
     * a customer that does not exist. */
    expect(result.current.customers).toHaveLength(0);
  });

  it('maps the server party without inventing supplier data', async () => {
    const mapped = partyToEntity(party());

    expect(mapped.entityCode).toBe('ACME');
    expect(mapped.city).toBe('Amman');
    expect(mapped.country).toBe('Jordan');
    expect(mapped.isActive).toBe(true);
    /* Supplier fields stay empty: this route cannot read them. */
    expect(mapped.defaultPayableAccount).toBe('');
    expect(mapped.supplierCategory).toBe('');
    expect(mapped.withholdingTaxApplicable).toBe(false);
  });

  it('reports an archived party as inactive rather than losing it', () => {
    const mapped = partyToEntity(party({ status: 'archived' }));
    expect(mapped.isActive).toBe(false);
  });
});

/* ══ Free Demo is untouched ════════════════════════════════════════════════ */

describe('Free Demo', () => {
  it('keeps its local customers and asks the server for nothing', async () => {
    engine.current = 'demo';
    await act(async () => { await loadCustomers(); });

    const { result } = renderHook(() => useCustomers());
    expect(result.current.serverBacked).toBe(false);
    expect(result.current.customers.map((c) => c.legalName)).toEqual([LOCAL_ONLY]);
    expect(calls.list).not.toHaveBeenCalled();
  });

  it('still allows local customer writes', () => {
    engine.current = 'demo';
    const added = useEntityStore.getState().addEntity({
      ...makeDefaultEntityValues('customer'), entityCode: 'NEW', legalName: 'New Demo Co',
    });
    expect(added.ok).toBe(true);
  });
});

/* ══ The durable write-refusal ═════════════════════════════════════════════ */

describe('direct store mutation', () => {
  it('is REFUSED for a customer when the server owns them', () => {
    const added = useEntityStore.getState().addEntity({
      ...makeDefaultEntityValues('customer'), entityCode: 'SNEAK', legalName: 'Sneaky Co',
    });

    expect(added.ok).toBe(false);
    expect(added.error).toMatch(/saved on the server/i);
    /* Nothing reached the browser store. */
    expect(useEntityStore.getState().entities.some((e) => e.entityCode === 'SNEAK')).toBe(false);
  });

  it('is refused for editing and deleting a durable customer', () => {
    const edited = useEntityStore.getState().updateEntity('local-c', {
      ...makeDefaultEntityValues('customer'), entityCode: 'LOCAL', legalName: 'Renamed',
    });
    expect(edited.ok).toBe(false);

    const deleted = useEntityStore.getState().deleteEntity('local-c');
    expect(deleted.ok).toBe(false);
    expect(deleted.error).toMatch(/saved on the server/i);
  });

  it('still permits SUPPLIER writes, which have not migrated', () => {
    /* Refusing these would break Bills and Payments for a domain this slice
     * does not touch. */
    const added = useEntityStore.getState().addEntity({
      ...makeDefaultEntityValues('supplier'), entityCode: 'SUP2', legalName: 'Another Supplier',
    });
    expect(added.ok).toBe(true);

    const deleted = useEntityStore.getState().deleteEntity('local-s');
    expect(deleted.ok).toBe(true);
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('company switching', () => {
  it('clears cached customers IMMEDIATELY, before anything is fetched', async () => {
    await act(async () => { await loadCustomers(); });
    expect(useCustomerDirectory.getState().customers).toHaveLength(1);

    act(() => { enterCompanyScope('co_other'); });

    /* Synchronous. A bookkeeper spending the loading interval looking at the
     * previous company's customers is how somebody invoices the wrong party. */
    expect(useCustomerDirectory.getState().customers).toHaveLength(0);
    expect(useCustomerDirectory.getState().state).toBe('idle');
  });

  it('DISCARDS a response that arrives after the company changed', async () => {
    let release: (value: { parties: ServerBusinessParty[]; nextCursor: null }) => void = () => {};
    calls.list.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = loadCustomers();
    await waitFor(() => expect(useCustomerDirectory.getState().state).toBe('loading'));

    act(() => { enterCompanyScope('co_elsewhere'); });

    await act(async () => {
      release({ parties: [party({ legalName: 'Previous company customer' })], nextCursor: null });
      await pending;
    });

    /* These customers belong to books nobody is looking at. */
    expect(useCustomerDirectory.getState().customers).toHaveLength(0);
  });
});

/* ══ The write path ════════════════════════════════════════════════════════ */

describe('the gateway', () => {
  it('sends writes to the server and re-reads rather than echoing', async () => {
    await act(async () => { await customerGateway.create({ partyCode: 'NEW', legalName: 'New Co' }); });

    expect(calls.create).toHaveBeenCalledWith({ partyCode: 'NEW', legalName: 'New Co' });
    /* Re-read: the server allocates the id and the version, and echoing the
     * request would leave the screen disagreeing with the directory. */
    expect(calls.list).toHaveBeenCalled();
  });

  it('carries the expected version on an update, so a stale edit is refused', async () => {
    await act(async () => {
      await customerGateway.update('party-1', { expectedVersion: 1, legalName: 'Renamed' });
    });
    expect(calls.update).toHaveBeenCalledWith('party-1', { expectedVersion: 1, legalName: 'Renamed' });
  });

  it('archives rather than deleting', async () => {
    await act(async () => {
      await customerGateway.setArchived('party-1', { archived: true, expectedVersion: 1 });
    });
    expect(calls.setArchived).toHaveBeenCalledWith('party-1', { archived: true, expectedVersion: 1 });
    /* There is no delete on the gateway at all. */
    expect((customerGateway as Record<string, unknown>).delete).toBeUndefined();
  });

  it('searches the server, not a local array', async () => {
    await act(async () => { await loadCustomers({ search: 'acme' }); });
    expect(calls.list).toHaveBeenCalledWith(expect.objectContaining({ search: 'acme' }));
  });
});
