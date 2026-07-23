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
  reset: () => void;
}

export const BUSINESS_WORKSPACE_STORES: WorkspaceStoreEntry[] = [
  { key: 'chart-of-accounts', store: () => useStore, reset: () => useStore.getState().resetToDefault() },
  { key: 'entities', store: () => useEntityStore, reset: () => useEntityStore.getState().resetToDefault() },
  { key: 'journal', store: () => useJournalStore, reset: () => useJournalStore.getState().resetToDefault() },
  { key: 'invoices', store: () => useInvoiceStore, reset: () => useInvoiceStore.getState().resetToDefault() },
  { key: 'credit-notes', store: () => useCreditNoteStore, reset: () => useCreditNoteStore.getState().resetToDefault() },
  { key: 'receipts', store: () => useReceiptStore, reset: () => useReceiptStore.getState().resetToDefault() },
  { key: 'bills', store: () => useBillStore, reset: () => useBillStore.getState().resetToDefault() },
  { key: 'payments', store: () => usePaymentStore, reset: () => usePaymentStore.getState().resetToDefault() },
  { key: 'inventory', store: () => useInventoryStore, reset: () => useInventoryStore.getState().resetToDefault() },
  { key: 'manufacturing', store: () => useManufacturingStore, reset: () => useManufacturingStore.getState().resetToDefault() },
  { key: 'projects', store: () => useProjectStore, reset: () => useProjectStore.getState().resetToDefault() },
  { key: 'project-budgets', store: () => useProjectBudgetStore, reset: () => useProjectBudgetStore.getState().resetToDefault() },
  { key: 'project-delivery', store: () => useProjectDeliveryStore, reset: () => useProjectDeliveryStore.getState().resetToDefault() },
  { key: 'project-recognition', store: () => useProjectRecognitionStore, reset: () => useProjectRecognitionStore.getState().resetToDefault() },
  { key: 'cost-centers', store: () => useCostCenterStore, reset: () => useCostCenterStore.getState().resetToDefault() },
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

/** Re-read every business store from the current workspace storage. */
export function rehydrateBusinessWorkspace(): void {
  for (const entry of BUSINESS_WORKSPACE_STORES) void entry.store().persist.rehydrate();
}
