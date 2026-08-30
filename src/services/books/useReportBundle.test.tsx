// @vitest-environment happy-dom
/**
 * A statement answer that arrives too late must never be shown.
 *
 * A report request outlives the screen that asked for it. Between asking and
 * answering the user can switch company or change the period, and applying a
 * late answer would put one company's figures under another company's name —
 * which is not a cosmetic bug: it is a bookkeeper reading, and possibly acting
 * on, the wrong entity's books.
 *
 * PGlite-style caveats do not apply here; these races are entirely in the
 * browser and can be driven exactly, so they are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('./booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./booksEngine')>()),
  booksEngine: () => engine.current,
}));

const bundleCall = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/services/api/reportsApi', () => ({
  reportsApi: { bundle: (...args: unknown[]) => bundleCall.fn(...args) },
}));

import { useReportBundle } from './useReportBundle';
import { enterCompanyScope, __resetBooksScopeForTests } from './booksScope';
import type { ServerReportBundle } from '@/services/api/reportsApi';

function bundleWith(total: string): ServerReportBundle {
  return {
    snapshot: { at: '2026-08-30T10:00:00.000Z', currency: 'JOD', decimals: 3 },
    parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    accountLedgers: [],
    trialBalance: { rows: [], totalDebit: total, totalCredit: total },
    incomeStatement: { rows: [], income: total, expense: '0.000', netIncome: total },
    balanceSheet: { rows: [], assets: total, liabilities: '0.000', equity: '0.000', unclosedEarnings: '0.000', balances: true },
    cashFlow: { status: 'ok', openingCash: '0.000', closingCash: total, movement: total },
  };
}

/** A probe that renders whatever the hook currently holds. */
function Probe({ from = '2026-01-01' }: { from?: string }) {
  const report = useReportBundle({ asOf: '2026-12-31', from, to: '2026-12-31' });
  return (
    <div>
      <span data-testid="state">{report.state}</span>
      <span data-testid="total">{report.bundle?.trialBalance.totalDebit ?? 'none'}</span>
      <span data-testid="error">{report.error ?? ''}</span>
    </div>
  );
}

beforeEach(() => {
  engine.current = 'server';
  bundleCall.fn.mockReset();
  __resetBooksScopeForTests();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('useReportBundle', () => {
  it('shows the answer to the current question', async () => {
    bundleCall.fn.mockResolvedValue(bundleWith('100.000'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('100.000'));
    expect(screen.getByTestId('state').textContent).toBe('ready');
  });

  it('DROPS an answer that arrives after the company changed', async () => {
    let release: (value: ServerReportBundle) => void = () => {};
    bundleCall.fn.mockReturnValue(new Promise<ServerReportBundle>((resolve) => { release = resolve; }));

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('loading'));

    /* The user switches company while the request is in flight. */
    act(() => { enterCompanyScope('co_other'); });

    /* The first company's figures now arrive. They belong to books nobody is
     * looking at, and must not be rendered under the new company's name. */
    await act(async () => { release(bundleWith('999999.000')); });

    expect(screen.getByTestId('total').textContent).toBe('none');
    expect(screen.getByTestId('state').textContent).toBe('loading');
  });

  it('DROPS a superseded answer even within the same company', async () => {
    /* Two period changes in quick succession. The first request answers last;
     * without a guard its figures would win because they arrived latest. */
    const resolvers: Array<(value: ServerReportBundle) => void> = [];
    bundleCall.fn.mockImplementation(
      () => new Promise<ServerReportBundle>((resolve) => { resolvers.push(resolve); }),
    );

    const view = render(<Probe from="2026-01-01" />);
    await waitFor(() => expect(bundleCall.fn).toHaveBeenCalledTimes(1));

    view.rerender(<Probe from="2026-06-01" />);
    await waitFor(() => expect(bundleCall.fn).toHaveBeenCalledTimes(2));

    /* Second request answers, then the stale first one. */
    await act(async () => { resolvers[1]!(bundleWith('222.000')); });
    await act(async () => { resolvers[0]!(bundleWith('111.000')); });

    expect(screen.getByTestId('total').textContent).toBe('222.000');
  });

  it('keeps the last good figures behind a failure, rather than blanking', async () => {
    bundleCall.fn.mockResolvedValueOnce(bundleWith('500.000'));
    const view = render(<Probe from="2026-01-01" />);
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('500.000'));

    bundleCall.fn.mockRejectedValueOnce(new Error('Assets do not equal liabilities plus equity.'));
    view.rerender(<Probe from="2026-06-01" />);

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('unavailable'));
    /* The server's own refusal, kept verbatim. */
    expect(screen.getByTestId('error').textContent).toContain('Assets do not equal liabilities');
    /* And the previous statement is still on screen, labelled stale by the UI. */
    expect(screen.getByTestId('total').textContent).toBe('500.000');
  });

  it('asks for nothing at all in a demo workspace', async () => {
    engine.current = 'demo';
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('idle'));
    expect(bundleCall.fn).not.toHaveBeenCalled();
  });
});
