// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BillEditorDrawer } from '@/components/bills/BillEditorDrawer';
import { ItemsPage } from '@/pages/inventory/ItemsPage';
import { useBillStore } from '@/store/billStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { makeInventorySeed } from '@/lib/inventorySeed';

const page = (node: React.ReactElement) => render(<ToastProvider>{node}</ToastProvider>);

beforeEach(() => {
  useBillStore.setState({ bills: [] });
  useInventoryStore.setState({ ...makeInventorySeed('manufacturing'), movements: [], documents: [], auditTrail: [], seeded: true });
});
afterEach(cleanup);

describe('vertical bill entry', () => {
  it('uses numbered stacked cards, supports multiple lines, and avoids an editable line table', () => {
    const id = useBillStore.getState().createDraft().id!;
    page(<BillEditorDrawer open billId={id} onClose={() => {}} />);

    const region = screen.getByTestId('bill-line-cards');
    expect(within(region).getAllByTestId('bill-line-card')).toHaveLength(1);
    expect(within(region).getByText('Line 1')).toBeTruthy();
    expect(within(region).queryByRole('table')).toBeNull();

    fireEvent.click(within(region).getByRole('button', { name: /add line/i }));
    expect(within(region).getAllByTestId('bill-line-card')).toHaveLength(2);
    expect(within(region).getByText('Line 2')).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: /remove line 2/i }));
    expect(within(region).getAllByTestId('bill-line-card')).toHaveLength(1);
  });

  it('keeps manual lines, calculated totals, and receive-to-stock guidance visible', () => {
    const id = useBillStore.getState().createDraft().id!;
    page(<BillEditorDrawer open billId={id} onClose={() => {}} />);
    expect(screen.getByText(/leave it blank for a manual line/i)).toBeTruthy();
    expect(screen.getByLabelText('Line 1 total')).toBeTruthy();
    expect(screen.getByText(/records a physical inventory receipt/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Totals' })).toBeTruthy();
  });
});

describe('vertical item entry', () => {
  it('shows the business sections and sticky drawer actions', () => {
    page(<ItemsPage />);
    fireEvent.click(screen.getByRole('button', { name: /new item/i }));
    expect(screen.getByRole('heading', { name: 'Item details' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sales information' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Purchase information' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Inventory settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /save item/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
  });

  it('does not show inventory settings after changing the item to a service', () => {
    page(<ItemsPage />);
    fireEvent.click(screen.getByRole('button', { name: /new item/i }));
    const kind = screen.getByDisplayValue('Product');
    fireEvent.change(kind, { target: { value: 'service' } });
    expect(screen.queryByRole('heading', { name: 'Inventory settings' })).toBeNull();
  });
});
