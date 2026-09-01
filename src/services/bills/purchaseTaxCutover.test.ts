// @vitest-environment happy-dom
/**
 * Purchase tax on the client: the server decides, the screen only shows.
 *
 * ══ What these guard ═════════════════════════════════════════════════════════
 *
 * The SELECTOR, because §3 forbids a sales-only code on a bill — offering one
 * is how a user is refused about something on the screen in front of them.
 *
 * The MAPPING, because a screen that recomputed tax from the browser calculator
 * would disagree with the ledger the moment a rate changed, and the frozen
 * snapshot is the only thing that can say what a posted bill was charged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const taxApi = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), history: vi.fn(),
  create: vi.fn(), update: vi.fn(), addRate: vi.fn(), setStatus: vi.fn(),
}));
vi.mock('@/services/api/taxCodesApi', () => ({ taxCodesApi: taxApi }));
vi.mock('@/services/api/billsApi', () => ({ billsApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/suppliersApi', () => ({ suppliersApi: { list: vi.fn(async () => ({ parties: [], nextCursor: null })), count: vi.fn(async () => 0) } }));
vi.mock('@/services/api/customersApi', () => ({ customersApi: { list: vi.fn(async () => ({ parties: [], nextCursor: null })) } }));
vi.mock('@/services/api/invoicesApi', () => ({ invoicesApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

import { __resetBooksScopeForTests } from '@/services/books/booksScope';
import { useServerTaxCodeStore } from '@/store/serverTaxCodeStore';
import { toBrowserBill } from './useBills';

const code = (over: Record<string, unknown> = {}) => ({
  id: 'tax-1', code: 'VATIN16', name: 'Standard-rated purchases', description: '',
  category: 'standard', calculationMethod: 'exclusive', direction: 'purchase',
  status: 'active', outputTaxAccountId: null, inputTaxAccountId: 'acct-input',
  effectiveFrom: '2026-01-01', effectiveTo: null, version: 1,
  rateVersions: [{
    id: 'rv-1', taxCodeId: 'tax-1', rate: '16.000000',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    outputTaxAccountId: null, inputTaxAccountId: 'acct-input', createdAt: null,
  }],
  ...over,
});

const taxedBill = (over: Record<string, unknown> = {}) => ({
  id: 'bill-1', billNumber: 'BILL-2026-0001', supplierInvoiceNumber: 'SUP-9',
  status: 'posted', issuingEntityId: 'entity-main', supplierId: 'sup-1',
  billDate: '2026-03-01', postingDate: '2026-03-01', dueDate: '2026-03-31',
  currency: 'JOD', memo: '',
  subtotal: '1000.000', discountTotal: '0.000', taxTotal: '160.000', total: '1160.000',
  payableAccountId: 'acct-payable', inputTaxAccountId: 'acct-input',
  journalEntryId: 'je-1', reversalJournalEntryId: null, reversalReason: null,
  postedAt: '2026-03-01T00:00:00.000Z', reversedAt: null, version: 2,
  lines: [{
    id: 'line-1', lineNumber: 1, description: 'Consulting', accountId: 'acct-expense',
    quantity: '1.000000', unit: '', unitPrice: '1000.000',
    discountType: null, discountValue: null, discountAmount: '0.000',
    lineSubtotal: '1000.000', lineNet: '1000.000',
    taxableAmount: '1000.000', taxAmount: '160.000', grossAmount: '1160.000',
    taxCodeId: 'tax-1',
    taxSnapshot: {
      taxCodeId: 'tax-1', code: 'VATIN16', name: 'Standard-rated purchases',
      direction: 'purchase', category: 'standard', calculationMethod: 'exclusive',
      recoverability: 'recoverable', rate: '16.000', rateVersionId: 'rv-1',
      effectiveFrom: '2026-01-01', effectiveTo: null, taxPointDate: '2026-03-01',
      taxableAmount: '1000.000', taxAmount: '160.000',
      recoverableTaxAmount: '160.000', grossAmount: '1160.000',
      inputTaxAccountId: 'acct-input', capturedAt: '2026-03-01T00:00:00.000Z',
    },
  }],
  ...over,
});

beforeEach(() => {
  engine.current = 'server';
  Object.values(taxApi).forEach((fn) => fn.mockReset());
  taxApi.list.mockResolvedValue([code()]);
  __resetBooksScopeForTests();
  localStorage.clear();
  useServerTaxCodeStore.setState({
    taxCodes: [], loading: false, loaded: false, loadError: undefined,
  });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ The selector ══════════════════════════════════════════════════════════ */

describe('which codes a bill line may choose', () => {
  it('offers PURCHASE and BOTH codes, never a sales-only one', async () => {
    taxApi.list.mockResolvedValue([
      code({ id: 'purchase', code: 'VATIN' }),
      code({ id: 'both', code: 'VAT16', direction: 'both', outputTaxAccountId: 'acct-output' }),
      code({ id: 'sales', code: 'VATOUT', direction: 'sales', inputTaxAccountId: null, outputTaxAccountId: 'acct-output' }),
    ]);
    await useServerTaxCodeStore.getState().load();

    const forPurchase = useServerTaxCodeStore.getState().selectableOn('2026-06-01', 'purchase');
    expect(forPurchase.map((c) => c.id).sort()).toEqual(['both', 'purchase']);
  });

  it('offers SALES and BOTH codes on an invoice, never a purchase-only one', async () => {
    taxApi.list.mockResolvedValue([
      code({ id: 'purchase', code: 'VATIN' }),
      code({ id: 'both', code: 'VAT16', direction: 'both', outputTaxAccountId: 'acct-output' }),
      code({ id: 'sales', code: 'VATOUT', direction: 'sales', inputTaxAccountId: null, outputTaxAccountId: 'acct-output' }),
    ]);
    await useServerTaxCodeStore.getState().load();

    const forSales = useServerTaxCodeStore.getState().selectableOn('2026-06-01', 'sales');
    expect(forSales.map((c) => c.id).sort()).toEqual(['both', 'sales']);
  });

  it('defaults to SALES, so S2c callers are unchanged', async () => {
    taxApi.list.mockResolvedValue([
      code({ id: 'sales', direction: 'sales', inputTaxAccountId: null, outputTaxAccountId: 'acct-output' }),
    ]);
    await useServerTaxCodeStore.getState().load();
    expect(useServerTaxCodeStore.getState().selectableOn('2026-06-01')).toHaveLength(1);
  });

  it('excludes an archived code and one with no rate on the date', async () => {
    taxApi.list.mockResolvedValue([
      code({ id: 'archived', status: 'archived' }),
      code({
        id: 'lapsed',
        rateVersions: [{
          id: 'rv-x', taxCodeId: 'lapsed', rate: '16.000000',
          effectiveFrom: '2026-01-01', effectiveTo: '2026-02-28',
          outputTaxAccountId: null, inputTaxAccountId: 'acct-input', createdAt: null,
        }],
      }),
    ]);
    await useServerTaxCodeStore.getState().load();
    expect(useServerTaxCodeStore.getState().selectableOn('2026-06-01', 'purchase')).toHaveLength(0);
  });
});

/* ══ The mapping ═══════════════════════════════════════════════════════════ */

describe('a taxed bill as the screens see it', () => {
  it('reports the SERVER tax, not a recomputed one', () => {
    const bill = toBrowserBill(taxedBill() as never);

    expect(bill.taxTotal).toBe(160);
    expect(bill.grandTotal).toBe(1160);
    expect(bill.lines[0]!.taxAmount).toBe(160);
    expect(bill.lines[0]!.taxRate).toBe(16);
    /* The expense is the NET; the tax is a claim on an authority, not a cost. */
    expect(bill.lines[0]!.taxableAmount).toBe(1000);
    expect(bill.lines[0]!.lineTotal).toBe(1160);
  });

  it('shows the whole gross outstanding, because nothing has cleared it', () => {
    const bill = toBrowserBill(taxedBill() as never);
    expect(bill.amountPaid).toBe(0);
    expect(bill.balanceDue).toBe(1160);
  });

  it('reports NO withholding, which has no server treatment', () => {
    const bill = toBrowserBill(taxedBill() as never);
    expect(bill.withholdingTaxTotal).toBe(0);
    expect(bill.additionalChargesTotal).toBe(0);
  });

  it('carries the tax code so the drawer can show what was chosen', () => {
    const bill = toBrowserBill(taxedBill() as never);
    expect(bill.lines[0]!.taxCodeId).toBe('tax-1');
  });

  it('reads a zero-tax-category line as zero WITHOUT losing the code', () => {
    const exempt = taxedBill({
      taxTotal: '0.000', total: '1000.000', inputTaxAccountId: null,
      lines: [{
        ...taxedBill().lines[0],
        taxAmount: '0.000', grossAmount: '1000.000',
        taxSnapshot: {
          ...taxedBill().lines[0]!.taxSnapshot,
          category: 'exempt', rate: '0.000', taxAmount: '0.000',
          recoverableTaxAmount: '0.000', grossAmount: '1000.000',
          inputTaxAccountId: null,
        },
      }],
    });

    const bill = toBrowserBill(exempt as never);
    expect(bill.taxTotal).toBe(0);
    expect(bill.grandTotal).toBe(1000);
    /* The classification survives even though the amount is zero. */
    expect(bill.lines[0]!.taxCodeId).toBe('tax-1');
  });
});
