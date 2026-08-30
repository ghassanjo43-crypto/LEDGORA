// @vitest-environment happy-dom
/**
 * A durable subscriber's statements come from the server, and from nowhere else.
 *
 * ══ The defect these guard against ═══════════════════════════════════════════
 *
 * The books moved to PostgreSQL, but the four statement screens kept deriving
 * their figures in the browser from the cached chart and journal. That cache is
 * filled by TWO separate requests, so a statement built from it is built from
 * two snapshots — and worse, it is a second opinion about the books. Two
 * opinions is one too many: when they disagree, nothing on the screen says
 * which one the business is expected to file.
 *
 * So each test below poisons the browser caches with a figure that could only
 * come from local computation, and asserts it never reaches the screen while
 * the server's figures do. A test that merely checked the server number was
 * displayed would pass even if the local one were displayed beside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

/* The engine verdict is the switch under test; every case here is a durable
 * subscriber unless it says otherwise. */
const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const bundleCall = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/services/api/reportsApi', () => ({
  reportsApi: { bundle: (...args: unknown[]) => bundleCall.fn(...args) },
}));

import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { TrialBalancePage } from './TrialBalancePage';
import { IncomeStatementPage } from './IncomeStatementPage';
import { BalanceSheetPage } from './BalanceSheetPage';
import { CashFlowStatementPage } from './CashFlowStatementPage';
import type { ServerReportBundle } from '@/services/api/reportsApi';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** A figure that exists ONLY on the server. Seeing it proves the source. */
const SERVER_ONLY_ACCOUNT = 'Server Cash Account';
const SERVER_TOTAL = '1234567.891';

/** A figure that exists ONLY in the browser cache. Seeing it is the bug. */
const POISON_ACCOUNT = 'Poisoned Local Account';

function account(over: Record<string, unknown> = {}) {
  return {
    accountId: 'a-1',
    accountCode: '1000',
    accountName: SERVER_ONLY_ACCOUNT,
    accountType: 'asset',
    accountSubtype: null,
    presentationType: 'cash_and_cash_equivalents',
    ifrsStatement: 'FINANCIAL_POSITION',
    ifrsCategory: 'Current assets',
    ifrsSubcategory: 'Cash and cash equivalents',
    cashFlowCategory: 'operating',
    cashClassification: 'cash_and_cash_equivalents',
    parentAccountId: null,
    isPostable: true,
    amount: SERVER_TOTAL,
    rollup: SERVER_TOTAL,
    ...over,
  };
}

function bundle(over: Partial<ServerReportBundle> = {}): ServerReportBundle {
  return {
    snapshot: { at: '2026-08-30T10:00:00.000Z', currency: 'JOD', decimals: 3 },
    parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    accountLedgers: [{
      accountId: 'a-1', accountCode: '1000', accountName: SERVER_ONLY_ACCOUNT,
      accountType: 'asset', normalBalance: 'debit',
      openingBalance: '0.000', periodDebit: SERVER_TOTAL, periodCredit: '0.000',
      netMovement: SERVER_TOTAL, closingBalance: SERVER_TOTAL, lineCount: 1,
    }],
    trialBalance: {
      rows: [{ ...account(), debit: SERVER_TOTAL, credit: '0.000', debitRollup: SERVER_TOTAL, creditRollup: '0.000' }],
      totalDebit: SERVER_TOTAL,
      totalCredit: SERVER_TOTAL,
    },
    incomeStatement: {
      rows: [account({ accountId: 'a-2', accountCode: '4000', accountType: 'income' })],
      income: SERVER_TOTAL, expense: '0.000', netIncome: SERVER_TOTAL,
    },
    balanceSheet: {
      rows: [account()],
      assets: SERVER_TOTAL, liabilities: '0.000', equity: '0.000',
      unclosedEarnings: '0.000', balances: true,
    },
    cashFlow: { status: 'ok', openingCash: '0.000', closingCash: SERVER_TOTAL, movement: SERVER_TOTAL },
    ...over,
  };
}

/**
 * Fill the browser caches with a chart and a journal that would produce a
 * completely different statement if anything still computed one locally.
 */
function poisonTheCaches(): void {
  useStore.setState({
    accounts: [{
      id: 'local-1', code: '9999', name: POISON_ACCOUNT, type: 'ASSET',
      ifrsStatement: 'FINANCIAL_POSITION', ifrsCategory: 'Current assets',
      ifrsSubcategory: 'Cash and cash equivalents', normalBalance: 'debit',
      level: 1, parentId: null, isPostable: true, active: true, currency: 'JOD',
    }] as never,
  });
  useJournalStore.setState({
    entries: [{
      id: 'local-entry-1',
      entryNumber: 'JE-LOCAL',
      entryDate: '2026-06-01',
      postedAt: '2026-06-01T00:00:00.000Z',
      status: 'posted',
      description: 'Poison',
      currency: 'JOD',
      lines: [
        { id: 'l1', lineNumber: 1, accountId: 'local-1', accountCode: '9999', accountName: POISON_ACCOUNT, debit: 999999, credit: 0 },
        { id: 'l2', lineNumber: 2, accountId: 'local-1', accountCode: '9999', accountName: POISON_ACCOUNT, debit: 0, credit: 999999 },
      ],
    }] as never,
  });
}

beforeEach(() => {
  engine.current = 'server';
  bundleCall.fn.mockReset();
  bundleCall.fn.mockResolvedValue(bundle());
  useStore.setState({
    settings: {
      ...useStore.getState().settings,
      companyName: 'Acme Trading', baseCurrency: 'JOD', fiscalYearStart: '01-01',
    },
  });
  poisonTheCaches();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ══ Every statement screen reads the server, and only the server ══════════ */

const SCREENS = [
  { name: 'Trial Balance', Page: TrialBalancePage },
  { name: 'Income Statement', Page: IncomeStatementPage },
  { name: 'Balance Sheet', Page: BalanceSheetPage },
  { name: 'Cash Movement Summary', Page: CashFlowStatementPage },
] as const;

describe('a durable subscriber never sees a locally computed figure', () => {
  for (const { name, Page } of SCREENS) {
    it(`${name} renders the server bundle and not the browser cache`, async () => {
      render(<Page />);

      /* It asked the server exactly once, for one bundle. */
      await waitFor(() => expect(bundleCall.fn).toHaveBeenCalledTimes(1));

      /* The poisoned local account must not appear ANYWHERE on the screen. If
       * it does, some calculator is still reading the cache. */
      await waitFor(() => {
        expect(screen.queryByText(new RegExp(POISON_ACCOUNT, 'i'))).toBeNull();
      });
      expect(screen.queryByText(/999,999/)).toBeNull();
    });
  }

  it('the trial balance shows the server figure at the server precision', async () => {
    render(<TrialBalancePage />);
    /* Grouped as a string, three decimals, exactly as PostgreSQL rounded it —
     * never re-derived through a float. */
    await waitFor(() => expect(screen.getAllByText('1,234,567.891').length).toBeGreaterThan(0));
    expect(screen.getByText(SERVER_ONLY_ACCOUNT)).toBeTruthy();
  });

  it('a demo workspace still computes locally and asks the server for nothing', async () => {
    engine.current = 'demo';
    render(<TrialBalancePage />);

    await waitFor(() => expect(screen.queryByText(/Reading these statements/i)).toBeNull());
    /* Free Demo has no server books; a request would be meaningless. */
    expect(bundleCall.fn).not.toHaveBeenCalled();
  });
});

/* ══ The states the screens must have ══════════════════════════════════════ */

describe('server-backed report states', () => {
  it('says it is loading before the first answer arrives', async () => {
    let release: (value: ServerReportBundle) => void = () => {};
    bundleCall.fn.mockReturnValue(new Promise<ServerReportBundle>((resolve) => { release = resolve; }));

    render(<TrialBalancePage />);
    expect(screen.getByRole('status')).toBeTruthy();

    release(bundle());
    await waitFor(() => expect(screen.getByText(SERVER_ONLY_ACCOUNT)).toBeTruthy());
  });

  it('shows the SERVER’s own words when it refuses to produce a statement', async () => {
    /* The server refuses an unbalanced statement rather than returning one.
     * That refusal is the message a bookkeeper needs; paraphrasing it as
     * "could not load reports" would hide the only useful detail. */
    bundleCall.fn.mockRejectedValue(new Error('Debits do not equal credits for this period.'));

    render(<TrialBalancePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Debits do not equal credits');
    });
  });

  it('reports cash accounts that are not configured, rather than inventing cash', async () => {
    bundleCall.fn.mockResolvedValue(bundle({
      cashFlow: {
        status: 'cash_accounts_not_configured',
        reason: 'No account carries a cash classification.',
      },
    }));

    render(<CashFlowStatementPage />);

    await waitFor(() => {
      expect(screen.getByText(/No cash accounts are configured/i)).toBeTruthy();
    });
    expect(screen.getByText(/No account carries a cash classification/i)).toBeTruthy();
  });

  it('shows the cash movement summary the server computed', async () => {
    render(<CashFlowStatementPage />);
    await waitFor(() => expect(screen.getByText(/Movement in the period/i)).toBeTruthy());
    expect(screen.getAllByText('1,234,567.891').length).toBeGreaterThan(0);
  });
});
