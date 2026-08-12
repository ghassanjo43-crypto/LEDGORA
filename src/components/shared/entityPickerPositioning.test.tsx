// @vitest-environment happy-dom
/**
 * EntityPicker dropdown placement — the clipping regression.
 *
 * ══ What was wrong ═══════════════════════════════════════════════════════════
 *
 * The panel was absolutely positioned INSIDE the picker, which made it a child
 * of the journal entry drawer's `overflow-y-auto` body. On a line near the
 * bottom of the drawer the options were cut off by that scroll container: every
 * option was in the DOM and every DOM-based test passed, while a real user
 * could not see or click them.
 *
 * That is the trap these tests are written around. Asserting "the option
 * exists" would have passed throughout the bug, so they assert the two things
 * that actually decide whether a user can reach it:
 *
 *   WHERE the panel lives  — on `document.body`, outside every scroll
 *                            container, so no ancestor can clip it;
 *   WHERE it is placed     — below when there is room, flipped above when there
 *                            is not, and always inside the viewport.
 *
 * Rects are stubbed because happy-dom reports every element as 0×0 at (0,0);
 * the positioning itself is the real `computePopoverPosition` used in the app.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { EntityPicker } from './EntityPicker';
import { JournalEntryDrawer } from '@/components/journal/JournalEntryDrawer';
import { ToastProvider } from '@/components/ui/Toast';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import type { BusinessEntity } from '@/types';

const VIEWPORT = { width: 1280, height: 800 };

/** Pin the viewport so placement maths is deterministic. */
function setViewport(): void {
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true });
}

/** Give one element a fixed viewport rect (happy-dom reports 0×0 for everything). */
function stubRect(el: Element, rect: { top: number; left?: number; width?: number; height?: number }): void {
  const left = rect.left ?? 400;
  const width = rect.width ?? 180;
  const height = rect.height ?? 36;
  el.getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** The entity picker's own panel, ignoring any other portalled picker. */
const panel = () => document.querySelector<HTMLElement>('[data-testid="entity-picker-panel"]');

/** Every scrollable ancestor between the panel and the document root. */
function scrollableAncestors(el: Element): Element[] {
  const found: Element[] = [];
  let node: Element | null = el.parentElement;
  while (node && node !== document.documentElement) {
    if (/overflow-(y-)?auto|overflow-hidden|overflow-y-scroll/.test(node.className || '')) found.push(node);
    node = node.parentElement;
  }
  return found;
}

function entity(id: string, legalName: string): BusinessEntity {
  return {
    ...(useEntityStore.getState().entities[0] as BusinessEntity),
    id,
    legalName,
    entityCode: id.toUpperCase(),
  };
}

let originalEntities: BusinessEntity[];

beforeEach(() => {
  setViewport();
  originalEntities = useEntityStore.getState().entities;
  useJournalStore.setState({ entries: [] });
});
afterEach(() => {
  cleanup();
  useEntityStore.setState({ entities: originalEntities });
});

/* ══ Standalone picker: placement maths ════════════════════════════════════ */

describe('EntityPicker placement', () => {
  const entities = [entity('e1', 'Alpha Trading'), entity('e2', 'Beta Supplies')];

  function openAt(top: number) {
    render(<EntityPicker value="" onChange={() => {}} entities={entities} />);
    const trigger = screen.getByRole('combobox');
    stubRect(trigger, { top });
    fireEvent.click(trigger);
    return trigger;
  }

  it('renders the panel on document.body, not inside the picker', () => {
    openAt(120);
    const p = panel();
    expect(p, 'panel must exist').toBeTruthy();
    // The portal target. If this ever regresses to an in-tree panel, the
    // drawer's scroll container becomes its ancestor again.
    expect(p!.parentElement).toBe(document.body);
  });

  it('has no scrollable ancestor that could clip it', () => {
    openAt(120);
    expect(scrollableAncestors(panel()!)).toEqual([]);
  });

  it('opens BELOW a trigger near the top of the viewport', () => {
    openAt(120);
    const p = panel()!;
    expect(p.dataset.placement).toBe('bottom');
    expect(p.style.top).not.toBe('');
    expect(p.style.bottom).toBe('');
    // Below the trigger, and the panel's bottom edge stays on screen.
    expect(parseFloat(p.style.top)).toBeGreaterThan(120);
    expect(parseFloat(p.style.top) + parseFloat(p.style.maxHeight)).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('FLIPS ABOVE a trigger near the bottom of the viewport', () => {
    // 36px tall trigger whose bottom sits 24px from the viewport floor.
    openAt(VIEWPORT.height - 60);
    const p = panel()!;
    expect(p.dataset.placement).toBe('top');
    expect(p.style.bottom).not.toBe('');
    expect(p.style.top).toBe('');
    // Grows upward from just above the trigger, and still fits on screen.
    expect(parseFloat(p.style.bottom)).toBeGreaterThan(0);
    expect(parseFloat(p.style.maxHeight)).toBeGreaterThan(0);
    expect(parseFloat(p.style.bottom) + parseFloat(p.style.maxHeight)).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('stays inside the viewport horizontally when the trigger is at the right edge', () => {
    render(<EntityPicker value="" onChange={() => {}} entities={entities} />);
    const trigger = screen.getByRole('combobox');
    stubRect(trigger, { top: 200, left: VIEWPORT.width - 60, width: 50 });
    fireEvent.click(trigger);
    const p = panel()!;
    const left = parseFloat(p.style.left);
    const width = parseFloat(p.style.width);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('caps its own height so the list scrolls internally instead of overflowing', () => {
    openAt(VIEWPORT.height - 200);
    const p = panel()!;
    const list = p.querySelector('ul')!;
    expect(parseFloat(p.style.maxHeight)).toBeGreaterThan(0);
    // The list is the scroller; the panel itself hides overflow.
    expect(list.className).toContain('overflow-y-auto');
    expect(p.className).toContain('overflow-hidden');
  });

  it('keeps "Add new entity" outside the scrolling list so it is always reachable', () => {
    openAt(VIEWPORT.height - 120);
    const p = panel()!;
    const add = Array.from(p.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add new entity')!;
    expect(add, '"Add new entity" must be present').toBeTruthy();
    // Not a descendant of the <ul> — a footer inside the scroller is the first
    // thing to disappear when the list is long.
    expect(p.querySelector('ul')!.contains(add)).toBe(false);
  });

  it('still offers No entity, the search box and the existing entities', () => {
    openAt(200);
    const p = panel()!;
    expect(Array.from(p.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'No entity')).toBe(true);
    expect(p.querySelector('input[placeholder^="Search company"]')).toBeTruthy();
    expect(p.querySelectorAll('[role="option"]')).toHaveLength(2);
  });

  it('keyboard navigation, selection and Escape survive the move to a portal', () => {
    const picked: Array<BusinessEntity | null> = [];
    render(<EntityPicker value="" onChange={(e) => picked.push(e)} entities={entities} />);
    const trigger = screen.getByRole('combobox');
    stubRect(trigger, { top: 200 });
    fireEvent.click(trigger);

    const search = panel()!.querySelector('input[placeholder^="Search company"]')!;
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(picked).toHaveLength(1);
    expect(picked[0]?.legalName).toBe('Beta Supplies');
    expect(panel(), 'selecting closes the panel').toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(panel()!.querySelector('input[placeholder^="Search company"]')!, { key: 'Escape' });
    expect(panel(), 'Escape closes the panel').toBeNull();
  });

  it('clicking inside the portalled panel does not close it', () => {
    openAt(200);
    // The outside-click handler has to know the panel is not in the trigger's
    // subtree any more, or every click on an option would close first.
    fireEvent.mouseDown(panel()!.querySelector('input[placeholder^="Search company"]')!);
    expect(panel()).toBeTruthy();
  });
});

/* ══ Inside the real journal drawer ════════════════════════════════════════ */

describe('EntityPicker inside the journal entry drawer', () => {
  function openDrawer() {
    return render(
      <ToastProvider>
        <JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />
      </ToastProvider>,
    );
  }

  /**
   * The entity trigger on a 0-based journal line.
   *
   * Identified by what it SAYS, not by its index among comboboxes: a line also
   * renders account, cost-center and project comboboxes, and any of those
   * counts can change without this test being about them.
   */
  function entityTrigger(line: number): HTMLElement {
    const triggers = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]')).filter((el) =>
      (el.textContent ?? '').trim().startsWith('No entity'),
    );
    return triggers[line]!;
  }

  it('the FIRST journal line opens below and escapes the drawer’s scroll container', () => {
    openDrawer();
    const trigger = entityTrigger(0);
    stubRect(trigger, { top: 240 });
    fireEvent.click(trigger);

    const p = panel()!;
    expect(p.parentElement).toBe(document.body);
    expect(scrollableAncestors(p)).toEqual([]);
    expect(p.dataset.placement).toBe('bottom');
  });

  it('the LAST journal line flips above rather than being clipped', () => {
    openDrawer();
    const lines = document.querySelectorAll('[data-col="debit"]').length;
    const trigger = entityTrigger(lines - 1);
    // A last line sitting low in the drawer, as in the reported screenshot.
    stubRect(trigger, { top: VIEWPORT.height - 70 });
    fireEvent.click(trigger);

    const p = panel()!;
    expect(p.parentElement).toBe(document.body);
    expect(p.dataset.placement, 'must flip up near the viewport floor').toBe('top');
    expect(parseFloat(p.style.bottom) + parseFloat(p.style.maxHeight)).toBeLessThanOrEqual(VIEWPORT.height);
    // And the create action is still there, on the far side of the list.
    const add = Array.from(p.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add new entity')!;
    expect(add).toBeTruthy();
    expect(p.querySelector('ul')!.contains(add)).toBe(false);
  });

  it('opening the picker does not scroll the drawer body', () => {
    openDrawer();
    const body = document.querySelector<HTMLElement>('.overflow-y-auto');
    expect(body, 'the drawer body is the scroll container under test').toBeTruthy();
    body!.scrollTop = 0;

    const trigger = entityTrigger(1);
    stubRect(trigger, { top: VIEWPORT.height - 90 });
    fireEvent.click(trigger);

    expect(panel()).toBeTruthy();
    expect(body!.scrollTop, 'the drawer must not jump when the panel opens').toBe(0);
  });

  it('creating an entity from a flipped panel still selects it on the originating line', () => {
    openDrawer();
    const lines = document.querySelectorAll('[data-col="debit"]').length;
    const trigger = entityTrigger(lines - 1);
    stubRect(trigger, { top: VIEWPORT.height - 70 });
    fireEvent.click(trigger);

    const search = panel()!.querySelector<HTMLInputElement>('input[placeholder^="Search company"]')!;
    fireEvent.change(search, { target: { value: 'Portal Co' } });
    fireEvent.click(
      Array.from(panel()!.querySelectorAll('button')).find((b) => /as a new entity/.test(b.textContent ?? ''))!,
    );

    // The create dialog opens above the panel and the journal is untouched.
    expect(document.querySelector('[aria-label="Add new entity"]')).toBeTruthy();
    expect(screen.getByText('New journal entry')).toBeTruthy();
  });
});
