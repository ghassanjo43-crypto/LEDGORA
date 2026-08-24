/**
 * The cutover's safety properties.
 *
 * Each test here pins a way the obvious implementation loses a subscriber's
 * invoices: flipping before the data lands, flipping on a partial import,
 * flipping when the server cannot confirm what it holds, or flipping a company
 * whose invoices use something the server cannot represent.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Invoice } from '@/types/invoice';
import { assessEligibility, backendFor } from './invoiceBackend';
import { migrateCompanyInvoices, toImportedInvoice } from './invoiceCutover';
import { invoicesApi, type ImportOutcome } from '@/services/api/invoicesApi';

vi.mock('@/services/api/invoicesApi', () => ({
  invoicesApi: { import: vi.fn(), list: vi.fn() },
}));

const importMock = vi.mocked(invoicesApi.import);
const listMock = vi.mocked(invoicesApi.list);

const clean: ImportOutcome = { imported: 1, skipped: 0, failures: [], unmatchedAccounts: [] };

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    entityId: 'company-1',
    customerId: 'cust-1',
    invoiceNumber: 'INV-2025-0001',
    status: 'issued',
    issueDate: '2025-06-01',
    dueDate: '2025-06-30',
    currency: 'JOD',
    exchangeRate: 1,
    templateId: 't1',
    templateVersionId: 'v1',
    templateResolutionSource: 'entity-default',
    lines: [{
      id: 'line-1',
      accountId: 'acct-sales',
      description: 'Consulting',
      quantity: 1,
      unitPrice: 100,
      lineSubtotal: 100,
      lineTotal: 116,
      taxAmount: 16,
      taxRate: 16,
    }],
    subtotal: 100,
    discountTotal: 0,
    taxTotal: 16,
    additionalChargesTotal: 0,
    grandTotal: 116,
    amountPaid: 0,
    creditsApplied: 0,
    balanceDue: 116,
    payments: [],
    auditTrail: [],
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    ...over,
  } as Invoice;
}

const lookup = (id: string) => (id === 'acct-sales' ? '4000' : undefined);
const run = (invoices: Invoice[]) => migrateCompanyInvoices({ invoices, decimals: 3, lookup });

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([{ invoiceNumber: 'INV-2025-0001' }] as never);
});

describe('the flag follows the data', () => {
  it('is browser until a migration timestamp exists', () => {
    expect(backendFor(undefined)).toBe('browser');
    expect(backendFor({ invoicesMigratedAt: null })).toBe('browser');
    expect(backendFor({ invoicesMigratedAt: '2026-01-01T00:00:00.000Z' })).toBe('server');
  });

  it('returns a timestamp only after the invoices are on the server', async () => {
    importMock.mockResolvedValue(clean);
    const result = await run([invoice()]);

    expect(result.ok).toBe(true);
    expect(result.migratedAt).toBeTruthy();
    // The import must have happened BEFORE the caller has anything to store.
    expect(importMock).toHaveBeenCalledOnce();
    expect(backendFor({ invoicesMigratedAt: result.migratedAt })).toBe('server');
  });
});

describe('what refuses to flip a company', () => {
  it('a partial import', async () => {
    importMock.mockResolvedValue({
      imported: 1, skipped: 0, unmatchedAccounts: [],
      failures: [{ invoiceNumber: 'INV-2025-0002', reason: 'bad date' }],
    });

    const result = await run([invoice(), invoice({ id: 'inv-2', invoiceNumber: 'INV-2025-0002' })]);

    // Flipping here would show a book with a document missing as if complete.
    expect(result.ok).toBe(false);
    expect(result.migratedAt).toBeUndefined();
    expect(result.error).toMatch(/company is unchanged/i);
  });

  it('a server that cannot confirm what it holds', async () => {
    importMock.mockResolvedValue(clean);
    listMock.mockRejectedValue(new Error('gateway timeout'));

    const result = await run([invoice()]);

    expect(result.ok).toBe(false);
    expect(result.migratedAt).toBeUndefined();
    expect(result.error).toMatch(/could not be verified/i);
  });

  it('a server whose list is missing something we just sent', async () => {
    importMock.mockResolvedValue({ ...clean, imported: 2 });
    listMock.mockResolvedValue([{ invoiceNumber: 'INV-2025-0001' }] as never);

    const result = await run([invoice(), invoice({ id: 'inv-2', invoiceNumber: 'INV-2025-0002' })]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing 1 migrated invoice/i);
  });

  it('a failed import, without flipping and without throwing', async () => {
    importMock.mockRejectedValue(new Error('network down'));

    const result = await run([invoice()]);

    expect(result.ok).toBe(false);
    expect(result.migratedAt).toBeUndefined();
    expect(result.error).toBe('network down');
  });
});

describe('eligibility guards what the server cannot yet represent', () => {
  it('allows a company with recorded receipts, now that the server holds them', () => {
    const withPayment = invoice({
      payments: [{ id: 'p1', amount: 50, date: '2025-06-10', bankAccountId: 'b1' }],
    } as Partial<Invoice>);
    expect(assessEligibility([withPayment]).eligible).toBe(true);
  });

  it('carries those receipts in the payload rather than dropping them', () => {
    const withPayment = invoice({
      payments: [{ id: 'p1', amount: 50, date: '2025-06-10', bankAccountId: 'b1', method: 'transfer' }],
    } as Partial<Invoice>);
    const payload = toImportedInvoice(withPayment, 3, lookup);
    expect(payload.payments).toEqual([
      { paidOn: '2025-06-10', amount: '50.000', method: 'transfer', reference: undefined },
    ]);
  });

  it('blocks a company selling inventory items', () => {
    const withStock = invoice({
      lines: [{ ...invoice().lines[0], inventoryItemId: 'item-1' }],
    } as Partial<Invoice>);

    const result = assessEligibility([withStock]);
    expect(result.eligible).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('inventory_lines');
  });

  it('carries additional charges rather than blocking on them', () => {
    expect(assessEligibility([invoice({ additionalChargesTotal: 5 })]).eligible).toBe(true);
    const payload = toImportedInvoice(invoice({ additionalChargesTotal: 5 }), 3, lookup);
    expect(payload.additionalChargesTotal).toBe('5.000');
  });

  it('never calls the API for an ineligible company', async () => {
    const stocked = invoice({ lines: [{ ...invoice().lines[0], inventoryItemId: 'i1' }] } as Partial<Invoice>);
    const result = await run([stocked]);
    expect(result.ok).toBe(false);
    expect(importMock).not.toHaveBeenCalled();
  });

  it('names the offending invoices so they can be found', () => {
    const stocked = invoice({
      invoiceNumber: 'INV-9',
      lines: [{ ...invoice().lines[0], inventoryItemId: 'i1' }],
    } as Partial<Invoice>);
    expect(assessEligibility([stocked]).blockers[0]!.examples).toEqual(['INV-9']);
  });

  it('allows a company that simply issues invoices', () => {
    expect(assessEligibility([invoice()]).eligible).toBe(true);
  });
});

describe('the payload the server receives', () => {
  it('sends money as decimal strings at the company precision', () => {
    const payload = toImportedInvoice(invoice(), 3, lookup);
    // Not 116 -- the wire format is the server's NUMERIC, not a JS float.
    expect(payload.grandTotal).toBe('116.000');
    expect(payload.lines[0]!.unitPrice).toBe('100.000');
  });

  it('resolves account ids to the codes the import endpoint matches on', () => {
    const payload = toImportedInvoice(invoice(), 3, lookup);
    expect(payload.lines[0]!.accountCode).toBe('4000');
  });

  it('marks an unresolvable account rather than sending an empty code', () => {
    const orphan = invoice({ lines: [{ ...invoice().lines[0], accountId: 'gone' }] } as Partial<Invoice>);
    // An empty code would strand the line's value invisibly; this one lands on
    // the server's suspense account and is reported back.
    expect(toImportedInvoice(orphan, 3, lookup).lines[0]!.accountCode).toBe('UNMAPPED');
  });

  it('preserves the number and the status', () => {
    const payload = toImportedInvoice(invoice({ status: 'void', voidReason: 'duplicate' }), 3, lookup);
    expect(payload).toMatchObject({ invoiceNumber: 'INV-2025-0001', status: 'void', voidReason: 'duplicate' });
  });
});
