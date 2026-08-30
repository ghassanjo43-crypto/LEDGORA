// @vitest-environment happy-dom
/**
 * The multi-account ledger, for a durable subscriber.
 *
 * ══ The three claims ═════════════════════════════════════════════════════════
 *
 * 1. The collapsed figures are the SERVER's. Summed in the browser from the
 *    lines it happens to hold, an opening balance becomes a function of what has
 *    been loaded — so the cache is poisoned here with figures that would show up
 *    instantly if anything still computed one.
 *
 * 2. Listing the chart costs ONE request, and no control can turn expansion into
 *    a request per account. The local version's "Expand all" was free because
 *    every line was already in memory; the same button against the server would
 *    fan out across the whole chart.
 *
 * 3. An account opened later is a SEPARATE read with its own watermark, and says
 *    so. Presenting those lines as part of the earlier bundle snapshot would be
 *    a quiet lie about when the books were seen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const calls = vi.hoisted(() => ({ bundle: vi.fn(), ledgerPage: vi.fn(), groupedExport: vi.fn() }));
vi.mock('@/services/api/reportsApi', () => ({
  reportsApi: {
    bundle: (...a: unknown[]) => calls.bundle(...a),
    ledgerPage: (...a: unknown[]) => calls.ledgerPage(...a),
    groupedExport: (...a: unknown[]) => calls.groupedExport(...a),
  },
}));

const downloaded = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  downloadFile: (...a: unknown[]) => downloaded.fn(...a),
}));

import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { GeneralLedgerPage } from './GeneralLedgerPage';
import type { ServerReportBundle, ServerLedgerPage } from '@/services/api/reportsApi';

const POISON = 'Poisoned Local Account';

/* Three posting accounts, so "one request per account" would be visible. */
const SUMMARIES = [
  {
    accountId: 'a-1', accountCode: '1000', accountName: 'Cash', accountType: 'asset',
    normalBalance: 'debit', openingBalance: '250.000', periodDebit: '1000.000',
    periodCredit: '0.000', netMovement: '1000.000', closingBalance: '1250.000', lineCount: 2,
  },
  {
    accountId: 'a-2', accountCode: '4000', accountName: 'Sales', accountType: 'income',
    normalBalance: 'credit', openingBalance: '0.000', periodDebit: '0.000',
    periodCredit: '1000.000', netMovement: '-1000.000', closingBalance: '-1000.000', lineCount: 2,
  },
  {
    accountId: 'a-3', accountCode: '3000', accountName: 'Dormant Equity', accountType: 'equity',
    normalBalance: 'credit', openingBalance: '0.000', periodDebit: '0.000',
    periodCredit: '0.000', netMovement: '0.000', closingBalance: '0.000', lineCount: 0,
  },
];

function bundle(): ServerReportBundle {
  return {
    snapshot: { at: '2026-08-30T10:00:00.000Z', currency: 'JOD', decimals: 3 },
    parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    accountLedgers: SUMMARIES,
    trialBalance: { rows: [], totalDebit: '1000.000', totalCredit: '1000.000' },
    incomeStatement: { rows: [], income: '1000.000', expense: '0.000', netIncome: '1000.000' },
    balanceSheet: { rows: [], assets: '1250.000', liabilities: '0.000', equity: '0.000', unclosedEarnings: '1000.000', balances: true },
    cashFlow: { status: 'ok', openingCash: '250.000', closingCash: '1250.000', movement: '1000.000' },
  };
}

function ledgerPage(): ServerLedgerPage {
  return {
    account: { id: 'a-1', code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    currency: 'JOD',
    decimals: 3,
    parameters: { accountId: 'a-1', from: '2026-01-01', to: '2026-12-31' },
    openingBalance: '250.000',
    totals: { debit: '1000.000', credit: '0.000', movement: '1000.000', closingBalance: '1250.000', lineCount: 2 },
    lines: [
      {
        lineId: 'l-1', journalId: 'j-1', journalNumber: 'JE-000001', postingDate: '2026-06-01',
        transactionDate: '2026-06-01', status: 'posted', reference: 'INV-1',
        description: 'Server line one', memo: '', sourceType: null, sourceId: null, sourceEvent: null,
        debit: '600.000', credit: '0.000', runningBalance: '850.000', cursor: 'c1',
      },
      {
        lineId: 'l-2', journalId: 'j-2', journalNumber: 'JE-000002', postingDate: '2026-06-02',
        transactionDate: '2026-06-02', status: 'posted', reference: 'INV-2',
        description: 'Server line two', memo: '', sourceType: null, sourceId: null, sourceEvent: null,
        debit: '400.000', credit: '0.000', runningBalance: '1250.000', cursor: 'c2',
      },
    ],
    nextCursor: null,
    watermark: 'WATERMARK-XYZ',
    readAt: '2026-08-30T11:30:00.000Z',
  };
}

/** Switch the page into multi-account mode. */
function openMultiMode(): void {
  fireEvent.click(screen.getByText(/Multi-account/i));
}

beforeEach(() => {
  engine.current = 'server';
  calls.bundle.mockReset().mockResolvedValue(bundle());
  calls.ledgerPage.mockReset().mockResolvedValue(ledgerPage());
  calls.groupedExport.mockReset();
  downloaded.fn.mockReset();

  useStore.setState({
    settings: { ...useStore.getState().settings, companyName: 'Acme', baseCurrency: 'JOD', fiscalYearStart: '01-01' },
    accounts: [{
      id: 'local-1', code: '9999', name: POISON, type: 'ASSET',
      ifrsStatement: 'FINANCIAL_POSITION', ifrsCategory: 'Current assets',
      ifrsSubcategory: 'Cash and cash equivalents', normalBalance: 'debit',
      level: 1, parentId: null, isPostable: true, isPostingAccount: true, active: true, currency: 'JOD',
    }] as never,
  });
  useJournalStore.setState({
    entries: [{
      id: 'local-entry', entryNumber: 'JE-LOCAL', entryDate: '2026-06-01',
      postedAt: '2026-06-01T00:00:00.000Z', status: 'posted', description: POISON,
      currency: 'JOD', transactionType: '', reference: '', memo: '',
      lines: [
        { id: 'p1', lineNumber: 1, accountId: 'local-1', accountCode: '9999', accountName: POISON, debit: 777777, credit: 0 },
        { id: 'p2', lineNumber: 2, accountId: 'local-1', accountCode: '9999', accountName: POISON, debit: 0, credit: 777777 },
      ],
    }] as never,
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/* ══ 1. The figures are the server's ═══════════════════════════════════════ */

describe('durable multi-account totals', () => {
  it('render the server’s opening, turnover and closing — never the cache', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();

    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    /* The server's decimal strings, at the snapshot's precision. */
    expect(screen.getByText('250.000')).toBeTruthy();
    expect(screen.getByText('1,250.000')).toBeTruthy();

    /* Nothing from the poisoned browser journal. */
    expect(screen.queryByText(new RegExp(POISON, 'i'))).toBeNull();
    expect(screen.queryByText(/777,777/)).toBeNull();
  });

  it('lists the whole chart from ONE request', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();

    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());
    expect(screen.getByText('Sales')).toBeTruthy();

    /* One bundle, and not a single per-account ledger request. */
    expect(calls.bundle).toHaveBeenCalledTimes(1);
    expect(calls.ledgerPage).not.toHaveBeenCalled();
  });

  it('keeps account order the server’s, by code', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();

    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    /* The rows appear in the order the server sent them, which is account-code
     * order. Nothing here re-sorts them. */
    const rows = document.querySelectorAll('button[aria-expanded]');
    const codes = [...rows]
      .map((row) => row.querySelector('.font-mono')?.textContent ?? '')
      /* The page's own dropdown trigger also carries aria-expanded. */
      .filter(Boolean);
    expect(codes).toEqual(['1000', '4000']);
  });
});

/* ══ 2. Filters are presentation, not arithmetic ═══════════════════════════ */

describe('search and include-zero', () => {
  it('do not recalculate a single figure, and issue no request', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    const before = calls.bundle.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/Search ledger/i), { target: { value: 'Sales' } });

    await waitFor(() => expect(screen.queryByText('Cash')).toBeNull());
    /* Sales is still showing its own server figures, unchanged by the filter. */
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByText('1,000.000')).toBeTruthy();
    /* Filtering asked the server for nothing. */
    expect(calls.bundle.mock.calls.length).toBe(before);
    expect(calls.ledgerPage).not.toHaveBeenCalled();
  });

  it('hides a dormant account until include-zero is turned on', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    expect(screen.queryByText('Dormant Equity')).toBeNull();

    fireEvent.click(screen.getByLabelText(/Include zero-balance accounts/i));

    await waitFor(() => expect(screen.getByText('Dormant Equity')).toBeTruthy());
    /* Revealing a row is not a recalculation and not a request. */
    expect(calls.ledgerPage).not.toHaveBeenCalled();
  });
});

/* ══ 3. Expansion, and the absence of a fan-out ════════════════════════════ */

describe('expanding accounts', () => {
  it('loads ONE account’s lines from the server ledger endpoint', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    fireEvent.click(screen.getByText('Cash'));

    await waitFor(() => expect(calls.ledgerPage).toHaveBeenCalledTimes(1));
    expect(calls.ledgerPage).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a-1' }));
    await waitFor(() => expect(screen.getByText('Server line one')).toBeTruthy());
  });

  it('states its OWN read time and watermark, not the bundle’s snapshot', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    fireEvent.click(screen.getByText('Cash'));

    /* These lines were read minutes after the summary above. Saying so is the
     * difference between a report and a misleading one. */
    await waitFor(() => expect(screen.getByText(/Lines read separately/i)).toBeTruthy());
    expect(screen.getByText(/WATERMARK-XYZ/)).toBeTruthy();
  });

  it('offers NO control that expands every account', async () => {
    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    /* The local build had "Expand all"; against the server it would be one
     * request per account, so it does not exist here. */
    expect(screen.queryByText(/Expand all/i)).toBeNull();

    /* And nothing else on the screen fans out either: after clicking every
     * control that is offered, no more than the accounts individually opened
     * have been fetched. */
    fireEvent.click(screen.getByText(/Export full ledger/i));
    await waitFor(() => expect(calls.groupedExport).toHaveBeenCalledTimes(1));
    expect(calls.ledgerPage).not.toHaveBeenCalled();
  });
});

/* ══ 4. The bound-ledger export ════════════════════════════════════════════ */

describe('the full ledger export', () => {
  it('is ONE grouped server operation, not one request per account', async () => {
    calls.groupedExport.mockResolvedValue({
      snapshot: { at: '2026-08-30T12:00:00.000Z', currency: 'JOD', decimals: 3 },
      parameters: { from: '2026-01-01', to: '2026-12-31', includeZero: false },
      accounts: [
        {
          accountId: 'a-1', accountCode: '1000', accountName: 'Cash', accountType: 'asset',
          normalBalance: 'debit', openingBalance: '250.000',
          totals: { debit: '1000.000', credit: '0.000', movement: '1000.000', closingBalance: '1250.000', lineCount: 1 },
          lines: [ledgerPage().lines[0]!],
        },
        {
          accountId: 'a-2', accountCode: '4000', accountName: 'Sales', accountType: 'income',
          normalBalance: 'credit', openingBalance: '0.000',
          totals: { debit: '0.000', credit: '1000.000', movement: '-1000.000', closingBalance: '-1000.000', lineCount: 1 },
          lines: [ledgerPage().lines[1]!],
        },
      ],
      totals: { accountCount: 2, lineCount: 2 },
      complete: true,
    });

    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    fireEvent.click(screen.getByText(/Export full ledger/i));

    await waitFor(() => expect(downloaded.fn).toHaveBeenCalledTimes(1));
    expect(calls.groupedExport).toHaveBeenCalledTimes(1);
    /* Never a per-account walk. */
    expect(calls.ledgerPage).not.toHaveBeenCalled();

    const csv = downloaded.fn.mock.calls[0]![1] as string;
    /* Every selected account, in the server's order, with its lines. */
    expect(csv).toContain('1000 — Cash');
    expect(csv).toContain('4000 — Sales');
    expect(csv.indexOf('1000 — Cash')).toBeLessThan(csv.indexOf('4000 — Sales'));
    expect(csv).toContain('JE-000001');
    expect(csv).toContain('JE-000002');
    /* Server decimal strings, written through unparsed. */
    expect(csv).toContain('250.000');
    expect(csv).toContain('1250.000');
    /* And the instant the whole book was read at. */
    expect(csv).toContain('2026-08-30T12:00:00.000Z');
  });

  it('shows the server’s refusal verbatim when the period is too large', async () => {
    calls.groupedExport.mockRejectedValue(
      new Error('This period holds 412000 ledger lines, more than the 250000 a single bound-ledger export carries. Export a shorter period. Nothing has been truncated.'),
    );

    render(<GeneralLedgerPage />);
    openMultiMode();
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy());

    fireEvent.click(screen.getByText(/Export full ledger/i));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      /* The measured count is the one number that tells the reader what to do
       * next; nothing may be silently truncated in its place. */
      expect(alert.textContent).toContain('412000');
      expect(alert.textContent).toContain('Nothing has been truncated');
    });
    expect(downloaded.fn).not.toHaveBeenCalled();
  });
});

/* ══ Free Demo keeps its local behaviour ═══════════════════════════════════ */

describe('a demo workspace', () => {
  it('keeps Expand all and asks the server for nothing', async () => {
    engine.current = 'demo';
    render(<GeneralLedgerPage />);
    openMultiMode();

    await waitFor(() => expect(screen.queryByText(/Export full ledger/i)).toBeNull());
    expect(calls.bundle).not.toHaveBeenCalled();
    expect(calls.ledgerPage).not.toHaveBeenCalled();
  });
});
