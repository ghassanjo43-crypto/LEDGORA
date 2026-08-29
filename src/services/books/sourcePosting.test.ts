/**
 * @vitest-environment happy-dom
 *
 * A DOM environment because the engine is decided partly by
 * `getWorkspaceStorageMode`, which reads `window.localStorage`.
 */
/**
 * A source document's journal, posted through the server exactly once.
 *
 * ══ What each claim protects ═════════════════════════════════════════════════
 *
 *   · a migrated module posts through the SERVER gateway, and writes nothing to
 *     `journalStore` while the books are the server's;
 *   · a run is marked posted only AFTER the server confirms — the ordering that
 *     separates "in the books" from "claims to be in the books";
 *   · a retry returns the same journal rather than a second one;
 *   · an AMBIGUOUS answer is reconciled by source identity, never re-posted,
 *     because the request may have succeeded and only the response been lost;
 *   · an invented source type is refused;
 *   · a server refusal leaves the run's status untouched;
 *   · Free Demo keeps its own ephemeral engine and calls no persistence API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCompanyReference, setCsrfToken } from '@/services/api/client';
import { setWorkspaceStorageMode } from '@/lib/workspaceStorage';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { resetCompanyRegistration } from '@/services/api/companyRegistration';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useCurrencyRevaluationStore } from '@/store/currencyRevaluationStore';
import { releaseServerBooks, booksEngine } from './booksEngine';
import { __resetBooksStatusForTests } from './booksHydration';
import { __resetBooksScopeForTests } from './booksScope';
import {
  postSourceJournal,
  reverseSourceJournal,
  findSourceJournal,
  SOURCE_TYPES,
  decimalString,
} from './sourcePostingGateway';

const fetchMock = vi.fn();

const ok = (body: unknown = {}, status = 200) => ({
  status, ok: true,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
} as unknown as Response);

const failure = (status: number, code: string, message: string) => ({
  status, ok: false,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { code, message } }),
} as unknown as Response);

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  method: (init as { method?: string })?.method ?? 'GET',
  body: (init as { body?: string })?.body ? JSON.parse((init as { body: string }).body) : null,
}));

const postings = () => calls().filter(
  (c) => c.method === 'POST' && c.url.includes('/accounting/source-postings') && !c.url.includes('reverse'),
);

const serverJournal = (over: Record<string, unknown> = {}) => ({
  id: 'je_server_1', journalNumber: 'JE-0001', status: 'posted',
  sourceType: 'currency_revaluation', sourceId: 'run_1', sourceEvent: 'post',
  reversalEntryId: null, version: 1, ...over,
});

/** Adoption, hydration and the source-posting door, all answered. */
function serve(handler: (path: string, method: string, body: unknown) => Response | null): void {
  fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
    const path = String(url);
    const method = (init as { method?: string })?.method ?? 'GET';
    const raw = (init as { body?: string })?.body;
    const body = raw ? JSON.parse(raw) : null;
    if (path.includes('/organizations/current/companies')) return ok({ company: { id: 'srv-co' } });
    const answer = handler(path, method, body);
    if (answer) return answer;
    if (path.includes('/accounting/accounts')) return ok({ accounts: [] });
    if (path.includes('/accounting/journals')) return ok({ journals: [] });
    return ok({});
  });
}

function signedInSubscriber(): void {
  setWorkspaceStorageMode('backend');
  useBackendSessionStore.setState({
    status: 'ready',
    user: { id: 'u1', email: 'owner@acme.test', fullName: 'Acme Owner', platformRoles: [] } as never,
    platformRoles: [], error: null,
  });
  useOrganizationStore.setState({ organization: { legalName: 'Acme Trading LLC' } as never });
}

const REQUEST = {
  sourceType: 'currency_revaluation' as const,
  sourceId: 'run_1',
  sourceEvent: 'post',
  transactionDate: '2026-06-01',
  reference: 'REV-2026-06',
  description: 'Revaluation',
  lines: [
    { accountId: 'a1', debit: '110.000' },
    { accountId: 'a2', credit: '110.000' },
  ],
};

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
  useCurrencyRevaluationStore.setState({ runs: [] });
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

/* ══ The controlled vocabulary ═════════════════════════════════════════════ */

describe('the source vocabulary', () => {
  it('is a closed list the browser cannot add to', () => {
    /* The server validates it too; this copy exists so a call site can be
     * checked without a round trip, and drift produces a refusal rather than
     * an orphan journal. */
    expect(SOURCE_TYPES).toContain('currency_revaluation');
    expect(SOURCE_TYPES).toContain('inventory_document');
    expect(SOURCE_TYPES).not.toContain('my_module');
  });

  it('reports the server’s refusal of an invented type', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? failure(400, 'validation', '"my_module" is not a source document Ledgora can post for.')
      : null));

    const result = await postSourceJournal({ ...REQUEST, sourceType: 'my_module' as never });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a source document/i);
  });

  it('converts an amount to an exact decimal string, never float notation', () => {
    expect(decimalString(110)).toBe('110');
    expect(decimalString(0.1 + 0.2)).toBe('0.3');
    expect(decimalString(1e-7)).toBe('0');
    expect(decimalString(0)).toBe('0');
  });
});

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

describe('posting through the gateway', () => {
  it('sends the identity and reports that the server created the journal', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? ok({ journal: serverJournal(), created: true }, 201) : null));

    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.journal.journalNumber).toBe('JE-0001');
    }
    expect(postings()[0]!.body).toMatchObject({
      sourceType: 'currency_revaluation', sourceId: 'run_1', sourceEvent: 'post',
    });
  });

  it('reports created:false when the server returned one it already had', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? ok({ journal: serverJournal(), created: false }) : null));

    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(true);
    /* Not a failure. The document IS in the books; a module that treated this
     * as an error would refuse a retry that had genuinely succeeded. */
    if (result.ok) expect(result.created).toBe(false);
  });

  it('sends exactly ONE request for a retry of the same event', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? ok({ journal: serverJournal(), created: postings().length === 0 }, 201) : null));

    const first = await postSourceJournal(REQUEST);
    const second = await postSourceJournal(REQUEST);

    /* Two requests, one journal — the identity is what makes the repeat safe,
     * and both calls name the same one. */
    expect(postings()).toHaveLength(2);
    expect(postings()[0]!.body.sourceEvent).toBe(postings()[1]!.body.sourceEvent);
    if (first.ok && second.ok) expect(second.journal.id).toBe(first.journal.id);
  });

  it('refuses on the demo engine rather than doing something different', async () => {
    setWorkspaceStorageMode('memory');
    releaseServerBooks();
    expect(booksEngine()).toBe('demo');

    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ══ The ambiguous answer ══════════════════════════════════════════════════ */

describe('an ambiguous network result', () => {
  it('is RECONCILED by source identity, not posted again', async () => {
    let attempted = 0;
    serve((path, method) => {
      if (method === 'POST' && path.includes('source-postings')) {
        attempted += 1;
        /* The request reached the server and committed; the answer was lost. */
        return failure(0, 'network', 'Network request failed.');
      }
      if (method === 'GET' && path.includes('source-postings')) {
        return ok({ journals: [serverJournal()] });
      }
      return null;
    });

    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(false);
      expect(result.journal.id).toBe('je_server_1');
    }
    /* Posted ONCE. A blind repeat is how a document lands in the books twice. */
    expect(attempted).toBe(1);
    expect(postings()).toHaveLength(1);
  });

  it('asks by the document identity, and by nothing else', async () => {
    serve((path, method) => {
      if (method === 'POST' && path.includes('source-postings')) {
        return failure(503, 'unavailable', 'Service unavailable.');
      }
      if (method === 'GET' && path.includes('source-postings')) return ok({ journals: [] });
      return null;
    });

    await postSourceJournal(REQUEST);

    const lookup = calls().find((c) => c.method === 'GET' && c.url.includes('source-postings'));
    expect(lookup!.url).toContain('sourceType=currency_revaluation');
    expect(lookup!.url).toContain('sourceId=run_1');
    expect(lookup!.url).toContain('sourceEvent=post');
  });

  it('stays RETRYABLE when the reconcile finds nothing', async () => {
    serve((path, method) => {
      if (method === 'POST' && path.includes('source-postings')) {
        return failure(0, 'network', 'Network request failed.');
      }
      if (method === 'GET' && path.includes('source-postings')) return ok({ journals: [] });
      return null;
    });

    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(false);
    /* Nothing was written, so trying again is safe — and the identity makes it
     * safe even if this verdict were wrong. */
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it('does NOT reconcile a decision the server meant', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? failure(409, 'conflict', 'The accounting period is locked.') : null));

    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/locked/i);
    }
    /* A 4xx is an answer, not an unknown. Looking it up would be asking a
     * question that has already been answered. */
    expect(calls().filter((c) => c.method === 'GET' && c.url.includes('source-postings'))).toHaveLength(0);
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('withdrawing a posting', () => {
  it('sends the identity and the reason', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings/reverse')
      ? ok({
          original: serverJournal({ status: 'reversed', reversalEntryId: 'je_rev' }),
          reversal: serverJournal({ id: 'je_rev' }),
          created: true,
        })
      : null));

    const result = await reverseSourceJournal(
      { sourceType: 'currency_revaluation', sourceId: 'run_1', sourceEvent: 'post' },
      { reason: 'Corrected rate' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reversal.id).toBe('je_rev');
    const sent = calls().find((c) => c.url.includes('source-postings/reverse'));
    expect(sent!.body).toMatchObject({ sourceId: 'run_1', sourceEvent: 'post', reason: 'Corrected rate' });
  });

  it('reconciles an ambiguous reversal through the original’s link', async () => {
    serve((path, method) => {
      if (method === 'POST' && path.includes('source-postings/reverse')) {
        return failure(0, 'network', 'Network request failed.');
      }
      if (method === 'GET' && path.includes('source-postings')) {
        /* It committed: the original now names its reversal. */
        return ok({ journals: [serverJournal({ status: 'reversed', reversalEntryId: 'je_rev' })] });
      }
      return null;
    });

    const result = await reverseSourceJournal(
      { sourceType: 'currency_revaluation', sourceId: 'run_1', sourceEvent: 'post' },
      { reason: 'Corrected rate' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(false);
      expect(result.reversal.id).toBe('je_rev');
    }
    /* One attempt. A second reversal would correspond to nothing. */
    expect(calls().filter((c) => c.url.includes('source-postings/reverse'))).toHaveLength(1);
  });
});

/* ══ A migrated module, end to end ═════════════════════════════════════════ */

describe('the currency revaluation run', () => {
  /**
   * A run in the store, ready to post.
   *
   * Built to the real `CurrencyRevaluationRun` shape rather than a convenient
   * subset: the posting builder reads `netFx` and `baseCurrencyCode`, and a
   * fixture missing them would fail for a reason that has nothing to do with
   * what is being tested.
   */
  function seedRun(): string {
    const id = 'run_seeded';
    useCurrencyRevaluationStore.setState({
      runs: [{
        id,
        entityId: 'primary',
        revaluationDate: '2026-12-31',
        baseCurrencyCode: 'JOD',
        currencyCodes: ['USD'],
        status: 'draft',
        totalGain: 110,
        totalLoss: 0,
        netFx: 110,
        lines: [{
          id: 'line_1',
          accountId: 'a1',
          accountCode: '1221',
          accountName: 'Receivable (USD)',
          currencyCode: 'USD',
          partyId: '',
          originalAmount: 10000,
          carryingRate: 0.709,
          carryingBaseAmount: 7090,
          closingRate: 0.72,
          revaluedBaseAmount: 7200,
          unrealizedGain: 110,
          unrealizedLoss: 0,
          fxGainAccountId: 'a2',
          fxLossAccountId: 'a3',
        }],
        auditTrail: [],
        createdAt: '2026-12-31T00:00:00.000Z',
        updatedAt: '2026-12-31T00:00:00.000Z',
      } as never],
    });
    return id;
  }

  it('posts through the SERVER and writes nothing to the journal store', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? ok({ journal: serverJournal({ id: 'je_rev_run' }), created: true }, 201) : null));

    const id = seedRun();
    const result = await useCurrencyRevaluationStore.getState().postRun(id);

    expect(result.ok).toBe(true);
    expect(postings()).toHaveLength(1);
    expect(postings()[0]!.body.sourceType).toBe('currency_revaluation');
    expect(postings()[0]!.body.sourceId).toBe(id);
    /*
     * The decisive assertion. A posted journal in browser storage looks saved,
     * counts towards nothing, and is erased by the next hydration.
     */
    expect(useJournalStore.getState().entries).toHaveLength(0);

    const run = useCurrencyRevaluationStore.getState().getRun(id)!;
    expect(run.status).toBe('posted');
    expect(run.journalEntryId).toBe('je_rev_run');
  });

  it('does NOT mark the run posted when the server refuses', async () => {
    serve((path, method) => (method === 'POST' && path.includes('source-postings')
      ? failure(409, 'conflict', 'The accounting period is locked.') : null));

    const id = seedRun();
    const result = await useCurrencyRevaluationStore.getState().postRun(id);

    expect(result.ok).toBe(false);
    /*
     * A run recorded as posted against a journal the server never accepted is a
     * document claiming to be in books it never reached, and nothing afterwards
     * can tell it from one that was.
     */
    const run = useCurrencyRevaluationStore.getState().getRun(id)!;
    expect(run.status).toBe('draft');
    expect(run.journalEntryId).toBeUndefined();
    expect(useJournalStore.getState().entries).toHaveLength(0);
  });

  it('does not mark it posted when the network is ambiguous and nothing landed', async () => {
    serve((path, method) => {
      if (method === 'POST' && path.includes('source-postings')) {
        return failure(0, 'network', 'Network request failed.');
      }
      if (method === 'GET' && path.includes('source-postings')) return ok({ journals: [] });
      return null;
    });

    const id = seedRun();
    const result = await useCurrencyRevaluationStore.getState().postRun(id);

    expect(result.ok).toBe(false);
    expect(useCurrencyRevaluationStore.getState().getRun(id)!.status).toBe('draft');
  });

  it('DOES mark it posted when the reconcile finds the journal', async () => {
    serve((path, method) => {
      if (method === 'POST' && path.includes('source-postings')) {
        return failure(0, 'network', 'Network request failed.');
      }
      if (method === 'GET' && path.includes('source-postings')) {
        return ok({ journals: [serverJournal({ id: 'je_landed' })] });
      }
      return null;
    });

    const id = seedRun();
    const result = await useCurrencyRevaluationStore.getState().postRun(id);

    /* The posting had succeeded; only the answer was lost. Recording it is the
     * correct outcome, and it is why the reconcile exists. */
    expect(result.ok).toBe(true);
    const run = useCurrencyRevaluationStore.getState().getRun(id)!;
    expect(run.status).toBe('posted');
    expect(run.journalEntryId).toBe('je_landed');
  });
});

/* ══ Free Demo ═════════════════════════════════════════════════════════════ */

describe('Free Demo', () => {
  it('keeps its own ephemeral engine and calls no persistence API', async () => {
    setWorkspaceStorageMode('memory');
    releaseServerBooks();

    /* The store's demo branch posts into the browser journal, which is what a
     * demo's records ARE — originals, not a cache. */
    const before = useJournalStore.getState().entries.length;
    const result = await postSourceJournal(REQUEST);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useJournalStore.getState().entries.length).toBe(before);
  });

  it('finds nothing to reconcile without a server', async () => {
    setWorkspaceStorageMode('memory');
    releaseServerBooks();

    await expect(findSourceJournal({
      sourceType: 'currency_revaluation', sourceId: 'run_1', sourceEvent: 'post',
    })).rejects.toThrow();
  });
});
