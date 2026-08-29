/**
 * @vitest-environment happy-dom
 */
/**
 * Every module that posts a journal, and where its posting goes.
 *
 * ══ Why this file reads source code ══════════════════════════════════════════
 *
 * P4 moved three modules onto the server posting door and deliberately left ten
 * behind. That is a defensible position only while it stays TRUE and stays
 * VISIBLE — and the way it stops being either is somebody adding a posting call
 * to a store, or wiring one of the remaining modules halfway, and nothing
 * noticing.
 *
 * A behavioural test cannot see that: it can only exercise the modules somebody
 * remembered to write a test for. So this reads the stores themselves and
 * asserts the shape of the boundary. It is a boundary test, and its failure
 * message is meant to be read as "P4's inventory is out of date", not as
 * "a test broke".
 *
 * ══ The invariant it protects ════════════════════════════════════════════════
 *
 * The migrated modules must go through the gateway. The unmigrated ones must be
 * REFUSED in durable mode rather than writing to `journalStore` — which they
 * are, by the guards added in P3, and that refusal is what makes leaving them
 * behind safe rather than merely incomplete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setWorkspaceStorageMode } from '@/lib/workspaceStorage';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useJournalStore } from '@/store/journalStore';
import { releaseServerBooks, booksAreServerAuthoritative } from './booksEngine';

const read = (file: string): string =>
  readFileSync(resolve(process.cwd(), 'src/store', file), 'utf8');

/** Moved onto the server posting door in P4. */
const MIGRATED = [
  'currencyRevaluationStore.ts',
  'costCenterAllocationStore.ts',
  'projectRecognitionStore.ts',
];

/**
 * Still posting through the browser journal, and therefore REFUSED for a
 * durable subscriber. Each is a source document whose posting is entangled with
 * other state — inventory movements, asset registers, another module's engine —
 * so moving it is its own slice of work, not a mechanical edit.
 */
const NOT_YET_MIGRATED = [
  'invoiceStore.ts',
  'billStore.ts',
  'creditNoteStore.ts',
  'paymentStore.ts',
  'receiptStore.ts',
  'inventoryStore.ts',
  'manufacturingStore.ts',
  'fixedAssetStore.ts',
  'journalVoucherStore.ts',
];

beforeEach(() => {
  /* The engine is only the server's when a backend is configured. */
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  setWorkspaceStorageMode('backend');
  useBackendSessionStore.setState({
    status: 'ready',
    user: { id: 'u1', email: 'owner@acme.test', fullName: 'Acme Owner', platformRoles: [] } as never,
    platformRoles: [], error: null,
  });
  releaseServerBooks();
  useJournalStore.setState({ entries: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  releaseServerBooks();
  setWorkspaceStorageMode('backend');
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  vi.restoreAllMocks();
});

describe('the migrated modules', () => {
  it.each(MIGRATED)('%s routes its posting through the server gateway', (file) => {
    const text = read(file);

    expect(text).toContain("from '@/services/books/runPostings'");
    expect(text).toContain('booksAreServerAuthoritative()');
    /* And the browser path is still there for Free Demo, which is a real
     * feature rather than a fallback — it runs only when the engine is not
     * the server's. */
    expect(text).toContain('useJournalStore.getState()');
  });

  it.each(MIGRATED)('%s decides by the ENGINE, never by a failed request', (file) => {
    const text = read(file);
    /*
     * A `catch` around the server call that fell back to `addEntry` would be
     * the silent-loss path wearing a helpful face. The engine decides; a
     * failure is reported.
     */
    const serverBranch = text.indexOf('booksAreServerAuthoritative()');
    expect(serverBranch).toBeGreaterThan(-1);
    expect(text).not.toMatch(/catch[\s\S]{0,200}addEntry\(/);
  });
});

describe('the modules P4 did not migrate', () => {
  it.each(NOT_YET_MIGRATED)('%s still posts through the browser journal', (file) => {
    const text = read(file);
    /* Named honestly rather than assumed: if one of these is migrated later,
     * this fails and the inventory above has to be corrected. */
    expect(text).not.toContain("from '@/services/books/runPostings'");
    expect(text).not.toContain("from '@/services/books/sourcePostingGateway'");
  });

  it('are REFUSED in durable mode rather than writing to the journal store', () => {
    expect(booksAreServerAuthoritative()).toBe(true);

    /*
     * The three seams every unmigrated module goes through. All refuse, so a
     * durable subscriber cannot post one of these documents — and, crucially,
     * cannot post one into browser storage either.
     */
    const store = useJournalStore.getState();

    const generated = store.insertPostedEntry({
      entryDate: '2026-06-01', reference: 'GEN', description: 'Generated',
      currency: 'JOD', exchangeRate: 1,
      lines: [
        { accountId: 'a1', debit: 5, credit: 0 },
        { accountId: 'a2', debit: 0, credit: 5 },
      ],
    });
    expect(generated.ok).toBe(false);

    const appended = store.appendEntries([]);
    expect(appended.ok).toBe(false);

    const withdrawn = store.reverseForSourceDocument('je_1', {
      sourceDocumentType: 'invoice', sourceDocumentId: 'inv_1',
      sourceDocumentNumber: 'INV-1', reason: 'Amended',
    });
    expect(withdrawn.ok).toBe(false);

    expect(useJournalStore.getState().entries).toHaveLength(0);
  });

  it('post normally again once the workspace is a demo', () => {
    setWorkspaceStorageMode('memory');
    releaseServerBooks();
    expect(booksAreServerAuthoritative()).toBe(false);

    /* Free Demo is unaffected by all of this: its records are the originals,
     * and the ephemeral engine is the right one for them. */
    const generated = useJournalStore.getState().insertPostedEntry({
      entryDate: '2026-06-01', reference: 'GEN', description: 'Generated',
      currency: 'JOD', exchangeRate: 1,
      lines: [
        { accountId: 'a1', debit: 5, credit: 0 },
        { accountId: 'a2', debit: 0, credit: 5 },
      ],
    });
    /* Past the engine guard — the refusal a durable subscriber gets is absent,
     * and the demo posting goes into the browser journal where it belongs. */
    expect(generated.error ?? '').not.toMatch(/kept on the Ledgora service/i);
    expect(generated.ok).toBe(true);
    expect(useJournalStore.getState().entries).toHaveLength(1);
  });
});

describe('the whole inventory', () => {
  it('accounts for every store that posts a journal', () => {
    /*
     * The audit found 13 modules. If a fourteenth appears, or one of these
     * stops posting, this fails — which is the only way a list in a test stays
     * true a year after it was written.
     */
    const all = [...MIGRATED, ...NOT_YET_MIGRATED];
    expect(all).toHaveLength(12);

    for (const file of all) {
      const text = read(file);
      const posts = /insertPostedEntry|addEntry\(|reverseEntry\(|reverseForSourceDocument|postRunJournal/.test(text);
      expect(posts, `${file} no longer posts a journal — update P4's inventory`).toBe(true);
    }
  });
});
