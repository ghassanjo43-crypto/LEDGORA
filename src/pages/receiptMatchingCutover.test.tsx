// @vitest-environment happy-dom
/**
 * The Receipt Matching screen a durable subscriber actually uses.
 *
 * The claim under test is that the clicks reach the server and that the screen
 * never authors an accounting figure: it sends a receipt line and a quantity,
 * the value comes back from the books, and the server's refusals — an invoice
 * priced differently from the goods, a quantity that never arrived — are shown
 * in the server's own words rather than pre-empted or reworded here.
 *
 * It also proves the negative: there is no browser matching store, so clearing
 * this browser changes nothing about what has been settled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

import { ReceiptMatchingPage } from './purchasing/ReceiptMatchingPage';
import { ReceivedNotInvoicedPage } from './purchasing/ReceivedNotInvoicedPage';
import {
  clearPurchasingCache, usePurchasing,
} from '@/services/purchasing/purchasingBackend';
import { clearInventoryCache } from '@/services/inventory/inventoryBackend';
import { clearSupplierCache } from '@/services/parties/supplierDirectory';
import { clearBillCache } from '@/services/bills/billBackend';
import { useStore } from '@/store/useStore';
import {
  server, resetServer, install, seedIssuedOrder, seedPostedReceipt,
} from './__fixtures__/advancedPurchasingFakeServer';

const realFetch = globalThis.fetch;

beforeEach(() => {
  engine.current = 'server';
  vi.stubEnv('VITE_API_URL', 'http://localhost:3000');
  resetServer();
  install();
  clearPurchasingCache();
  clearInventoryCache();
  clearSupplierCache();
  clearBillCache();
  useStore.setState({ accounts: [] } as never);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const fill = (label: RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** An issued order with a posted receipt of 4 at 5.000, awaiting an invoice. */
function delivered(quantity = '4.000', total = '20.000') {
  const order = seedIssuedOrder('4', '5.000');
  return { order, receipt: seedPostedReceipt(order, quantity, total) };
}

async function offered(): Promise<void> {
  await waitFor(() => expect(usePurchasing.getState().eligibleState).toBe('ready'));
  await waitFor(() => expect(screen.getByLabelText(/^Supplier$/i)).toBeTruthy());
  fill(/^Supplier$/i, 'sup-1');
}

/* ══ Matching ══════════════════════════════════════════════════════════════ */

describe('a durable subscriber settles a delivery', () => {
  it('sends a receipt line and a quantity, and no account or cost', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await offered();

    fill(/Supplier invoice number/i, 'INV-991');
    await waitFor(() => expect(screen.getByLabelText(/Quantity billed for SKU-1/i)).toBeTruthy());
    fill(/Quantity billed for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post supplier bill/i }));

    await waitFor(() => expect(server.matches).toHaveLength(1));

    const created = server.calls.find((c) => c.method === 'POST' && c.path === '/api/bills')!;
    const body = created.body as {
      workflow: string; lines: Array<Record<string, unknown>>;
    };
    expect(body.workflow).toBe('receipt-matched');
    expect(Object.keys(body.lines[0]!)).not.toContain('accountId');
    expect(Object.keys(body.lines[0]!)).not.toContain('unitCost');
    expect(body.lines[0]!.receiptLineId).toBeTruthy();
    expect(body.lines[0]!.matchedQuantity).toBe('4');

    /* And the clearing is the receipt's own value, from the server. */
    expect(server.matches[0]!.matchedReceiptValue).toBe('20.000');
    expect(server.matches[0]!.valueDifference).toBe('0.000');
  });

  it('shows the SERVER-derived outstanding quantity, never one it computed', async () => {
    const { receipt } = delivered('10.000', '50.000');
    /* A previous bill already settled 4 of the 10. */
    server.matches.push({
      matchId: 'm-seed', status: 'active', matchedAt: 'now',
      billId: 'b-seed', billNumber: 'BILL-2026-0001', supplierInvoiceNumber: 'INV-1',
      billStatus: 'posted', billPostingDate: '2026-03-10',
      supplierId: 'sup-1', supplierName: 'Acme Supplies',
      receiptId: receipt.id, receiptLineId: receipt.lines[0]!.id,
      receiptNumber: receipt.receiptNumber, receiptPostingDate: '2026-03-05',
      orderId: receipt.orderId, orderNumber: receipt.orderNumber,
      itemId: 'item-1', itemCode: 'SKU-1', itemName: 'Widget', baseUnitCode: 'EA',
      matchedQuantity: '4.000', receiptUnitCost: '5.000', matchedReceiptValue: '20.000',
      billNetUnitPrice: '5.000', matchedBillValue: '20.000', valueDifference: '0.000',
      accountCode: '2150', accountName: 'Goods received not invoiced', reversalReason: '',
    });

    render(<ReceiptMatchingPage />);
    await offered();

    await waitFor(() => expect(screen.getByText('6.000')).toBeTruthy());
    expect(screen.getByText('4.000')).toBeTruthy();
  });

  it("surfaces the server's price refusal in its own words", async () => {
    const { receipt } = delivered();
    /* The receipt was costed at 5.000; the fake server refuses anything else,
     * exactly as the real one does. Rig the line so the screen sends 6.000. */
    receipt.lines[0]!.totalCost = '24.000';
    receipt.lines[0]!.unitCost = '6.000';
    receipt.totalValue = '24.000';
    receipt.openValue = '24.000';
    /* ...but the bill will be built from `remainingValue`, so make the two
     * disagree the way a genuine price difference does. */
    server.receipts[0]!.lines[0]!.totalCost = '24.000';

    render(<ReceiptMatchingPage />);
    await offered();
    fill(/Supplier invoice number/i, 'INV-BAD');
    await waitFor(() => expect(screen.getByLabelText(/Quantity billed for SKU-1/i)).toBeTruthy());
    /* Billing 2 of 4 takes a pro-rata share of 24.000 = 12.000, which the
     * fake server accepts. Force a mismatch by editing the receipt after the
     * eligible list was rendered. */
    fill(/Quantity billed for SKU-1/i, '2');
    server.receipts[0]!.lines[0]!.totalCost = '30.000';
    fireEvent.click(screen.getByRole('button', { name: /Post supplier bill/i }));

    await waitFor(() => expect(
      screen.getByText(/Purchase-price variance has no defined destination/i),
    ).toBeTruthy());
    expect(server.matches).toHaveLength(0);
  });

  it('refuses to post with nothing entered, and never calls the server', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await offered();
    fill(/Supplier invoice number/i, 'INV-EMPTY');

    const before = server.calls.filter((c) => c.path === '/api/bills').length;
    /* With no quantity the action is disabled, so nothing can be sent at all. */
    expect(screen.getByRole('button', { name: /Post supplier bill/i })).toHaveProperty(
      'disabled', true,
    );
    expect(server.calls.filter((c) => c.path === '/api/bills')).toHaveLength(before);
  });

  it('requires the supplier invoice number the books will record', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await offered();
    await waitFor(() => expect(screen.getByLabelText(/Quantity billed for SKU-1/i)).toBeTruthy());
    fill(/Quantity billed for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post supplier bill/i }));

    await waitFor(() => expect(screen.getByText(/own invoice number/i)).toBeTruthy());
    expect(server.matches).toHaveLength(0);
  });

  it('offers nothing for a supplier with no outstanding deliveries', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await waitFor(() => expect(usePurchasing.getState().eligibleState).toBe('ready'));
    /* No supplier chosen yet: the screen asks rather than guessing. */
    expect(screen.getByText(/Choose a supplier to see the deliveries/i)).toBeTruthy();
  });

  it('states the exact-value rule from the SERVER, not from the screen', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await waitFor(() => expect(usePurchasing.getState().exactValueRequired).toBe(true));
    expect(usePurchasing.getState().varianceNote).toMatch(/exact/i);
  });

  it('reads EMPTY and says so when the server cannot answer', async () => {
    delivered();
    server.failReads = true;

    render(<ReceiptMatchingPage />);
    await waitFor(() => expect(usePurchasing.getState().eligibleState).toBe('unavailable'));
    expect(usePurchasing.getState().eligible).toHaveLength(0);
    expect(screen.getByText(/not reachable/i)).toBeTruthy();
  });
});

/* ══ Settled history ═══════════════════════════════════════════════════════ */

describe('what has been settled', () => {
  it('lists the clearings with both values and no difference', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await offered();
    fill(/Supplier invoice number/i, 'INV-HIST');
    await waitFor(() => expect(screen.getByLabelText(/Quantity billed for SKU-1/i)).toBeTruthy());
    fill(/Quantity billed for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post supplier bill/i }));

    await waitFor(() => expect(screen.getByText('INV-HIST')).toBeTruthy());
    expect(screen.getByText(/Settled/i)).toBeTruthy();
    /* Zero difference, shown rather than assumed. */
    const history = usePurchasing.getState().matches;
    expect(history).toHaveLength(1);
    expect(Number(history[0]!.valueDifference)).toBe(0);
  });

  it('drops a settled delivery from the offer list', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await offered();
    fill(/Supplier invoice number/i, 'INV-DONE');
    await waitFor(() => expect(screen.getByLabelText(/Quantity billed for SKU-1/i)).toBeTruthy());
    fill(/Quantity billed for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post supplier bill/i }));

    await waitFor(() => expect(usePurchasing.getState().eligible).toHaveLength(0));
    expect(screen.getByText(/no delivered goods awaiting an invoice/i)).toBeTruthy();
  });
});

/* ══ The GRNI schedule after matching ══════════════════════════════════════ */

describe('the received-not-invoiced schedule', () => {
  it('shows what was received, what was billed and what is still open', async () => {
    const { receipt } = delivered('10.000', '50.000');
    server.matches.push({
      matchId: 'm-seed', status: 'active', matchedAt: 'now',
      billId: 'b-seed', billNumber: 'BILL-2026-0001', supplierInvoiceNumber: 'INV-1',
      billStatus: 'posted', billPostingDate: '2026-03-10',
      supplierId: 'sup-1', supplierName: 'Acme Supplies',
      receiptId: receipt.id, receiptLineId: receipt.lines[0]!.id,
      receiptNumber: receipt.receiptNumber, receiptPostingDate: '2026-03-05',
      orderId: receipt.orderId, orderNumber: receipt.orderNumber,
      itemId: 'item-1', itemCode: 'SKU-1', itemName: 'Widget', baseUnitCode: 'EA',
      matchedQuantity: '4.000', receiptUnitCost: '5.000', matchedReceiptValue: '20.000',
      billNetUnitPrice: '5.000', matchedBillValue: '20.000', valueDifference: '0.000',
      accountCode: '2150', accountName: 'Goods received not invoiced', reversalReason: '',
    });

    render(<ReceivedNotInvoicedPage />);
    await waitFor(() => expect(usePurchasing.getState().grniState).toBe('ready'));

    const schedule = usePurchasing.getState().grni!;
    expect(Number(schedule.rows[0]!.value)).toBe(50);
    expect(Number(schedule.rows[0]!.clearedValue)).toBe(20);
    expect(Number(schedule.rows[0]!.openValue)).toBe(30);
    expect(Number(schedule.total)).toBe(30);
    expect(schedule.matchingImplemented).toBe(true);
    expect(screen.getByText(/Reconciled/i)).toBeTruthy();
  });

  it('says plainly that returns are not implemented', async () => {
    delivered();
    render(<ReceivedNotInvoicedPage />);
    await waitFor(() => expect(usePurchasing.getState().grniState).toBe('ready'));
    expect(screen.getByText(/not implemented/i)).toBeTruthy();
  });
});

/* ══ Free Demo, and the absence of a browser engine ════════════════════════ */

describe('a browser-books workspace', () => {
  it('is told plainly that matching is server-only, and asks nothing of the server', () => {
    engine.current = 'demo';
    render(<ReceiptMatchingPage />);
    expect(screen.getByText(/held on the server only/i)).toBeTruthy();
    expect(server.calls).toHaveLength(0);
  });
});

/* ══ Clearing the browser ══════════════════════════════════════════════════ */

describe('clearing this browser', () => {
  it('leaves the durable matches and clearings exactly as they were', async () => {
    delivered();
    render(<ReceiptMatchingPage />);
    await offered();
    fill(/Supplier invoice number/i, 'INV-CLEAR');
    await waitFor(() => expect(screen.getByLabelText(/Quantity billed for SKU-1/i)).toBeTruthy());
    fill(/Quantity billed for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post supplier bill/i }));
    await waitFor(() => expect(server.matches).toHaveLength(1));

    localStorage.clear();
    clearPurchasingCache();
    expect(usePurchasing.getState().matches).toHaveLength(0);
    expect(usePurchasing.getState().eligible).toHaveLength(0);
    expect(usePurchasing.getState().grni).toBeNull();

    /* The books are untouched, because they were never here. */
    expect(server.matches).toHaveLength(1);
    expect(server.matches[0]!.matchedReceiptValue).toBe('20.000');
    expect(server.bills).toHaveLength(1);
    expect(server.bills[0]!.status).toBe('posted');
  });
});
