/**
 * The registry of stores that hold *business data* (books, documents, stock,
 * production, projects, tax, currencies, metered usage).
 *
 * All of them persist through `businessJSONStorage`, so switching the workspace
 * storage mode switches all of them at once. This module owns the two workspace
 * lifecycle operations that the onboarding flow needs:
 *
 *   - `resetBusinessWorkspace()`  — return every store to its seeded defaults
 *     (entering Free Demo, leaving Free Demo, signing out).
 *   - `rehydrateBusinessWorkspace()` — re-read the durable workspace after the
 *     storage mode changes back to `'backend'`.
 *
 * Platform stores (auth, session, organization/subscription, billing packages,
 * entitlements, metering configuration) are deliberately NOT in this list: they
 * are account/configuration state, not the subscriber's books, and the
 * onboarding screens must keep working after a demo workspace is discarded.
 */
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { useInvoiceStore } from './invoiceStore';
import { useCreditNoteStore } from './creditNoteStore';
import { useReceiptStore } from './receiptStore';
import { useBillStore } from './billStore';
import { usePaymentStore } from './paymentStore';
import { useInventoryStore } from './inventoryStore';
import { useManufacturingStore } from './manufacturingStore';
import { useProjectStore } from './projectStore';
import { useProjectBudgetStore } from './projectBudgetStore';
import { useProjectDeliveryStore } from './projectDeliveryStore';
import { useProjectRecognitionStore } from './projectRecognitionStore';
import { useCostCenterStore } from './costCenterStore';
import { useCostCenterBudgetStore } from './costCenterBudgetStore';
import { useCostCenterAllocationStore } from './costCenterAllocationStore';
import { useCurrencyStore } from './currencyStore';
import { useExchangeRateStore } from './exchangeRateStore';
import { useCurrencyRevaluationStore } from './currencyRevaluationStore';
import { useTaxCodeStore } from './taxCodeStore';
import { useTaxPeriodStore } from './taxPeriodStore';
import { useCompanyStore } from './companyStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useStatementStore } from './statementStore';
import { useUsageStore } from './usageStore';
import { useFixedAssetStore } from './fixedAssetStore';
import { useJournalVoucherStore } from './journalVoucherStore';
import { useAmendmentPolicyStore } from './amendmentPolicyStore';
import { useAmendmentAuditStore } from './amendmentAuditStore';
import {
  clearWorkspaceData,
  getActiveWorkspace,
  setActiveWorkspace,
  workspaceScope,
  type WorkspaceIdentity,
} from '@/lib/workspaceStorage';

/** Minimal shape we need from a persisted zustand store. */
interface PersistedStore {
  persist: { rehydrate: () => void | Promise<void> };
}

interface WorkspaceStoreEntry {
  /** Human-readable name (used in diagnostics/tests). */
  key: string;
  /**
   * Lazy accessor, NOT a captured value: several business stores sit on import
   * cycles (e.g. journalStore → entitlementHooks → platform session stores →
   * sessionMirror → freeDemoSession → this module), so snapshotting the import
   * at module evaluation could freeze an as-yet-undefined binding. Resolving at
   * call time always sees the fully-initialised store.
   */
  store: () => PersistedStore;
  /** The store's shipped default — which for several stores means DEMO data. */
  reset: () => void;
  /**
   * Empty this store for a real subscriber.
   *
   * Present only where `reset()` would install demo records. A new tenant must
   * open its books with nothing in them, and several stores ship seeded: the
   * journal carries nine POSTED demo entries (and therefore real balances in
   * every statement), and the entity directory carries demo customers and
   * suppliers. Those are fixtures for the demo workspace, and they have no
   * business appearing in a subscriber's books.
   *
   * Stores WITHOUT a `clearForTenant` are ones whose `reset()` is either already
   * empty (invoices, bills, payments, inventory, manufacturing, fixed assets…)
   * or a legitimate configuration TEMPLATE a new organization should start with
   * (chart of accounts, currency master, tax codes, invoice templates). Those
   * templates are written under the new organization's own scoped key, so they
   * are that organization's records — never shared rows owned by another tenant.
   */
  clearForTenant?: () => void;
}

export const BUSINESS_WORKSPACE_STORES: WorkspaceStoreEntry[] = [
  { key: 'chart-of-accounts', store: () => useStore, reset: () => useStore.getState().resetToDefault() },
  {
    key: 'entities',
    store: () => useEntityStore,
    reset: () => useEntityStore.getState().resetToDefault(),
    // SEED_ENTITIES is a demo customer/supplier directory.
    clearForTenant: () => useEntityStore.setState({ entities: [] }),
  },
  {
    key: 'journal',
    store: () => useJournalStore,
    reset: () => useJournalStore.getState().resetToDefault(),
    // SEED_JOURNAL_ENTRIES is nine POSTED demo transactions — real balances in
    // the trial balance, the ledger and every financial statement.
    clearForTenant: () => useJournalStore.setState({ entries: [] }),
  },
  { key: 'invoices', store: () => useInvoiceStore, reset: () => useInvoiceStore.getState().resetToDefault() },
  /*
   * The posted-document amendment stores.
   *
   * They belong here for the same reason every other document store does: they
   * hold the SUBSCRIBER's records — who that organization authorised to amend
   * its posted documents, and the trail of every amendment attempted against
   * its books. Left out of this registry they persisted under the right
   * workspace key but never rehydrated when one was opened, so switching
   * organizations left the previous tenant's policy and trail sitting in memory
   * under the next tenant's name. Both have an empty `reset()`, so no
   * `clearForTenant` is needed — a new tenant starts with no grants and no
   * history, which is exactly right.
   */
  { key: 'amendment-policy', store: () => useAmendmentPolicyStore, reset: () => useAmendmentPolicyStore.getState().resetToDefault() },
  { key: 'amendment-audit', store: () => useAmendmentAuditStore, reset: () => useAmendmentAuditStore.getState().resetToDefault() },
  { key: 'credit-notes', store: () => useCreditNoteStore, reset: () => useCreditNoteStore.getState().resetToDefault() },
  { key: 'receipts', store: () => useReceiptStore, reset: () => useReceiptStore.getState().resetToDefault() },
  { key: 'bills', store: () => useBillStore, reset: () => useBillStore.getState().resetToDefault() },
  { key: 'payments', store: () => usePaymentStore, reset: () => usePaymentStore.getState().resetToDefault() },
  { key: 'inventory', store: () => useInventoryStore, reset: () => useInventoryStore.getState().resetToDefault() },
  { key: 'manufacturing', store: () => useManufacturingStore, reset: () => useManufacturingStore.getState().resetToDefault() },
  {
    key: 'projects',
    store: () => useProjectStore,
    reset: () => useProjectStore.getState().resetToDefault(),
    clearForTenant: () => useProjectStore.setState({ projects: [] }),
  },
  { key: 'project-budgets', store: () => useProjectBudgetStore, reset: () => useProjectBudgetStore.getState().resetToDefault() },
  { key: 'project-delivery', store: () => useProjectDeliveryStore, reset: () => useProjectDeliveryStore.getState().resetToDefault() },
  { key: 'project-recognition', store: () => useProjectRecognitionStore, reset: () => useProjectRecognitionStore.getState().resetToDefault() },
  {
    key: 'cost-centers',
    store: () => useCostCenterStore,
    reset: () => useCostCenterStore.getState().resetToDefault(),
    clearForTenant: () => useCostCenterStore.setState({ costCenters: [] }),
  },
  { key: 'cost-center-budgets', store: () => useCostCenterBudgetStore, reset: () => useCostCenterBudgetStore.getState().resetToDefault() },
  { key: 'cost-center-allocations', store: () => useCostCenterAllocationStore, reset: () => useCostCenterAllocationStore.getState().resetToDefault() },
  { key: 'currencies', store: () => useCurrencyStore, reset: () => useCurrencyStore.getState().resetToDefault() },
  { key: 'exchange-rates', store: () => useExchangeRateStore, reset: () => useExchangeRateStore.getState().resetToDefault() },
  { key: 'currency-revaluations', store: () => useCurrencyRevaluationStore, reset: () => useCurrencyRevaluationStore.getState().resetToDefault() },
  { key: 'tax-codes', store: () => useTaxCodeStore, reset: () => useTaxCodeStore.getState().resetToDefault() },
  { key: 'tax-periods', store: () => useTaxPeriodStore, reset: () => useTaxPeriodStore.getState().resetToDefault() },
  { key: 'invoice-templates', store: () => useInvoiceTemplateStore, reset: () => useInvoiceTemplateStore.getState().resetToDefault() },
  { key: 'usage', store: () => useUsageStore, reset: () => useUsageStore.getState().resetToDefault() },
  { key: 'fixed-assets', store: () => useFixedAssetStore, reset: () => useFixedAssetStore.getState().resetToDefault() },
  { key: 'journal-vouchers', store: () => useJournalVoucherStore, reset: () => useJournalVoucherStore.getState().resetToDefault() },
  // Company registry re-initialises itself from the working stores on next read.
  { key: 'companies', store: () => useCompanyStore, reset: () => useCompanyStore.setState({ companies: [], activeCompanyId: '' }) },
  // Statement view preferences (customer selection) belong to the workspace too.
  {
    key: 'statement-view',
    store: () => useStatementStore,
    reset: () => {
      useStatementStore.getState().selectCustomer('');
      useStatementStore.getState().resetOptions();
    },
  },
];

/** Return every business store to its seeded default state. */
export function resetBusinessWorkspace(): void {
  for (const entry of BUSINESS_WORKSPACE_STORES) entry.reset();
}

/**
 * Return every business store to the state a NEW SUBSCRIBER should open with:
 * configuration templates present, business records empty.
 *
 * `reset()` first, so the template stores get their templates, then
 * `clearForTenant()` over the ones whose defaults are demo fixtures.
 */
export function resetBusinessWorkspaceForTenant(): void {
  for (const entry of BUSINESS_WORKSPACE_STORES) {
    entry.reset();
    entry.clearForTenant?.();
  }
}

/** Re-read every business store from the current workspace storage. */
export function rehydrateBusinessWorkspace(): void {
  for (const entry of BUSINESS_WORKSPACE_STORES) void entry.store().persist.rehydrate();
}

/* ── Workspace lifecycle ──────────────────────────────────────────────────── */

/**
 * Marks a workspace as initialised. Scoped like every other workspace key, so
 * one organization's marker says nothing about another's.
 */
const INITIALISED_MARKER = '__ledgora_workspace_initialised';

/**
 * The one designated demo workspace.
 *
 * Seed fixtures are installed for THIS id and no other, which is what makes
 * "demo data appears only in an explicitly designated demo organization" a
 * property of the code rather than a convention.
 */
export const FREE_DEMO_WORKSPACE_ID = 'free-demo';

function markerKey(identity: WorkspaceIdentity): string {
  return `${workspaceScope(identity)}${INITIALISED_MARKER}`;
}

function isInitialised(identity: WorkspaceIdentity): boolean {
  try {
    return window.localStorage.getItem(markerKey(identity)) === '1';
  } catch {
    return false;
  }
}

function markInitialised(identity: WorkspaceIdentity): void {
  try {
    window.localStorage.setItem(markerKey(identity), '1');
  } catch {
    // Storage unavailable (private mode). The workspace still works for this
    // session; it simply re-initialises next time, which is empty either way.
  }
}

/**
 * Open one organization's books.
 *
 * The ONE entry point for "which tenant are we looking at?". It does three
 * things, in an order that matters:
 *
 *  1. points the storage adapter at this organization's namespace, so every
 *     subsequent read and write addresses that tenant's keys and no other's;
 *  2. on FIRST open, lays down the starting state — empty books for a real
 *     subscriber, seeded fixtures only for the demo workspace;
 *  3. rehydrates every business store from the newly-active namespace, which is
 *     what makes switching organizations reload the books rather than leave the
 *     previous tenant's records sitting in memory.
 *
 * Step 3 is not optional even when nothing is stored: without it the stores keep
 * whatever the last workspace put in them, and the screen would show the
 * previous tenant's data despite the storage layer being correctly scoped.
 */
export function openBusinessWorkspace(identity: WorkspaceIdentity): void {
  /*
   * Re-opening the workspace that is ALREADY open is a no-op.
   *
   * Not an optimisation — a correctness requirement. This is called from a React
   * effect that re-runs whenever its inputs change, and without this guard a
   * benign re-render would rehydrate (discarding unsaved in-memory work) or, on
   * a workspace whose marker had not been written, re-initialise and blank the
   * books outright. "Open X" when X is open must mean nothing happened.
   */
  const active = getActiveWorkspace();
  if (active && active.kind === identity.kind && active.organizationId === identity.organizationId) {
    return;
  }

  setActiveWorkspace(identity);

  const firstOpen = !isInitialised(identity);
  if (firstOpen) {
    // Establish the starting state BEFORE hydrating, then let the stores persist
    // it into this workspace's own namespace.
    if (identity.kind === 'demo') resetBusinessWorkspace();
    else resetBusinessWorkspaceForTenant();
    markInitialised(identity);
    return;
  }

  rehydrateBusinessWorkspace();
}

/**
 * Close the active workspace (sign-out).
 *
 * Deliberately NON-destructive: the tenant's durable records are left exactly
 * where they are, and only made unreachable by clearing the active-workspace
 * marker. Signing out is not a request to destroy the account's books. The
 * in-memory stores are then blanked so nothing stays on screen or in memory for
 * whoever signs in next.
 */
export function closeBusinessWorkspace(): void {
  setActiveWorkspace(null);
  resetBusinessWorkspaceForTenant();
}

/**
 * Destroy one organization's browser-resident books.
 *
 * ── When this may be called ──────────────────────────────────────────────────
 * ONLY with an organization id the SERVER has confirmed it deleted. Never from
 * an inference such as "no organization is loaded" or "the fetch failed": a
 * session that has not resolved yet, an offline reload and a genuinely deleted
 * tenant all look identical from here, and acting on that guess would destroy a
 * live subscriber's ledger. `openBusinessWorkspace` deliberately keeps guessing
 * out of the durable path for the same reason, and `closeBusinessWorkspace`
 * (sign-out) is non-destructive precisely because signing out is not a request
 * to delete anything.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * Ledgora's accounting records live in browser storage, so the server-side purge
 * cannot reach them. It can only make them unreachable through the application
 * by destroying the account. This is the one mechanism that removes the bytes,
 * and it necessarily runs in whichever browser holds them — which is why it
 * cleans up the operator's own machine after a cleanup run and cannot do
 * anything about a tenant user's laptop.
 *
 * Scoped by construction: `clearWorkspaceData` can only address keys under this
 * workspace's own prefix, so purging one tenant cannot reach another's.
 */
export function purgeBusinessWorkspace(identity: WorkspaceIdentity): number {
  const removed = clearWorkspaceData(identity);

  // Drop the "already initialised" marker too, so the id cannot come back as a
  // half-open workspace that skips seeding and rehydrates from nothing.
  try {
    window.localStorage.removeItem(markerKey(identity));
  } catch {
    // Storage unavailable; there was nothing durable to remove either.
  }

  // If the purged tenant was on screen, stop showing it.
  const active = getActiveWorkspace();
  if (active && active.kind === identity.kind && active.organizationId === identity.organizationId) {
    closeBusinessWorkspace();
  }

  return removed;
}
