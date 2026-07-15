import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NegativeFormat } from '@/types/incomeStatement';

interface BalanceSheetPreferencesState {
  detail: boolean;
  includeZero: boolean;
  negativeFormat: NegativeFormat;

  setDetail: (v: boolean) => void;
  setIncludeZero: (v: boolean) => void;
  setNegativeFormat: (f: NegativeFormat) => void;
  resetPreferences: () => void;
}

const DEFAULTS = { detail: true, includeZero: false, negativeFormat: 'parentheses' as NegativeFormat };

/** Persisted Balance Sheet report preferences. */
export const useBalanceSheetPreferences = create<BalanceSheetPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setDetail: (detail) => set({ detail }),
      setIncludeZero: (includeZero) => set({ includeZero }),
      setNegativeFormat: (negativeFormat) => set({ negativeFormat }),
      resetPreferences: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'ledgerly-balance-sheet-prefs',
      version: 1,
      partialize: (s) => ({ detail: s.detail, includeZero: s.includeZero, negativeFormat: s.negativeFormat }),
    },
  ),
);
