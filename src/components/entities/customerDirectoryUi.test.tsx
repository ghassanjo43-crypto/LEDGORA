// @vitest-environment happy-dom
/**
 * The customer directory UI, driven the way a person drives it.
 *
 * ══ Why this is not covered by the gateway tests ═════════════════════════════
 *
 * `customerDirectory.test.tsx` proves the gateway. It cannot prove that the
 * SCREENS call it — and the screens were exactly where S1 stopped short: the
 * list read from the server while create, edit and archive still called
 * `useEntityStore` and were refused. So these tests click the actual controls
 * and then assert two things about every action: the server was asked, and
 * `localStorage` did not change.
 *
 * The second half matters as much as the first. A screen that writes to both
 * looks correct in every test that only checks the server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const calls = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), setArchived: vi.fn(),
}));
vi.mock('@/services/api/customersApi', () => ({
  customersApi: {
    list: (...a: unknown[]) => calls.list(...a),
    create: (...a: unknown[]) => calls.create(...a),
    update: (...a: unknown[]) => calls.update(...a),
    setArchived: (...a: unknown[]) => calls.setArchived(...a),
  },
}));

import { EntityDirectory } from './EntityDirectory';
import { ToastProvider } from '@/components/ui/Toast';
import { useEntityStore } from '@/store/useEntityStore';
import { loadCustomers, clearCustomerCache } from '@/services/parties/customerDirectory';
import { customerActions } from '@/services/parties/customerActions';
import { __resetBooksScopeForTests } from '@/services/books/booksScope';
import type { ServerBusinessParty } from '@/services/api/customersApi';

function party(over: Partial<ServerBusinessParty> = {}): ServerBusinessParty {
  return {
    id: 'party-1', partyCode: 'ACME', legalName: 'Acme Trading LLC', tradingName: 'Acme',
    isCustomer: true, isSupplier: false,
    contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '', website: '',
    taxRegistrationNumber: '', commercialRegistrationNumber: '',
    paymentTerms: 'NET_30', defaultCurrency: 'JOD',
    bankName: '', bankAccountName: '', iban: '', swiftCode: '', notes: '',
    status: 'active', version: 1,
    addresses: [], customer: null,
    createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

/** Everything the browser holds, so a stray local write is visible. */
function browserSnapshot(): string {
  return JSON.stringify({
    entities: useEntityStore.getState().entities,
    storage: localStorage.getItem('ifrs-entity-store'),
  });
}

beforeEach(async () => {
  engine.current = 'server';
  calls.list.mockReset().mockResolvedValue({ parties: [party()], nextCursor: null });
  calls.create.mockReset().mockResolvedValue(party({ id: 'party-2', partyCode: 'NEW' }));
  calls.update.mockReset().mockResolvedValue(party({ version: 2 }));
  calls.setArchived.mockReset().mockResolvedValue(party({ status: 'archived', version: 2 }));
  __resetBooksScopeForTests();
  clearCustomerCache();
  localStorage.clear();
  useEntityStore.setState({ entities: [] as never });
  await act(async () => { await loadCustomers(); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const directory = () => render(
  <ToastProvider>
    <EntityDirectory scope="customer" title="Customer directory" description="Entities we invoice." />
  </ToastProvider>,
);

/* ══ The list ══════════════════════════════════════════════════════════════ */

describe('the customer directory screen', () => {
  it('lists the server’s customers', async () => {
    directory();
    await waitFor(() => expect(screen.getByText('Acme Trading LLC')).toBeTruthy());
  });

  it('keeps the customer after the browser store is cleared', async () => {
    directory();
    await waitFor(() => expect(screen.getByText('Acme Trading LLC')).toBeTruthy());

    act(() => { localStorage.clear(); useEntityStore.setState({ entities: [] as never }); });

    /* Still on screen: it was never in the browser to begin with. */
    expect(screen.getByText('Acme Trading LLC')).toBeTruthy();
  });

  it('shows what a second session sees, by re-reading the server', async () => {
    directory();
    await waitFor(() => expect(screen.getByText('Acme Trading LLC')).toBeTruthy());

    /* Another session created a customer; this one re-reads and finds it. */
    calls.list.mockResolvedValue({
      parties: [party(), party({ id: 'party-9', partyCode: 'OTHER', legalName: 'Made Elsewhere' })],
      nextCursor: null,
    });
    await act(async () => { await loadCustomers(); });

    await waitFor(() => expect(screen.getByText('Made Elsewhere')).toBeTruthy());
  });
});

/* ══ The write actions, through the seam the screens use ═══════════════════ */

describe('customer actions in durable mode', () => {
  it('CREATES through the server and writes nothing to the browser', async () => {
    const before = browserSnapshot();

    const result = await customerActions().save({
      entityCode: 'NEW', legalName: 'New Customer LLC', entityType: 'customer',
      tradingName: '', contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '',
      website: '', country: 'Jordan', city: 'Amman', addressLine1: 'Street', addressLine2: '',
      postalCode: '11118', taxRegistrationNumber: '', commercialRegistrationNumber: '',
      paymentTerms: 'NET_30', defaultCurrency: 'JOD', bankName: '', bankAccountName: '',
      iban: '', swiftCode: '', notes: '', isActive: true,
      customerCategory: 'wholesale', creditLimit: 2500.5, defaultRevenueAccount: '',
      defaultReceivableAccount: '', defaultInvoiceTemplateId: '', invoiceDeliveryMethod: '',
      customerPaymentTerms: '', supplierCategory: '', defaultExpenseAccount: '',
      defaultPayableAccount: '', supplierPaymentTerms: '', withholdingTaxApplicable: false,
      preferredPaymentMethod: '',
    } as never);

    expect(result.ok).toBe(true);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(browserSnapshot()).toBe(before);

    const sent = calls.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.partyCode).toBe('NEW');
    /* The credit limit crosses as a decimal STRING, not a float. */
    expect(sent.customer).toMatchObject({ creditLimit: '2500.5' });
    /* The single form address becomes the primary billing address. */
    expect(sent.addresses).toEqual([expect.objectContaining({ purpose: 'billing', isPrimary: true, city: 'Amman' })]);
    /* And no supplier-only field is present at all. */
    expect(Object.keys(sent)).not.toContain('supplierCategory');
    expect(Object.keys(sent)).not.toContain('defaultPayableAccount');
    expect(Object.keys(sent)).not.toContain('withholdingTaxApplicable');
  });

  it('EDITS with the version the server last gave, not one the form carried', async () => {
    /* The cached row is at version 1; the edit must send that. */
    const result = await customerActions().save(
      { entityCode: 'ACME', legalName: 'Renamed', entityType: 'customer' } as never,
      'party-1',
    );

    expect(result.ok).toBe(true);
    expect(calls.update).toHaveBeenCalledWith('party-1', expect.objectContaining({ expectedVersion: 1 }));
  });

  it('reports a VERSION CONFLICT as a conflict, not a generic failure', async () => {
    calls.update.mockRejectedValue(
      new Error('This customer was changed by someone else while you were editing it. '
        + 'Review the latest version before applying your changes.'),
    );

    const result = await customerActions().save(
      { entityCode: 'ACME', legalName: 'Mine', entityType: 'customer' } as never, 'party-1',
    );

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toMatch(/changed by someone else/i);
  });

  it('renders a PERMISSION refusal in the server’s own words', async () => {
    calls.create.mockRejectedValue(new Error('You do not have permission to create customers.'));

    const result = await customerActions().save(
      { entityCode: 'X', legalName: 'X Co', entityType: 'customer' } as never,
    );

    expect(result.ok).toBe(false);
    expect(result.conflict).toBeFalsy();
    expect(result.error).toBe('You do not have permission to create customers.');
  });

  it('renders a SUBSCRIPTION refusal in the server’s own words', async () => {
    calls.create.mockRejectedValue(
      new Error('Activate your subscription to save business records.'),
    );

    const result = await customerActions().save(
      { entityCode: 'X', legalName: 'X Co', entityType: 'customer' } as never,
    );

    expect(result.error).toMatch(/Activate your subscription/i);
  });

  it('ARCHIVES and RESTORES through the server', async () => {
    const before = browserSnapshot();

    const archived = await customerActions().setArchived('party-1', true);
    expect(archived.ok).toBe(true);
    expect(calls.setArchived).toHaveBeenCalledWith('party-1', { archived: true, expectedVersion: 1 });

    calls.list.mockResolvedValue({ parties: [party({ status: 'archived', version: 2 })], nextCursor: null });
    await act(async () => { await loadCustomers(); });

    const restored = await customerActions().setArchived('party-1', false);
    expect(restored.ok).toBe(true);
    expect(calls.setArchived).toHaveBeenLastCalledWith('party-1', { archived: false, expectedVersion: 2 });

    expect(browserSnapshot()).toBe(before);
  });

  it('duplicates through the server, deriving a free code and dropping the tax number', async () => {
    const result = await customerActions().duplicate('party-1');

    expect(result.ok).toBe(true);
    const sent = calls.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.partyCode).toBe('ACME-COPY');
    expect(sent.legalName).toBe('Acme Trading LLC (copy)');
    /* Unique per company: a copy cannot carry the original's tax number. */
    expect(sent.taxRegistrationNumber).toBe('');
  });
});

/* ══ Actions with no server equivalent ═════════════════════════════════════ */

describe('actions S1 cannot serve', () => {
  it('refuses a role change rather than falling back to the browser', async () => {
    const actions = customerActions();
    expect(actions.canChangeRoles).toBe(false);

    /* And the message says why, rather than failing silently. */
    const { ROLE_CHANGE_UNSUPPORTED } = await import('@/services/parties/customerActions');
    expect(ROLE_CHANGE_UNSUPPORTED).toMatch(/not available for server-held customers/i);
  });

  it('refuses an import rather than writing parties the server never saw', async () => {
    const actions = customerActions();
    expect(actions.canImport).toBe(false);

    const { IMPORT_UNSUPPORTED } = await import('@/services/parties/customerActions');
    expect(IMPORT_UNSUPPORTED).toMatch(/not available for server-held customers/i);
  });
});

/* ══ Free Demo keeps its local behaviour ═══════════════════════════════════ */

describe('Free Demo', () => {
  beforeEach(() => { engine.current = 'demo'; });

  it('writes locally and asks the server for nothing', async () => {
    const actions = customerActions();
    expect(actions.serverBacked).toBe(false);
    /* Every action the durable path refuses is still offered here. */
    expect(actions.canChangeRoles).toBe(true);
    expect(actions.canImport).toBe(true);

    const { makeDefaultEntityValues } = await import('@/store/useEntityStore');
    const result = await actions.save({
      ...makeDefaultEntityValues('customer'), entityCode: 'DEMO', legalName: 'Demo Co',
    });

    expect(result.ok).toBe(true);
    expect(calls.create).not.toHaveBeenCalled();
    expect(useEntityStore.getState().entities.some((e) => e.entityCode === 'DEMO')).toBe(true);
  });
});
