// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StockMovementsPage } from './StockMovementsPage';
import { useInventoryStore } from '@/store/inventoryStore';
import { makeInventorySeed } from '@/lib/inventorySeed';

beforeEach(() => {
  const seed = makeInventorySeed('core');
  useInventoryStore.setState({ ...seed, movements: [], documents: [], auditTrail: [], seeded: true });
  useInventoryStore.getState().postGoodsReceipt({ date: '2026-08-01', reference: 'SUP-778', lines: [{ id: 'line-1', itemId: 'item_goods', warehouseId: 'wh_main', quantity: 5, unitId: 'uom_ea', unitCost: 10 }] });
});
afterEach(cleanup);

describe('StockMovementsPage item identification', () => {
  it('shows item code/name, receipt destination, unit, value, and status', () => {
    render(<StockMovementsPage />);
    expect(screen.getAllByText('GOODS-001 — Trading goods')).toHaveLength(2);
    expect(screen.getAllByText('MAIN — Main warehouse')).toHaveLength(2);
    expect(screen.getByText('EA')).toBeTruthy();
    expect(screen.getByText('posted')).toBeTruthy();
    expect(screen.getByText('SUP-778')).toBeTruthy();
  });

  it('supports item filtering and item/reference search without hiding archived history', () => {
    useInventoryStore.setState((state) => ({ items: state.items.map((item) => ({ ...item, status: 'archived' as const })) }));
    render(<StockMovementsPage />);
    expect(screen.getByText('archived')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Item'), { target: { value: 'item_goods' } });
    expect(screen.getAllByText('GOODS-001 — Trading goods')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'SUP-778' } });
    expect(screen.getAllByText('GOODS-001 — Trading goods')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'not-present' } });
    expect(screen.getByText('No stock movements.')).toBeTruthy();
  });
});
