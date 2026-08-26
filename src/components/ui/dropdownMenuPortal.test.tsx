// @vitest-environment happy-dom
/**
 * The row Actions menu — the table clipping regression.
 *
 * ══ What was wrong ═══════════════════════════════════════════════════════════
 *
 * `Dropdown` rendered its panel as an `absolute z-50` child of the trigger. Every
 * data table in the app wraps its rows in a `Card` with `overflow-hidden` (which
 * is what gives the table its rounded border) around a `div` with
 * `overflow-x-auto` (which is what lets it scroll sideways on a narrow screen).
 * An overflow box clips its descendants regardless of `z-index`, so a row's
 * Actions menu opened *inside* that box and was sliced off at its edge.
 *
 * That is the trap these tests are written around. Asserting "the menu item
 * exists" passed throughout the bug — every item was in the DOM the whole time,
 * simply invisible. So they assert the things that decide whether a user can
 * actually reach it:
 *
 *   WHERE the panel lives — on `document.body`, outside every overflow
 *                           container, so no ancestor can clip it;
 *   WHERE it is placed    — below when there is room, flipped above when there
 *                           is not, and always inside the viewport;
 *   THAT the table is unchanged — the rounding and the sideways scroll are still
 *                           there, because the fix did not open the box up.
 *
 * Rects are stubbed because happy-dom reports every element as 0×0 at (0,0); the
 * positioning itself is the real `computePopoverPosition` the app ships.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Dropdown, MenuItem } from './Dropdown';

const VIEWPORT = { width: 1280, height: 800 };

function setViewport(): void {
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true });
}

/** Give one element a fixed viewport rect (happy-dom reports 0×0 for everything). */
function stubRect(el: Element, top: number, left = 1100, width = 84, height = 32): void {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * The exact shape of every table in the app: rounded clipping card > horizontal
 * scroller > table > a row action cell. This is the structure that did the
 * clipping, reproduced so the test proves the escape rather than assuming it.
 */
function Table({ onPreview, onDelete }: { onPreview?: () => void; onDelete?: () => void }) {
  return (
    <div data-testid="card" className="overflow-hidden rounded-xl border">
      <div data-testid="scroller" className="overflow-x-auto">
        <table>
          <tbody>
            <tr>
              <td>INV-0001</td>
              <td>
                <Dropdown label="Actions" align="right" trigger={() => <span>Actions</span>}>
                  <MenuItem onClick={onPreview}>Preview</MenuItem>
                  <MenuItem onClick={onDelete} disabled>
                    Delete draft
                  </MenuItem>
                  <MenuItem>View customer statement</MenuItem>
                </Dropdown>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function openMenu(top = 200, left = 1100): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'Actions' });
  stubRect(trigger, top, left);
  fireEvent.click(trigger);
  return trigger;
}

beforeEach(setViewport);
afterEach(cleanup);

/* ── 1: the panel escapes the clipping container ─────────────────────────── */

describe('the menu renders outside the table clipping container', () => {
  it('mounts the panel on document.body, not inside the card or the scroller', () => {
    render(<Table />);
    openMenu();

    const panel = screen.getByTestId('dropdown-menu');
    const card = screen.getByTestId('card');
    const scroller = screen.getByTestId('scroller');

    // The whole point: neither overflow box is an ancestor any more.
    expect(card.contains(panel)).toBe(false);
    expect(scroller.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
  });

  it('has no ancestor that clips overflow', () => {
    render(<Table />);
    openMenu();

    let node: HTMLElement | null = screen.getByTestId('dropdown-menu').parentElement;
    const clipping: string[] = [];
    while (node && node !== document.body) {
      const cls = node.className ?? '';
      if (/overflow-hidden|overflow-x-auto|overflow-y-auto|overflow-auto/.test(String(cls))) {
        clipping.push(String(cls));
      }
      node = node.parentElement;
    }
    expect(clipping, 'clipping ancestors between the panel and <body>').toEqual([]);
  });

  it('paints above the table surface on a fixed layer', () => {
    render(<Table />);
    openMenu();
    const panel = screen.getByTestId('dropdown-menu');

    // Fixed, so no ancestor scroll offset applies, and on the app's popover layer.
    expect(panel.style.position).toBe('fixed');
    expect(panel.className).toContain('z-[1000]');
  });
});

/* ── 2: the table itself is untouched ────────────────────────────────────── */

describe('the table keeps its own behaviour', () => {
  it('still rounds its border and still scrolls horizontally', () => {
    render(<Table />);
    openMenu();

    // The fix must NOT have worked by making the table overflow visible.
    expect(screen.getByTestId('card').className).toContain('overflow-hidden');
    expect(screen.getByTestId('scroller').className).toContain('overflow-x-auto');
  });
});

/* ── 3: the actions still work ───────────────────────────────────────────── */

describe('menu actions', () => {
  it('runs a click on an item and closes the menu', () => {
    const onPreview = vi.fn();
    render(<Table onPreview={onPreview} />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview' }));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('dropdown-menu')).toBeNull();
  });

  it('keeps a disabled item disabled and unclickable', () => {
    const onDelete = vi.fn();
    render(<Table onDelete={onDelete} />);
    openMenu();

    const item = screen.getByRole('menuitem', { name: 'Delete draft' }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    fireEvent.click(item);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('keeps the accessible labelling on the trigger', () => {
    render(<Table />);
    const trigger = screen.getByRole('button', { name: 'Actions' });

    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    openMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('dropdown-menu').getAttribute('role')).toBe('menu');
  });
});

/* ── 4: dismissal and keyboard ───────────────────────────────────────────── */

describe('dismissal', () => {
  it('closes on Escape and puts focus back on the trigger', () => {
    render(<Table />);
    const trigger = openMenu();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('dropdown-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the pointer goes down outside', () => {
    render(<Table />);
    openMenu();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('dropdown-menu')).toBeNull();
  });

  it('does NOT close when the pointer goes down inside the portaled panel', () => {
    render(<Table />);
    openMenu();
    const panel = screen.getByTestId('dropdown-menu');

    // The panel is outside the trigger's DOM subtree now, so an outside-click
    // check that only consulted the trigger would dismiss on every menu click.
    fireEvent.mouseDown(panel);

    expect(screen.queryByTestId('dropdown-menu')).not.toBeNull();
  });
});

describe('keyboard navigation', () => {
  it('walks the enabled items with the arrow keys, skipping disabled ones', () => {
    render(<Table />);
    openMenu();

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Preview' }));

    // "Delete draft" is disabled and must be stepped over, not landed on.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'View customer statement' }),
    );

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Preview' }));
  });

  it('jumps to the last and first items with End and Home', () => {
    render(<Table />);
    openMenu();

    fireEvent.keyDown(window, { key: 'End' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'View customer statement' }),
    );

    fireEvent.keyDown(window, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Preview' }));
  });

  it('closes on Tab so focus is never trapped in a portaled panel', () => {
    render(<Table />);
    openMenu();

    fireEvent.keyDown(window, { key: 'Tab' });

    expect(screen.queryByTestId('dropdown-menu')).toBeNull();
  });
});

/* ── 5: placement ────────────────────────────────────────────────────────── */

describe('placement', () => {
  it('opens below when there is room underneath the row', () => {
    render(<Table />);
    openMenu(120); // near the top of an 800px viewport

    const panel = screen.getByTestId('dropdown-menu');
    expect(panel.getAttribute('data-placement')).toBe('bottom');
    // Positioned under the trigger (top 120 + height 32 + offset).
    expect(parseFloat(panel.style.top)).toBeGreaterThan(120);
  });

  it('flips above for a row near the bottom of the viewport', () => {
    render(<Table />);
    openMenu(760); // only ~8px below the trigger in an 800px viewport

    const panel = screen.getByTestId('dropdown-menu');
    expect(panel.getAttribute('data-placement')).toBe('top');
    // Anchored from the bottom edge rather than the top when flipped.
    expect(panel.style.bottom).not.toBe('');
    expect(panel.style.top).toBe('');
  });

  it('stays inside the right edge of the viewport', () => {
    render(<Table />);
    // A trigger hard against the right edge — the menu must not hang off it.
    openMenu(200, VIEWPORT.width - 40);

    const panel = screen.getByTestId('dropdown-menu');
    const left = parseFloat(panel.style.left);
    const width = parseFloat(panel.style.minWidth);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('bounds the height to the space available', () => {
    render(<Table />);
    openMenu(700);

    const panel = screen.getByTestId('dropdown-menu');
    expect(parseFloat(panel.style.maxHeight)).toBeGreaterThan(0);
    expect(parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(360);
  });

  it('repositions while an ancestor scrolls', () => {
    render(<Table />);
    const trigger = openMenu(300);
    const before = screen.getByTestId('dropdown-menu').style.top;

    // The row moved up the viewport; the panel must follow it.
    stubRect(trigger, 180);
    fireEvent.scroll(window);

    expect(screen.getByTestId('dropdown-menu').style.top).not.toBe(before);
  });

  it('repositions on resize', () => {
    render(<Table />);
    const trigger = openMenu(300);
    const before = screen.getByTestId('dropdown-menu').style.left;

    Object.defineProperty(window, 'innerWidth', { value: 640, configurable: true });
    stubRect(trigger, 300, 560);
    fireEvent.resize(window);

    expect(screen.getByTestId('dropdown-menu').style.left).not.toBe(before);
  });
});
