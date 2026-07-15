// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useInventoryStore } from '@/store/inventoryStore';
import { makeInventorySeed } from '@/lib/inventorySeed';
import { InventoryDashboardPage } from './InventoryDashboardPage';
import { ItemsPage } from './ItemsPage';
import { WarehousesPage } from './WarehousesPage';
import { StockMovementsPage } from './StockMovementsPage';
import { InventoryReportsPage } from './InventoryReportsPage';

beforeEach(() => {
  useInventoryStore.getState().resetToDefault();
  const seed = makeInventorySeed('manufacturing');
  useInventoryStore.setState({ ...seed, movements: [], documents: [], auditTrail: [], seeded: true });
});

afterEach(() => cleanup());

describe('inventory pages render', () => {
  it('renders the dashboard, items, warehouses, movements and reports without crashing', () => {
    render(<InventoryDashboardPage />);
    expect(screen.getByText(/Inventory value/i)).toBeTruthy();
    cleanup();

    render(<ItemsPage />);
    expect(screen.getByText('GOODS-001')).toBeTruthy(); // seeded item visible
    cleanup();

    render(<WarehousesPage />);
    expect(screen.getByText('MAIN')).toBeTruthy(); // seeded warehouse visible
    cleanup();

    render(<StockMovementsPage />);
    expect(screen.getByText(/No stock movements/i)).toBeTruthy();
    cleanup();

    render(<InventoryReportsPage />);
    expect(screen.getByText(/GL Reconciliation/i)).toBeTruthy();
  });
});
