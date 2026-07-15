import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NegativeFormat } from '@/types/incomeStatement';
import type { CashFlowPolicy } from '@/types/cashFlow';
import { DEFAULT_CASH_FLOW_POLICY } from '@/types/cashFlow';

interface CashFlowPreferencesState {
  detail: boolean;
  includeZero: boolean;
  showUnclassified: boolean;
  negativeFormat: NegativeFormat;
  policy: CashFlowPolicy;

  setDetail: (v: boolean) => void;
  setIncludeZero: (v: boolean) => void;
  setShowUnclassified: (v: boolean) => void;
  setNegativeFormat: (f: NegativeFormat) => void;
  setPolicy: (patch: Partial<CashFlowPolicy>) => void;
  resetPreferences: () => void;
}

const DEFAULTS = {
  detail: true,
  includeZero: false,
  showUnclassified: true,
  negativeFormat: 'parentheses' as NegativeFormat,
  policy: DEFAULT_CASH_FLOW_POLICY,
};

/** Persisted Statement of Cash Flows preferences + accounting policy. */
export const useCashFlowPreferences = create<CashFlowPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setDetail: (detail) => set({ detail }),
      setIncludeZero: (includeZero) => set({ includeZero }),
      setShowUnclassified: (showUnclassified) => set({ showUnclassified }),
      setNegativeFormat: (negativeFormat) => set({ negativeFormat }),
      setPolicy: (patch) => set((s) => ({ policy: { ...s.policy, ...patch } })),
      resetPreferences: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'ledgerly-cash-flow-prefs',
      version: 1,
      partialize: (s) => ({ detail: s.detail, includeZero: s.includeZero, showUnclassified: s.showUnclassified, negativeFormat: s.negativeFormat, policy: s.policy }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CashFlowPreferencesState>;
        return { ...current, ...p, policy: { ...DEFAULT_CASH_FLOW_POLICY, ...(p.policy ?? {}) } };
      },
    },
  ),
);
