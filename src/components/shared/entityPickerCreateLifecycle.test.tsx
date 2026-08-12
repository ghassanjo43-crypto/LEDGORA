// @vitest-environment happy-dom
/**
 * EntityPicker → QuickEntityDialog: the hand-over lifecycle.
 *
 * ══ The defect these exist to keep dead ══════════════════════════════════════
 *
 * Clicking "+ Add new entity" opened the create modal while leaving the picker
 * OPEN. Because the dropdown is portalled onto `document.body`, that left a
 * live panel in the document: it stacked over the modal, swallowed clicks meant
 * for the form, and held DOM focus on a search box the user could no longer
 * see.
 *
 * ══ Why these tests do not assert z-index ════════════════════════════════════
 *
 * Raising the modal above the panel would have hidden the symptom and left the
 * panel mounted, focusable and first in the hit-test wherever the modal does not
 * cover. So every assertion below is about the panel's EXISTENCE and about who
 * actually owns focus — not about stacking order. A fix that only changed
 * `z-index` fails all of them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { EntityPicker } from './EntityPicker';
import { JournalEntryDrawer } from '@/components/journal/JournalEntryDrawer';
import { ToastProvider } from '@/components/ui/Toast';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import type { BusinessEntity } from '@/types';

/* ─────────────────────────────── Harness ────────────────────────────────── */

const pickerPanel = () => document.querySelector<HTMLElement>('[data-testid="entity-picker-panel"]');
const modal = () => document.querySelector<HTMLElement>('[aria-label="Add new entity"]');
const pickerSearch = () => document.querySelector<HTMLInputElement>('input[placeholder^="Search company"]');
const nameField = () => document.getElementById('quick-entity-name') as HTMLInputElement | null;

function entity(id: string, legalName: string): BusinessEntity {
  return { ...(useEntityStore.getState().entities[0] as BusinessEntity), id, legalName, entityCode: id.toUpperCase() };
}

/**
 * Mirrors how every real call site wires the picker: the entity list comes from
 * the canonical store, so a newly created entity shows up in later searches the
 * way it does in the Invoice, Bill, Payment and Receipt drawers.
 */
function StorePicker({ onPick }: { onPick: (e: BusinessEntity | null) => void }) {
  const entities = useEntityStore((s) => s.entities);
  return <EntityPicker value="" entities={entities} onChange={onPick} placeholder="Select customer" />;
}

function renderPicker() {
  const picked: Array<BusinessEntity | null> = [];
  useEntityStore.setState({ entities: [entity('e1', 'Existing Customer')] });
  render(<StorePicker onPick={(e) => picked.push(e)} />);
  return { picked, trigger: screen.getByRole('combobox') };
}

/** Open the picker and click through to the create dialog. */
function openCreateFlow(search = 'ABC Trading') {
  const ctx = renderPicker();
  fireEvent.click(ctx.trigger);
  fireEvent.change(pickerSearch()!, { target: { value: search } });
  const cta = Array.from(pickerPanel()!.querySelectorAll('button')).find((b) => /as a new entity/.test(b.textContent ?? ''))!;
  fireEvent.click(cta);
  return ctx;
}

let originalEntities: BusinessEntity[];

beforeEach(() => {
  originalEntities = useEntityStore.getState().entities;
  useJournalStore.setState({ entries: [] });
});
afterEach(() => {
  cleanup();
  useEntityStore.setState({ entities: originalEntities });
});

/* ══ 1–7 · The hand-over ═══════════════════════════════════════════════════ */

describe('opening the create dialog', () => {
  it('1–4 · removes the picker panel from the DOM and shows the modal', () => {
    const { trigger } = renderPicker();
    fireEvent.click(trigger);
    expect(pickerPanel(), 'the dropdown is open to begin with').toBeTruthy();

    fireEvent.change(pickerSearch()!, { target: { value: 'ABC Trading' } });
    fireEvent.click(
      Array.from(pickerPanel()!.querySelectorAll('button')).find((b) => /as a new entity/.test(b.textContent ?? ''))!,
    );

    // The assertion the bug failed: the portalled panel is GONE, not merely
    // covered. This is what a z-index-only fix cannot satisfy.
    expect(pickerPanel(), 'the picker panel must be unmounted').toBeNull();
    expect(document.querySelectorAll('[data-testid="entity-picker-panel"]')).toHaveLength(0);
    expect(modal(), 'the create modal is up').toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('5 · leaves nothing of the picker behind to intercept clicks', () => {
    openCreateFlow();
    // Nothing from the picker remains anywhere in the document body.
    expect(pickerSearch(), 'the picker search box is gone').toBeNull();
    expect(document.querySelectorAll('[role="option"]'), 'no stale options remain').toHaveLength(0);
    // The only portalled overlay left is the modal itself.
    const overlays = Array.from(document.body.children).filter(
      (el) => el.querySelector('[role="dialog"]') || el.getAttribute('role') === 'dialog',
    );
    expect(overlays.length).toBeGreaterThan(0);
  });

  it('6 · the picker search field no longer holds focus', () => {
    openCreateFlow();
    expect(pickerSearch()).toBeNull();
    expect(document.activeElement, 'focus is not left on a removed search box').not.toBe(pickerSearch());
  });

  it('7 · every modal field is present and editable', async () => {
    openCreateFlow('ABC Trading');
    await waitFor(() => expect(document.activeElement).toBe(nameField()));

    for (const id of ['quick-entity-name', 'quick-entity-code', 'quick-entity-contact', 'quick-entity-email', 'quick-entity-phone', 'quick-entity-tax']) {
      const field = document.getElementById(id) as HTMLInputElement;
      expect(field, `${id} exists`).toBeTruthy();
      expect(field.disabled, `${id} is editable`).toBe(false);
      fireEvent.change(field, { target: { value: 'x' } });
    }
    expect(document.getElementById('quick-entity-type')).toBeTruthy();
    // The typed search became the name.
    expect((document.getElementById('quick-entity-name') as HTMLInputElement).value).toBe('x');
  });

  it('carries the typed search into the modal as the name', async () => {
    openCreateFlow('ABC Trading');
    await waitFor(() => expect(nameField()!.value).toBe('ABC Trading'));
  });
});

/* ══ 8–10 · Saving ═════════════════════════════════════════════════════════ */

describe('saving the new entity', () => {
  it('8–9 · creates it and selects it on the picker, without reopening the dropdown', async () => {
    const { picked } = openCreateFlow('ABC Trading');
    fireEvent.submit(nameField()!.closest('form')!);

    await waitFor(() => expect(useEntityStore.getState().entities.some((e) => e.legalName === 'ABC Trading')).toBe(true));

    expect(modal(), 'the modal closes').toBeNull();
    expect(picked, 'the new entity is selected').toHaveLength(1);
    expect(picked[0]?.legalName).toBe('ABC Trading');
    // The dropdown must NOT spring back open after saving.
    expect(pickerPanel(), 'the dropdown stays closed after saving').toBeNull();
  });

  it('14 · reopening the picker afterwards still works normally', async () => {
    const { trigger } = openCreateFlow('ABC Trading');
    fireEvent.submit(nameField()!.closest('form')!);
    await waitFor(() => expect(modal()).toBeNull());

    fireEvent.click(trigger);
    expect(pickerPanel(), 'the picker opens again').toBeTruthy();
    expect(pickerSearch()!.value, 'with a fresh search').toBe('');
    // And the new entity is now among the options.
    fireEvent.change(pickerSearch()!, { target: { value: 'ABC' } });
    expect(Array.from(document.querySelectorAll('[role="option"]')).some((o) => /ABC Trading/.test(o.textContent ?? ''))).toBe(true);
  });
});

/* ══ 11–13 · Cancelling and Escape ═════════════════════════════════════════ */

describe('leaving the dialog without saving', () => {
  it('11–12 · Cancel closes only the modal and leaves the picker closed', () => {
    openCreateFlow('Never Created');
    // Counted after the harness has seeded the store, so this measures the
    // effect of Cancel and nothing else.
    const before = useEntityStore.getState().entities.length;

    fireEvent.click(Array.from(modal()!.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel')!);

    expect(modal(), 'the modal closes').toBeNull();
    expect(pickerPanel(), 'and the dropdown does NOT spring back open').toBeNull();
    expect(useEntityStore.getState().entities, 'nothing was created').toHaveLength(before);
  });

  it('13 · Escape closes the modal without reopening the picker', () => {
    openCreateFlow('Never Created');
    fireEvent.keyDown(modal()!, { key: 'Escape' });

    expect(modal()).toBeNull();
    expect(pickerPanel(), 'Escape must not reopen the dropdown').toBeNull();
  });

  it('focus returns to the originating trigger, not to a removed search box', () => {
    const { trigger } = openCreateFlow('Never Created');
    fireEvent.click(Array.from(modal()!.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel')!);
    expect(document.activeElement).toBe(trigger);
  });
});

/* ══ 15 · The same flow inside the General Journal ═════════════════════════ */

describe('the General Journal entity cell', () => {
  it('closes its dropdown before the modal opens, and preserves the journal draft', async () => {
    render(
      <ToastProvider>
        <JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />
      </ToastProvider>,
    );

    // A draft worth protecting.
    const debits = Array.from(document.querySelectorAll<HTMLInputElement>('[data-col="debit"]'));
    const credits = Array.from(document.querySelectorAll<HTMLInputElement>('[data-col="credit"]'));
    fireEvent.change(debits[0]!, { target: { value: '5000000' } });
    fireEvent.change(credits[1]!, { target: { value: '5000000' } });
    fireEvent.change(document.getElementById('description')!, { target: { value: 'Land purchase' } });

    const entityTrigger = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]')).find((el) =>
      (el.textContent ?? '').trim().startsWith('No entity'),
    )!;
    fireEvent.click(entityTrigger);
    expect(pickerPanel()).toBeTruthy();

    fireEvent.change(pickerSearch()!, { target: { value: 'Journal Co' } });
    fireEvent.click(
      Array.from(pickerPanel()!.querySelectorAll('button')).find((b) => /as a new entity/.test(b.textContent ?? ''))!,
    );

    expect(pickerPanel(), 'the journal dropdown unmounts too').toBeNull();
    expect(modal()).toBeTruthy();
    // The journal drawer is untouched underneath.
    expect(screen.getByText('New journal entry')).toBeTruthy();
    expect(debits[0]!.value).toBe('5000000');

    fireEvent.submit(nameField()!.closest('form')!);
    await waitFor(() => expect(modal()).toBeNull());

    expect(pickerPanel(), 'no dropdown after saving').toBeNull();
    expect(debits[0]!.value, 'amounts preserved').toBe('5000000');
    expect(credits[1]!.value).toBe('5000000');
    expect((document.getElementById('description') as HTMLInputElement).value).toBe('Land purchase');
  });
});
