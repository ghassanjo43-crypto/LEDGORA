// @vitest-environment happy-dom
/**
 * Tenant isolation of browser-resident business data.
 *
 * ── The defect these tests exist to prevent recurring ────────────────────────
 * Every accounting store persisted under its bare name — `ifrs-coa-store`,
 * `ifrs-journal-store`, `ledgerly-invoices` — with no organization component, and
 * nothing reset the workspace when a different account signed in. A subscriber
 * opening the application on a browser that had held another subscriber's books
 * therefore read them: chart of accounts, journal, customers, suppliers,
 * invoices, bills, payments, receipts.
 *
 * Separately, several stores shipped DEMO FIXTURES as their default state — nine
 * posted journal entries (and so real balances in every statement) and a demo
 * customer/supplier directory — which appeared in a real subscriber's books even
 * on a pristine browser.
 *
 * ── What is being asserted, and what is not ──────────────────────────────────
 * These prove the storage layer keys by tenant and that the lifecycle blanks and
 * reloads the stores. They do NOT prove production-grade isolation, and cannot:
 * this is all the user's own browser. See the note at the end of the file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ACTIVE_WORKSPACE_KEY,
  WORKSPACE_PREFIX,
  businessDataStorage,
  clearWorkspaceData,
  getActiveWorkspace,
  setActiveWorkspace,
  setWorkspaceStorageMode,
  workspaceKeys,
  workspaceScope,
  type WorkspaceIdentity,
} from '@/lib/workspaceStorage';
import {
  BUSINESS_WORKSPACE_STORES,
  FREE_DEMO_WORKSPACE_ID,
  closeBusinessWorkspace,
  openBusinessWorkspace,
  purgeBusinessWorkspace,
  resetBusinessWorkspaceForTenant,
} from '@/store/businessWorkspace';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useProjectStore } from '@/store/projectStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import {
  buildTrialBalanceRows,
  calculateTrialBalanceTotals,
} from '@/lib/trialBalanceCalculations';

const PERIOD = { from: '1900-01-01', to: '2999-12-31' };

/** The trial balance the statements and dashboard are built from. */
function trialBalanceTotals() {
  const rows = buildTrialBalanceRows(
    useStore.getState().accounts,
    useJournalStore.getState().entries,
    PERIOD,
    'USD',
  );
  return { rows, totals: calculateTrialBalanceTotals(rows) };
}

const ORG_A: WorkspaceIdentity = { kind: 'tenant', organizationId: 'org-aaaa' };
const ORG_B: WorkspaceIdentity = { kind: 'tenant', organizationId: 'org-bbbb' };
const DEMO: WorkspaceIdentity = { kind: 'demo', organizationId: FREE_DEMO_WORKSPACE_ID };

beforeEach(() => {
  window.localStorage.clear();
  setWorkspaceStorageMode('backend');
});

afterEach(() => {
  setActiveWorkspace(null);
  window.localStorage.clear();
});

/** Post a balanced entry into whichever workspace is currently open. */
function postEntry(reference: string, amount: number): void {
  const accounts = useStore.getState().accounts.filter((a) => a.isPostingAccount);
  const debit = accounts[0]!;
  const credit = accounts[1]!;
  const result = useJournalStore.getState().insertPostedEntry({
    entryDate: '2026-01-15',
    reference,
    description: `Test ${reference}`,
    currency: 'USD',
    exchangeRate: 1,
    lines: [
      { accountId: debit.id, debit: amount, credit: 0 },
      { accountId: credit.id, debit: 0, credit: amount },
    ],
  });
  expect(result.ok, `posting ${reference} failed: ${result.error ?? ''}`).toBe(true);
}

/* ── A new organization starts empty ──────────────────────────────────────── */

describe('a newly created organization', () => {
  it('opens with zero transactions and zero balances', () => {
    openBusinessWorkspace(ORG_A);

    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useInvoiceStore.getState().invoices).toEqual([]);

    // And therefore no balances anywhere the statements derive from.
    const { rows, totals } = trialBalanceTotals();
    expect(rows.every((row) => row.periodDebits === 0 && row.periodCredits === 0)).toBe(true);
    expect(totals.periodDebits).toBe(0);
    expect(totals.periodCredits).toBe(0);
    expect(totals.closingDebit).toBe(0);
    expect(totals.closingCredit).toBe(0);
  });

  it('carries no demo customers or suppliers', () => {
    openBusinessWorkspace(ORG_A);
    // The seeded directory is a demo fixture and must not appear in real books.
    expect(useEntityStore.getState().entities).toEqual([]);
  });

  it('carries no demo projects or cost centres', () => {
    openBusinessWorkspace(ORG_A);
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useCostCenterStore.getState().costCenters).toEqual([]);
  });

  it('receives the chart of accounts template, with no postings against it', () => {
    openBusinessWorkspace(ORG_A);

    const accounts = useStore.getState().accounts;
    // The template is intentional — a new organization should not start with a
    // blank chart of accounts.
    expect(accounts.length).toBeGreaterThan(0);
    // But it is a TEMPLATE: nothing has been posted to any of it.
    expect(useJournalStore.getState().entries).toHaveLength(0);

    // And the template records live under THIS organization's namespace, so
    // they are its own records rather than rows shared with another tenant.
    const keys = workspaceKeys(ORG_A);
    expect(keys.some((key) => key.endsWith('ifrs-coa-store'))).toBe(true);
    expect(keys.every((key) => key.startsWith(workspaceScope(ORG_A)))).toBe(true);
  });
});

/* ── One organization cannot reach another's records ──────────────────────── */

describe('cross-tenant access', () => {
  it('keeps organization A’s records out of organization B', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 1500);
    useInvoiceStore.setState({
      invoices: [{ id: 'inv-a', invoiceNumber: 'A-INV-1' } as never],
    });
    expect(useJournalStore.getState().entries).toHaveLength(1);

    // A different subscriber signs in on the SAME browser.
    openBusinessWorkspace(ORG_B);

    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useInvoiceStore.getState().invoices).toEqual([]);

    // Physically separate namespaces — not a filter someone has to remember.
    const aKeys = workspaceKeys(ORG_A);
    const bKeys = workspaceKeys(ORG_B);
    expect(aKeys.length).toBeGreaterThan(0);
    expect(aKeys.some((key) => bKeys.includes(key))).toBe(false);

    // Nothing A wrote is addressable from B's scope.
    const serialisedB = bKeys.map((key) => window.localStorage.getItem(key) ?? '').join('');
    expect(serialisedB).not.toContain('A-001');
    expect(serialisedB).not.toContain('A-INV-1');
  });

  it('returns organization A’s own records when A is reopened', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 1500);

    openBusinessWorkspace(ORG_B);
    postEntry('B-001', 99);
    expect(useJournalStore.getState().entries).toHaveLength(1);
    expect(useJournalStore.getState().entries[0]!.reference).toBe('B-001');

    // Back to A: its own single entry, not B's.
    openBusinessWorkspace(ORG_A);
    expect(useJournalStore.getState().entries).toHaveLength(1);
    expect(useJournalStore.getState().entries[0]!.reference).toBe('A-001');
  });

  it('cannot be bypassed by writing another tenant’s key by hand', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 1500);

    // Forge a payload under a bare, unscoped key — the shape the old defect used.
    window.localStorage.setItem(
      'ifrs-journal-store',
      JSON.stringify({ state: { entries: [{ id: 'forged', reference: 'FORGED' }] }, version: 3 }),
    );

    openBusinessWorkspace(ORG_B);
    /*
     * The adapter only ever addresses SCOPED keys, so the bare one is
     * unreachable: what comes back is B's own (empty) journal, never the forged
     * payload sitting under the unscoped name.
     */
    const served = businessDataStorage.getItem('ifrs-journal-store') ?? '';
    expect(served).not.toContain('FORGED');
    expect(window.localStorage.getItem('ifrs-journal-store')).toContain('FORGED');
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(JSON.stringify(useJournalStore.getState().entries)).not.toContain('FORGED');
  });
});

/* ── Sign-out and sign-in on one browser ──────────────────────────────────── */

describe('signing out of A and into B in the same browser', () => {
  it('leaks no cached records', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 4200);
    useEntityStore.setState({ entities: [{ id: 'ent-a', legalName: 'Alpha Customer' } as never] });

    closeBusinessWorkspace();
    // Nothing addressable, and nothing left in memory for the next account.
    expect(getActiveWorkspace()).toBeNull();
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useEntityStore.getState().entities).toEqual([]);

    openBusinessWorkspace(ORG_B);
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useEntityStore.getState().entities).toEqual([]);
    expect(JSON.stringify(useEntityStore.getState().entities)).not.toContain('Alpha Customer');
  });

  it('does not destroy the signed-out tenant’s data', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 4200);
    const before = workspaceKeys(ORG_A).length;
    expect(before).toBeGreaterThan(0);

    closeBusinessWorkspace();

    // Signing out is not a request to delete the books.
    expect(workspaceKeys(ORG_A).length).toBe(before);
    openBusinessWorkspace(ORG_A);
    expect(useJournalStore.getState().entries).toHaveLength(1);
  });

  it('reloads every tenant-dependent store when the organization changes', () => {
    // Every registered business store must be re-read on a switch, or a store
    // nobody remembered to reset keeps the previous tenant's records on screen.
    // Both workspaces are established first, so the switch back to A takes the
    // rehydrate path rather than first-open initialisation.
    openBusinessWorkspace(ORG_A);
    openBusinessWorkspace(ORG_B);

    const rehydrated: string[] = [];
    const restore: Array<() => void> = [];
    for (const entry of BUSINESS_WORKSPACE_STORES) {
      const persist = entry.store().persist;
      const original = persist.rehydrate;
      persist.rehydrate = () => {
        rehydrated.push(entry.key);
        return original.call(persist);
      };
      restore.push(() => {
        persist.rehydrate = original;
      });
    }

    try {
      openBusinessWorkspace(ORG_A);
      expect(rehydrated.sort()).toEqual(BUSINESS_WORKSPACE_STORES.map((e) => e.key).sort());
    } finally {
      for (const undo of restore) undo();
    }
  });

  it('does nothing when the organization has not actually changed', () => {
    /*
     * Re-opening the active workspace must be inert. The shell calls this from
     * an effect that re-runs on unrelated state changes, and a rehydrate there
     * would discard unsaved work — or, on a workspace whose marker was missing,
     * blank the books outright.
     */
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 500);

    openBusinessWorkspace(ORG_A);
    expect(useJournalStore.getState().entries).toHaveLength(1);
    expect(useJournalStore.getState().entries[0]!.reference).toBe('A-001');
  });
});

/* ── Demo data is confined to the demo workspace ──────────────────────────── */

describe('demo seed data', () => {
  it('appears in the designated demo workspace', () => {
    openBusinessWorkspace(DEMO);
    // The demo is the ONE workspace that is supposed to look populated.
    expect(useJournalStore.getState().entries.length).toBeGreaterThan(0);
    expect(useEntityStore.getState().entities.length).toBeGreaterThan(0);
  });

  it('never appears in a real subscriber workspace', () => {
    openBusinessWorkspace(DEMO);
    const demoRefs = useJournalStore.getState().entries.map((e) => e.reference);
    expect(demoRefs.length).toBeGreaterThan(0);

    openBusinessWorkspace(ORG_A);
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useEntityStore.getState().entities).toEqual([]);

    // Nothing in the tenant's namespace mentions a demo reference.
    const serialised = workspaceKeys(ORG_A)
      .map((key) => window.localStorage.getItem(key) ?? '')
      .join('');
    for (const reference of demoRefs) expect(serialised).not.toContain(reference);
  });

  it('keeps the demo workspace in its own namespace', () => {
    openBusinessWorkspace(DEMO);
    openBusinessWorkspace(ORG_A);
    const demoKeys = workspaceKeys(DEMO);
    const tenantKeys = workspaceKeys(ORG_A);
    expect(demoKeys.some((key) => tenantKeys.includes(key))).toBe(false);
  });
});

/* ── Reports derive only from the active organization ─────────────────────── */

describe('financial statements and dashboard totals', () => {
  it('are calculated solely from the active organization’s records', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 1000);
    expect(trialBalanceTotals().totals.periodDebits).toBe(1000);

    openBusinessWorkspace(ORG_B);
    postEntry('B-001', 25);
    // B's totals reflect B alone — A's 1000 is nowhere in them.
    const bTotals = trialBalanceTotals().totals;
    expect(bTotals.periodDebits).toBe(25);
    expect(bTotals.periodCredits).toBe(25);
  });
});

/* ── The storage adapter itself ───────────────────────────────────────────── */

describe('the workspace storage adapter', () => {
  it('writes nothing durable while no workspace is open', () => {
    setActiveWorkspace(null);
    businessDataStorage.setItem('ifrs-journal-store', '{"state":{"entries":[]}}');

    // Fail closed: an early write must not land on a shared, unscoped key.
    expect(window.localStorage.getItem('ifrs-journal-store')).toBeNull();
    const durable = Object.keys(window.localStorage).filter((k) => k.startsWith(WORKSPACE_PREFIX));
    expect(durable).toHaveLength(0);
  });

  it('namespaces every key it writes', () => {
    openBusinessWorkspace(ORG_A);
    businessDataStorage.setItem('some-store', 'value');
    expect(window.localStorage.getItem(`${workspaceScope(ORG_A)}some-store`)).toBe('value');
    expect(window.localStorage.getItem('some-store')).toBeNull();
  });

  it('records the active workspace outside the business namespace', () => {
    openBusinessWorkspace(ORG_A);
    expect(getActiveWorkspace()).toEqual(ORG_A);
    // Session information, not business data — so clearing a tenant's records
    // does not clear the pointer, and vice versa.
    expect(ACTIVE_WORKSPACE_KEY.startsWith(WORKSPACE_PREFIX)).toBe(false);
  });

  it('treats a corrupt workspace marker as no workspace rather than guessing', () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, 'not json');
    expect(getActiveWorkspace()).toBeNull();
    expect(businessDataStorage.getItem('ifrs-journal-store')).toBeNull();
  });

  it('clears only the named tenant’s records', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 10);
    openBusinessWorkspace(ORG_B);
    postEntry('B-001', 20);

    const removed = clearWorkspaceData(ORG_A);
    expect(removed).toBeGreaterThan(0);
    expect(workspaceKeys(ORG_A)).toHaveLength(0);
    // B is untouched — a scoped delete cannot reach another tenant.
    expect(workspaceKeys(ORG_B).length).toBeGreaterThan(0);
  });
});

/* ── What survives a server-side tenant deletion ──────────────────────────── */

/**
 * The books are in the browser, so deleting a subscriber on the server cannot
 * touch them. These tests state that plainly rather than leaving it implied, and
 * pin down the one mechanism that does remove them.
 */
describe('a tenant deleted on the server', () => {
  it('still has its books in this browser until something purges them', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 100);
    postEntry('A-002', 250);

    expect(useJournalStore.getState().entries).toHaveLength(2);

    /*
     * Simulate everything the server-side purge actually achieves in this
     * browser: the account is gone, so the session ends and the workspace
     * closes. That is the whole of its reach.
     */
    closeBusinessWorkspace();

    // On screen: nothing. In storage: everything.
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(
      workspaceKeys(ORG_A).length,
      'the ledger is still physically present after the server-side deletion',
    ).toBeGreaterThan(0);

    const stored = workspaceKeys(ORG_A)
      .map((key) => window.localStorage.getItem(key) ?? '')
      .join('');
    expect(stored, 'the posted entries are still readable in localStorage').toContain('A-001');
  });

  it('is genuinely erased by purgeBusinessWorkspace, and only that tenant', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 100);
    openBusinessWorkspace(ORG_B);
    postEntry('B-001', 200);

    expect(workspaceKeys(ORG_A).length).toBeGreaterThan(0);

    const removed = purgeBusinessWorkspace(ORG_A);
    expect(removed).toBeGreaterThan(0);

    // A is gone from disk, including its "already initialised" marker.
    expect(workspaceKeys(ORG_A)).toEqual([]);

    // B is untouched: a scoped purge cannot reach another tenant.
    expect(workspaceKeys(ORG_B).length).toBeGreaterThan(0);
    const bStored = workspaceKeys(ORG_B)
      .map((key) => window.localStorage.getItem(key) ?? '')
      .join('');
    expect(bStored).toContain('B-001');
    expect(bStored).not.toContain('A-001');
  });

  it('closes the workspace when the purged tenant is the one on screen', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 100);
    expect(getActiveWorkspace()).toEqual(ORG_A);

    purgeBusinessWorkspace(ORG_A);

    expect(getActiveWorkspace(), 'a destroyed tenant must not stay the active workspace').toBeNull();
    expect(useJournalStore.getState().entries).toEqual([]);
  });

  it('re-opens a purged tenant as an empty workspace, not a half-initialised one', () => {
    openBusinessWorkspace(ORG_A);
    postEntry('A-001', 100);
    purgeBusinessWorkspace(ORG_A);

    // Re-opening the same id must seed a fresh workspace rather than rehydrate
    // from nothing — that is what dropping the initialised marker buys.
    openBusinessWorkspace(ORG_A);
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useStore.getState().accounts.length, 'a re-opened tenant gets the template back').toBeGreaterThan(
      0,
    );
  });
});

/* ── The tenant starting state, independent of storage ────────────────────── */

describe('resetBusinessWorkspaceForTenant', () => {
  it('empties business records but keeps configuration templates', () => {
    resetBusinessWorkspaceForTenant();

    // Business records: empty.
    expect(useJournalStore.getState().entries).toEqual([]);
    expect(useEntityStore.getState().entities).toEqual([]);
    expect(useInvoiceStore.getState().invoices).toEqual([]);
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useCostCenterStore.getState().costCenters).toEqual([]);

    // Configuration templates: present, because a new organization needs them.
    expect(useStore.getState().accounts.length).toBeGreaterThan(0);
  });
});
