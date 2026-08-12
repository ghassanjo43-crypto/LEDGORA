// @vitest-environment happy-dom
/**
 * AccountSelect — the open/close interaction lifecycle.
 *
 * ══ The defect these exist to keep dead ══════════════════════════════════════
 *
 * Clicking "Select account" opened the dropdown and closed it again in the same
 * gesture — a blink, after which the user could neither search nor select.
 *
 * The cause was two state transitions for one interaction. A real mouse press
 * on a `<button>` produces:
 *
 *     pointerdown → mousedown → FOCUS → mouseup → CLICK
 *
 * `openOnFocus` opened the panel on the focus step; the click that completed
 * the very same press then ran `setOpen(o => !o)` and closed it.
 *
 * ══ Why the old tests passed anyway ══════════════════════════════════════════
 *
 * `fireEvent.click(el)` and `el.click()` dispatch a click WITHOUT the preceding
 * focus — so only one transition ever happened and the panel stayed open. Every
 * test below that concerns opening therefore drives `focus` and `click` in the
 * real order. A test that only fires `click` cannot see this bug, and neither
 * could the browser check that used `el.click()`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { AccountSelect } from './AccountSelect';
import { useStore } from '@/store/useStore';
import type { Account } from '@/types';

const panel = (): HTMLElement | null =>
  document.querySelector<HTMLInputElement>('input[placeholder^="Search code, name"]')?.closest('div[style*="position"]') ??
  null;
const searchBox = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('input[placeholder^="Search code, name"]')!;
const optionTexts = (): string[] =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => (o.textContent ?? '').trim());

/**
 * A real mouse press, in the order a browser produces it.
 *
 * This is the whole point of the file: `focus` BEFORE `click`, because that
 * ordering is what turned one gesture into two state transitions.
 */
function realPress(el: HTMLElement): void {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  // The browser's default action for a press on a button.
  el.focus();
  fireEvent.focus(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

function renderPicker(props: Partial<React.ComponentProps<typeof AccountSelect>> = {}) {
  const picked: Account[] = [];
  const view = render(
    <AccountSelect
      value=""
      accounts={useStore.getState().accounts}
      onChange={(a) => picked.push(a)}
      openOnFocus
      {...props}
    />,
  );
  return { view, picked };
}

afterEach(cleanup);

/* ══ The blink ═════════════════════════════════════════════════════════════ */

describe('one interaction, one state transition', () => {
  it('a real mouse press OPENS the picker and it STAYS open', () => {
    renderPicker();
    const trigger = screen.getByRole('combobox');

    realPress(trigger);

    // The assertion the bug failed: still open after the whole gesture.
    expect(panel(), 'the panel must survive the click that completes the press').toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('stays open after React has flushed every pending effect', () => {
    renderPicker();
    realPress(screen.getByRole('combobox'));

    // Nothing deferred may close it a tick later — this is the "blink" window.
    act(() => {});
    expect(panel()).toBeTruthy();
  });

  it('focuses the search input, and the focus move does NOT close the panel', async () => {
    renderPicker();
    const trigger = screen.getByRole('combobox');
    realPress(trigger);

    // The component focuses the search box on the next tick; let it happen.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement, 'the search box takes focus').toBe(searchBox());

    // Focus left the trigger for the search box; no blur handler may act on it.
    fireEvent.blur(trigger);
    fireEvent.focusOut(trigger);
    expect(panel(), 'a blur caused by focusing INTO the dropdown must not close it').toBeTruthy();
  });

  it('a second real press CLOSES it — the toggle still works', () => {
    renderPicker();
    const trigger = screen.getByRole('combobox');
    realPress(trigger);
    expect(panel()).toBeTruthy();

    // The trigger already has focus this time, so the click must toggle.
    realPress(trigger);
    expect(panel(), 'clicking the trigger again closes it').toBeNull();
  });

  it('keyboard focus (Tab) opens without needing a click', () => {
    renderPicker();
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    fireEvent.focus(trigger);
    expect(panel(), 'tabbing into the cell opens it').toBeTruthy();
  });

  it('a plain click with no preceding focus also opens once', () => {
    // Guards the other direction: the swallow must not eat a genuine click.
    renderPicker({ openOnFocus: false });
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    expect(panel()).toBeTruthy();
    fireEvent.click(trigger);
    expect(panel()).toBeNull();
  });
});

/* ══ Search while open ═════════════════════════════════════════════════════ */

describe('searching without losing the panel', () => {
  it('typing filters instantly and the panel stays open throughout', () => {
    renderPicker();
    realPress(screen.getByRole('combobox'));

    fireEvent.change(searchBox(), { target: { value: '111' } });
    expect(panel(), 'still open while typing').toBeTruthy();
    expect(optionTexts().every((t) => t.includes('111'))).toBe(true);

    fireEvent.change(searchBox(), { target: { value: 'cash' } });
    expect(panel()).toBeTruthy();
    expect(optionTexts().some((t) => /Cash on hand/i.test(t))).toBe(true);
    expect(optionTexts().every((t) => /cash/i.test(t))).toBe(true);
  });

  it('clicking the search input does not close the panel', () => {
    renderPicker();
    realPress(screen.getByRole('combobox'));
    // The outside-click listener runs on mousedown — the portalled panel must
    // count as inside even though it is not a DOM child of the trigger.
    fireEvent.mouseDown(searchBox());
    fireEvent.click(searchBox());
    expect(panel()).toBeTruthy();
  });

  it('clicking the list area (not an option) does not close the panel', () => {
    renderPicker();
    realPress(screen.getByRole('combobox'));
    const list = panel()!.querySelector('ul')!;
    fireEvent.mouseDown(list);
    fireEvent.click(list);
    expect(panel()).toBeTruthy();
  });

  it('clicking genuinely outside DOES close the panel', () => {
    renderPicker();
    realPress(screen.getByRole('combobox'));
    expect(panel()).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(panel(), 'an outside press closes it').toBeNull();
  });

  it('Escape closes the panel', () => {
    renderPicker();
    realPress(screen.getByRole('combobox'));
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(panel()).toBeNull();
  });
});

/* ══ Selection ═════════════════════════════════════════════════════════════ */

describe('selecting an account', () => {
  it('a portalled option is clickable, selects, and closes', () => {
    const { picked } = renderPicker();
    realPress(screen.getByRole('combobox'));
    fireEvent.change(searchBox(), { target: { value: 'land' } });

    const option = document.querySelectorAll('[role="option"]')[0] as HTMLElement;
    expect(option, 'an option is rendered').toBeTruthy();
    // mousedown first, exactly as a real click would — this is the event the
    // outside-close listener watches.
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(picked).toHaveLength(1);
    expect(picked[0]!.name).toMatch(/Land and buildings/i);
    expect(panel(), 'selection closes the panel').toBeNull();
  });

  it('ArrowDown / Enter selects from the keyboard', () => {
    const { picked } = renderPicker();
    realPress(screen.getByRole('combobox'));
    fireEvent.change(searchBox(), { target: { value: 'cash' } });

    const second = optionTexts()[1];
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });

    expect(panel()).toBeNull();
    expect(picked).toHaveLength(1);
    if (second) expect(second).toContain(picked[0]!.code);
  });

  it('Enter on the closed trigger opens it', () => {
    renderPicker({ openOnFocus: false });
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(panel()).toBeTruthy();
  });
});

/* ══ Independence between pickers ══════════════════════════════════════════ */

describe('two pickers side by side', () => {
  function renderTwo() {
    const a: Account[] = [];
    const bPicked: Account[] = [];
    render(
      <>
        <AccountSelect id="acc-a" value="" accounts={useStore.getState().accounts} onChange={(x) => a.push(x)} openOnFocus />
        <AccountSelect id="acc-b" value="" accounts={useStore.getState().accounts} onChange={(x) => bPicked.push(x)} openOnFocus />
      </>,
    );
    const triggers = screen.getAllByRole('combobox');
    return { a, bPicked, first: triggers[0]!, second: triggers[1]! };
  }

  it('opening the second closes the first, leaving exactly one panel', () => {
    const { first, second } = renderTwo();
    realPress(first);
    expect(document.querySelectorAll('input[placeholder^="Search code, name"]')).toHaveLength(1);

    realPress(second);
    // The first picker's outside-click listener sees a press on another trigger.
    expect(
      document.querySelectorAll('input[placeholder^="Search code, name"]'),
      'exactly one panel is open at a time',
    ).toHaveLength(1);
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(first.getAttribute('aria-expanded')).toBe('false');
  });

  it('each picker reports its own selection only', () => {
    const { a, bPicked, first, second } = renderTwo();

    realPress(first);
    fireEvent.change(searchBox(), { target: { value: 'land' } });
    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);

    realPress(second);
    fireEvent.change(searchBox(), { target: { value: 'cash' } });
    fireEvent.click(document.querySelectorAll('[role="option"]')[0]!);

    expect(a).toHaveLength(1);
    expect(bPicked).toHaveLength(1);
    expect(a[0]!.id).not.toBe(bPicked[0]!.id);
  });
});
