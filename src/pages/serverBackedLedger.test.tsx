// @vitest-environment happy-dom
/**
 * A durable subscriber's general ledger is read, not recomputed.
 *
 * The figures that matter here are the opening balance and the period totals.
 * Computed in the browser they would be sums of whatever pages had been
 * fetched, so the closing balance would grow as the reader scrolled — every
 * figure on screen individually correct and the one at the bottom a function of
 * how far they had got. The server aggregates them over the whole range on
 * every request instead, and these tests hold the screen to that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const ledgerCall = vi.hoisted(() => ({ fn: vi.fn() }));
const bundleCall = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/services/api/reportsApi', () => ({
  reportsApi: {
    ledgerPage: (...args: unknown[]) => ledgerCall.fn(...args),
    bundle: (...args: unknown[]) => bundleCall.fn(...args),
    groupedExport: vi.fn(),
  },
}));

import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { GeneralLedgerPage } from './GeneralLedgerPage';
import { useLedgerFocus } from '@/store/ledgerFocusStore';
import type { ServerLedgerPage } from '@/services/api/reportsApi';

const ACCOUNT_ID = 'srv-account-1';
const POISON_DESCRIPTION = 'Poisoned local line';

function line(over: Record<string, unknown> = {}) {
  return {
    lineId: 'l-1', journalId: 'j-1', journalNumber: 'JE-000001',
    postingDate: '2026-06-01', transactionDate: '2026-06-01', status: 'posted',
    reference: 'INV-1', description: 'Server posting', memo: '',
    sourceType: null, sourceId: null, sourceEvent: null,
    debit: '1000.000', credit: '0.000', runningBalance: '1000.000', cursor: 'c1',
    ...over,
  };
}

function ledgerPage(over: Partial<ServerLedgerPage> = {}): ServerLedgerPage {
  return {
    account: { id: ACCOUNT_ID, code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    currency: 'JOD',
    decimals: 3,
    parameters: { accountId: ACCOUNT_ID, from: '2026-01-01', to: '2026-12-31' },
    openingBalance: '250.000',
    totals: { debit: '1000.000', credit: '0.000', movement: '1000.000', closingBalance: '1250.000', lineCount: 1 },
    lines: [line()],
    nextCursor: null,
    watermark: '2026-08-30T10:00:00Z:1',
    readAt: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  engine.current = 'server';
  ledgerCall.fn.mockReset();
  ledgerCall.fn.mockResolvedValue(ledgerPage());
  bundleCall.fn.mockReset();
  bundleCall.fn.mockResolvedValue({
    snapshot: { at: '2026-08-30T10:00:00.000Z', currency: 'JOD', decimals: 3 },
    parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    accountLedgers: [{
      accountId: ACCOUNT_ID, accountCode: '1000', accountName: 'Cash', accountType: 'asset',
      normalBalance: 'debit', openingBalance: '250.000', periodDebit: '1000.000',
      periodCredit: '0.000', netMovement: '1000.000', closingBalance: '1250.000', lineCount: 1,
    }],
    trialBalance: { rows: [], totalDebit: '0.000', totalCredit: '0.000' },
    incomeStatement: { rows: [], income: '0.000', expense: '0.000', netIncome: '0.000' },
    balanceSheet: { rows: [], assets: '0.000', liabilities: '0.000', equity: '0.000', unclosedEarnings: '0.000', balances: true },
    cashFlow: { status: 'ok', openingCash: '0.000', closingCash: '0.000', movement: '0.000' },
  });

  useStore.setState({
    settings: { ...useStore.getState().settings, companyName: 'Acme', baseCurrency: 'JOD', fiscalYearStart: '01-01' },
    accounts: [{
      id: ACCOUNT_ID, code: '1000', name: 'Cash', type: 'ASSET',
      ifrsStatement: 'FINANCIAL_POSITION', ifrsCategory: 'Current assets',
      ifrsSubcategory: 'Cash and cash equivalents', normalBalance: 'debit',
      level: 1, parentId: null, isPostable: true, active: true, currency: 'JOD',
    }] as never,
  });

  /* A cached journal that would produce completely different figures. */
  useJournalStore.setState({
    entries: [{
      id: 'local-1', entryNumber: 'JE-LOCAL', entryDate: '2026-06-02',
      postedAt: '2026-06-02T00:00:00.000Z', status: 'posted',
      description: POISON_DESCRIPTION, currency: 'JOD',
      lines: [
        { id: 'p1', lineNumber: 1, accountId: ACCOUNT_ID, accountCode: '1000', accountName: 'Cash', debit: 888888, credit: 0 },
        { id: 'p2', lineNumber: 2, accountId: ACCOUNT_ID, accountCode: '1000', accountName: 'Cash', debit: 0, credit: 888888 },
      ],
    }] as never,
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the general ledger for a durable subscriber', () => {
  it('reads the account ledger from the server, never from the cached journal', async () => {
    /* The same path the Trial Balance drill-down uses to open an account. */
    act(() => {
      useLedgerFocus.getState().requestLedgerFocus({ accountId: ACCOUNT_ID, from: '2026-01-01', to: '2026-12-31' });
    });
    render(<GeneralLedgerPage />);

    await waitFor(() => expect(ledgerCall.fn).toHaveBeenCalled());

    /* The server's opening balance and closing balance, at its precision. */
    await waitFor(() => expect(screen.getByText('250.000')).toBeTruthy());
    expect(screen.getByText('1,250.000')).toBeTruthy();

    /* Nothing derived from the poisoned cache reached the screen. */
    expect(screen.queryByText(new RegExp(POISON_DESCRIPTION, 'i'))).toBeNull();
    expect(screen.queryByText(/888,888/)).toBeNull();
  });

  it('asks the server for the ledger rather than computing one', async () => {
    act(() => {
      useLedgerFocus.getState().requestLedgerFocus({ accountId: ACCOUNT_ID, from: '2026-01-01', to: '2026-12-31' });
    });
    render(<GeneralLedgerPage />);

    await waitFor(() => expect(ledgerCall.fn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID }),
    ));
  });

  it('serves the multi-account view from the bundle, with no expand-all fan-out', async () => {
    render(<GeneralLedgerPage />);

    fireEvent.click(screen.getByText(/Multi-account/i));

    /* Collapsed rows come from the bundle the screen already fetched. */
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());
    expect(screen.getByText('1,250.000')).toBeTruthy();

    /* Listing the chart cost one bundle request and no per-account reads. */
    expect(bundleCall.fn).toHaveBeenCalledTimes(1);
    expect(ledgerCall.fn).not.toHaveBeenCalled();

    /* And nothing offers to open every account at once. */
    expect(screen.queryByText(/Expand all/i)).toBeNull();

    /* The cached journal is not rendered as a substitute for any of it. */
    expect(screen.queryByText(new RegExp(POISON_DESCRIPTION, 'i'))).toBeNull();
  });
});
