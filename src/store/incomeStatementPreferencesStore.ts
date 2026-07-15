import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ComparisonMode, DetailLevel, NegativeFormat, PresentationMode } from '@/types/incomeStatement';

interface IncomeStatementPreferencesState {
  presentation: PresentationMode;
  detail: DetailLevel;
  comparison: ComparisonMode;
  showPercentOfRevenue: boolean;
  includeZero: boolean;
  negativeFormat: NegativeFormat;

  setPresentation: (p: PresentationMode) => void;
  setDetail: (d: DetailLevel) => void;
  setComparison: (c: ComparisonMode) => void;
  setShowPercentOfRevenue: (v: boolean) => void;
  setIncludeZero: (v: boolean) => void;
  setNegativeFormat: (f: NegativeFormat) => void;
  resetPreferences: () => void;
}

const DEFAULTS = {
  presentation: 'IAS1' as PresentationMode,
  detail: 'standard' as DetailLevel,
  comparison: 'none' as ComparisonMode,
  showPercentOfRevenue: false,
  includeZero: false,
  negativeFormat: 'parentheses' as NegativeFormat,
};

/** Persisted Income Statement report preferences. */
export const useIncomeStatementPreferences = create<IncomeStatementPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setPresentation: (presentation) => set({ presentation }),
      setDetail: (detail) => set({ detail }),
      setComparison: (comparison) => set({ comparison }),
      setShowPercentOfRevenue: (showPercentOfRevenue) => set({ showPercentOfRevenue }),
      setIncludeZero: (includeZero) => set({ includeZero }),
      setNegativeFormat: (negativeFormat) => set({ negativeFormat }),
      resetPreferences: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'ledgerly-income-statement-prefs',
      version: 1,
      partialize: (s) => ({
        presentation: s.presentation,
        detail: s.detail,
        comparison: s.comparison,
        showPercentOfRevenue: s.showPercentOfRevenue,
        includeZero: s.includeZero,
        negativeFormat: s.negativeFormat,
      }),
    },
  ),
);
