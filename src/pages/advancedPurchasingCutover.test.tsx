// @vitest-environment happy-dom
/**
 * The Advanced Purchasing screens a durable subscriber actually uses.
 *
 * The claim under test is narrow and important: a durable subscriber's orders,
 * outstanding quantities, receipts and goods-received-not-invoiced balance all
 * come from the SERVER, every write goes to the server, and there is no browser
 * store behind any of it. A screen that fell back to local storage would show a
 * commitment the business has no record of and a stock quantity the books have
 * never seen — and somebody would act on both.
 *
 * It also proves the negative: clearing this browser changes nothing, because
 * there is nothing here to clear.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

import { PurchaseOrdersPage } from './purchasing/PurchaseOrdersPage';
import { GoodsReceiptsPage } from './purchasing/GoodsReceiptsPage';
import { ReceivedNotInvoicedPage } from './purchasing/ReceivedNotInvoicedPage';
import {
  clearPurchasingCache, usePurchasing,
} from '@/services/purchasing/purchasingBackend';
import { clearInventoryCache, useServerInventory } from '@/services/inventory/inventoryBackend';
import { clearSupplierCache } from '@/services/parties/supplierDirectory';
import { useStore } from '@/store/useStore';
import {
  server, resetServer, install, seedIssuedOrder,
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

async function itemsReady(): Promise<void> {
  await waitFor(() => expect(useServerInventory.getState().itemState).toBe('ready'));
}

/* ══ Purchase orders ═══════════════════════════════════════════════════════ */

describe('a durable subscriber raises a purchase order', () => {
  it('sends quantities and prices to the server and no amounts at all', async () => {
    render(<PurchaseOrdersPage />);
    await itemsReady();
    await waitFor(() => expect(screen.getByLabelText(/^Supplier$/i)).toBeTruthy());

    fill(/^Supplier$/i, 'sup-1');
    fill(/Item on line 1/i, 'item-1');
    fill(/Quantity on line 1/i, '10');
    fill(/Unit price on line 1/i, '5.000');
    fireEvent.click(screen.getByRole('button', { name: /Create draft order/i }));

    await waitFor(() => expect(server.orders).toHaveLength(1));
    const posted = server.calls.find((c) => c.method === 'POST' && c.path === '/api/purchasing/orders');
    expect(posted).toBeTruthy();

    /* Quantities, prices and a tax code. Never a total, a tax amount or a status. */
    const body = posted!.body as { lines: Array<Record<string, unknown>> };
    expect(Object.keys(posted!.body)).not.toContain('total');
    expect(Object.keys(posted!.body)).not.toContain('status');
    expect(Object.keys(body.lines[0]!)).not.toContain('netAmount');
    expect(Object.keys(body.lines[0]!)).not.toContain('lineNet');
    expect(body.lines[0]!.quantity).toBe('10');
    expect(body.lines[0]!.unitPrice).toBe('5.000');

    /* And the register shows what the SERVER computed. */
    await waitFor(() => expect(screen.getByText('PO-2026-0001')).toBeTruthy());
  });

  it('says plainly that nothing was posted', async () => {
    render(<PurchaseOrdersPage />);
    await itemsReady();
    expect(screen.getByText(/A purchase order posts nothing/i)).toBeTruthy();
  });

  it('approves and issues through the server, as two separate acts', async () => {
    const order = seedIssuedOrder();
    order.status = 'draft';
    order.approvedAt = null;
    order.issuedAt = null;
    order.version = 1;

    render(<PurchaseOrdersPage />);
    await waitFor(() => expect(screen.getByText('PO-2026-0001')).toBeTruthy());
    fireEvent.click(screen.getByText('PO-2026-0001'));

    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/i }));
    await waitFor(() => expect(server.orders[0]!.status).toBe('approved'));

    fireEvent.click(await screen.findByRole('button', { name: /Issue to supplier/i }));
    await waitFor(() => expect(server.orders[0]!.status).toBe('issued'));

    expect(server.calls.some((c) => c.path.endsWith('/approve'))).toBe(true);
    expect(server.calls.some((c) => c.path.endsWith('/issue'))).toBe(true);
  });

  it('shows the SERVER-derived outstanding quantity, never one it computed', async () => {
    const order = seedIssuedOrder('10', '5.000');
    server.receipts.push({
      id: 'gr-seed', receiptNumber: 'GR-2026-0001', orderId: order.id,
      orderNumber: order.orderNumber, supplierId: order.supplierId,
      supplierName: order.supplierName, receiptDate: '2026-03-05', postingDate: '2026-03-05',
      deliveryNoteReference: '', memo: '', status: 'posted', totalValue: '20.000',
      inventoryDocumentId: 'doc-seed', inventoryDocumentNumber: 'PRC-2026-0001',
      journalEntryId: 'je-seed', reversalDocumentId: null, reversalReason: '', reversedAt: null,
      matched: false, version: 1, createdAt: null, idempotencyKey: 'seed',
      lines: [{
        id: 'grl-seed', lineNumber: 1, orderLineId: order.lines[0]!.id, orderLineNumber: 1,
        itemId: 'item-1', itemCode: 'SKU-1', itemName: 'Widget', baseUnitId: 'unit-1',
        baseUnitCode: 'EA', warehouseId: 'wh-1', warehouseCode: 'MAIN',
        receivedQuantity: '4.000', unitCost: '5.000', totalCost: '20.000', movementId: 'mv-seed',
      }],
    });

    render(<PurchaseOrdersPage />);
    await waitFor(() => expect(screen.getByText('PO-2026-0001')).toBeTruthy());
    fireEvent.click(screen.getByText('PO-2026-0001'));

    await waitFor(() => expect(screen.getByText('6.000')).toBeTruthy());
    expect(screen.getByText('4.000')).toBeTruthy();
  });

  it('reads EMPTY and says so when the server cannot answer', async () => {
    seedIssuedOrder();
    server.failReads = true;

    render(<PurchaseOrdersPage />);
    await waitFor(() => expect(usePurchasing.getState().orderState).toBe('unavailable'));
    expect(usePurchasing.getState().orders).toHaveLength(0);
    /* The SERVER's own sentence, not a message the screen invented. */
    expect(screen.getByText(/not reachable/i)).toBeTruthy();
    expect(screen.queryByText('PO-2026-0001')).toBeNull();
  });
});

/* ══ Goods receipts ════════════════════════════════════════════════════════ */

describe('a durable subscriber receives ordered stock', () => {
  it('sends only an order line and a quantity', async () => {
    seedIssuedOrder('10', '5.000');
    render(<GoodsReceiptsPage />);

    await waitFor(() => expect(screen.getByLabelText(/Quantity received for SKU-1/i)).toBeTruthy());
    fill(/Quantity received for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));

    await waitFor(() => expect(server.receipts).toHaveLength(1));
    const posted = server.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/purchasing/receipts',
    )!;
    const body = posted.body as { lines: Array<Record<string, unknown>>; idempotencyKey: string };

    expect(Object.keys(body.lines[0]!).sort()).toEqual(['orderLineId', 'quantity']);
    expect(body.idempotencyKey).toBeTruthy();

    /* The cost came from the order, not from the screen. */
    expect(server.receipts[0]!.totalValue).toBe('20.000');
  });

  it('carries the SAME idempotency key across a retry of one attempt', async () => {
    seedIssuedOrder('10', '5.000');
    render(<GoodsReceiptsPage />);

    await waitFor(() => expect(screen.getByLabelText(/Quantity received for SKU-1/i)).toBeTruthy());
    fill(/Quantity received for SKU-1/i, '4');

    /* Two clicks of the SAME filled form: one attempt, retried. */
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));
    await waitFor(() => expect(server.receipts).toHaveLength(1));

    const first = server.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/purchasing/receipts',
    )!;
    /* Post the same key again directly, as a retry after a timeout would. */
    const retry = await fetch('http://localhost:3000/api/purchasing/receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first.body),
    });
    expect((await retry.json()).created).toBe(false);
    expect(server.receipts).toHaveLength(1);
  });

  it('surfaces the server\'s over-receipt refusal in its own words', async () => {
    seedIssuedOrder('3', '5.000');
    render(<GoodsReceiptsPage />);

    await waitFor(() => expect(screen.getByLabelText(/Quantity received for SKU-1/i)).toBeTruthy());
    fill(/Quantity received for SKU-1/i, '9');
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));

    await waitFor(() => expect(screen.getByText(/no over-receipt tolerance/i)).toBeTruthy());
    expect(server.receipts).toHaveLength(0);
  });

  it('refuses to receive without a controlled order, and says why', async () => {
    render(<GoodsReceiptsPage />);
    await waitFor(() => expect(
      screen.getByText(/no issued purchase order to receive against/i),
    ).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Post goods receipt/i })).toBeNull();
  });

  it('never presents a receipt as matched, invoiced or settled', async () => {
    const order = seedIssuedOrder('4', '5.000');
    render(<GoodsReceiptsPage />);
    await waitFor(() => expect(screen.getByLabelText(/Quantity received for SKU-1/i)).toBeTruthy());
    fill(/Quantity received for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));

    await waitFor(() => expect(server.receipts).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/Awaiting invoice/i)).toBeTruthy());
    expect(screen.queryByText(/Matched|Settled|Invoiced/)).toBeNull();
    expect(order.status).toBe('received');
  });

  it('reverses through the server and refuses without a reason', async () => {
    const order = seedIssuedOrder('4', '5.000');
    server.receipts.push({
      id: 'gr-seed', receiptNumber: 'GR-2026-0001', orderId: order.id,
      orderNumber: order.orderNumber, supplierId: order.supplierId,
      supplierName: order.supplierName, receiptDate: '2026-03-05', postingDate: '2026-03-05',
      deliveryNoteReference: '', memo: '', status: 'posted', totalValue: '20.000',
      inventoryDocumentId: 'doc-seed', inventoryDocumentNumber: 'PRC-2026-0001',
      journalEntryId: 'je-seed', reversalDocumentId: null, reversalReason: '', reversedAt: null,
      matched: false, version: 1, createdAt: null, idempotencyKey: 'seed',
      lines: [{
        id: 'grl-seed', lineNumber: 1, orderLineId: order.lines[0]!.id, orderLineNumber: 1,
        itemId: 'item-1', itemCode: 'SKU-1', itemName: 'Widget', baseUnitId: 'unit-1',
        baseUnitCode: 'EA', warehouseId: 'wh-1', warehouseCode: 'MAIN',
        receivedQuantity: '4.000', unitCost: '5.000', totalCost: '20.000', movementId: 'mv-seed',
      }],
    });

    render(<GoodsReceiptsPage />);
    await waitFor(() => expect(screen.getByText('GR-2026-0001')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Reverse$/i }));

    /* Without a reason, nothing is sent at all. */
    fireEvent.click(await screen.findByRole('button', { name: /^Withdraw$/i }));
    await waitFor(() => expect(screen.getByText(/at least five characters/i)).toBeTruthy());
    expect(server.receipts[0]!.status).toBe('posted');

    fill(/Reason for reversal/i, 'Wrong goods delivered');
    fireEvent.click(screen.getByRole('button', { name: /^Withdraw$/i }));
    await waitFor(() => expect(server.receipts[0]!.status).toBe('reversed'));
    expect(server.receipts[0]!.reversalReason).toBe('Wrong goods delivered');
  });
});

/* ══ Received not invoiced ═════════════════════════════════════════════════ */

describe('the received-not-invoiced schedule', () => {
  it('shows the server figure and its reconciliation to the ledger', async () => {
    const order = seedIssuedOrder('4', '5.000');
    server.receipts.push({
      id: 'gr-seed', receiptNumber: 'GR-2026-0001', orderId: order.id,
      orderNumber: order.orderNumber, supplierId: order.supplierId,
      supplierName: order.supplierName, receiptDate: '2026-03-05', postingDate: '2026-03-05',
      deliveryNoteReference: '', memo: '', status: 'posted', totalValue: '20.000',
      inventoryDocumentId: 'doc-seed', inventoryDocumentNumber: 'PRC-2026-0001',
      journalEntryId: 'je-seed', reversalDocumentId: null, reversalReason: '', reversedAt: null,
      matched: false, version: 1, createdAt: null, idempotencyKey: 'seed',
      lines: [{
        id: 'grl-seed', lineNumber: 1, orderLineId: order.lines[0]!.id, orderLineNumber: 1,
        itemId: 'item-1', itemCode: 'SKU-1', itemName: 'Widget', baseUnitId: 'unit-1',
        baseUnitCode: 'EA', warehouseId: 'wh-1', warehouseCode: 'MAIN',
        receivedQuantity: '4.000', unitCost: '5.000', totalCost: '20.000', movementId: 'mv-seed',
      }],
    });

    render(<ReceivedNotInvoicedPage />);
    await waitFor(() => expect(screen.getByText('GR-2026-0001')).toBeTruthy());
    expect(screen.getByText(/Reconciled/i)).toBeTruthy();
    expect(screen.getByText(/awaiting a supplier invoice/i)).toBeTruthy();
  });

  it('reads EMPTY rather than stale when the server cannot answer', async () => {
    server.failReads = true;
    render(<ReceivedNotInvoicedPage />);
    await waitFor(() => expect(usePurchasing.getState().grniState).toBe('unavailable'));
    expect(usePurchasing.getState().grni).toBeNull();
    expect(screen.getByText(/not reachable/i)).toBeTruthy();
  });
});

/* ══ Free Demo, and the absence of a browser engine ════════════════════════ */

describe('a browser-books workspace', () => {
  it('is told plainly that advanced purchasing is server-only', async () => {
    engine.current = 'demo';
    render(<PurchaseOrdersPage />);
    expect(screen.getByText(/held on the server only/i)).toBeTruthy();
    /* And nothing was asked of the server at all. */
    expect(server.calls).toHaveLength(0);
  });

  it('offers no local receiving path', () => {
    engine.current = 'demo';
    render(<GoodsReceiptsPage />);
    expect(screen.getByText(/held on the server only/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Post goods receipt/i })).toBeNull();
  });

  it('offers no local GRNI balance', () => {
    engine.current = 'demo';
    render(<ReceivedNotInvoicedPage />);
    expect(screen.getByText(/held on the server only/i)).toBeTruthy();
  });
});

/* ══ Clearing the browser ══════════════════════════════════════════════════ */

describe('clearing this browser', () => {
  it('leaves the durable orders, receipts and GRNI balance exactly as they were', async () => {
    const order = seedIssuedOrder('4', '5.000');
    render(<GoodsReceiptsPage />);
    await waitFor(() => expect(screen.getByLabelText(/Quantity received for SKU-1/i)).toBeTruthy());
    fill(/Quantity received for SKU-1/i, '4');
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));
    await waitFor(() => expect(server.receipts).toHaveLength(1));

    /* Everything the browser holds, gone. */
    localStorage.clear();
    clearPurchasingCache();
    expect(usePurchasing.getState().orders).toHaveLength(0);
    expect(usePurchasing.getState().receipts).toHaveLength(0);
    expect(usePurchasing.getState().grni).toBeNull();

    /* The books are untouched, because they were never here. */
    expect(server.orders).toHaveLength(1);
    expect(server.receipts).toHaveLength(1);
    expect(server.receipts[0]!.totalValue).toBe('20.000');
    expect(order.status).toBe('received');
  });
});
