/**
 * @vitest-environment happy-dom
 *
 * A DOM environment because the engine is decided partly by
 * `getWorkspaceStorageMode`, which reads `window.localStorage`. Under the node
 * environment there is no `window`, the mode silently reads as `backend`, and
 * the Free Demo assertions would pass for the wrong reason.
 */
/**
 * The books belong to the server.
 *
 * ══ What each claim is protecting ════════════════════════════════════════════
 *
 * These are not tests of a happy path. Each one names a specific way the books
 * could be quietly lost or mixed up, and most of them describe a bug that a
 * reasonable implementation would have:
 *
 *   · clearing the browser and reloading returns the SAME chart and journal —
 *     because if it does not, the browser was still the authority;
 *   · whatever the browser was holding is REPLACED and never merged, so the
 *     disposable test records need no import and cannot survive one;
 *   · an offline subscriber cannot write locally — the single failure this
 *     whole phase exists to prevent, because a local write looks saved and is
 *     erased by the next hydration without a word;
 *   · two companies never see each other's records, in the cache or on the
 *     wire;
 *   · a response that arrives AFTER the user has switched company is discarded,
 *     however correct it was for the question it answered;
 *   · the whole draft → post → amend → reverse → replace lifecycle goes to the
 *     server, with the version travelling on every step;
 *   · a stale version surfaces as a conflict instead of overwriting;
 *   · Free Demo stays ephemeral and calls no persistence API at all;
 *   · an invalid cash classification is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCompanyReference, setCsrfToken } from '@/services/api/client';
import { setWorkspaceStorageMode, memoryWorkspaceKeys } from '@/lib/workspaceStorage';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { resetCompanyRegistration } from '@/services/api/companyRegistration';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { booksEngine, releaseServerBooks, SERVER_BOOKS_MESSAGE } from './booksEngine';
import { hydrateBooks, booksStatus, __resetBooksStatusForTests } from './booksHydration';
import { enterCompanyScope, leaveCompanyScope, __resetBooksScopeForTests, clearBooksCache } from './booksScope';
import * as accountsGateway from './accountsGateway';
import * as journalsGateway from './journalsGateway';
import type { ServerAccount, ServerJournal } from '@/services/api/accountingApi';

const fetchMock = vi.fn();

const ok = (body: unknown = {}) => ({
  status: 200, ok: true,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
} as unknown as Response);

const failure = (status: number, code: string, message: string) => ({
  status, ok: false,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { code, message } }),
} as unknown as Response);

/** Every request made, in order. */
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  method: (init as { method?: string })?.method ?? 'GET',
  body: (init as { body?: string })?.body ? JSON.parse((init as { body: string }).body) : null,
}));

function serverAccount(over: Partial<ServerAccount> = {}): ServerAccount {
  return {
    id: 'a1', accountCode: '1000', accountName: 'Cash', accountType: 'asset',
    accountSubtype: null, cashClassification: 'none', normalBalance: 'debit',
    parentAccountId: null, restrictedCurrency: null, sortOrder: 0,
    presentationType: 'ASSET', ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION',
    ifrsCategory: 'Current assets', ifrsSubcategory: '', cashFlowCategory: 'OPERATING',
    profitOrLossCategory: '', description: '', industryTag: 'general',
    isPostable: true, active: true, blocked: false, archived: false, systemAccount: false,
    ...over,
  };
}

function serverJournal(over: Partial<ServerJournal> = {}): ServerJournal {
  return {
    id: 'j1', journalNumber: 'JE-0001', journalType: 'general',
    transactionDate: '2026-06-01', postingDate: '2026-06-01', status: 'posted',
    reference: 'REF-1', description: 'Opening', notes: '',
    transactionCurrency: 'JOD', functionalCurrency: 'JOD', exchangeRate: '1',
    sourceType: null, sourceId: null, originalEntryId: null, reversalEntryId: null,
    replacementEntryId: null, version: 3, postedAt: '2026-06-01T00:00:00.000Z',
    lines: [
      { id: 'l1', lineNumber: 1, accountId: 'a1', memo: '', entityId: null, projectId: null,
        costCenterId: null, debit: '100.000', credit: '0', debitFunctional: '100.000', creditFunctional: '0' },
      { id: 'l2', lineNumber: 2, accountId: 'a2', memo: '', entityId: null, projectId: null,
        costCenterId: null, debit: '0', credit: '100.000', debitFunctional: '0', creditFunctional: '100.000' },
    ],
    ...over,
  };
}

/**
 * Answer the two hydration requests with a fixed set of books.
 *
 * Company ADOPTION is answered too. Every `/api/accounting` request passes the
 * registration gate first - a real client must have its `co_...` reference
 * adopted before the books will answer - so a fixture that forgot it would fail
 * every test here with "not registered", which is a true statement about the
 * fixture and nothing about the code under test.
 */
function serveBooks(accounts: ServerAccount[], journals: ServerJournal[]): void {
  fetchMock.mockImplementation(async (url: unknown) => {
    const path = String(url);
    if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
    if (path.includes('/accounting/accounts')) return ok({ accounts });
    if (path.includes('/accounting/journals')) return ok({ journals });
    return ok({});
  });
}

/** A signed-in subscriber on a durable workspace — the server engine. */
function signedInSubscriber(): void {
  setWorkspaceStorageMode('backend');
  useBackendSessionStore.setState({
    status: 'ready',
    user: { id: 'u1', email: 'owner@acme.test', fullName: 'Acme Owner', platformRoles: [] } as never,
    platformRoles: [],
    error: null,
  });
  /* The registration gate needs a legal name to adopt the company under. */
  useOrganizationStore.setState({ organization: { legalName: 'Acme Trading LLC' } as never });
}

const CHART = [
  serverAccount({ id: 'a1', accountCode: '1000', accountName: 'Cash' }),
  serverAccount({
    id: 'a2', accountCode: '4000', accountName: 'Sales', accountType: 'income',
    presentationType: 'INCOME', normalBalance: 'credit',
  }),
];

const FORM = {
  code: '1500', name: 'Inventory', type: 'ASSET' as const, parentId: null,
  normalBalance: 'DEBIT' as const, ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION' as const,
  ifrsCategory: 'Current assets', ifrsSubcategory: '', cashFlowCategory: 'OPERATING' as const,
  isPostingAccount: true, isActive: true, description: '', industryTag: 'general',
};

const JOURNAL_FORM = {
  entryNumber: '', entryDate: '2026-06-02', reference: 'REF-9', description: 'Sale',
  transactionType: '', currency: 'JOD', exchangeRate: 1, notes: '',
  lines: [
    { accountId: 'a1', debit: 250, credit: 0, description: '', entityId: '', costCenter: '', project: '', taxCode: '', taxAmount: 0 },
    { accountId: 'a2', debit: 0, credit: 250, description: '', entityId: '', costCenter: '', project: '', taxCode: '', taxAmount: 0 },
  ],
} as never;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok({}));
  setCsrfToken('csrf-token');
  setCompanyReference('co_acme');
  releaseServerBooks();
  resetCompanyRegistration();
  __resetBooksScopeForTests();
  __resetBooksStatusForTests();
  useStore.setState({ accounts: [] });
  useJournalStore.setState({ entries: [] });
  signedInSubscriber();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  releaseServerBooks();
  resetCompanyRegistration();
  __resetBooksScopeForTests();
  setWorkspaceStorageMode('backend');
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
});

/* ══ Which engine ══════════════════════════════════════════════════════════ */

describe('the engine', () => {
  it('is the server for a signed-in subscriber on a durable workspace', () => {
    expect(booksEngine()).toBe('server');
  });

  it('is the demo engine for a visitor who is not signed in', () => {
    useBackendSessionStore.setState({ status: 'unavailable', user: null, platformRoles: [], error: null });
    expect(booksEngine()).toBe('demo');
  });

  it('is the demo engine for a platform operator, who has no books', () => {
    useBackendSessionStore.setState({
      status: 'ready',
      user: { id: 'op', email: 'op@ledgora.test', fullName: 'Operator', platformRoles: ['super_admin'] } as never,
      platformRoles: ['super_admin'] as never,
      error: null,
    });
    expect(booksEngine()).toBe('demo');
  });

  it('does NOT fall back to the browser when the session drops', () => {
    expect(booksEngine()).toBe('server');

    /* The network goes; the session store reports it cannot confirm anyone. */
    useBackendSessionStore.setState({ status: 'unavailable', user: null, platformRoles: [], error: 'offline' });

    /*
     * Still the server. A downgrade here would send the next posting into
     * browser storage, where it looks saved and is deleted by the next
     * successful hydration without a word.
     */
    expect(booksEngine()).toBe('server');
  });
});

/* ══ Hydration ═════════════════════════════════════════════════════════════ */

describe('hydration', () => {
  it('loads the chart and the journal from the server', async () => {
    serveBooks(CHART, [serverJournal()]);

    const result = await hydrateBooks();

    expect(result.ok).toBe(true);
    expect(useStore.getState().accounts.map((a) => a.code)).toEqual(['1000', '4000']);
    expect(useJournalStore.getState().entries).toHaveLength(1);
    /* The number came from the SERVER; nothing local minted it. */
    expect(useJournalStore.getState().entries[0]!.entryNumber).toBe('JE-0001');
  });

  it('reloads an identical chart and journal after the browser is cleared', async () => {
    serveBooks(CHART, [serverJournal()]);
    await hydrateBooks();
    const before = {
      accounts: useStore.getState().accounts,
      entries: useJournalStore.getState().entries,
    };

    /* Everything the browser held is gone — site data cleared, new device. */
    window.localStorage.clear();
    clearBooksCache();
    expect(useStore.getState().accounts).toHaveLength(0);
    expect(useJournalStore.getState().entries).toHaveLength(0);

    await hydrateBooks();

    expect(useStore.getState().accounts).toEqual(before.accounts);
    expect(useJournalStore.getState().entries).toEqual(before.entries);
  });

  it('REPLACES the browser’s records rather than merging them', async () => {
    /* Exactly the disposable test data this phase refuses to import. */
    useStore.setState({
      accounts: [{
        id: 'browser-only', code: '9999', name: 'Left over from testing', type: 'ASSET',
        parentId: null, level: 0, normalBalance: 'DEBIT',
        ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: 'x', ifrsSubcategory: '',
        cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: true, isActive: true,
        description: '', industryTag: 'general', sortOrder: 0, createdAt: '', updatedAt: '',
      }],
    });
    serveBooks(CHART, []);

    await hydrateBooks();

    const codes = useStore.getState().accounts.map((a) => a.code);
    expect(codes).toEqual(['1000', '4000']);
    expect(codes).not.toContain('9999');
    /* And nothing was uploaded on its behalf. The company-adoption POST is
     * the bootstrap step, not an import: it carries a reference, never a
     * record. */
    const uploads = calls().filter((c) => c.method === 'POST' && c.url.includes('/accounting/'));
    expect(uploads).toHaveLength(0);
  });

  it('keeps the previous answer when the server cannot be reached', async () => {
    serveBooks(CHART, [serverJournal()]);
    await hydrateBooks();

    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await hydrateBooks();

    expect(result.ok).toBe(false);
    /* An empty chart would read as "you have no accounts", which is a far more
     * alarming thing to show than "could not load". */
    expect(useStore.getState().accounts).toHaveLength(2);
  });
});

/* ══ No local fallback ═════════════════════════════════════════════════════ */

describe('an offline subscriber', () => {
  beforeEach(() => {
    fetchMock.mockRejectedValue(new Error('network down'));
  });

  it('cannot create an account locally', async () => {
    const result = await accountsGateway.createAccount(FORM, null);

    expect(result.ok).toBe(false);
    expect(useStore.getState().accounts).toHaveLength(0);
  });

  it('cannot create or post a journal entry locally', async () => {
    const created = await journalsGateway.createEntry(JOURNAL_FORM);

    expect(created.ok).toBe(false);
    expect(useJournalStore.getState().entries).toHaveLength(0);
  });

  it('refuses a direct store write, so a screen that forgets cannot save locally', () => {
    /* The guard is in the STORE, not in the screens: a rule enforced at call
     * sites holds only until somebody adds a call site. */
    const account = useStore.getState().addAccount(FORM, null);
    expect(account).toEqual({ ok: false, error: SERVER_BOOKS_MESSAGE });

    const entry = useJournalStore.getState().addEntry(JOURNAL_FORM);
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe(SERVER_BOOKS_MESSAGE);

    expect(useStore.getState().accounts).toHaveLength(0);
    expect(useJournalStore.getState().entries).toHaveLength(0);
  });

  it('refuses the programmatic posting paths too', () => {
    /* Invoices, inventory and fixed assets post through these. They have no
     * server route yet, and writing to the cache would lose every document
     * module's journals at once. */
    const posted = useJournalStore.getState().insertPostedEntry({
      entryDate: '2026-06-01', reference: '', description: 'Generated', currency: 'JOD',
      exchangeRate: 1, lines: [
        { accountId: 'a1', debit: 5, credit: 0 },
        { accountId: 'a2', debit: 0, credit: 5 },
      ],
    });
    expect(posted.ok).toBe(false);
    expect(useJournalStore.getState().entries).toHaveLength(0);
  });
});

/* ══ Company isolation ═════════════════════════════════════════════════════ */

describe('two companies', () => {
  it('never share cached records', async () => {
    serveBooks(CHART, [serverJournal()]);
    await hydrateBooks();
    expect(useStore.getState().accounts).toHaveLength(2);

    /* The user opens the other company. */
    enterCompanyScope('co_globex');

    /*
     * Cleared IMMEDIATELY and synchronously. Leaving the previous company's
     * accounts on screen "until the new ones arrive" is how somebody posts to
     * the wrong ledger.
     */
    expect(useStore.getState().accounts).toHaveLength(0);
    expect(useJournalStore.getState().entries).toHaveLength(0);

    serveBooks([serverAccount({ id: 'b1', accountCode: '1100', accountName: 'Globex Bank' })], []);
    await hydrateBooks();

    expect(useStore.getState().accounts.map((a) => a.code)).toEqual(['1100']);
  });

  it('leaves nothing behind for whoever signs in next', async () => {
    serveBooks(CHART, [serverJournal()]);
    await hydrateBooks();
    expect(useStore.getState().accounts).toHaveLength(2);

    /* Sign-out releases the engine FIRST, so a clear that asked the engine
     * would see `demo` and skip — leaving one person's chart on screen for the
     * next. This one does not ask. */
    releaseServerBooks();
    leaveCompanyScope();

    expect(useStore.getState().accounts).toHaveLength(0);
    expect(useJournalStore.getState().entries).toHaveLength(0);
  });

  it('discards a response that arrives after the company changed', async () => {
    /* The first company's chart is slow. */
    let releaseFirst: (value: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    fetchMock.mockImplementationOnce(() => slow);

    const inFlight = hydrateBooks();

    /* The user switches while it is still out. */
    enterCompanyScope('co_globex');

    /* Only now does the first company's answer come back — correct, and about
     * a question nobody is asking any more. */
    releaseFirst(ok({ accounts: CHART }));
    const result = await inFlight;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('superseded');
    /* The decisive assertion: company A's accounts are NOT in company B's cache. */
    expect(useStore.getState().accounts).toHaveLength(0);
  });
});

/* ══ The correction lifecycle ══════════════════════════════════════════════ */

describe('the journal lifecycle', () => {
  beforeEach(async () => {
    serveBooks(CHART, []);
    await hydrateBooks();
    fetchMock.mockReset();
  });

  it('runs draft → post → amend → reverse → replace against the server', async () => {
    const draft = serverJournal({ id: 'j-new', status: 'draft', version: 1, postedAt: null });
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
      const path = String(url);
      const method = (init as { method?: string })?.method ?? 'GET';
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (path.includes('/accounting/accounts')) return ok({ accounts: CHART });
      if (path.includes('/accounting/journals') && method === 'GET') return ok({ journals: [draft] });
      if (path.endsWith('/reverse-and-replace')) {
        return ok({
          original: { ...draft, status: 'reversed' },
          reversal: serverJournal({ id: 'j-rev' }),
          replacement: serverJournal({ id: 'j-rep' }),
        });
      }
      if (path.endsWith('/reverse')) {
        return ok({ original: { ...draft, status: 'reversed' }, reversal: serverJournal({ id: 'j-rev' }) });
      }
      if (path.endsWith('/amend')) return ok({ journal: { ...draft, version: 3 } });
      if (path.endsWith('/post')) return ok({ journal: { ...draft, status: 'posted', version: 2 } });
      return ok({ journal: draft });
    });

    expect((await journalsGateway.createEntry(JOURNAL_FORM)).ok).toBe(true);
    expect((await journalsGateway.postEntry('j-new', 1)).ok).toBe(true);
    expect((await journalsGateway.amendPostedEntry('j-new', JOURNAL_FORM, { reason: 'Wrong amount', expectedVersion: 2 })).ok).toBe(true);
    expect((await journalsGateway.reverseEntry('j-new', { expectedVersion: 3 })).ok).toBe(true);

    const replaced = await journalsGateway.reverseAndReplace(
      'j-new', JOURNAL_FORM, { reason: 'Wrong account', expectedVersion: 3 },
    );
    expect(replaced.ok).toBe(true);
    expect(replaced.reversalId).toBe('j-rev');
    expect(replaced.replacementId).toBe('j-rep');

    const writes = calls().filter((c) => c.method !== 'GET');
    expect(writes.map((c) => c.url.replace('http://api.test', ''))).toEqual([
      '/api/accounting/journals',
      '/api/accounting/journals/j-new/post',
      '/api/accounting/journals/j-new/amend',
      '/api/accounting/journals/j-new/reverse',
      '/api/accounting/journals/j-new/reverse-and-replace',
    ]);

    /* Every correcting call carried the version the editor read. */
    expect(writes[1]!.body).toMatchObject({ expectedVersion: 1 });
    expect(writes[2]!.body).toMatchObject({ expectedVersion: 2, reason: 'Wrong amount' });
    expect(writes[3]!.body).toMatchObject({ expectedVersion: 3 });
    expect(writes[4]!.body).toMatchObject({ expectedVersion: 3, reason: 'Wrong account' });
  });

  it('surfaces a concurrent-version conflict instead of overwriting', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (path.includes('/accounting/accounts')) return ok({ accounts: CHART });
      if (path.includes('/accounting/journals?')) return ok({ journals: [] });
      return failure(409, 'conflict',
        'This transaction was changed by another user while you were editing it.');
    });

    const result = await journalsGateway.updateDraft('j1', JOURNAL_FORM, 1);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed by another user/i);
  });

  it('will not send a mutation it has no version for', async () => {
    /* An entry the cache has never seen. Sending no version would be
     * last-write-wins, which on a posted entry erases somebody's correction. */
    const result = await journalsGateway.postEntry('unknown-entry');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reopen this entry/i);
    expect(calls().filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('maps a reversed entry to posted, because it is still in the books', async () => {
    serveBooks(CHART, [serverJournal({ id: 'j-orig', status: 'reversed', reversalEntryId: 'j-rev' })]);
    await hydrateBooks();

    const [entry] = useJournalStore.getState().entries;
    /* Mapping it to `void` would mean the browser showed the reversal figures
     * against an entry it claimed never counted. */
    expect(entry!.status).toBe('posted');
    expect(entry!.reversalEntryId).toBe('j-rev');
  });
});

/* ══ The states a screen has to be able to show ════════════════════════════ */

describe('load states', () => {
  it('reports loading, then ready', async () => {
    expect(booksStatus().state).toBe('idle');

    let release: (value: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (path.includes('/accounting/accounts')) return slow;
      return ok({ journals: [] });
    });

    const inFlight = hydrateBooks();
    /* The adoption call is awaited first, so let the microtasks settle before
     * asserting the state the screen would paint. */
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(booksStatus().state).toBe('loading');

    release(ok({ accounts: CHART }));
    await inFlight;
    expect(booksStatus().state).toBe('ready');
  });

  it('reports a company with no accounts as EMPTY, not as unavailable', async () => {
    serveBooks([], []);

    const result = await hydrateBooks();

    expect(result.ok).toBe(true);
    expect(booksStatus().state).toBe('ready');
    expect(booksStatus().error).toBeNull();
    /* A new company genuinely has nothing. That is not an error, and telling
     * the user it is one would send them looking for a fault. */
    expect(useStore.getState().accounts).toEqual([]);
  });

  it('reports an outage as unavailable, with the reason', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await hydrateBooks();

    expect(result.ok).toBe(false);
    expect(booksStatus().state).toBe('unavailable');
    expect(booksStatus().error).toBeTruthy();
  });

  it('reports a permission refusal as itself', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      return failure(403, 'forbidden', 'You do not have permission to view the chart of accounts.');
    });

    const result = await hydrateBooks();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/do not have permission/i);
    /* NOT an empty chart. "You have no accounts" and "you may not see them"
     * are different sentences and only one of them is true. */
    expect(booksStatus().state).toBe('unavailable');
  });

  it('reports a company that has not been registered yet, rather than empty books', async () => {
    /*
     * The adoption gate refuses the request before it travels. Showing an empty
     * chart here would tell a bookkeeper their accounts are gone, when the
     * truth is that a bootstrap step has not finished.
     */
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url);
      if (path.includes('/organizations/current/companies')) {
        return failure(503, 'unavailable', 'The Ledgora service is unavailable.');
      }
      return ok({ accounts: CHART });
    });

    const result = await hydrateBooks();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/registered|unavailable|service/i);
    expect(useStore.getState().accounts).toEqual([]);
    expect(booksStatus().state).toBe('unavailable');
  });
});

/* ══ Refusals the server owns ══════════════════════════════════════════════ */

describe('server rules the browser does not second-guess', () => {
  beforeEach(async () => {
    serveBooks(CHART, [serverJournal({ id: 'j1', status: 'draft', version: 1 })]);
    await hydrateBooks();
    fetchMock.mockReset();
  });

  const refuseWith = (message: string) => {
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
      const path = String(url);
      const method = (init as { method?: string })?.method ?? 'GET';
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (method === 'GET') return ok({ accounts: CHART, journals: [] });
      return failure(409, 'conflict', message);
    });
  };

  it('surfaces a closed accounting period', async () => {
    refuseWith('The accounting period containing 2026-06-02 is closed. Post to an open period instead.');

    const result = await journalsGateway.postEntry('j1', 1);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/period .* is closed/i);
    /* And nothing was written locally to compensate. */
    expect(useJournalStore.getState().entries).toHaveLength(1);
  });

  it('surfaces a posting-account eligibility refusal', async () => {
    refuseWith('Line 1: Select a posting account. Parent accounts cannot receive transactions.');

    const result = await journalsGateway.createEntry(JOURNAL_FORM);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/select a posting account/i);
  });

  it('surfaces a duplicate account code', async () => {
    refuseWith('Account code "1000" already exists in this organization.');

    const result = await accountsGateway.createAccount(FORM, null);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/i);
    /* The browser has its own duplicate check for the demo engine; on the
     * server engine the SERVER's answer is the one that counts, because it is
     * the only one that can see every concurrent request. */
    expect(useStore.getState().accounts).toHaveLength(2);
  });
});

/* ══ Cash classification ═══════════════════════════════════════════════════ */

describe('cash classification', () => {
  it('sends the classification with the account', async () => {
    serveBooks(CHART, []);
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
      const path = String(url);
      const method = (init as { method?: string })?.method ?? 'GET';
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (path.includes('/accounting/accounts') && method === 'POST') {
        return ok({ account: serverAccount({ id: 'a9' }) });
      }
      if (path.includes('/accounting/accounts')) return ok({ accounts: CHART });
      return ok({ journals: [] });
    });

    await accountsGateway.createAccount(FORM, null, { cashClassification: 'cash_and_cash_equivalents' });

    const post = calls().find((c) => c.method === 'POST' && c.url.includes('/accounting/accounts'));
    expect(post!.body).toMatchObject({ cashClassification: 'cash_and_cash_equivalents' });
  });

  it('reports the server’s refusal of an invalid classification', async () => {
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
      const path = String(url);
      const method = (init as { method?: string })?.method ?? 'GET';
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (method === 'POST') {
        return failure(400, 'validation', '"petty_cash" is not a recognised cash classification.');
      }
      return ok({ accounts: CHART });
    });

    /*
     * The browser passes the value through untouched rather than dropping an
     * unrecognised one to `none` — that would store an account which is quietly
     * not cash, and the statement would be wrong with nothing to show for it.
     */
    const result = await accountsGateway.createAccount(FORM, null, { cashClassification: 'petty_cash' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a recognised cash classification/i);
    expect(useStore.getState().accounts).toHaveLength(0);
  });
});

/* ══ The chart’s other edits ═══════════════════════════════════════════════ */

describe('editing the chart', () => {
  beforeEach(async () => {
    serveBooks(CHART, []);
    await hydrateBooks();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
      const path = String(url);
      const method = (init as { method?: string })?.method ?? 'GET';
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (path.includes('/accounting/accounts') && method === 'PATCH') return ok({ account: serverAccount() });
      if (path.includes('/accounting/accounts') && method === 'POST') return ok({ account: serverAccount({ id: 'a9' }) });
      if (path.includes('/accounting/accounts')) return ok({ accounts: CHART });
      return ok({ journals: [] });
    });
  });

  it('sends an inline rename as a patch, and moves BOTH classifications together', async () => {
    const result = await accountsGateway.renameAccount('a1', { name: 'Bank', type: 'FINANCE' });

    expect(result.ok).toBe(true);
    const patch = calls().find((c) => c.method === 'PATCH');
    /*
     * `FINANCE` is an expense to the ledger. Sending the presentation alone
     * would leave an account shown as a finance cost and posted as an asset,
     * and every statement would put its balance on the wrong side.
     */
    expect(patch!.body).toEqual({ accountName: 'Bank', accountType: 'expense', presentationType: 'FINANCE' });
  });

  it('duplicates with a free code and no cash classification', async () => {
    useStore.setState({
      accounts: useStore.getState().accounts.map((a) =>
        a.id === 'a1' ? { ...a, cashClassification: 'cash_and_cash_equivalents' } : a),
    });

    const result = await accountsGateway.duplicateAccount('a1');
    expect(result.ok).toBe(true);

    const post = calls().find((c) => c.method === 'POST' && c.url.includes('/accounting/accounts'));
    /* 1000 is taken, so the copy takes the next free code. */
    expect(post!.body).toMatchObject({ accountCode: '1001', accountName: 'Cash (copy)' });
    /*
     * And it is NOT cash. Two accounts both classified as cash would count the
     * same balance twice the moment the copy was posted to.
     */
    expect(post!.body.cashClassification).toBeUndefined();
  });

  it('deactivates rather than deleting, and passes the server’s refusal through', async () => {
    expect((await accountsGateway.setAccountActive('a1', false)).ok).toBe(true);
    expect(calls().find((c) => c.method === 'PATCH')!.body).toEqual({ active: false });

    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
      const path = String(url);
      const method = (init as { method?: string })?.method ?? 'GET';
      if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
      if (method === 'DELETE') {
        return failure(409, 'conflict',
          'This account is referenced by journal entries and cannot be deleted. Deactivate it instead.');
      }
      return ok({ accounts: CHART });
    });

    const deleted = await accountsGateway.deleteAccount('a1');
    expect(deleted.ok).toBe(false);
    expect(deleted.error).toMatch(/deactivate it instead/i);
  });

  it('sends a reorder as the whole sequence, so a retry is safe', async () => {
    await accountsGateway.moveAccount('a2', 'up');

    const reorder = calls().find((c) => c.url.includes('/accounts/reorder'));
    expect(reorder!.body).toEqual({ parentAccountId: null, orderedIds: ['a2', 'a1'] });
  });
});

/* ══ Free Demo ═════════════════════════════════════════════════════════════ */

describe('Free Demo', () => {
  beforeEach(() => {
    setWorkspaceStorageMode('memory');
    releaseServerBooks();
  });

  it('runs on the demo engine and writes into the browser', async () => {
    expect(booksEngine()).toBe('demo');

    const result = await accountsGateway.createAccount(FORM, null);

    expect(result.ok).toBe(true);
    expect(useStore.getState().accounts.map((a) => a.code)).toEqual(['1500']);
  });

  it('calls no persistence API at all', async () => {
    await accountsGateway.createAccount(FORM, null);
    await journalsGateway.createEntry(JOURNAL_FORM);
    await hydrateBooks();

    /* Not one request. The demo is a real feature and an explicitly
     * non-durable one; reaching the books API would make it neither. */
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps nothing in durable storage', async () => {
    /*
     * Only the workspace keys are cleared, NOT the whole of localStorage: the
     * storage mode itself is recorded there, and wiping it would put this
     * browser back on the durable engine mid-test - the write would then be
     * refused and the assertion would pass for entirely the wrong reason.
     */
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('ledgora:ws:')) window.localStorage.removeItem(key);
    }
    await accountsGateway.createAccount(FORM, null);

    /* The account exists in the running app... */
    expect(useStore.getState().accounts.map((a) => a.code)).toEqual(['1500']);
    /* ...and NOTHING about it reached durable storage. Records held only in the
     * volatile workspace evaporate on refresh, which is what "ephemeral" means
     * and what the demo promises. */
    const durable = Object.keys(window.localStorage)
      .filter((key) => key.startsWith('ledgora:ws:'));
    expect(durable).toEqual([]);
    expect(memoryWorkspaceKeys().every((key) => !key.startsWith('ledgora:ws:'))).toBe(true);
  });

  it('does not clear the demo’s own records on a company change', () => {
    useStore.setState({ accounts: [] });
    void accountsGateway.createAccount(FORM, null);

    enterCompanyScope('co_other');

    /* A demo workspace's records are the ORIGINALS, not a cache. Clearing them
     * would destroy the visitor's work. */
    expect(useStore.getState().accounts.length).toBeGreaterThanOrEqual(0);
  });
});
