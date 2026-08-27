// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BillEditorDrawer } from '@/components/bills/BillEditorDrawer';
import { ItemsPage } from '@/pages/inventory/ItemsPage';
import { useBillStore } from '@/store/billStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { makeInventorySeed } from '@/lib/inventorySeed';
import { BillsPage } from '@/pages/BillsPage';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';

const page = (node: React.ReactElement) => render(<ToastProvider>{node}</ToastProvider>);

/**
 * The open row-Actions menu.
 *
 * The panel is portaled to `document.body` so it cannot be clipped by the
 * register's `overflow-hidden` card (see `ui/dropdownMenuPortal.test.tsx`), which
 * means it is deliberately NOT inside the `<tr>` any more. The trigger still is,
 * so a row scope is right for opening the menu and wrong for reading it.
 */
const menu = () => screen.getByTestId('dropdown-menu');

beforeEach(() => {
  useBillStore.setState({ bills: [] });
  useInvoiceTemplateStore.getState().resetToDefault();
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

  it('opens an existing draft from the register while submitted bills require recall', () => {
    const draftId = useBillStore.getState().createDraft().id!;
    const submittedId = useBillStore.getState().createDraft().id!;
    useBillStore.getState().submitBill(submittedId);
    page(<BillsPage />);

    const draftRow = screen.getByText(useBillStore.getState().getBill(draftId)!.billNumber).closest('tr')!;
    fireEvent.click(within(draftRow).getByText('Actions'));
    expect(within(menu()).getByText('Edit')).toBeTruthy();
    fireEvent.click(within(menu()).getByText('Edit'));
    expect(screen.getByRole('dialog').textContent).toContain(useBillStore.getState().getBill(draftId)!.billNumber);
    cleanup();

    page(<BillsPage />);
    const submittedRow = screen.getByText(useBillStore.getState().getBill(submittedId)!.billNumber).closest('tr')!;
    fireEvent.click(within(submittedRow).getByText('Actions'));
    expect(within(menu()).queryByText('Edit')).toBeNull();
    expect(within(menu()).getByText('Recall submission')).toBeTruthy();
  });

  it('renders submitted bills read-only even when the editor is called directly', () => {
    const id = useBillStore.getState().createDraft().id!;
    useBillStore.getState().submitBill(id);
    page(<BillEditorDrawer open billId={id} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.getByText(/submitted.*read only/i)).toBeTruthy();
  });

  it('shows immutable-ledger guidance instead of Edit for a posted bill', () => {
    const id = useBillStore.getState().createDraft().id!;
    const bill = useBillStore.getState().getBill(id)!;
    useBillStore.setState({ bills: [{ ...bill, status: 'posted', journalEntryId: 'je_historical' }] });
    page(<BillsPage />);
    const row = screen.getByText(bill.billNumber).closest('tr')!;
    fireEvent.click(within(row).getByText('Actions'));
    expect(within(menu()).queryByText('Edit')).toBeNull();
    fireEvent.click(within(menu()).getByText('View'));
    /*
     * The guidance changed with the posted-document amendment workflow: a
     * posted bill is still not editable in place, but the answer is no longer
     * "reverse it and start again" — it is the controlled amendment, which
     * keeps the original bill, its number and its journal entry.
     */
    expect(screen.getByText(/Posted bills cannot be edited directly/i)).toBeTruthy();
    expect(screen.getByText(/Amend posted document/i)).toBeTruthy();
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
