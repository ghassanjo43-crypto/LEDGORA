import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  DashboardDensity,
  DashboardWidgetId,
  DashboardWidgetPreference,
  ReportingPeriodId,
} from '@/types/dashboard';

/** Canonical widget order + labels used for the default layout and customiser. */
export const WIDGET_META: { id: DashboardWidgetId; label: string }[] = [
  { id: 'financial-summary', label: 'Financial summary' },
  { id: 'operational-status', label: 'Operational status' },
  { id: 'cash-flow', label: 'Cash flow' },
  { id: 'income-expense', label: 'Income & expenses' },
  { id: 'receivables', label: 'Receivables' },
  { id: 'payables', label: 'Payables' },
  { id: 'top-expenses', label: 'Top expenses' },
  { id: 'bank-accounts', label: 'Bank & cash accounts' },
  { id: 'attention-required', label: 'Attention required' },
  { id: 'recent-activity', label: 'Recent activity' },
  { id: 'business-overview', label: 'Business overview' },
];

export function defaultWidgetPreferences(): DashboardWidgetPreference[] {
  return WIDGET_META.map((w, i) => ({ id: w.id, visible: true, order: i }));
}

interface DashboardPreferencesState {
  widgets: DashboardWidgetPreference[];
  density: DashboardDensity;
  periodId: ReportingPeriodId;
  customFrom: string;
  customTo: string;

  setPeriod: (id: ReportingPeriodId) => void;
  setCustomRange: (from: string, to: string) => void;
  setDensity: (d: DashboardDensity) => void;
  toggleWidget: (id: DashboardWidgetId) => void;
  moveWidget: (id: DashboardWidgetId, direction: 'up' | 'down') => void;
  resetLayout: () => void;
}

/** Reconcile persisted widgets with the current known set (add new, drop stale). */
function reconcile(widgets: DashboardWidgetPreference[]): DashboardWidgetPreference[] {
  const known = new Map(widgets.map((w) => [w.id, w]));
  const merged = WIDGET_META.map((w, i) => {
    const existing = known.get(w.id);
    return existing ? { ...existing } : { id: w.id, visible: true, order: 100 + i };
  });
  return merged.sort((a, b) => a.order - b.order).map((w, i) => ({ ...w, order: i }));
}

export const useDashboardPreferences = create<DashboardPreferencesState>()(
  persist(
    (set, get) => ({
      widgets: defaultWidgetPreferences(),
      density: 'comfortable',
      periodId: 'this-year',
      customFrom: '',
      customTo: '',

      setPeriod: (id) => set({ periodId: id }),
      setCustomRange: (customFrom, customTo) => set({ customFrom, customTo, periodId: 'custom' }),
      setDensity: (density) => set({ density }),

      toggleWidget: (id) =>
        set((s) => ({
          widgets: s.widgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)),
        })),

      moveWidget: (id, direction) => {
        const widgets = [...get().widgets].sort((a, b) => a.order - b.order);
        const idx = widgets.findIndex((w) => w.id === id);
        const swap = direction === 'up' ? idx - 1 : idx + 1;
        if (idx < 0 || swap < 0 || swap >= widgets.length) return;
        const a = widgets[idx];
        const b = widgets[swap];
        if (!a || !b) return;
        const reordered = widgets.map((w) => {
          if (w.id === a.id) return { ...w, order: swap };
          if (w.id === b.id) return { ...w, order: idx };
          return w;
        });
        set({ widgets: reordered.sort((x, y) => x.order - y.order) });
      },

      resetLayout: () => set({ widgets: defaultWidgetPreferences(), density: 'comfortable' }),
    }),
    {
      name: 'ledgerly-dashboard-prefs',
      version: 1,
      partialize: (s) => ({
        widgets: s.widgets,
        density: s.density,
        periodId: s.periodId,
        customFrom: s.customFrom,
        customTo: s.customTo,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<DashboardPreferencesState> | undefined;
        return {
          ...current,
          ...p,
          widgets: reconcile(p?.widgets ?? defaultWidgetPreferences()),
        };
      },
    },
  ),
);
