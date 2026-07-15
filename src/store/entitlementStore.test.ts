import { describe, it, expect, beforeEach } from 'vitest';
import { useEntitlementStore } from './entitlementStore';
import { useJournalStore, makeDefaultJournalValues, makeEmptyLine } from './journalStore';
import { useStore } from './useStore';
import {
  filterNavigationByEntitlements,
  canAccessView,
  NAV_GROUPS,
} from '@/config/navigation';
import { canShowDashboardWidget } from '@/config/dashboardWidgets';
import { EDITION_MODULES } from '@/config/editions';

const ent = () => useEntitlementStore.getState();

/** Two distinct posting-leaf account ids for a balanced test entry. */
function twoPostingAccounts(): [string, string] {
  const posting = useStore.getState().accounts.filter((a) => a.isPostingAccount);
  return [posting[0]!.id, posting[1]!.id];
}

beforeEach(() => {
  useEntitlementStore.getState().resetToDefault(); // Enterprise / active
  useJournalStore.getState().resetToDefault();
});

/* ── Store defaults & actions ─────────────────────────────────────────────── */

describe('entitlement store', () => {
  it('defaults to an active Enterprise development subscription', () => {
    expect(ent().subscription.edition).toBe('enterprise');
    expect(ent().subscription.status).toBe('active');
    expect(ent().hasModule('projects')).toBe(true);
  });

  it('switching edition re-resolves owned modules immediately', () => {
    ent().setEdition('core');
    expect(ent().hasModule('projects')).toBe(false);
    expect(ent().hasModule('cost_centers')).toBe(false);
    expect(ent().hasModule('core_accounting')).toBe(true);
    ent().setEdition('projects');
    expect(ent().hasModule('projects')).toBe(true);
    expect(ent().hasModule('construction_projects')).toBe(false);
  });

  it('switching to Manufacturing owns manufacturing modules but not Projects', () => {
    ent().setEdition('manufacturing');
    expect(ent().hasModule('manufacturing_core')).toBe(true);
    expect(ent().hasModule('manufacturing_work_orders')).toBe(true);
    expect(ent().hasModule('inventory_basic')).toBe(true);
    expect(ent().hasModule('cost_centers')).toBe(true);
    expect(ent().hasModule('projects')).toBe(false);
    // switching away hides manufacturing again
    ent().setEdition('core');
    expect(ent().hasModule('manufacturing_core')).toBe(false);
    expect(ent().hasModule('inventory_basic')).toBe(false);
  });

  it('enables an add-on without upgrading the edition', () => {
    ent().setEdition('core');
    ent().enableModule('cost_centers');
    expect(ent().hasModule('cost_centers')).toBe(true);
    expect(ent().hasModule('projects')).toBe(false);
    expect(ent().subscription.edition).toBe('core');
  });

  it('downgrade hides modules but records the change in the audit trail', () => {
    ent().setEdition('projects');
    ent().setEdition('core');
    const events = ent().auditTrail.map((a) => a.event);
    expect(events).toContain('edition-selected');
  });

  it('records audit events for status, modules and activation', () => {
    ent().enableModule('multi_entity');
    ent().suspendSubscription('test');
    ent().activateSubscription({ bankRemittanceReference: 'TT-1' });
    const events = ent().auditTrail.map((a) => a.event);
    expect(events).toContain('module-enabled');
    expect(events).toContain('subscription-suspended');
    expect(events).toContain('subscription-activated');
    expect(events).toContain('bank-remittance-recorded');
  });
});

/* ── Selector safety ──────────────────────────────────────────────────────── */

describe('selector safety', () => {
  it('effectiveModuleIds keeps a stable reference until the subscription changes', () => {
    const a = ent().effectiveModuleIds;
    const b = ent().effectiveModuleIds;
    expect(a).toBe(b); // never rebuilt on read
    ent().setEdition('core');
    const c = ent().effectiveModuleIds;
    expect(c).not.toBe(a); // rebuilt only on change
  });
});

/* ── Navigation filtering ─────────────────────────────────────────────────── */

describe('navigation filtering', () => {
  it('Core hides Projects, Cost Centers and advanced groups/items', () => {
    const groups = filterNavigationByEntitlements(EDITION_MODULES.core);
    const ids = groups.map((g) => g.id);
    expect(ids).not.toContain('projects');
    expect(ids).not.toContain('cost-centers');
    // Tax group present but only basic items
    const tax = groups.find((g) => g.id === 'tax');
    expect(tax).toBeDefined();
    const taxKeys = tax!.items.map((i) => i.key);
    expect(taxKeys).toContain('tax-codes');
    expect(taxKeys).not.toContain('tax-groups');
    expect(taxKeys).not.toContain('tax-jurisdictions');
    // Currency group only basic items
    const cur = groups.find((g) => g.id === 'currency');
    expect(cur!.items.map((i) => i.key)).not.toContain('fx-gain-loss');
  });

  it('Manufacturing shows Manufacturing + Inventory groups, hides Projects/Construction', () => {
    const groups = filterNavigationByEntitlements(EDITION_MODULES.manufacturing);
    const ids = groups.map((g) => g.id);
    expect(ids).toContain('manufacturing');
    expect(ids).toContain('inventory');
    expect(ids).toContain('cost-centers'); // cost centers ship with Manufacturing
    expect(ids).not.toContain('projects');
    // manufacturing group has its work-order item
    const mfg = groups.find((g) => g.id === 'manufacturing')!;
    expect(mfg.items.map((i) => i.key)).toContain('manufacturing-work-orders');
  });

  it('Core never exposes Manufacturing or Inventory terminology', () => {
    const groups = filterNavigationByEntitlements(EDITION_MODULES.core);
    const ids = groups.map((g) => g.id);
    expect(ids).not.toContain('manufacturing');
    expect(ids).not.toContain('inventory');
    for (const g of groups) {
      for (const item of g.items) {
        const l = item.label.toLowerCase();
        expect(l).not.toContain('work order');
        expect(l).not.toContain('bill of material');
        expect(l).not.toContain('routing');
      }
    }
  });

  it('Projects shows Projects and Cost Centers, hides Construction', () => {
    const groups = filterNavigationByEntitlements(EDITION_MODULES.projects);
    const ids = groups.map((g) => g.id);
    expect(ids).toContain('projects');
    expect(ids).toContain('cost-centers');
    // no construction group exists yet — assert no construction-labelled items leak
    for (const g of groups) {
      for (const item of g.items) {
        expect(item.label.toLowerCase()).not.toContain('boq');
        expect(item.label.toLowerCase()).not.toContain('retention');
      }
    }
  });

  it('removes empty groups and preserves order', () => {
    const groups = filterNavigationByEntitlements(EDITION_MODULES.core);
    // every returned group must have at least one item
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    // order preserved relative to NAV_GROUPS
    const order = NAV_GROUPS.map((g) => g.id);
    const returned = groups.map((g) => g.id);
    const positions = returned.map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('always shows Dashboard, Subscription and Settings regardless of edition', () => {
    const groups = filterNavigationByEntitlements(EDITION_MODULES.core);
    const keys = groups.flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toContain('dashboard');
    expect(keys).toContain('subscription');
    expect(keys).toContain('settings');
  });
});

/* ── Route/view access ────────────────────────────────────────────────────── */

describe('view access (route guard)', () => {
  it('Core cannot access protected views', () => {
    const core = EDITION_MODULES.core;
    expect(canAccessView(core, 'projects')).toBe(false);
    expect(canAccessView(core, 'cost-centers')).toBe(false);
    expect(canAccessView(core, 'tax-groups')).toBe(false);
    expect(canAccessView(core, 'currency-revaluation')).toBe(false);
    // but core views are reachable
    expect(canAccessView(core, 'journal')).toBe(true);
    expect(canAccessView(core, 'invoices')).toBe(true);
    expect(canAccessView(core, 'tax-codes')).toBe(true);
    expect(canAccessView(core, 'subscription')).toBe(true);
  });

  it('Construction can access construction-tier and project views', () => {
    const c = EDITION_MODULES.construction;
    expect(canAccessView(c, 'projects')).toBe(true);
    expect(canAccessView(c, 'cost-centers')).toBe(true);
  });

  it('Core cannot access manufacturing views; Manufacturing can', () => {
    const core = EDITION_MODULES.core;
    const mfg = EDITION_MODULES.manufacturing;
    for (const view of [
      'manufacturing-work-orders',
      'manufacturing-bom',
      'inventory-items',
      'inventory-warehouses',
    ] as const) {
      expect(canAccessView(core, view)).toBe(false);
      expect(canAccessView(mfg, view)).toBe(true);
    }
    // manufacturing customers still cannot reach project/construction views
    expect(canAccessView(mfg, 'projects')).toBe(false);
  });
});

/* ── Dashboard filtering ──────────────────────────────────────────────────── */

describe('dashboard widget filtering', () => {
  it('hides widgets whose module is not owned', () => {
    const onlyCore = ['core_accounting'] as const;
    expect(canShowDashboardWidget([...onlyCore], 'financial-summary')).toBe(true);
    expect(canShowDashboardWidget([...onlyCore], 'receivables')).toBe(false); // needs sales
    expect(canShowDashboardWidget([...onlyCore], 'payables')).toBe(false); // needs purchases
    expect(canShowDashboardWidget(EDITION_MODULES.core, 'receivables')).toBe(true);
  });
});

/* ── Manufacturing downgrade preserves data ───────────────────────────────── */

describe('manufacturing downgrade preserves data', () => {
  it('keeps posted journal metadata and GL totals unchanged when Manufacturing is disabled', () => {
    ent().setEdition('manufacturing');
    const [a, b] = twoPostingAccounts();
    const values = makeDefaultJournalValues('JE-MFG', 'USD');
    values.description = 'Material issue (Dr WIP / Cr raw material)';
    values.lines = [
      { ...makeEmptyLine(), accountId: a, debit: 400, credit: 0, costCenter: 'cc_plant' },
      { ...makeEmptyLine(), accountId: b, debit: 0, credit: 400 },
    ];
    const added = useJournalStore.getState().addEntry(values);
    expect(added.ok).toBe(true);
    useJournalStore.getState().postEntry(added.id!);

    const before = useJournalStore.getState().entries.find((e) => e.id === added.id)!;
    const beforeCount = useJournalStore.getState().entries.length;

    // Downgrade Manufacturing → Core (removes manufacturing + inventory + cost centers from UI)
    ent().setEdition('core');
    expect(ent().hasModule('manufacturing_core')).toBe(false);

    const after = useJournalStore.getState().entries.find((e) => e.id === added.id)!;
    expect(after).toBeDefined(); // nothing deleted
    expect(useJournalStore.getState().entries.length).toBe(beforeCount);
    expect(after.totalDebit).toBe(before.totalDebit); // GL unchanged
    expect(after.totalCredit).toBe(before.totalCredit);
    expect(after.lines.find((l) => l.costCenter === 'cc_plant')).toBeDefined(); // metadata preserved
    expect(after.status).toBe('posted');
  });

  it('blocks new production posting while suspended (manufacturing edition)', () => {
    ent().setEdition('manufacturing');
    ent().suspendSubscription('unpaid');
    const [a, b] = twoPostingAccounts();
    const values = makeDefaultJournalValues('JE-MFG2', 'USD');
    values.lines = [
      { ...makeEmptyLine(), accountId: a, debit: 100, credit: 0 },
      { ...makeEmptyLine(), accountId: b, debit: 0, credit: 100 },
    ];
    const blocked = useJournalStore.getState().addEntry(values);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/suspend/i);
  });
});

/* ── Posting guard integration (journal is the central chokepoint) ────────── */

describe('subscription posting block', () => {
  function balancedValues() {
    const [a, b] = twoPostingAccounts();
    const values = makeDefaultJournalValues('JE-TEST', 'USD');
    values.description = 'Guard test';
    values.lines = [
      { ...makeEmptyLine(), accountId: a, debit: 100, credit: 0 },
      { ...makeEmptyLine(), accountId: b, debit: 0, credit: 100 },
    ];
    return values;
  }

  it('allows posting while active', () => {
    const added = useJournalStore.getState().addEntry(balancedValues());
    expect(added.ok).toBe(true);
    const posted = useJournalStore.getState().postEntry(added.id!);
    expect(posted.ok).toBe(true);
  });

  it('blocks new posting while suspended and preserves existing data', () => {
    const added = useJournalStore.getState().addEntry(balancedValues());
    expect(added.ok).toBe(true);
    const before = useJournalStore.getState().entries.length;

    ent().suspendSubscription('test');
    const posted = useJournalStore.getState().postEntry(added.id!);
    expect(posted.ok).toBe(false);
    expect(posted.error).toMatch(/suspend/i);
    // new draft creation is also blocked (no orphan drafts)
    const blockedAdd = useJournalStore.getState().addEntry(balancedValues());
    expect(blockedAdd.ok).toBe(false);
    // existing data untouched
    expect(useJournalStore.getState().entries.length).toBe(before);

    // reactivation restores posting
    ent().activateSubscription({ bankRemittanceReference: 'TT-9' });
    const reposted = useJournalStore.getState().postEntry(added.id!);
    expect(reposted.ok).toBe(true);
  });
});

/* ── Downgrade preserves journal metadata & GL balances ───────────────────── */

describe('downgrade preserves historical data', () => {
  it('keeps journal dimension metadata and GL totals unchanged after downgrade', () => {
    const [a, b] = twoPostingAccounts();
    const values = makeDefaultJournalValues('JE-DIM', 'USD');
    values.description = 'Dimensioned';
    values.lines = [
      { ...makeEmptyLine(), accountId: a, debit: 250, credit: 0, costCenter: 'cc_seed', project: 'prj_seed' },
      { ...makeEmptyLine(), accountId: b, debit: 0, credit: 250 },
    ];
    const added = useJournalStore.getState().addEntry(values);
    useJournalStore.getState().postEntry(added.id!);

    const before = useJournalStore.getState().entries.find((e) => e.id === added.id)!;
    const beforeTotals = { d: before.totalDebit, c: before.totalCredit };
    const dimLineBefore = before.lines.find((l) => l.project === 'prj_seed');
    expect(dimLineBefore).toBeDefined();

    // Downgrade Enterprise → Core (removes projects + cost_centers from UI)
    ent().setEdition('core');

    const after = useJournalStore.getState().entries.find((e) => e.id === added.id)!;
    // nothing deleted
    expect(after).toBeDefined();
    // metadata preserved on the posted line
    const dimLineAfter = after.lines.find((l) => l.project === 'prj_seed');
    expect(dimLineAfter).toBeDefined();
    expect(dimLineAfter!.costCenter).toBe('cc_seed');
    expect(dimLineAfter!.project).toBe('prj_seed');
    // GL balances unchanged
    expect(after.totalDebit).toBe(beforeTotals.d);
    expect(after.totalCredit).toBe(beforeTotals.c);
    expect(after.status).toBe('posted');
  });
});
