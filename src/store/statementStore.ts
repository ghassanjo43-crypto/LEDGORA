import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { StatementOptions } from '@/types/statementOfAccount';

/** Sensible default period: the current calendar year to date. */
function defaultOptions(): StatementOptions {
  const now = new Date();
  const year = now.getFullYear();
  const today = now.toISOString().slice(0, 10);
  return {
    statementType: 'balance-forward',
    statementBasis: 'document',
    periodStart: `${year}-01-01`,
    periodEnd: today,
    asOfDate: today,
    currencyMode: 'single-currency',
    currency: 'USD',
    includeSettledInvoices: false,
    includeUnappliedReceipts: true,
    includeAllocationDetails: true,
    includeAging: true,
    includeOutstandingSchedule: true,
    includeZeroValueActivity: false,
  };
}

interface StatementState {
  /** Selected customer (persisted so a refresh keeps the statement open). */
  selectedCustomerId: string;
  options: StatementOptions;

  selectCustomer: (customerId: string) => void;
  setOptions: (patch: Partial<StatementOptions>) => void;
  resetOptions: () => void;
}

/**
 * UI-only preferences for the statement view (no accounting balances stored).
 * Persisted so the customer selection and filters survive a browser refresh.
 */
export const useStatementStore = create<StatementState>()(
  persist(
    (set) => ({
      selectedCustomerId: '',
      options: defaultOptions(),
      selectCustomer: (selectedCustomerId) => set({ selectedCustomerId }),
      setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
      resetOptions: () => set({ options: defaultOptions() }),
    }),
    { name: 'ledgerly-statement-view', storage: businessJSONStorage, version: 1 },
  ),
);
