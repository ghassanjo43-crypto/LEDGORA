// @vitest-environment happy-dom
/**
 * The Fixed Assets screens a durable subscriber actually uses.
 *
 * ══ Why these go through `fetch` ═════════════════════════════════════════════
 *
 * A gateway test proves the adapter; it does not prove a durable subscriber can
 * keep an asset register. So these render the REAL pages, click the REAL
 * buttons and fill in the REAL drawers, and everything below them — the page
 * handler, the gateway, the API client, the URL, the method, the body and the
 * error mapping — runs unmocked against an in-memory server standing at the
 * `fetch` boundary.
 *
 * ══ And what they prove is NOT there ═════════════════════════════════════════
 *
 * No cost column, no accumulated depreciation, no net book value, no
 * reconciliation. Registering an asset must not make a posting available
 * anywhere, and clearing browser storage must not touch a durable register.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

import { FixedAssetCategoriesPage } from './fixedAssets/FixedAssetCategoriesPage';
import { FixedAssetRegisterPage } from './fixedAssets/FixedAssetRegisterPage';
import { FixedAssetsReportsPage } from './fixedAssets/FixedAssetsReportsPage';
import { FixedAssetsDepreciationPage } from './fixedAssets/FixedAssetsDepreciationPage';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { useStore } from '@/store/useStore';
import {
  clearFixedAssetCache, useServerFixedAssets,
} from '@/services/fixedAssets/fixedAssetsBackend';
import { clearSupplierCache } from '@/services/parties/supplierDirectory';
import { server, resetServer, install, FAKE_ACCOUNTS } from './__fixtures__/fixedAssetsFakeServer';

const realFetch = globalThis.fetch;

/** The chart the pickers narrow, in the browser's own `Account` shape. */
const accounts = FAKE_ACCOUNTS.map((a) => ({
  id: a.id,
  code: a.code,
  name: a.name,
  type: a.type,
  parentId: null,
  level: 0,
  normalBalance: a.normalBalance,
  ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION',
  ifrsCategory: '',
  ifrsSubcategory: '',
  cashFlowCategory: 'NOT_APPLICABLE',
  cashClassification: 'none',
  isPostingAccount: true,
  isActive: true,
  isBlocked: false,
  isArchived: false,
  description: '',
  industryTag: 'general',
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
}));

beforeEach(() => {
  engine.current = 'server';
  /* The suite is hermetic by default (`VITE_API_URL: ''`), which makes the
   * client refuse before it reaches `fetch`. These tests are about the request
   * actually travelling, so they configure a base the fake server answers. */
  vi.stubEnv('VITE_API_URL', 'http://localhost:3000');
  resetServer();
  install();
  clearFixedAssetCache();
  clearSupplierCache();
  useFixedAssetStore.setState({
    categories: [], assets: [], transactions: [], runs: [], auditTrail: [], seeded: false,
  } as never);
  useStore.setState({ accounts } as never);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Wait for the register to finish its first load. */
async function categoriesReady(): Promise<void> {
  await waitFor(() => expect(useServerFixedAssets.getState().categoryState).toBe('ready'));
}
async function assetsReady(): Promise<void> {
  await waitFor(() => expect(useServerFixedAssets.getState().assetState).toBe('ready'));
}

function fill(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** A category on the fake server, without going through the screen. */
function seedCategory(over: Record<string, unknown> = {}): string {
  const id = `cat-seed-${server.categories.length + 1}`;
  server.categories.push({
    id,
    code: 'MACH',
    name: 'Machinery',
    description: '',
    defaultMethod: 'straight_line',
    defaultUsefulLifeMonths: 120,
    defaultResidualPercent: '5',
    depreciationConvention: 'full_month',
    assetCostAccountId: 'acc-cost',
    accumulatedDepreciationAccountId: 'acc-accum',
    depreciationExpenseAccountId: 'acc-expense',
    status: 'active',
    version: 1,
    ...over,
  } as never);
  return id;
}

/* ══ Categories ════════════════════════════════════════════════════════════ */

describe('a durable subscriber keeps asset categories through the screen', () => {
  it('creates one on the SERVER, not in the browser', async () => {
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();

    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    await screen.findByLabelText(/^Code/i);

    fill(/^Code/i, 'MACH');
    fill(/^Name/i, 'Machinery');
    fill(/Default useful life/i, '120');
    fireEvent.change(screen.getByLabelText(/Fixed asset cost/i), {
      target: { value: 'acc-cost' },
    });
    fireEvent.change(screen.getByLabelText(/Accumulated depreciation/i), {
      target: { value: 'acc-accum' },
    });
    fireEvent.change(screen.getByLabelText(/Depreciation expense/i), {
      target: { value: 'acc-expense' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save category/i }));

    await waitFor(() => expect(server.categories).toHaveLength(1));
    expect(server.categories[0]!.code).toBe('MACH');
    expect(server.categories[0]!.defaultUsefulLifeMonths).toBe(120);

    /* And nowhere near the browser store. */
    expect(useFixedAssetStore.getState().categories).toHaveLength(0);

    expect(server.calls).toContainEqual({
      method: 'POST', path: '/api/fixed-assets/categories',
    });
  });

  it('offers only the accounts each role can legally take', async () => {
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    await screen.findByLabelText(/^Code/i);

    const cost = screen.getByLabelText(/Fixed asset cost/i) as HTMLSelectElement;
    const accum = screen.getByLabelText(/Accumulated depreciation/i) as HTMLSelectElement;
    const expense = screen.getByLabelText(/Depreciation expense/i) as HTMLSelectElement;

    const values = (el: HTMLSelectElement) =>
      [...el.options].map((o) => o.value).filter(Boolean);

    /* The contra-asset is offered for accumulated depreciation and NOWHERE
     * else; the debit-balance asset is offered for cost and nowhere else. */
    expect(values(cost)).toEqual(['acc-cost']);
    expect(values(accum)).toEqual(['acc-accum']);
    expect(values(expense)).toEqual(['acc-expense']);
  });

  it('shows the SERVER’s duplicate-code refusal, in its own words', async () => {
    seedCategory();
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();

    fireEvent.click(screen.getByRole('button', { name: /New category/i }));
    await screen.findByLabelText(/^Code/i);
    fill(/^Code/i, 'mach');
    fill(/^Name/i, 'Machinery again');
    fireEvent.click(screen.getByRole('button', { name: /Save category/i }));

    expect(await screen.findByText(/already used in these books/i)).toBeTruthy();
    expect(screen.getByText(/without regard to case/i)).toBeTruthy();
    expect(server.categories).toHaveLength(1);
  });

  it('carries the version the server last returned, and shows a stale refusal', async () => {
    const id = seedCategory();
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();

    /* Somebody else saves first. */
    server.categories.find((c) => c.id === id)!.version = 7;

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/i })[0]!);
    await screen.findByLabelText(/^Code/i);
    fill(/^Name/i, 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: /Save category/i }));

    expect(await screen.findByText(/changed by another user/i)).toBeTruthy();
  });

  it('archives through the server, and refuses when assets still need it', async () => {
    const id = seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Lathe', description: '',
      categoryId: id, acquisitionDate: '2026-03-01', depreciationStartDate: null,
      depreciationMethod: 'straight_line', usefulLifeMonths: 120, residualValue: '0',
      quantity: 1, location: '', custodian: '', branch: '', department: '',
      supplierPartyId: null, purchaseReference: '', notes: '', status: 'draft', version: 1,
    } as never);

    render(<FixedAssetCategoriesPage />);
    await categoriesReady();

    fireEvent.click(screen.getByRole('button', { name: /^Archive$/i }));
    expect(await screen.findByText(/still has 1 asset\(s\)/i)).toBeTruthy();
    expect(server.categories[0]!.status).toBe('active');
  });

  it('offers ARCHIVE rather than delete', async () => {
    seedCategory();
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();

    expect(screen.getByRole('button', { name: /^Archive$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete$/i })).toBeNull();
  });

  it('reads the audit history from the server', async () => {
    const id = seedCategory();
    server.audit.push({
      id: 'aud-1', subjectType: 'category', subjectId: id, action: 'CATEGORY_UPDATED',
      previousVersion: 1, resultingVersion: 2, reason: '',
      detail: {
        before: { default_useful_life_months: 999 },
        after: { default_useful_life_months: 111 },
      },
      actorName: 'Someone Else', occurredAt: '2026-01-01T00:00:00.000Z',
    } as never);

    render(<FixedAssetCategoriesPage />);
    await categoriesReady();
    fireEvent.click(screen.getByRole('button', { name: /^History$/i }));

    expect(await screen.findByText(/Category updated/i)).toBeTruthy();
    /* Before AND after: "it changed" is a notification, not a history. */
    expect(screen.getByText('999')).toBeTruthy();
    expect(screen.getByText('111')).toBeTruthy();
    expect(screen.getByText(/Someone Else/)).toBeTruthy();
  });

  it('says which mappings it does NOT ask for, rather than silently dropping them', async () => {
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();
    expect(screen.getByText(/Mappings this release does not ask for/i)).toBeTruthy();
    expect(screen.getByText(/Impairment loss, accumulated impairment/i)).toBeTruthy();
  });
});

/* ══ The register ══════════════════════════════════════════════════════════ */

describe('a durable subscriber keeps an asset register through the screen', () => {
  it('registers an asset on the SERVER, with an allocated code', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);

    fill(/^Name/i, 'Lathe');
    fireEvent.click(screen.getByRole('button', { name: /Register asset/i }));

    await waitFor(() => expect(server.assets).toHaveLength(1));
    expect(server.assets[0]!.name).toBe('Lathe');
    /* Allocated by the server, not chosen by the browser. */
    expect(server.assets[0]!.assetCode).toBe('AST-0001');
    expect(useFixedAssetStore.getState().assets).toHaveLength(0);
  });

  it('copies the category policy onto the draft, and sends what was saved', async () => {
    seedCategory({ defaultUsefulLifeMonths: 84 });
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);

    /* Pre-filled FROM the category — the value a bookkeeper sees before typing. */
    expect((screen.getByLabelText(/Useful life \(months\)/i) as HTMLInputElement).value)
      .toBe('84');

    fill(/^Name/i, 'Press');
    fireEvent.click(screen.getByRole('button', { name: /Register asset/i }));

    await waitFor(() => expect(server.assets).toHaveLength(1));
    expect(server.assets[0]!.usefulLifeMonths).toBe(84);
  });

  it('sends a residual value as an exact STRING, never through a float', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);
    fill(/^Name/i, 'Lathe');
    fill(/Residual value/i, '1250.125');
    fireEvent.click(screen.getByRole('button', { name: /Register asset/i }));

    await waitFor(() => expect(server.assets).toHaveLength(1));
    /* The third place is still there. A JOD residual that lost it would be
     * frozen onto the asset the moment F2 capitalised it. */
    expect(server.assets[0]!.residualValue).toBe('1250.125');
  });

  it('archives and reactivates through the server, and calls it archive not disposal', async () => {
    seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Lathe', description: '',
      categoryId: server.categories[0]!.id, acquisitionDate: '2026-03-01',
      depreciationStartDate: null, depreciationMethod: 'straight_line', usefulLifeMonths: 120,
      residualValue: '0', quantity: 1, location: '', custodian: '', branch: '', department: '',
      supplierPartyId: null, purchaseReference: '', notes: '', status: 'draft', version: 1,
    } as never);

    render(<FixedAssetRegisterPage />);
    await assetsReady();

    expect(screen.queryByRole('button', { name: /Dispose|Sell/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Archive$/i }));
    await waitFor(() => expect(server.assets[0]!.status).toBe('archived'));

    expect(await screen.findByRole('button', { name: /^Reactivate$/i })).toBeTruthy();
  });

  it('shows an archived asset by default — the register does not hide history', async () => {
    seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Old lathe', description: '',
      categoryId: server.categories[0]!.id, acquisitionDate: '2026-03-01',
      depreciationStartDate: null, depreciationMethod: 'straight_line', usefulLifeMonths: 120,
      residualValue: '0', quantity: 1, location: '', custodian: '', branch: '', department: '',
      supplierPartyId: null, purchaseReference: '', notes: '', status: 'archived', version: 1,
    } as never);

    render(<FixedAssetRegisterPage />);
    await assetsReady();
    expect(screen.getByText('Old lathe')).toBeTruthy();
    expect(screen.getByText('archived')).toBeTruthy();
  });

  it('searches the SERVER rather than filtering a stale page', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();
    server.calls.length = 0;

    fireEvent.change(screen.getByLabelText(/Search assets/i), { target: { value: 'lathe' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search$/i }));

    await waitFor(() => expect(
      server.calls.some((c) => c.path === '/api/fixed-assets/assets'),
    ).toBe(true));
    expect(useServerFixedAssets.getState().assetSearch).toBe('lathe');
  });
});

/* ══ What F1 deliberately does not show ════════════════════════════════════ */

describe('what this release deliberately does not show', () => {
  it('shows NO cost, accumulated depreciation or net book value column', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    /*
     * Not "shows zero" — shows NOTHING. A zero in a Cost column is a figure
     * somebody reconciles against a balance sheet.
     */
    expect(screen.queryByText(/^Cost$/i)).toBeNull();
    expect(screen.queryByText(/Accum\. dep\./i)).toBeNull();
    expect(screen.queryByText(/Net book value/i)).toBeNull();
    expect(screen.queryByText(/^Impairment$/i)).toBeNull();
  });

  it('says the register holds no accounting, in so many words', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();
    expect(screen.getByText(/Register only — no accounting yet/i)).toBeTruthy();
    expect(screen.getByText(/no acquisition cost, no accumulated depreciation/i)).toBeTruthy();
  });

  it('offers no capitalisation, depreciation, impairment, revaluation or disposal action', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    for (const label of [/Capitalize/i, /Impair/i, /Revalue/i, /Dispose/i, /Transfer/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('explains each deferred workflow rather than leaving a blank screen', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    expect(screen.getByText(/Capitalisation and acquisition cost/i)).toBeTruthy();
    expect(screen.getByText(/Depreciation schedules, runs and posting/i)).toBeTruthy();
    expect(screen.getAllByText(/Disposal, sale, write-off and retirement/i).length)
      .toBeGreaterThan(0);
    expect(screen.getByText(/Buying an asset on a supplier bill/i)).toBeTruthy();
  });

  it('asks the server for no cost, depreciation, schedule or posting route', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    const paths = server.calls.map((c) => c.path).join(' ');
    expect(paths).not.toMatch(/capitalize|depreciat|schedule|impair|revalue|dispose|transfer/i);
  });

  it('shows the depreciation page as deferred, and never a run list', async () => {
    render(<FixedAssetsDepreciationPage />);
    expect(await screen.findByText(/Depreciation runs are not available yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Preview|Post run/i })).toBeNull();
  });
});

/* ══ Reports ═══════════════════════════════════════════════════════════════ */

describe('the register report', () => {
  it('reports counts and refuses to claim a reconciliation', async () => {
    seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Lathe', description: '',
      categoryId: server.categories[0]!.id, acquisitionDate: '2026-03-01',
      depreciationStartDate: null, depreciationMethod: 'straight_line', usefulLifeMonths: 120,
      residualValue: '0', quantity: 3, location: '', custodian: '', branch: '', department: '',
      supplierPartyId: null, purchaseReference: '', notes: '', status: 'draft', version: 1,
    } as never);

    render(<FixedAssetsReportsPage />);
    await waitFor(() => expect(useServerFixedAssets.getState().reportState).toBe('ready'));

    expect(screen.getByText(/Register figures, not ledger balances/i)).toBeTruthy();
    expect(screen.getByText(/do not reconcile/i)).toBeTruthy();
    expect(screen.getByText('Register by category')).toBeTruthy();

    /*
     * Counts, and no reconciliation. The deferred panel names depreciation, so
     * the word appears — what must not appear is a claim that the register ties
     * to the ledger, or any carrying amount to tie with.
     */
    expect(screen.queryByText(/Reconciliation/i)).toBeNull();
    expect(screen.queryByText(/Net book value/i)).toBeNull();
    expect(screen.queryByText(/Accumulated depreciation/i)).toBeNull();
  });

  it('lists the configuration that would stop depreciation', async () => {
    seedCategory({ accumulatedDepreciationAccountId: null });
    render(<FixedAssetsReportsPage />);
    await waitFor(() => expect(useServerFixedAssets.getState().reportState).toBe('ready'));

    expect(screen.getByText(/Configuration that would stop depreciation/i)).toBeTruthy();
    expect(screen.getByText(/incomplete account mappings/i)).toBeTruthy();
  });
});

/* ══ The census, and durability ════════════════════════════════════════════ */

describe('records left in this browser', () => {
  it('COUNTS them instead of importing them, and says why', async () => {
    seedCategory();
    useFixedAssetStore.setState({
      assets: [{ id: 'local-1', assetCode: 'OLD-1', name: 'Browser lathe' }],
      categories: [{ id: 'local-cat', code: 'OLD', name: 'Browser category' }],
    } as never);

    render(<FixedAssetRegisterPage />);
    await assetsReady();

    expect(screen.getByText(/Fixed assets left in this browser/i)).toBeTruthy();
    expect(screen.getByText(/1 asset\(s\) and 1 category\(ies\)/i)).toBeTruthy();
    expect(screen.getByText(/cannot be imported automatically/i)).toBeTruthy();

    /* Counted, and NOT sent. */
    expect(server.assets).toHaveLength(0);
    expect(server.categories).toHaveLength(1);
  });

  it('loses nothing when browser storage is cleared: the register is on the server', async () => {
    seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Durable lathe', description: '',
      categoryId: server.categories[0]!.id, acquisitionDate: '2026-03-01',
      depreciationStartDate: null, depreciationMethod: 'straight_line', usefulLifeMonths: 120,
      residualValue: '0', quantity: 1, location: '', custodian: '', branch: '', department: '',
      supplierPartyId: null, purchaseReference: '', notes: '', status: 'draft', version: 1,
    } as never);

    render(<FixedAssetRegisterPage />);
    await assetsReady();
    expect(screen.getByText('Durable lathe')).toBeTruthy();

    cleanup();
    /* Everything the browser holds, gone. */
    globalThis.localStorage?.clear();
    useFixedAssetStore.setState({
      categories: [], assets: [], transactions: [], runs: [], auditTrail: [], seeded: false,
    } as never);
    clearFixedAssetCache();

    render(<FixedAssetRegisterPage />);
    await assetsReady();
    expect(screen.getByText('Durable lathe')).toBeTruthy();
    expect(server.assets).toHaveLength(1);
  });

  it('shows NOTHING rather than a browser figure when the server is unreachable', async () => {
    seedCategory();
    useFixedAssetStore.setState({
      assets: [{ id: 'local-1', assetCode: 'OLD-1', name: 'Browser lathe' }],
    } as never);

    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;

    render(<FixedAssetRegisterPage />);
    await waitFor(() => expect(useServerFixedAssets.getState().assetState).toBe('unavailable'));

    /* The browser asset must NOT appear. A register that fell back would show
     * somebody a list their books have never seen. */
    expect(screen.queryByText('Browser lathe')).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it('never writes to the browser store when a save fails', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);

    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;

    fill(/^Name/i, 'Never saved');
    fireEvent.click(screen.getByRole('button', { name: /Register asset/i }));

    /* The client's own network sentence, not a raw exception message. */
    await screen.findByText(/Could not reach the LEDGORA service/i);
    expect(useFixedAssetStore.getState().assets).toHaveLength(0);
    expect(server.assets).toHaveLength(0);
  });
});

/* ══ Free Demo ═════════════════════════════════════════════════════════════ */

describe('Free Demo', () => {
  beforeEach(() => {
    engine.current = 'demo';
  });

  it('keeps its local workbench, and asks the server for nothing', async () => {
    render(<FixedAssetRegisterPage />);
    /* The demo module seeds its own categories from the local chart. */
    await waitFor(() => expect(useFixedAssetStore.getState().seeded).toBe(true));

    expect(server.calls).toHaveLength(0);
    expect(server.assets).toHaveLength(0);
  });

  it('still offers the posting workbench, which only the demo engine can do', async () => {
    useFixedAssetStore.setState({ seeded: true, categories: [] } as never);
    render(<FixedAssetRegisterPage />);
    /* The demo register shows the columns a posting engine fills in. */
    expect(await screen.findByText(/Accumulated depreciation/i)).toBeTruthy();
    expect(screen.getByText(/Net book value/i)).toBeTruthy();
  });

  it('still offers its depreciation runs', async () => {
    useFixedAssetStore.setState({ seeded: true } as never);
    render(<FixedAssetsDepreciationPage />);
    expect(screen.queryByText(/Depreciation runs are not available yet/i)).toBeNull();
  });

  it('keeps its category editor with all eleven mappings', async () => {
    useFixedAssetStore.setState({ seeded: true, categories: [] } as never);
    render(<FixedAssetCategoriesPage />);
    fireEvent.click(screen.getByRole('button', { name: /New category/i }));

    const drawer = await screen.findByText(/Accounting mappings \(chart of accounts\)/i);
    expect(drawer).toBeTruthy();
    expect(screen.getByText(/Impairment loss/i)).toBeTruthy();
    expect(screen.getByText(/Revaluation surplus/i)).toBeTruthy();
    expect(server.calls).toHaveLength(0);
  });
});

/* ══ The bill boundary ═════════════════════════════════════════════════════ */

describe('the acquisition boundary', () => {
  it('never offers to create an asset from a bill', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    expect(screen.queryByRole('button', { name: /from a bill|from bill/i })).toBeNull();
    expect(server.calls.map((c) => c.path)).not.toContain('/api/fixed-assets/assets/from-bill');
  });

  it('explains that a supplier on an asset links no document', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();

    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);

    expect(screen.getByText(/Links no bill and posts nothing/i)).toBeTruthy();
  });
});

/* ══ Detail and history ════════════════════════════════════════════════════ */

describe('the asset detail', () => {
  it('states that no accounting exists rather than showing zeros', async () => {
    seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Lathe', description: '',
      categoryId: server.categories[0]!.id, acquisitionDate: '2026-03-01',
      depreciationStartDate: null, depreciationMethod: 'straight_line', usefulLifeMonths: 120,
      residualValue: '500.000', quantity: 1, location: 'Shop floor', custodian: 'Ali',
      branch: '', department: '', supplierPartyId: null, purchaseReference: '', notes: '',
      status: 'draft', version: 1,
    } as never);

    render(<FixedAssetRegisterPage />);
    await assetsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Open$/i }));

    expect(await screen.findByText(/No accounting for this asset yet/i)).toBeTruthy();
    expect(screen.getByText(/has 0 posted accounting entries/i)).toBeTruthy();

    /* The policy it froze, and the unit it is measured in. */
    expect(screen.getByText('120 months')).toBeTruthy();
    expect(screen.getByText('Full month')).toBeTruthy();
    expect(screen.getByText('500.000')).toBeTruthy();
  });

  it('shows the server-held history inside the detail', async () => {
    seedCategory();
    server.assets.push({
      id: 'ast-1', assetCode: 'AST-0001', name: 'Lathe', description: '',
      categoryId: server.categories[0]!.id, acquisitionDate: '2026-03-01',
      depreciationStartDate: null, depreciationMethod: 'straight_line', usefulLifeMonths: 120,
      residualValue: '0', quantity: 1, location: '', custodian: '', branch: '', department: '',
      supplierPartyId: null, purchaseReference: '', notes: '', status: 'draft', version: 1,
    } as never);
    server.audit.push({
      id: 'aud-1', subjectType: 'asset', subjectId: 'ast-1', action: 'ASSET_REGISTERED',
      previousVersion: null, resultingVersion: 1, reason: '', detail: {},
      actorName: 'Registrar', occurredAt: '2026-01-01T00:00:00.000Z',
    } as never);

    render(<FixedAssetRegisterPage />);
    await assetsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Open$/i }));

    expect(await screen.findByText(/Asset registered/i)).toBeTruthy();
    expect(screen.getByText(/Registrar/)).toBeTruthy();
    expect(server.calls).toContainEqual({
      method: 'GET', path: '/api/fixed-assets/assets/ast-1/history',
    });
  });
});

/* ══ Refused methods, end to end ═══════════════════════════════════════════ */

describe('unsupported depreciation methods', () => {
  it('offers only straight line and none in the pickers', async () => {
    seedCategory();
    render(<FixedAssetRegisterPage />);
    await assetsReady();
    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);

    const method = screen.getByLabelText(/Depreciation method/i) as HTMLSelectElement;
    expect([...method.options].map((o) => o.value)).toEqual(['straight_line', 'none']);
  });

  it('surfaces the SERVER’s named refusal if one is somehow sent', async () => {
    render(<FixedAssetCategoriesPage />);
    await categoriesReady();

    /* Not reachable through the picker; this proves the refusal survives the
     * whole client stack and reaches the screen in the server's own words. */
    const { categoryGateway } = await import('@/services/fixedAssets/fixedAssetsBackend');
    await expect(categoryGateway.create({
      code: 'VEH', name: 'Vehicles', defaultMethod: 'reducing_balance',
    })).rejects.toThrow(/Reducing balance is not available yet/);

    expect(server.categories).toHaveLength(0);
  });
});

/* ══ Nothing is a journal ══════════════════════════════════════════════════ */

describe('no journal, ever', () => {
  it('never posts a voucher through the browser journal store', async () => {
    seedCategory();
    const { useJournalStore } = await import('@/store/journalStore');
    const before = useJournalStore.getState().entries.length;

    render(<FixedAssetRegisterPage />);
    await assetsReady();
    fireEvent.click(screen.getByRole('button', { name: /New asset/i }));
    await screen.findByLabelText(/^Name/i);
    fill(/^Name/i, 'Lathe');
    fireEvent.click(screen.getByRole('button', { name: /Register asset/i }));

    await waitFor(() => expect(server.assets).toHaveLength(1));
    expect(useJournalStore.getState().entries).toHaveLength(before);
    expect(useFixedAssetStore.getState().transactions).toHaveLength(0);
    expect(useFixedAssetStore.getState().runs).toHaveLength(0);
  });
});
