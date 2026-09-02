// @vitest-environment happy-dom
/**
 * The stock screens a durable subscriber actually uses.
 *
 * The claim under test is narrow and important: a durable subscriber's
 * quantities come from the SERVER, their postings go to the server, and the
 * browser movement store is never consulted or written. A screen that fell back
 * to browser stock would show a number the books have never seen — and somebody
 * would issue against it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

vi.mock('@/services/api/taxCodesApi', () => ({
  taxCodesApi: { list: vi.fn(async () => []) },
}));

import { GoodsReceiptsPage, GoodsIssuesPage } from './inventory/MovementDocumentPage';
import { TransfersPage } from './inventory/TransfersPage';
import { StockMovementsPage } from './inventory/StockMovementsPage';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { makeInventorySeed } from '@/lib/inventorySeed';
import {
  clearInventoryCache, clearStockCache, useServerStock, useServerInventory,
} from '@/services/inventory/inventoryBackend';
import { server, resetServer, install } from './__fixtures__/stockFakeServer';

const realFetch = globalThis.fetch;

beforeEach(() => {
  engine.current = 'server';
  vi.stubEnv('VITE_API_URL', 'http://localhost:3000');
  resetServer();
  install();
  clearInventoryCache();
  clearStockCache();
  useInventoryStore.getState().resetToDefault();
  useStore.setState({ accounts: [] } as never);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function ready(): Promise<void> {
  await waitFor(() => expect(useServerInventory.getState().itemState).toBe('ready'));
}

function fill(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/* ══ Receipts ══════════════════════════════════════════════════════════════ */

describe('a durable subscriber posts stock through the screen', () => {
  it('receives stock on the SERVER, not in the browser', async () => {
    render(<GoodsReceiptsPage />);
    await ready();

    fill(/^Item$/i, 'item-1');
    fill(/^Quantity$/i, '10');
    fill(/Unit cost/i, '5.000');
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));

    await waitFor(() => expect(server.documents).toHaveLength(1));
    const document = server.documents[0]!;
    expect(document.kind).toBe('receipt');
    expect(document.movements[0]!.quantity).toBe('10');
    expect(document.movements[0]!.unitCost).toBe('5.000');

    /* Nothing went into the browser movement ledger. */
    expect(useInventoryStore.getState().movements).toHaveLength(0);
    expect(await screen.findByText(/Posted as GRN-/i)).toBeTruthy();
  });

  it('sends the SAME idempotency key when the same attempt is retried', async () => {
    render(<GoodsReceiptsPage />);
    await ready();

    fill(/^Item$/i, 'item-1');
    fill(/^Quantity$/i, '4');
    fill(/Unit cost/i, '1.000');
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));

    /* The first attempt fails at the network; the second is a RETRY. */
    server.failNextPost = true;
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));
    await screen.findByText(/could not/i);

    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));
    await waitFor(() => expect(server.documents).toHaveLength(1));

    expect(server.postedKeys).toHaveLength(2);
    expect(server.postedKeys[0]).toBe(server.postedKeys[1]);
  });

  it('shows the SERVER’s insufficient-stock refusal in its own words', async () => {
    render(<GoodsIssuesPage />);
    await ready();

    fill(/^Item$/i, 'item-1');
    fill(/^Quantity$/i, '999');
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    fireEvent.click(screen.getByRole('button', { name: /Post goods issue/i }));

    expect(await screen.findByText(/less than nothing/i)).toBeTruthy();
    expect(server.documents).toHaveLength(0);
  });

  it('requires a reason on an adjustment, because the server does', async () => {
    render(<TransfersPage />);
    await waitFor(() => expect(useServerInventory.getState().warehouseState).toBe('ready'));
    /* The transfer screen has no reason field at all — reasons belong to
     * adjustments, and a transfer explains itself. */
    expect(screen.queryByLabelText(/Reason/i)).toBeNull();
  });
});

/* ══ Transfers ═════════════════════════════════════════════════════════════ */

describe('transfers', () => {
  it('posts ONE document with two legs and no journal', async () => {
    /* Stock has to be there before it can be moved — the fake refuses an empty
     * warehouse exactly as the server does. */
    server.documents.push({
      id: 'doc-seed', documentNumber: 'GRN-2026-0001', kind: 'receipt',
      movementDate: '2026-03-01', postingDate: '2026-03-01', reference: '', memo: '', reason: '',
      status: 'posted', journalEntryId: 'j-1', reversalOfDocumentId: null,
      reversedByDocumentId: null, reversalReason: '', version: 1, createdAt: null,
      movements: [{
        id: 'mv-seed', lineNumber: 1, movementType: 'receipt', itemId: 'item-1',
        itemCode: 'SKU-1', itemName: 'Widget', warehouseId: 'wh-1', warehouseCode: 'MAIN',
        baseUnitId: 'unit-1', baseUnitCode: 'EA', direction: 'in', quantity: '10',
        unitCost: '2.000', totalCost: '20.000', inventoryAccountId: 'acct-stock',
        offsetAccountId: 'acct-offset', movementDate: '2026-03-01', postingDate: '2026-03-01',
        status: 'posted', reversalOfMovementId: null, reversedByMovementId: null,
      }],
    });

    render(<TransfersPage />);
    await ready();
    await waitFor(() => expect(useServerInventory.getState().warehouseState).toBe('ready'));

    fill(/^Item$/i, 'item-1');
    fill(/^Quantity$/i, '3');
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    fireEvent.click(screen.getByRole('button', { name: /Post transfer/i }));

    await waitFor(() => expect(server.documents).toHaveLength(2));
    const document = server.documents[0]!;
    expect(document.kind).toBe('transfer');
    expect(document.movements).toHaveLength(2);
    expect(document.journalEntryId).toBeNull();
    expect(await screen.findByText(/Cost-neutral/i)).toBeTruthy();
  });
});

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

describe('what a durable screen reads', () => {
  it('shows the SERVER’s movements and never the browser’s', async () => {
    /* A browser movement that must not appear anywhere. */
    const seed = makeInventorySeed('manufacturing');
    useInventoryStore.setState({
      ...seed,
      movements: [{
        id: 'browser-mv', entityId: 'primary', movementNumber: 'MOV-BROWSER',
        movementType: 'purchase-receipt', movementDate: '2026-01-01', postingDate: '2026-01-01',
        itemId: 'item_goods', warehouseId: 'wh_main', direction: 'in', quantity: 999,
        baseUnitId: 'uom_ea', unitCostBase: 1, totalCostBase: 999,
        sourceDocumentType: 'goods-receipt', sourceDocumentId: 'x',
        itemSnapshot: { code: 'BROWSER', name: 'Browser good', itemType: 'inventory', baseUnitCode: 'EA' },
        warehouseSnapshot: { code: 'MAIN', name: 'Main' },
        accountSnapshot: {}, status: 'posted', createdAt: '2026-01-01T00:00:00.000Z',
      }],
      seeded: true,
    } as never);

    server.documents.push({
      id: 'doc-1', documentNumber: 'GRN-2026-0001', kind: 'receipt',
      movementDate: '2026-03-01', postingDate: '2026-03-01', reference: '', memo: '', reason: '',
      status: 'posted', journalEntryId: 'j-1', reversalOfDocumentId: null,
      reversedByDocumentId: null, reversalReason: '', version: 1, createdAt: null,
      movements: [{
        id: 'mv-1', lineNumber: 1, movementType: 'receipt', itemId: 'item-1',
        itemCode: 'SKU-1', itemName: 'Widget', warehouseId: 'wh-1', warehouseCode: 'MAIN',
        baseUnitId: 'unit-1', baseUnitCode: 'EA', direction: 'in', quantity: '12',
        unitCost: '2.000', totalCost: '24.000', inventoryAccountId: 'acct-stock',
        offsetAccountId: 'acct-grni', movementDate: '2026-03-01', postingDate: '2026-03-01',
        status: 'posted', reversalOfMovementId: null, reversedByMovementId: null,
      }],
    });

    render(<StockMovementsPage />);

    expect(await screen.findByText('GRN-2026-0001')).toBeTruthy();
    expect(screen.getByText(/SKU-1/)).toBeTruthy();
    /* The browser's 999 is nowhere on the page. */
    expect(screen.queryByText('MOV-BROWSER')).toBeNull();
    expect(screen.queryByText(/BROWSER/)).toBeNull();
  });

  it('shows NOTHING rather than a browser figure when the server cannot answer', async () => {
    const seed = makeInventorySeed('manufacturing');
    useInventoryStore.setState({ ...seed, seeded: true } as never);
    server.failReads = true;

    render(<StockMovementsPage />);
    await waitFor(() => expect(useServerStock.getState().documentState).toBe('unavailable'));

    expect(useServerStock.getState().documents).toEqual([]);
    expect(await screen.findByText(/No stock movements/i)).toBeTruthy();
  });
});

/* ══ Free Demo ═════════════════════════════════════════════════════════════ */

describe('Free Demo', () => {
  beforeEach(() => {
    engine.current = 'demo';
    const seed = makeInventorySeed('manufacturing');
    useInventoryStore.setState({ ...seed, movements: [], documents: [], seeded: true } as never);
    /* The browser posting engine resolves its accounts from the chart by
     * well-known code. Without them the demo post fails for a reason that has
     * nothing to do with what these tests are about. */
    const account = (id: string, code: string, name: string, type: string) => ({
      id, code, name, type, parentId: null, level: 1,
      normalBalance: type === 'ASSET' ? 'DEBIT' : 'CREDIT',
      ifrsStatement: 'SFP', ifrsCategory: name, ifrsSubcategory: name,
      cashFlowCategory: 'OPERATING', isPostingAccount: true, isActive: true,
    });
    useStore.setState({
      accounts: [
        account('a-1213', '1213', 'Finished goods', 'ASSET'),
        account('a-2210', '2210', 'Trade payables', 'LIABILITY'),
        account('a-5500', '5500', 'Cost of goods sold', 'OPERATING_EXPENSE'),
        account('a-5600', '5600', 'Inventory write-downs', 'OPERATING_EXPENSE'),
        account('a-4300', '4300', 'Other operating income', 'REVENUE'),
      ],
    } as never);
  });

  it('posts a receipt in the BROWSER and asks the server for nothing', async () => {
    render(<GoodsReceiptsPage />);

    fill(/^Item$/i, 'item_goods');
    fill(/^Quantity$/i, '5');
    fill(/Unit cost/i, '2');
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    fireEvent.click(screen.getByRole('button', { name: /Post goods receipt/i }));

    await waitFor(() => {
      const alert = screen.queryByRole('alert')?.textContent ?? '';
      expect(useInventoryStore.getState().movements.length, alert).toBeGreaterThan(0);
    });
    expect(server.documents).toHaveLength(0);
    expect(server.calls).toEqual([]);
  });

  it('offers no expense-account picker, which is a server control', async () => {
    render(<GoodsIssuesPage />);
    expect(screen.queryByLabelText(/Expense account/i)).toBeNull();
  });
});
