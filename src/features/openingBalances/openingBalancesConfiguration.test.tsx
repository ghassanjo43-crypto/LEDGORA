// @vitest-environment happy-dom
/**
 * What Opening Balances does when it cannot be used yet.
 *
 * Two distinct faults were being shown as the same dead end. With no company,
 * the page offered nothing to do about it; with a session whose subscriber
 * workspace could not be resolved, it showed a bare permission error that read
 * as "you are not allowed" rather than "this account is not configured".
 *
 * The rules pinned here: neither state navigates on its own — a redirect out of
 * the application surface is reversed by the shell and reads as a button that
 * did nothing — and the setup action must actually land somewhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OpeningBalancesPage } from '@/pages/OpeningBalancesPage';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useCompanyStore } from '@/store/companyStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';

const API = 'https://api.example.test';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const forbidden = () =>
  json({ error: { code: 'forbidden', message: 'You do not belong to an organization.' } }, 403);

/**
 * A FRESH response per call. The page loads the record and the account
 * catalogue concurrently, and a single shared `Response` can only have its body
 * read once — the second read throws a TypeError that looks nothing like the
 * 403 under test.
 */
const mockForbidden = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => forbidden());

const renderPage = () => render(<ToastProvider><OpeningBalancesPage /></ToastProvider>);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  useStore.setState({ activeView: 'opening-balances' });
  useCompanyStore.setState({ companies: [], activeCompanyId: '' });
  // Default: an ordinary subscriber, nobody being viewed as an administrator.
  useBackendSessionStore.setState({ platformRoles: [] });
  useOperatorViewStore.setState({ active: false, organizationId: null, ownerUserId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * A platform administrator is not a subscriber. They hold a role in
 * `platform_user_roles` and never a workspace membership, so the accounting API
 * — which resolves the workspace from the caller's OWN membership — can never
 * serve them. The old behavior asked anyway and rendered the 403 verbatim:
 * "You do not belong to an organization", which describes a state a subscriber
 * cannot be in (a subscription cannot exist without a workspace) and so reads
 * as a fault when it is the design.
 */
describe('Opening Balances as a platform administrator', () => {
  it('sends an administrator with no subscriber selected to the console', async () => {
    useBackendSessionStore.setState({ platformRoles: ['super_admin'] });
    const fetchSpy = mockForbidden();

    renderPage();

    expect(await screen.findByText(/No subscriber selected/i)).toBeTruthy();
    expect(screen.getByText(/no books of your own/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Back to admin console/i })).toBeTruthy();
    // The misleading message must not appear — and nothing was asked of a
    // server that could only have answered with it.
    expect(screen.queryByText(/do not belong to an organization/i)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('explains that previewing a subscriber does not grant their ledger', async () => {
    useBackendSessionStore.setState({ platformRoles: ['super_admin'] });
    useOperatorViewStore.setState({ active: true, organizationId: 'org-1', ownerUserId: 'user-1' });
    useCompanyStore.setState({
      companies: [{ id: 'co-1', settings: useStore.getState().settings, accounts: [], entities: [], entries: [] }],
      activeCompanyId: 'co-1',
    });
    const fetchSpy = mockForbidden();

    renderPage();

    expect(await screen.findByText(/Opening balances belong to the subscriber/i)).toBeTruthy();
    expect(screen.getByText(/cannot be entered from an administrator session/i)).toBeTruthy();
    // Preview may resolve the workspace, but the ledger is never asked for:
    // every accounting route reads the caller's own membership.
    const accountingCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes('/api/accounting/'));
    expect(accountingCalls).toEqual([]);
  });
});

describe('Opening Balances with no company', () => {
  it('offers a setup action instead of an empty account list', async () => {
    const fetchSpy = mockForbidden();
    renderPage();

    expect(await screen.findByText(/No company is set up yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Set up company/i })).toBeTruthy();
    // Nothing is asked of the server while there is no company to ask about.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates the company and lands on its setup, staying inside the app', async () => {
    mockForbidden();
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Set up company/i }));
    fireEvent.change(screen.getByLabelText(/Company name/i), { target: { value: 'Migrated Holdings Ltd.' } });
    fireEvent.click(screen.getByRole('button', { name: /Create company/i }));

    await waitFor(() => {
      expect(useCompanyStore.getState().companies).toHaveLength(1);
    });
    expect(useCompanyStore.getState().companies[0]!.settings.companyName).toBe('Migrated Holdings Ltd.');
    expect(useCompanyStore.getState().activeCompanyId).toBeTruthy();
    // An in-app view change, not a route change: the shell has no redirect that
    // can cancel it, which is what made the old button appear to do nothing.
    expect(useStore.getState().activeView).toBe('settings');
  });
});

/**
 * The books live in the browser; opening balances post through the server's
 * journal and read the SERVER's chart. Nothing in the frontend had ever written
 * to it, so a subscriber with a full chart on screen saw "0 accounts" here.
 */
describe('Opening Balances when the server holds no chart', () => {
  beforeEach(() => {
    useCompanyStore.setState({
      companies: [{ id: 'co-1', settings: useStore.getState().settings, accounts: [], entities: [], entries: [] }],
      activeCompanyId: 'co-1',
    });
  });

  it('offers to import the browser chart instead of showing an empty table', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/opening-balances/accounts')) return json({ accounts: [], restrictions: [] });
      if (url.includes('/opening-balances/current')) return json({ openingBalance: null });
      if (url.includes('/api/accounting/accounts')) return json({ accounts: [] }); // server chart is empty
      return json({}, 404);
    });

    renderPage();

    expect(await screen.findByText(/has not been shared with the accounting service/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import chart of accounts/i })).toBeTruthy();
  });

  it('stays quiet when the server has a chart but nothing in it is eligible', async () => {
    // A chart that is entirely control accounts is a different situation with a
    // different explanation — the restrictions banner — and must not be
    // mistaken for "no chart at all".
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/opening-balances/accounts')) {
        return json({ accounts: [], restrictions: ['Accounts Receivable opening details require the customer subledger workflow.'] });
      }
      if (url.includes('/opening-balances/current')) return json({ openingBalance: null });
      return json({}, 404);
    });

    renderPage();

    expect(await screen.findByText(/customer subledger workflow/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Import chart of accounts/i })).toBeNull();
  });
});

describe('Opening Balances with an unresolved subscriber workspace', () => {
  beforeEach(() => {
    useCompanyStore.setState({
      companies: [{ id: 'co-1', settings: useStore.getState().settings, accounts: [], entities: [], entries: [] }],
      activeCompanyId: 'co-1',
    });
  });

  it('explains the configuration fault and stays on the page', async () => {
    mockForbidden();
    renderPage();

    expect(await screen.findByText(/subscriber workspace could not be resolved/i)).toBeTruthy();
    expect(screen.getByText(/workspace configuration problem/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy();
    // No silent redirect: the user is left where they asked to be.
    expect(useStore.getState().activeView).toBe('opening-balances');
  });

  it('retries the resolution and renders the workbench once it succeeds', async () => {
    let attempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      attempt += 1;
      if (attempt <= 2) return forbidden();
      return String(input).includes('/accounts')
        ? json({ accounts: [], restrictions: [] })
        : json({ openingBalance: null });
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Try again/i }));

    expect(await screen.findByText(/Balance-sheet accounts/i)).toBeTruthy();
    expect(screen.queryByText(/could not be resolved/i)).toBeNull();
  });
});
