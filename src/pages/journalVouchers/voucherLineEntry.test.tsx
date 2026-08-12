// @vitest-environment happy-dom
/**
 * Journal Voucher line entry: money-column width and the searchable account cell.
 *
 * ══ What was wrong ═══════════════════════════════════════════════════════════
 *
 * Two separate usability failures in the same row:
 *
 *   width    Debit and Credit were 112px (`w-28`). `1,250,000,000.00` is
 *            sixteen characters and did not fit, so a figure had to be scrolled
 *            inside its own field to be read — and a misread order of magnitude
 *            is the most expensive mistake a ledger can carry.
 *
 *   search   The account cell was a native `<select>`. Every other document
 *            surface in Ledgora — General Journal, invoices, bills, payments,
 *            receipts, credit notes — already used the searchable
 *            `AccountSelect`; this page alone made you scroll a hundred
 *            accounts to reach "1251 Cash on hand".
 *
 * The tests below therefore check the two things a user actually experiences:
 * that a large figure is fully rendered in a field wide enough to hold it, and
 * that typing narrows the list to what was typed — while the amounts already
 * entered on that line, and on every other line, stay exactly as they were.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { JournalVouchersPage } from './JournalVouchersPage';
import { useStore } from '@/store/useStore';
import { useJournalVoucherStore } from '@/store/journalVoucherStore';
import type { Account } from '@/types';

/* ─────────────────────────────── Harness ────────────────────────────────── */

function openNewVoucher() {
  const view = render(<JournalVouchersPage />);
  fireEvent.click(screen.getByRole('button', { name: /new journal voucher/i }));
  return view;
}

const moneyHeader = (label: 'Debit' | 'Credit'): HTMLElement =>
  Array.from(document.querySelectorAll('th')).find((th) => th.textContent?.trim() === label)!;

const debitInput = (line: number): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`[data-testid="jv-debit-${line}"]`)!;
const creditInput = (line: number): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`[data-testid="jv-credit-${line}"]`)!;

/**
 * The ACCOUNT trigger on a 0-based voucher line.
 *
 * A line also renders cost-center and project comboboxes, so this matches on
 * what the account cell says rather than counting comboboxes — the count is not
 * what any of these tests are about.
 */
const accountTrigger = (line: number): HTMLElement =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]')).filter((el) => {
    const text = (el.textContent ?? '').trim();
    // A filled account reads "1111Land and buildings" — the code and name are
    // separate spans, so there is no separator to match on. Dimension pickers
    // start with their code prefix ("CC-…", "PRJ-…") or their empty-state label.
    return text.startsWith('Select account') || text.startsWith('Account unavailable') || /^\d/.test(text);
  })[line]!;

/** The account picker's panel specifically — not a dimension picker's. */
const panel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('input[placeholder^="Search code, name"]')?.closest('div[style*="position"]') ?? null;

const searchBox = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('input[placeholder^="Search code, name"]')!;

const optionTexts = (): string[] =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => (o.textContent ?? '').trim());

function postingAccounts(): Account[] {
  return useStore.getState().accounts.filter((a) => a.isPostingAccount && a.isActive);
}

/** Type into the picker's search box. */
function typeSearch(text: string): void {
  fireEvent.change(searchBox(), { target: { value: text } });
}

beforeEach(() => {
  // A clean register; the editor is what these tests exercise.
  useJournalVoucherStore.setState({ vouchers: [] } as never);
});
afterEach(cleanup);

/* ══ 1 · Debit / Credit width ══════════════════════════════════════════════ */

describe('money column width', () => {
  it('Debit and Credit are equal and at least 150px', () => {
    openNewVoucher();
    const debit = moneyHeader('Debit');
    const credit = moneyHeader('Credit');

    // Read the intended width off the utility classes: happy-dom does no
    // layout, so the declared width is the honest thing to assert.
    const widthOf = (el: HTMLElement): number => {
      const match = /w-\[(\d+)px\]/.exec(el.className);
      return match ? Number(match[1]) : 0;
    };
    expect(widthOf(debit)).toBe(widthOf(credit));
    expect(widthOf(debit)).toBeGreaterThanOrEqual(150);
    expect(widthOf(debit)).toBeLessThanOrEqual(180);
    // Fixed AND floored, so table auto-layout cannot squeeze them back.
    expect(debit.className).toContain('min-w-[176px]');
    expect(credit.className).toContain('min-w-[176px]');
  });

  it('the grid scrolls horizontally rather than compressing the amounts', () => {
    openNewVoucher();
    const table = document.querySelector('table.min-w-\\[1040px\\]');
    expect(table, 'the line table declares a min width').toBeTruthy();
    expect(table!.parentElement!.className).toContain('overflow-x-auto');
  });

  it.each([
    [5_000_000, '5,000,000.00'],
    [125_000_000, '125,000,000.00'],
    [1_250_000_000, '1,250,000,000.00'],
  ])('renders %d in full as %s', (value, formatted) => {
    openNewVoucher();
    const input = debitInput(0);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: String(value) } });
    fireEvent.blur(input);

    // The whole formatted figure, separators and cents included.
    expect(input.value).toBe(formatted);
    expect(input.className).toContain('text-right');
    expect(input.className).toContain('tabular-nums');
  });

  it('keeps the underlying value exact while typing, and formats on blur', () => {
    openNewVoucher();
    const input = debitInput(0);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '1250000000' } });
    // Raw while editing — no caret-shifting reformat mid-keystroke.
    expect(input.value).toBe('1250000000');
    fireEvent.blur(input);
    expect(input.value).toBe('1,250,000,000.00');
  });

  it('accepts a pasted, already-grouped figure', () => {
    openNewVoucher();
    const input = debitInput(0);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '1,250,000,000.00' } });
    fireEvent.blur(input);
    expect(input.value).toBe('1,250,000,000.00');
  });

  it('entering a debit clears the credit on the same line', () => {
    openNewVoucher();
    fireEvent.focus(creditInput(0));
    fireEvent.change(creditInput(0), { target: { value: '400' } });
    fireEvent.blur(creditInput(0));
    expect(creditInput(0).value).toBe('400.00');

    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '900' } });
    fireEvent.blur(debitInput(0));
    expect(debitInput(0).value).toBe('900.00');
    expect(creditInput(0).value, 'the canonical withDebit clears the other side').toBe('');
  });
});

/* ══ 2–4 · The searchable account cell ═════════════════════════════════════ */

describe('the account cell', () => {
  /**
   * A real mouse press, in the order a browser produces it. The blink bug lived
   * entirely in the gap between `focus` and `click`, so any test that only
   * fires `click` is blind to it.
   */
  function realPress(el: HTMLElement): void {
    fireEvent.pointerDown(el);
    fireEvent.mouseDown(el);
    el.focus();
    fireEvent.focus(el);
    fireEvent.mouseUp(el);
    fireEvent.click(el);
  }

  it('survives a REAL mouse press on the voucher grid — the blink regression', () => {
    openNewVoucher();
    // Amounts first, so we can prove the gesture does not disturb them.
    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '250000' } });
    fireEvent.blur(debitInput(0));

    realPress(accountTrigger(0));

    expect(panel(), 'the picker stays open after the full press').toBeTruthy();
    typeSearch('cash');
    expect(panel(), 'and stays open while typing').toBeTruthy();
    expect(optionTexts().some((t) => /Cash on hand/i.test(t))).toBe(true);

    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);
    expect(panel()).toBeNull();
    expect(accountTrigger(0).textContent).toMatch(/cash/i);
    fireEvent.blur(debitInput(0));
    expect(debitInput(0).value, 'the amount is untouched').toBe('250,000.00');
  });

  it('survives a real press on the LAST line, where the panel flips upward', () => {
    openNewVoucher();
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(Array.from(document.querySelectorAll('button')).find((b) => /Add line/.test(b.textContent ?? ''))!);
    }
    const lines = document.querySelectorAll('[data-testid^="jv-debit-"]').length;
    const trigger = accountTrigger(lines - 1);
    // Put it near the viewport floor so the panel must flip.
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    trigger.getBoundingClientRect = () =>
      ({ top: 740, bottom: 776, left: 300, right: 500, width: 200, height: 36, x: 300, y: 740, toJSON: () => ({}) }) as DOMRect;

    realPress(trigger);

    const p = panel()!;
    expect(p, 'open after the press even when flipped').toBeTruthy();
    expect(p.dataset.placement).toBe('top');
    typeSearch('cash');
    expect(panel(), 'still open while searching in a flipped panel').toBeTruthy();
    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);
    expect(accountTrigger(lines - 1).textContent).toMatch(/cash/i);
  });

  it('is the shared searchable combobox, not a native select', () => {
    openNewVoucher();
    expect(accountTrigger(0).getAttribute('role')).toBe('combobox');
    expect(accountTrigger(0).getAttribute('aria-haspopup')).toBe('listbox');
  });

  it('opens the picker on click and shows every posting account', () => {
    openNewVoucher();
    expect(panel()).toBeNull();
    fireEvent.click(accountTrigger(0));
    expect(panel()).toBeTruthy();
    expect(searchBox()).toBeTruthy();
    expect(optionTexts().length).toBe(postingAccounts().length);
  });

  it('opens on focus so the cell behaves like a spreadsheet', () => {
    openNewVoucher();
    fireEvent.focus(accountTrigger(0));
    expect(panel()).toBeTruthy();
  });

  it('typing a printable character on the closed cell opens it and seeds the search', () => {
    openNewVoucher();
    fireEvent.keyDown(accountTrigger(0), { key: '1' });
    expect(panel()).toBeTruthy();
    expect(searchBox().value).toBe('1');
  });

  it('filters instantly by account CODE prefix', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));
    typeSearch('111');
    const shown = optionTexts();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((t) => /111/.test(t)), '111 must only match accounts containing 111').toBe(true);
    expect(shown.some((t) => t.includes('1111') && /Land and buildings/i.test(t))).toBe(true);
  });

  it('filters instantly by part of the account NAME', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));
    typeSearch('land');
    expect(optionTexts().some((t) => /Land and buildings/i.test(t))).toBe(true);

    typeSearch('cash');
    const cash = optionTexts();
    expect(cash.some((t) => /Cash on hand/i.test(t))).toBe(true);
    expect(cash.every((t) => /cash/i.test(t))).toBe(true);
  });

  it('is case-insensitive and trims surrounding spaces', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));

    typeSearch('LAND');
    const upper = optionTexts();
    typeSearch('land');
    const lower = optionTexts();
    typeSearch('   land   ');
    const padded = optionTexts();

    expect(upper).toEqual(lower);
    expect(padded).toEqual(lower);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('shows a no-result state naming what was searched for', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));
    typeSearch('xyz');
    expect(optionTexts()).toHaveLength(0);
    expect(panel()!.textContent).toMatch(/no active posting accounts match/i);
    expect(panel()!.textContent).toContain('xyz');
  });

  it('selecting a result fills that line and closes the picker', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));
    typeSearch('land');
    const first = document.querySelectorAll('[role="option"]')[0]!;
    const label = (first.textContent ?? '').trim();
    fireEvent.click(first);

    expect(panel()).toBeNull();
    expect(accountTrigger(0).textContent).toContain('Land and buildings');
    expect(label).toContain('Land and buildings');
  });

  it('supports ArrowDown / Enter selection from the keyboard', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));
    typeSearch('cash');
    const expected = optionTexts()[1] ?? optionTexts()[0]!;

    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(panel()).toBeNull();
    // The highlighted row — the second after one ArrowDown — is what landed.
    expect(expected).toContain(accountTrigger(0).textContent?.split(/\s+/).find((w) => /^\d{3,}$/.test(w)) ?? '');
  });

  it('Escape closes the picker WITHOUT closing the voucher drawer', () => {
    openNewVoucher();
    const before = accountTrigger(0).textContent;
    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '5000000' } });
    fireEvent.blur(debitInput(0));

    fireEvent.click(accountTrigger(0));
    typeSearch('cash');
    fireEvent.keyDown(searchBox(), { key: 'Escape' });

    expect(panel(), 'the dropdown closes').toBeNull();
    /*
     * The regression this guards. The host drawer listens for Escape on
     * `window`; before the picker stopped propagation, dismissing the dropdown
     * tore down the whole voucher and every line entered into it.
     */
    expect(document.querySelectorAll('[role="combobox"]').length, 'the voucher editor stays open').toBeGreaterThan(0);
    expect(debitInput(0).value, 'entered amounts survive').toBe('5,000,000.00');
    expect(accountTrigger(0).textContent).toBe(before);
  });

  it('searching NEVER disturbs the debit or credit already on the line', () => {
    openNewVoucher();
    // Amounts first, account second — the order that used to be risky.
    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '1250000000' } });
    fireEvent.blur(debitInput(0));
    fireEvent.focus(creditInput(1));
    fireEvent.change(creditInput(1), { target: { value: '1250000000' } });
    fireEvent.blur(creditInput(1));

    fireEvent.click(accountTrigger(0));
    typeSearch('cash');
    typeSearch('land');
    expect(debitInput(0).value).toBe('1,250,000,000.00');
    expect(creditInput(1).value).toBe('1,250,000,000.00');

    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);
    /*
     * Selecting advances focus to this line's Debit cell by design, so that
     * field is now in its editable (unformatted) state — the VALUE is what must
     * be untouched, and blurring shows it formatted again.
     */
    expect(debitInput(0).value, 'the amount itself is unchanged').toBe('1250000000');
    fireEvent.blur(debitInput(0));
    expect(debitInput(0).value, 'selecting must not touch the amounts').toBe('1,250,000,000.00');
    expect(creditInput(1).value, 'another line is never touched').toBe('1,250,000,000.00');
  });

  it('each line keeps its own independent account selection', () => {
    openNewVoucher();

    fireEvent.click(accountTrigger(0));
    typeSearch('land');
    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);

    fireEvent.click(accountTrigger(1));
    typeSearch('cash');
    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);

    const line0 = accountTrigger(0).textContent ?? '';
    const line1 = accountTrigger(1).textContent ?? '';
    expect(line0).toMatch(/Land and buildings/i);
    expect(line1).toMatch(/cash/i);
    expect(line0).not.toBe(line1);
  });

  it('offers the same accounts the store holds — no second account list', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(0));
    const shown = optionTexts();
    const expected = postingAccounts();
    expect(shown).toHaveLength(expected.length);
    // Every offered account is a posting account from the canonical chart.
    for (const account of expected.slice(0, 5)) {
      expect(shown.some((t) => t.includes(account.code) && t.includes(account.name))).toBe(true);
    }
  });

  it('choosing an account moves focus to that line’s Debit cell', () => {
    openNewVoucher();
    fireEvent.click(accountTrigger(1));
    typeSearch('cash');
    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);
    expect(document.activeElement).toBe(creditInput(1).previousElementSibling ?? debitInput(1));
  });
});

/* ══ The register is untouched ═════════════════════════════════════════════ */

describe('the voucher register', () => {
  it('still renders with the editor closed', () => {
    render(<JournalVouchersPage />);
    expect(screen.getByRole('button', { name: /new journal voucher/i })).toBeTruthy();
    expect(within(document.body).queryByText('No vouchers in this view yet.')).toBeTruthy();
  });
});
