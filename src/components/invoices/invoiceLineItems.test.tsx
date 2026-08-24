// @vitest-environment happy-dom
/**
 * The line-item editor, after it stopped being a table.
 *
 * ══ What these keep dead ═════════════════════════════════════════════════════
 *
 * The layout change is cosmetic; the ways it can break are not. A card stack
 * has no header row, so every field's label has to be attached to its own
 * control — and a `<label htmlFor>` pointing at an id nothing renders looks
 * exactly like a working label until someone uses a screen reader. Two of these
 * (Item, Revenue account) wrap custom components that had to gain an `id` prop
 * for the association to resolve at all.
 *
 * The rest pin that editing still edits, the total is still derived, and the
 * last line still cannot be removed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { InvoiceLineItems } from './InvoiceLineItems';
import { LanguageProvider } from '@/contexts/LanguageContext';
import type { InvoiceLine } from '@/types/invoice';
import type { Account } from '@/types';

const account = (id: string, code: string, name: string): Account =>
  ({
    id, code, name,
    // Uppercase: `ACCOUNT_COLOR` is keyed by AccountType, and a lowercase value
    // resolves to undefined and throws inside AccountDot.
    type: 'INCOME',
    parentId: null, level: 1, normalBalance: 'CREDIT',
    isPostingAccount: true, isActive: true,
  }) as unknown as Account;

const ACCOUNTS = [account('a1', '4120', 'Professional services — consulting')];

const line = (over: Partial<InvoiceLine> = {}): InvoiceLine =>
  ({
    id: 'l1', accountId: 'a1', description: 'Consulting', quantity: 2,
    unitPrice: 100, taxRate: 16, taxAmount: 32, lineSubtotal: 200, lineTotal: 232,
    sortOrder: 1, ...over,
  }) as InvoiceLine;

function setup(lines: InvoiceLine[], overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  const onSelectItem = vi.fn();
  render(
    /*
     * The provider both supplies direction and initialises i18next. Without it
     * `useTranslation` returns the KEY, so every label would render as
     * "lineItems.quantity" and every `getByLabelText` here would fail — which
     * is exactly what a missing provider looks like in production too.
     */
    <LanguageProvider>
    <InvoiceLineItems
      lines={lines}
      accounts={ACCOUNTS}
      projects={[]}
      currency="JOD"
      issueDate="2026-03-01"
      moneyStep="0.001"
      money={(n) => `JOD ${n.toFixed(3)}`}
      readOnly={false}
      showCostCenter={false}
      showProject={false}
      showInventory={false}
      onChange={onChange}
      onSelectItem={onSelectItem}
      onRemove={onRemove}
      {...overrides}
    />
    </LanguageProvider>,
  );
  return { onChange, onRemove, onSelectItem };
}

beforeEach(() => cleanup());

describe('every field is reachable by its label', () => {
  it.each([
    ['Description'],
    ['Qty'],
    ['Unit price'],
    ['Disc %'],
    ['Tax %'],
    ['Item'],
    ['Revenue account'],
  ])('%s resolves to a real control', (label) => {
    setup([line()]);
    /*
     * `getByLabelText` fails if the label's htmlFor points at nothing — which
     * is exactly the bug a card layout invites, and which no amount of visual
     * checking would reveal.
     */
    expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it('labels each line separately, so two lines are not ambiguous', () => {
    setup([line(), line({ id: 'l2', description: 'Second' })]);
    // Duplicate ids would make one label point at the other line's input.
    expect(screen.getAllByLabelText('Qty')).toHaveLength(2);
  });
});

describe('editing', () => {
  it('reports a description change', () => {
    const { onChange } = setup([line()]);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Advisory' } });
    expect(onChange).toHaveBeenCalledWith('l1', { description: 'Advisory' });
  });

  it('reports a quantity change as a number, not a string', () => {
    const { onChange } = setup([line()]);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith('l1', { quantity: 5 });
  });

  it('sets the discount TYPE alongside the value', () => {
    const { onChange } = setup([line()]);
    fireEvent.change(screen.getByLabelText('Disc %'), { target: { value: '10' } });
    // A value with no type is a discount the calculator cannot interpret.
    expect(onChange).toHaveBeenCalledWith('l1', { discountType: 'percentage', discountValue: 10 });
  });

  it('carries the company monetary step onto the price field', () => {
    setup([line()]);
    const price = screen.getByLabelText('Unit price');
    // A JOD company is thousandths; a hard-coded 0.01 would refuse a valid price.
    expect(price.getAttribute('step')).toBe('0.001');
    expect(price.getAttribute('data-money')).toBe('true');
  });
});

describe('the line total', () => {
  it('is derived from the line, not from a stored figure', () => {
    // 2 x 100 = 200 net, +16% tax = 232.
    setup([line({ lineTotal: 999999 })]);
    expect(screen.getByText('JOD 232.000')).toBeTruthy();
  });

  it('is not an editable control', () => {
    setup([line()]);
    /*
     * Rendered as <output>, so there is nothing to type into. A disabled input
     * would look like a field someone was not permitted to edit.
     */
    expect(screen.queryByLabelText('Line total')).toBeNull();
    expect(screen.getByText('Line total')).toBeTruthy();
  });
});

describe('removing a line', () => {
  it('offers removal when there is more than one', () => {
    const { onRemove } = setup([line(), line({ id: 'l2' })]);
    const buttons = screen.getAllByRole('button', { name: /remove line/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onRemove).toHaveBeenCalledWith('l1');
  });

  it('does not offer it for the only line', () => {
    setup([line()]);
    /*
     * The store already refuses to remove the last line. A button that silently
     * does nothing is worse than one that is not there.
     */
    expect(screen.queryByRole('button', { name: /remove line/i })).toBeNull();
  });

  it('names the line in the button, so two buttons are distinguishable', () => {
    setup([line({ description: 'Consulting' }), line({ id: 'l2', description: 'Travel' })]);
    expect(screen.getByRole('button', { name: /Remove line 2: Travel/i })).toBeTruthy();
  });
});

describe('read-only', () => {
  it('disables every control and offers no removal', () => {
    setup([line(), line({ id: 'l2' })], { readOnly: true });
    expect((screen.getAllByLabelText('Description')[0] as HTMLInputElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('Qty')[0] as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /remove line/i })).toBeNull();
  });
});

describe('dimension controls', () => {
  it('are absent when the edition does not sell them', () => {
    setup([line()]);
    expect(screen.queryByText('Project')).toBeNull();
  });

  it('appear when entitled', () => {
    setup([line()], { showProject: true });
    expect(screen.getByText('Project')).toBeTruthy();
  });
});

describe('the card structure', () => {
  it('groups each line into its own card', () => {
    setup([line(), line({ id: 'l2' })]);
    // Two lines, two labelled quantity fields, each inside its own container.
    const quantities = screen.getAllByLabelText('Qty');
    expect(quantities).toHaveLength(2);
    const firstCard = quantities[0]!.closest('div.rounded-xl');
    expect(firstCard).toBeTruthy();
    expect(within(firstCard as HTMLElement).getAllByLabelText('Description')).toHaveLength(1);
  });
});
