import { describe, it, expect, beforeEach } from 'vitest';
import { useDashboardPreferences, defaultWidgetPreferences } from './dashboardPreferencesStore';

describe('dashboard preferences store', () => {
  beforeEach(() => {
    useDashboardPreferences.setState({
      widgets: defaultWidgetPreferences(),
      density: 'comfortable',
      periodId: 'this-year',
    });
  });

  it('starts with all widgets visible in order', () => {
    const w = useDashboardPreferences.getState().widgets;
    expect(w).toHaveLength(11);
    expect(w.every((x) => x.visible)).toBe(true);
    expect(w.map((x) => x.order)).toEqual([...Array(11).keys()]);
  });

  it('toggles widget visibility', () => {
    useDashboardPreferences.getState().toggleWidget('cash-flow');
    const w = useDashboardPreferences.getState().widgets.find((x) => x.id === 'cash-flow');
    expect(w?.visible).toBe(false);
  });

  it('reorders widgets with moveWidget', () => {
    const before = useDashboardPreferences.getState().widgets.map((x) => x.id);
    useDashboardPreferences.getState().moveWidget('operational-status', 'up');
    const after = useDashboardPreferences.getState().widgets.sort((a, b) => a.order - b.order).map((x) => x.id);
    expect(after[0]).toBe('operational-status');
    expect(after[1]).toBe(before[0]);
  });

  it('resetLayout restores defaults', () => {
    const s = useDashboardPreferences.getState();
    s.toggleWidget('payables');
    s.setDensity('compact');
    s.resetLayout();
    const w = useDashboardPreferences.getState();
    expect(w.widgets.every((x) => x.visible)).toBe(true);
    expect(w.density).toBe('comfortable');
  });
});
