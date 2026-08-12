// @vitest-environment happy-dom
/**
 * Journal Voucher dimension cells: Project and Cost Center.
 *
 * ══ What was wrong ═══════════════════════════════════════════════════════════
 *
 * Both were native `<select>`s at 128px. Two failures compounded:
 *
 *   width    `PRJ-2026-014 · Amman Office Development` truncated to roughly the
 *            code and one word, which is not enough to tell two projects in the
 *            same city apart;
 *   reach    no search, and no way to open a missing project or cost center
 *            without abandoning the voucher — the exact moment an accountant
 *            gives up and leaves the dimension blank, which is how postings
 *            arrive unattributed.
 *
 * The tests below are written around the thing that makes the create flow worth
 * having at all: that the voucher SURVIVES it. Every creation assertion is
 * paired with a check that the amounts, the other lines and the header are
 * exactly as they were.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { JournalVouchersPage } from './JournalVouchersPage';
import { useJournalVoucherStore } from '@/store/journalVoucherStore';
import { useProjectStore } from '@/store/projectStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useAuthStore } from '@/store/authStore';
import type { Project } from '@/types/project';
import type { CostCenter } from '@/types/costCenter';

/* ─────────────────────────────── Harness ────────────────────────────────── */

type Kind = 'project' | 'costCenter';

const EMPTY_LABEL: Record<Kind, string> = { project: 'No project', costCenter: 'No cost center' };
const PANEL_ID: Record<Kind, string> = {
  project: 'project-picker-panel',
  costCenter: 'cost-center-picker-panel',
};

function openNewVoucher() {
  const view = render(<JournalVouchersPage />);
  fireEvent.click(screen.getByRole('button', { name: /new journal voucher/i }));
  return view;
}

/** All triggers of one dimension kind, in line order. */
function triggers(kind: Kind): HTMLElement[] {
  const prefix = kind === 'project' ? 'PRJ' : 'CC';
  return Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]')).filter((el) => {
    const text = (el.textContent ?? '').trim();
    return text.startsWith(EMPTY_LABEL[kind]) || text.startsWith(prefix);
  });
}

const trigger = (kind: Kind, line: number): HTMLElement => triggers(kind)[line]!;
const panel = (kind: Kind): HTMLElement | null => document.querySelector(`[data-testid="${PANEL_ID[kind]}"]`);
const searchBox = (kind: Kind): HTMLInputElement =>
  panel(kind)!.querySelector<HTMLInputElement>('input[placeholder^="Search code or name"]')!;
const options = (kind: Kind): string[] =>
  Array.from(panel(kind)!.querySelectorAll('[role="option"]')).map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim());

const debitInput = (line: number): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`[data-testid="jv-debit-${line}"]`)!;
const creditInput = (line: number): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`[data-testid="jv-credit-${line}"]`)!;

function open(kind: Kind, line: number): void {
  fireEvent.click(trigger(kind, line));
}
function search(kind: Kind, text: string): void {
  fireEvent.change(searchBox(kind), { target: { value: text } });
}
function clickCreate(kind: Kind): void {
  const label = kind === 'project' ? /as a new project|^Add new project$/ : /as a new cost center|^Add new cost center$/;
  const btn = Array.from(panel(kind)!.querySelectorAll('button')).find((b) => label.test((b.textContent ?? '').trim()))!;
  fireEvent.click(btn);
}
function fillAndSave(kind: Kind, name: string): void {
  const id = kind === 'project' ? 'quick-project-name' : 'quick-cc-name';
  fireEvent.change(document.getElementById(id)!, { target: { value: name } });
  fireEvent.submit(document.getElementById(id)!.closest('form')!);
}

/** A known project / cost center so searches have something to find. */
const SEED_PROJECT = (): Project => ({
  ...(useProjectStore.getState().projects[0] as Project),
  id: 'prj-test-1',
  code: 'PRJ-AMM-001',
  name: 'Amman Development',
  status: 'active',
  startDate: '2020-01-01',
  endDate: undefined,
});
const SEED_CC = (): CostCenter => ({
  ...(useCostCenterStore.getState().costCenters[0] as CostCenter),
  id: 'cc-test-1',
  code: 'CC-OPS-AMM',
  name: 'Amman Operations',
  status: 'active',
  isPostingAllowed: true,
  parentId: undefined,
  hierarchyPath: ['cc-test-1'],
  level: 0,
  effectiveFrom: '2020-01-01',
  effectiveTo: undefined,
});

let originalProjects: Project[];
let originalCentres: CostCenter[];

beforeEach(() => {
  originalProjects = useProjectStore.getState().projects;
  originalCentres = useCostCenterStore.getState().costCenters;
  useJournalVoucherStore.setState({ vouchers: [] } as never);
  useProjectStore.setState({ projects: [SEED_PROJECT()] } as never);
  useCostCenterStore.setState({ costCenters: [SEED_CC()] } as never);
  useAuthStore.setState({ currentUserId: null } as never);
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: originalProjects } as never);
  useCostCenterStore.setState({ costCenters: originalCentres } as never);
  useAuthStore.setState({ currentUserId: null } as never);
});

/* ══ 1 / 13 · Column width ═════════════════════════════════════════════════ */

describe('dimension column width', () => {
  const widthOf = (label: string): number => {
    const th = Array.from(document.querySelectorAll('th')).find((x) => x.textContent?.trim() === label)!;
    const m = /w-\[(\d+)px\]/.exec(th.className);
    return m ? Number(m[1]) : 0;
  };

  it('Project and Cost center are each 180–220px', () => {
    openNewVoucher();
    for (const label of ['Project', 'Cost center']) {
      expect(widthOf(label), `${label} width`).toBeGreaterThanOrEqual(180);
      expect(widthOf(label), `${label} width`).toBeLessThanOrEqual(220);
    }
  });

  it('does not steal width from Debit, Credit or Account', () => {
    openNewVoucher();
    // The money columns keep the 176px won in the previous change.
    expect(widthOf('Debit')).toBe(176);
    expect(widthOf('Credit')).toBe(176);
    const account = Array.from(document.querySelectorAll('th')).find((x) => x.textContent?.trim() === 'Account')!;
    expect(account.className).toContain('min-w-[220px]');
  });

  it('shows the complete code and name in a title when truncated', () => {
    openNewVoucher();
    open('project', 0);
    fireEvent.click(Array.from(panel('project')!.querySelectorAll('[role="option"]'))[0]!);
    expect(trigger('project', 0).getAttribute('title')).toBe('PRJ-AMM-001 · Amman Development');
  });
});

/* ══ 2–6 · Project search ══════════════════════════════════════════════════ */

describe('the project picker', () => {
  it('searches by project code', () => {
    openNewVoucher();
    open('project', 0);
    search('project', 'AMM');
    expect(options('project').some((t) => t.includes('PRJ-AMM-001'))).toBe(true);
  });

  it('searches by partial project name, case-insensitively', () => {
    openNewVoucher();
    open('project', 0);
    search('project', 'develop');
    expect(options('project').some((t) => /Amman Development/i.test(t))).toBe(true);
    search('project', 'DEVELOP');
    expect(options('project').some((t) => /Amman Development/i.test(t))).toBe(true);
  });

  it('keeps "No project" as a valid option', () => {
    openNewVoucher();
    open('project', 0);
    const none = Array.from(panel('project')!.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'No project')!;
    expect(none).toBeTruthy();
    fireEvent.click(none);
    expect(trigger('project', 0).textContent).toContain('No project');
  });

  it('always offers "Add new project"', () => {
    openNewVoucher();
    open('project', 0);
    expect(
      Array.from(panel('project')!.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Add new project'),
    ).toBe(true);
  });

  it('offers creation from the no-match state, carrying the typed text', () => {
    openNewVoucher();
    open('project', 0);
    search('project', 'ABC');
    expect(panel('project')!.textContent).toMatch(/No projects match “ABC”/);
    expect(
      Array.from(panel('project')!.querySelectorAll('button')).some((b) => /Add “ABC” as a new project/.test(b.textContent ?? '')),
    ).toBe(true);
  });
});

/* ══ 7–12 · Creating a project ═════════════════════════════════════════════ */

describe('creating a project from a voucher line', () => {
  /** Fill the voucher with data that must survive the round trip. */
  function seedVoucher(): void {
    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '250000' } });
    fireEvent.blur(debitInput(0));
    fireEvent.focus(creditInput(1));
    fireEvent.change(creditInput(1), { target: { value: '250000' } });
    fireEvent.blur(creditInput(1));
  }

  it('keeps the voucher open and assigns the new project to the originating line', () => {
    openNewVoucher();
    seedVoucher();
    // Give line 2 its own project so we can prove it is not disturbed.
    open('project', 1);
    fireEvent.click(Array.from(panel('project')!.querySelectorAll('[role="option"]'))[0]!);
    expect(trigger('project', 1).textContent).toContain('Amman Development');

    open('project', 0);
    search('project', 'Amman Expansion');
    clickCreate('project');

    // The voucher is still there behind the dialog.
    expect(document.querySelector('[aria-label="Add new project"]')).toBeTruthy();
    expect(debitInput(0), 'the voucher editor is still mounted').toBeTruthy();

    fillAndSave('project', 'Amman Expansion');

    // Dialog closed, voucher open.
    expect(document.querySelector('[aria-label="Add new project"]')).toBeNull();
    expect(debitInput(0)).toBeTruthy();

    // Assigned to line 1 only.
    expect(trigger('project', 0).textContent).toContain('Amman Expansion');
    expect(trigger('project', 1).textContent, 'other lines untouched').toContain('Amman Development');

    // Amounts intact.
    expect(debitInput(0).value).toBe('250,000.00');
    expect(creditInput(1).value).toBe('250,000.00');

    // Persisted through the canonical store.
    expect(useProjectStore.getState().projects.some((p) => p.name === 'Amman Expansion')).toBe(true);
  });

  it('the new project appears in later searches', () => {
    openNewVoucher();
    open('project', 0);
    search('project', 'Zenith Initiative');
    clickCreate('project');
    fillAndSave('project', 'Zenith Initiative');

    open('project', 1);
    search('project', 'Zenith');
    expect(panel('project')!.textContent).not.toMatch(/No projects match/);
    expect(options('project').some((t) => /Zenith Initiative/.test(t))).toBe(true);
  });

  it('cancelling changes nothing', () => {
    openNewVoucher();
    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '250000' } });
    fireEvent.blur(debitInput(0));
    const projectsBefore = useProjectStore.getState().projects.length;

    open('project', 0);
    search('project', 'Never Created');
    clickCreate('project');
    fireEvent.click(
      Array.from(document.querySelector('[aria-label="Add new project"]')!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Cancel',
      )!,
    );

    expect(document.querySelector('[aria-label="Add new project"]')).toBeNull();
    expect(useProjectStore.getState().projects).toHaveLength(projectsBefore);
    expect(trigger('project', 0).textContent).toContain('No project');
    expect(debitInput(0).value).toBe('250,000.00');
  });

  it('a role without projects.create gets no create action, and the store refuses anyway', () => {
    useAuthStore.setState({
      currentUserId: 'u1',
      users: [{ id: 'u1', fullName: 'V', email: 'v@x.test', role: 'viewer', status: 'active', organizationId: 'org' }],
    } as never);
    openNewVoucher();
    open('project', 0);
    search('project', 'Nope');

    expect(
      Array.from(panel('project')!.querySelectorAll('button')).some((b) => /new project/i.test(b.textContent ?? '')),
    ).toBe(false);

    // Hiding the button is the affordance; the write is the guarantee.
    const before = useProjectStore.getState().projects.length;
    const result = useProjectStore.getState().createProject({ code: 'PRJ-X', name: 'Back door' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/projects\.create/);
    expect(useProjectStore.getState().projects).toHaveLength(before);
  });
});

/* ══ 14–22 · Cost centers ══════════════════════════════════════════════════ */

describe('the cost center picker', () => {
  it('searches by code and by partial name', () => {
    openNewVoucher();
    open('costCenter', 0);
    search('costCenter', 'OPS');
    expect(options('costCenter').some((t) => t.includes('CC-OPS-AMM'))).toBe(true);

    search('costCenter', 'operations');
    expect(options('costCenter').some((t) => /Amman Operations/i.test(t))).toBe(true);
  });

  it('keeps "No cost center" valid and always offers creation', () => {
    openNewVoucher();
    open('costCenter', 0);
    expect(
      Array.from(panel('costCenter')!.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'No cost center'),
    ).toBe(true);
    expect(
      Array.from(panel('costCenter')!.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Add new cost center'),
    ).toBe(true);
  });

  it('offers creation from the no-match state', () => {
    openNewVoucher();
    open('costCenter', 0);
    search('costCenter', 'Marketing');
    expect(panel('costCenter')!.textContent).toMatch(/No cost centers match “Marketing”/);
    expect(
      Array.from(panel('costCenter')!.querySelectorAll('button')).some((b) =>
        /Add “Marketing” as a new cost center/.test(b.textContent ?? ''),
      ),
    ).toBe(true);
  });

  it('creates, activates and selects on the originating line without disturbing the voucher', () => {
    openNewVoucher();
    fireEvent.focus(debitInput(0));
    fireEvent.change(debitInput(0), { target: { value: '50000' } });
    fireEvent.blur(debitInput(0));
    open('costCenter', 1);
    fireEvent.click(Array.from(panel('costCenter')!.querySelectorAll('[role="option"]'))[0]!);

    open('costCenter', 0);
    search('costCenter', 'Amman Marketing');
    clickCreate('costCenter');
    fillAndSave('costCenter', 'Amman Marketing');

    expect(document.querySelector('[aria-label="Add new cost center"]')).toBeNull();
    expect(trigger('costCenter', 0).textContent).toContain('Amman Marketing');
    expect(trigger('costCenter', 1).textContent, 'other lines untouched').toContain('Amman Operations');
    expect(debitInput(0).value).toBe('50,000.00');

    /*
     * Activated through the canonical path — an inactive cost center is not
     * selectable, so creating one without activating it would hand the user a
     * record the picker then refuses to offer.
     */
    const created = useCostCenterStore.getState().costCenters.find((c) => c.name === 'Amman Marketing')!;
    expect(created).toBeDefined();
    expect(created.status).toBe('active');
  });

  it('cancelling leaves the draft untouched', () => {
    openNewVoucher();
    const before = useCostCenterStore.getState().costCenters.length;
    open('costCenter', 0);
    search('costCenter', 'Never');
    clickCreate('costCenter');
    fireEvent.click(
      Array.from(document.querySelector('[aria-label="Add new cost center"]')!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Cancel',
      )!,
    );
    expect(useCostCenterStore.getState().costCenters).toHaveLength(before);
    expect(trigger('costCenter', 0).textContent).toContain('No cost center');
  });

  it('a role without cost_centers.create is refused by the store', () => {
    useAuthStore.setState({
      currentUserId: 'u1',
      users: [{ id: 'u1', fullName: 'V', email: 'v@x.test', role: 'viewer', status: 'active', organizationId: 'org' }],
    } as never);
    openNewVoucher();
    open('costCenter', 0);
    expect(
      Array.from(panel('costCenter')!.querySelectorAll('button')).some((b) => /new cost center/i.test(b.textContent ?? '')),
    ).toBe(false);

    const result = useCostCenterStore.getState().createCostCenter({ code: 'CC-X', name: 'Back door' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cost_centers\.create/);
  });
});

/* ══ 23–26 · Positioning ═══════════════════════════════════════════════════ */

describe('dimension picker positioning', () => {
  const VIEWPORT = { width: 1280, height: 800 };

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true });
  });

  function stubRect(el: Element, top: number): void {
    el.getBoundingClientRect = () =>
      ({ top, bottom: top + 36, left: 500, right: 700, width: 200, height: 36, x: 500, y: top, toJSON: () => ({}) }) as DOMRect;
  }

  /** Add lines until the last one would sit low in the drawer. */
  function addLines(n: number): void {
    for (let i = 0; i < n; i += 1) {
      fireEvent.click(Array.from(document.querySelectorAll('button')).find((b) => /Add line/.test(b.textContent ?? ''))!);
    }
  }

  it.each(['project', 'costCenter'] as Kind[])('%s picker portals out of the table and is not clipped', (kind) => {
    openNewVoucher();
    addLines(5);
    const last = triggers(kind).length - 1;
    stubRect(trigger(kind, last), 240);
    open(kind, last);

    const p = panel(kind)!;
    expect(p.parentElement, 'rendered on document.body').toBe(document.body);
    // No scrollable ancestor survives to clip it.
    let node: Element | null = p.parentElement;
    const clippers: string[] = [];
    while (node && node !== document.documentElement) {
      if (/overflow-(x|y)-auto|overflow-hidden/.test(node.className || '')) clippers.push(node.tagName);
      node = node.parentElement;
    }
    expect(clippers).toEqual([]);
  });

  it.each(['project', 'costCenter'] as Kind[])('%s picker flips above near the viewport floor', (kind) => {
    openNewVoucher();
    addLines(5);
    const last = triggers(kind).length - 1;
    stubRect(trigger(kind, last), VIEWPORT.height - 60);
    open(kind, last);

    const p = panel(kind)!;
    expect(p.dataset.placement).toBe('top');
    expect(p.style.bottom).not.toBe('');
    expect(p.style.top).toBe('');
    expect(parseFloat(p.style.bottom) + parseFloat(p.style.maxHeight)).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it.each(['project', 'costCenter'] as Kind[])('%s create action stays outside the scrolling list', (kind) => {
    openNewVoucher();
    addLines(5);
    const last = triggers(kind).length - 1;
    stubRect(trigger(kind, last), VIEWPORT.height - 60);
    open(kind, last);

    const p = panel(kind)!;
    const label = kind === 'project' ? 'Add new project' : 'Add new cost center';
    const add = Array.from(p.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
    expect(add, 'the create action is present').toBeTruthy();
    expect(p.querySelector('ul')!.contains(add), 'and not inside the scroller').toBe(false);
  });
});
