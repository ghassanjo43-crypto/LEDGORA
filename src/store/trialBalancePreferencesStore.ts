import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TrialBalanceViewMode } from '@/types/trialBalance';

type ActiveFilter = 'active' | 'all' | 'inactive';

interface TrialBalancePreferencesState {
  viewMode: TrialBalanceViewMode;
  grouped: boolean;
  includeZero: boolean;
  active: ActiveFilter;
  rowsPerPage: number;

  setViewMode: (m: TrialBalanceViewMode) => void;
  setGrouped: (g: boolean) => void;
  setIncludeZero: (v: boolean) => void;
  setActive: (a: ActiveFilter) => void;
  setRowsPerPage: (n: number) => void;
  resetPreferences: () => void;
}

const DEFAULTS = {
  viewMode: 'movement' as TrialBalanceViewMode,
  grouped: true,
  includeZero: false,
  active: 'active' as ActiveFilter,
  rowsPerPage: 50,
};

/** Persisted Trial Balance report preferences. */
export const useTrialBalancePreferences = create<TrialBalancePreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setViewMode: (viewMode) => set({ viewMode }),
      setGrouped: (grouped) => set({ grouped }),
      setIncludeZero: (includeZero) => set({ includeZero }),
      setActive: (active) => set({ active }),
      setRowsPerPage: (rowsPerPage) => set({ rowsPerPage }),
      resetPreferences: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'ledgerly-trial-balance-prefs',
      version: 1,
      partialize: (s) => ({ viewMode: s.viewMode, grouped: s.grouped, includeZero: s.includeZero, active: s.active, rowsPerPage: s.rowsPerPage }),
    },
  ),
);
