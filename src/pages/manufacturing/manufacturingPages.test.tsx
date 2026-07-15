// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { ManufacturingDashboardPage } from './ManufacturingDashboardPage';
import { WorkOrdersPage } from './WorkOrdersPage';
import { ManufacturingReportsPage } from './ManufacturingReportsPage';
import { WorkCentersPage } from './MasterPages';

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault();
  useInventoryStore.getState().resetToDefault();
  useManufacturingStore.getState().resetToDefault();
  useManufacturingStore.getState().ensureSeeded();
});
afterEach(() => cleanup());

describe('manufacturing pages render', () => {
  it('renders dashboard, work orders, work centers and reports on seeded data', () => {
    render(<ManufacturingDashboardPage />);
    expect(screen.getByText(/Finished goods value/i)).toBeTruthy();
    cleanup();

    render(<WorkOrdersPage />);
    expect(screen.getAllByText(/New work order/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/WO-/).length).toBeGreaterThan(0); // seeded work orders visible
    cleanup();

    render(<WorkCentersPage />);
    expect(screen.getByText('CUT-01')).toBeTruthy();
    cleanup();

    render(<ManufacturingReportsPage />);
    expect(screen.getByText(/WIP by Work Order/i)).toBeTruthy();
  });
});
