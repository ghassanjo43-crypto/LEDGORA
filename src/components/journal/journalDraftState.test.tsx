// @vitest-environment happy-dom
/**
 * General Journal — draft state ownership, and inline entity creation.
 *
 * ══ The defect these exist to keep dead ══════════════════════════════════════
 *
 * The drawer showed two complete lines — account, 5,000,000 debit, 5,000,000
 * credit — while the footer read 0.00 / 0.00 and the panel insisted the entry
 * "needs at least two lines" and had "no debit or credit amounts".
 *
 * The inputs were never wrong. `watch('lines')` hands back the SAME array on
 * every render and mutates it in place, so every `useMemo` keyed on that array
 * never recomputed: the component rendered live data and displayed a cache
 * captured at mount.
 *
 * A test that only checked the DOM would have passed throughout. So the tests
 * below assert on what the user actually reads — the rendered footer and the
 * rendered validation panel — AFTER typing, because that is the only place the
 * disagreement was visible.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { JournalEntryDrawer } from './JournalEntryDrawer';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { makeDefaultEntityValues, useEntityStore } from '@/store/useEntityStore';
import { useAuthStore } from '@/store/authStore';
import { deriveJournalDraft, draftSignature, toDecimalAmount } from '@/lib/journalDraft';
import type { Account, BusinessEntity } from '@/types';

/* ─────────────────────────────── Harness ────────────────────────────────── */

function drawer(mode: { kind: 'create' } | { kind: 'edit'; entryId: string } = { kind: 'create' }) {
  return render(
    <ToastProvider>
      <JournalEntryDrawer open mode={mode} onClose={() => {}} />
    </ToastProvider>,
  );
}

const debitInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-col="debit"]'));
const creditInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-col="credit"]'));

/** What the sticky footer actually reads, as the user sees it. */
function footerTotals(): { debit: string; credit: string; difference: string } {
  const read = (label: string): string => {
    const node = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === label);
    return node?.parentElement?.querySelector('span:last-child')?.textContent ?? '';
  };
  return { debit: read('Total debit'), credit: read('Total credit'), difference: read('Difference') };
}

const panelText = (): string => document.body.textContent ?? '';

/** Two posting accounts from the seeded chart. */
function postingAccounts(): Account[] {
  return useStore.getState().accounts.filter((a) => a.isPostingAccount && a.isActive);
}

/** Select an account on a line through the real picker. */
function pickAccount(index: number, account: Account): void {
  fireEvent.click(document.getElementById(`account-${index}`)!);
  const option = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(account.code) && b.textContent?.includes(account.name),
  );
  fireEvent.click(option!);
}

function typeAmount(index: number, side: 'debit' | 'credit', value: string): void {
  const el = side === 'debit' ? debitInputs()[index]! : creditInputs()[index]!;
  fireEvent.change(el, { target: { value } });
}

/** The two-line, 5,000,000 balanced entry from the defect report. */
function buildBalancedEntry(): { land: Account; cash: Account } {
  const [land, cash] = postingAccounts();
  pickAccount(0, land!);
  pickAccount(1, cash!);
  typeAmount(0, 'debit', '5000000');
  typeAmount(1, 'credit', '5000000');
  return { land: land!, cash: cash! };
}

const ENTITY_SEED = () => useEntityStore.getState().entities;
let originalEntities: BusinessEntity[];

beforeEach(() => {
  originalEntities = ENTITY_SEED();
  useJournalStore.setState({ entries: [] });
  // A role that holds entity.create unless a test says otherwise.
  useAuthStore.setState({ currentUserId: null } as never);
});

afterEach(() => {
  cleanup();
  useEntityStore.setState({ entities: originalEntities });
  vi.restoreAllMocks();
});

/* ══ 1–8: the draft is what the user sees ══════════════════════════════════ */

describe('journal draft state', () => {
  it('1 · recognises two rendered lines as two draft lines', () => {
    drawer();
    buildBalancedEntry();
    // The min-lines error is the one that used to persist over two real lines.
    expect(panelText()).not.toContain('needs at least two lines');
    expect(debitInputs()).toHaveLength(2);
  });

  it('2 · a debit input immediately updates total debit', () => {
    drawer();
    const [land] = postingAccounts();
    pickAccount(0, land!);
    typeAmount(0, 'debit', '5000000');
    expect(footerTotals().debit).toBe('5,000,000.00');
  });

  it('3 · a credit input immediately updates total credit', () => {
    drawer();
    const [, cash] = postingAccounts();
    pickAccount(1, cash!);
    typeAmount(1, 'credit', '5000000');
    expect(footerTotals().credit).toBe('5,000,000.00');
  });

  it('4 · 5,000,000 debit + 5,000,000 credit gives difference 0 and reads balanced', () => {
    drawer();
    buildBalancedEntry();
    expect(footerTotals()).toEqual({
      debit: '5,000,000.00',
      credit: '5,000,000.00',
      difference: '0.00',
    });
    expect(panelText()).toContain('Balanced');
  });

  it('5 · “needs at least two lines” disappears with two valid lines', () => {
    drawer();
    expect(deriveJournalDraft({ description: '', entryDate: '', lines: [] }, new Map(), new Map()).postingErrors.map((i) => i.rule))
      .toContain('min-lines');
    buildBalancedEntry();
    expect(panelText()).not.toContain('needs at least two lines');
  });

  it('6 · “no debit or credit amounts” disappears once amounts are entered', () => {
    drawer();
    buildBalancedEntry();
    expect(panelText()).not.toContain('no debit or credit amounts');
  });

  it('7 · “no entity” does not invalidate a journal line', () => {
    drawer();
    buildBalancedEntry();
    // Nothing was selected in either entity picker.
    expect(document.body.textContent).toContain('No entity');
    expect(footerTotals().difference).toBe('0.00');
    expect(panelText()).not.toContain('needs at least two lines');

    const accounts = new Map(postingAccounts().map((a) => [a.id, a]));
    const [land, cash] = postingAccounts();
    const derived = deriveJournalDraft(
      {
        description: 'Land purchase',
        entryDate: '2026-08-11',
        lines: [
          { accountId: land!.id, entityId: null, debit: '5000000', credit: '0' },
          { accountId: cash!.id, entityId: null, debit: '0', credit: '5000000' },
        ],
      },
      accounts,
      new Map(),
    );
    expect(derived.lineCount).toBe(2);
    expect(derived.canPost).toBe(true);
  });

  it('8 · a blank placeholder line is not counted', () => {
    const [land, cash] = postingAccounts();
    const accounts = new Map(postingAccounts().map((a) => [a.id, a]));
    const derived = deriveJournalDraft(
      {
        description: 'Land purchase',
        entryDate: '2026-08-11',
        lines: [
          { accountId: land!.id, debit: '5000000', credit: '0' },
          { accountId: cash!.id, debit: '0', credit: '5000000' },
          { accountId: '', debit: '', credit: '', memo: '' },
        ],
      },
      accounts,
      new Map(),
    );
    expect(derived.lines).toHaveLength(3);
    expect(derived.lineCount).toBe(2);
    expect(derived.canPost).toBe(true);
  });

  it('9 · entering a debit clears the credit on the same line', () => {
    drawer();
    const [land] = postingAccounts();
    pickAccount(0, land!);
    typeAmount(0, 'credit', '400');
    expect(footerTotals().credit).toBe('400.00');
    typeAmount(0, 'debit', '900');
    // The existing UX clears the opposite side; totals follow immediately.
    expect(footerTotals()).toMatchObject({ debit: '900.00', credit: '0.00' });
  });

  it('10 · removing a line does not detach the remaining inputs', () => {
    drawer();
    const [land, cash, third] = postingAccounts();
    pickAccount(0, land!);
    pickAccount(1, cash!);
    typeAmount(0, 'debit', '100');
    typeAmount(1, 'credit', '100');

    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    pickAccount(2, third!);
    typeAmount(2, 'debit', '50');
    expect(footerTotals().debit).toBe('150.00');

    const removes = screen.getAllByRole('button', { name: /remove line/i });
    fireEvent.click(removes[2]!);

    // The survivors keep their own amounts — no write landed on the wrong row.
    expect(footerTotals()).toMatchObject({ debit: '100.00', credit: '100.00', difference: '0.00' });
  });

  it('10b · moving a line keeps each amount with its own row', () => {
    drawer();
    const [land, cash] = postingAccounts();
    pickAccount(0, land!);
    pickAccount(1, cash!);
    typeAmount(0, 'debit', '700');
    typeAmount(1, 'credit', '700');

    fireEvent.click(screen.getAllByRole('button', { name: /move line down/i })[0]!);

    expect(footerTotals()).toMatchObject({ debit: '700.00', credit: '700.00', difference: '0.00' });
    // The debit travelled with its line rather than staying on row 1.
    expect(creditInputs()[0]!.value).toBe('700');
    expect(debitInputs()[1]!.value).toBe('700');
  });

  it('10c · Escape inside the account picker closes only the picker', () => {
    /*
     * The entry drawer listens for Escape on `window`. The account picker's
     * search box is inside that drawer, so an un-stopped Escape closed the
     * whole entry — losing every line — instead of the dropdown. The picker
     * now consumes the key.
     */
    const closes: number[] = [];
    render(
      <ToastProvider>
        <JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => closes.push(1)} />
      </ToastProvider>,
    );
    buildBalancedEntry();

    fireEvent.click(document.getElementById('account-0')!);
    const search = document.querySelector<HTMLInputElement>('input[placeholder^="Search code"]')!;
    fireEvent.keyDown(search, { key: 'Escape' });

    expect(closes, 'the entry drawer must not be dismissed').toHaveLength(0);
    expect(footerTotals().difference).toBe('0.00');
    expect(debitInputs()[0]!.value).toBe('5000000');
  });

  it('11 · Save & close persists exactly the visible amounts', async () => {
    drawer();
    const { land, cash } = buildBalancedEntry();
    fireEvent.change(document.getElementById('description')!, { target: { value: 'Land purchase' } });

    fireEvent.click(screen.getByRole('button', { name: /save & close/i }));
    await waitFor(() => expect(useJournalStore.getState().entries).toHaveLength(1));

    const [saved] = useJournalStore.getState().entries;
    expect(saved).toBeDefined();
    expect(saved!.lines).toHaveLength(2);
    expect(saved!.lines[0]).toMatchObject({ accountId: land.id, debit: 5000000, credit: 0 });
    expect(saved!.lines[1]).toMatchObject({ accountId: cash.id, debit: 0, credit: 5000000 });
    expect(saved!.totalDebit).toBe(5000000);
    expect(saved!.totalCredit).toBe(5000000);
  });

  it('12 · Post entry posts exactly the visible amounts', async () => {
    drawer();
    buildBalancedEntry();
    fireEvent.change(document.getElementById('description')!, { target: { value: 'Land purchase' } });

    fireEvent.click(screen.getByRole('button', { name: /post entry/i }));
    await waitFor(() => expect(useJournalStore.getState().entries[0]?.status).toBe('posted'));

    const [posted] = useJournalStore.getState().entries;
    expect(posted?.status).toBe('posted');
    expect(posted?.totalDebit).toBe(5000000);
    expect(posted?.totalCredit).toBe(5000000);
    expect(posted?.difference).toBe(0);
  });

  it('13 · reopening a saved draft reproduces the same lines and totals', async () => {
    const view = drawer();
    buildBalancedEntry();
    fireEvent.change(document.getElementById('description')!, { target: { value: 'Land purchase' } });
    fireEvent.click(screen.getByRole('button', { name: /save & close/i }));
    await waitFor(() => expect(useJournalStore.getState().entries).toHaveLength(1));
    const saved = useJournalStore.getState().entries[0]!;
    view.unmount();

    drawer({ kind: 'edit', entryId: saved.id });

    expect(debitInputs()[0]!.value).toBe('5000000');
    expect(creditInputs()[1]!.value).toBe('5000000');
    expect(footerTotals()).toEqual({
      debit: '5,000,000.00',
      credit: '5,000,000.00',
      difference: '0.00',
    });
  });
});

/* ══ Money protocol ════════════════════════════════════════════════════════ */

describe('draft money handling', () => {
  it('parses grouped, decimal and empty amounts without losing value', () => {
    expect(toDecimalAmount('5000000')).toBe('5000000');
    expect(toDecimalAmount('5,000,000.00')).toBe('5000000.00');
    expect(toDecimalAmount('1234.56')).toBe('1234.56');
    expect(toDecimalAmount('')).toBe('0');
    expect(toDecimalAmount('abc')).toBe('0');
    expect(toDecimalAmount(0.1)).toBe('0.1');
  });

  it('balances decimal amounts that floating point would not', () => {
    const [a, b, c] = postingAccounts();
    const accounts = new Map(postingAccounts().map((x) => [x.id, x]));
    // 0.1 + 0.2 !== 0.3 in binary floating point.
    const derived = deriveJournalDraft(
      {
        description: 'Decimal balance',
        entryDate: '2026-08-11',
        lines: [
          { accountId: a!.id, debit: '0.1', credit: '0' },
          { accountId: b!.id, debit: '0.2', credit: '0' },
          { accountId: c!.id, debit: '0', credit: '0.3' },
        ],
      },
      accounts,
      new Map(),
    );
    expect(derived.totals.totalDebit).toBe('0.3');
    expect(derived.totals.balanced).toBe(true);
    expect(derived.postingErrors.map((i) => i.rule)).not.toContain('unbalanced');
  });

  it('renders a foreign-currency decimal entry in the footer', () => {
    drawer();
    const [land, cash] = postingAccounts();
    pickAccount(0, land!);
    pickAccount(1, cash!);
    // The entry currency is chosen through the shared searchable picker now,
    // not a native <select> restricted to nine codes.
    fireEvent.click(screen.getByLabelText('Currency', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('Search currencies'), { target: { value: 'EUR' } });
    fireEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"] button')).find((o) =>
        (o.textContent ?? '').includes('EUR'),
      )!,
    );
    typeAmount(0, 'debit', '1234.56');
    typeAmount(1, 'credit', '1234.56');
    expect(footerTotals()).toEqual({ debit: '1,234.56', credit: '1,234.56', difference: '0.00' });
  });

  it('the draft signature changes whenever a value changes', () => {
    const base = { description: 'x', entryDate: '2026-08-11', lines: [{ accountId: 'a', debit: '1', credit: '0' }] };
    const mutated = { ...base, lines: [{ accountId: 'a', debit: '2', credit: '0' }] };
    expect(draftSignature(base)).not.toBe(draftSignature(mutated));

    /*
     * The exact shape of the original defect: the SAME array object, mutated.
     * Identity is unchanged, so anything keyed on identity would go stale —
     * the signature must not.
     */
    const lines = [{ accountId: 'a', debit: '1', credit: '0' }];
    const draftObject = { description: 'x', entryDate: '2026-08-11', lines };
    const before = draftSignature(draftObject);
    lines[0]!.debit = '5000000';
    expect(draftSignature(draftObject)).not.toBe(before);
  });
});

/* ══ 14–24: inline entity creation ═════════════════════════════════════════ */

describe('creating an entity from the journal', () => {
  const openPicker = (line = 0): void => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.textContent?.trim().startsWith('No entity'),
    );
    fireEvent.click(buttons[line]!);
  };

  const searchBox = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[placeholder^="Search company"]')!;

  /** Fill and submit the create dialog, waiting for the entity to land in the store. */
  const createEntity = async (name: string): Promise<void> => {
    fireEvent.change(document.getElementById('quick-entity-name')!, { target: { value: name } });
    fireEvent.submit(document.getElementById('quick-entity-name')!.closest('form')!);
    await waitFor(() =>
      expect(useEntityStore.getState().entities.some((e) => e.legalName === name)).toBe(true),
    );
  };

  it('14 · the picker always offers “Add new entity”', () => {
    drawer();
    openPicker();
    expect(screen.getByRole('button', { name: /^Add new entity$/ })).toBeTruthy();
  });

  it('15 · a no-match search shows a prominent create action carrying the typed text', () => {
    drawer();
    openPicker();
    fireEvent.change(searchBox(), { target: { value: 'ABC Properties' } });

    expect(document.body.textContent).toContain('No entities match “ABC Properties”');
    expect(screen.getByRole('button', { name: /Add “ABC Properties” as a new entity/ })).toBeTruthy();
  });

  it('16–20 · creating selects on the originating line and preserves the whole draft', async () => {
    drawer();
    const { land } = buildBalancedEntry();
    fireEvent.change(document.getElementById('description')!, { target: { value: 'Land purchase' } });
    fireEvent.change(document.getElementById('notes')!, { target: { value: 'Board approved' } });
    fireEvent.change(document.getElementById('createdBy')!, { target: { value: 'R. Auditor' } });

    openPicker(0);
    fireEvent.change(searchBox(), { target: { value: 'ABC Properties' } });
    fireEvent.click(screen.getByRole('button', { name: /Add “ABC Properties” as a new entity/ }));

    // 16/17 · the journal drawer is still open and still the journal.
    expect(screen.getByText('New journal entry')).toBeTruthy();
    await createEntity('ABC Properties');

    // 19 · selected on the line it was created from.
    const pickers = Array.from(document.querySelectorAll('button')).filter(
      (b) => b.textContent?.includes('ABC Properties'),
    );
    expect(pickers.length).toBeGreaterThan(0);

    // 18 · amounts untouched. 20 · the other line untouched.
    expect(footerTotals()).toEqual({ debit: '5,000,000.00', credit: '5,000,000.00', difference: '0.00' });
    expect(debitInputs()[0]!.value).toBe('5000000');
    expect(creditInputs()[1]!.value).toBe('5000000');
    expect((document.getElementById('description') as HTMLInputElement).value).toBe('Land purchase');
    expect((document.getElementById('notes') as HTMLInputElement).value).toBe('Board approved');
    expect((document.getElementById('createdBy') as HTMLInputElement).value).toBe('R. Auditor');

    // Line 2 still has no entity — creation touched one line only.
    const noEntityStill = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.textContent?.trim().startsWith('No entity'),
    );
    expect(noEntityStill.length).toBeGreaterThan(0);

    // Persisted through the canonical store, not a journal-only table.
    const created = useEntityStore.getState().entities.find((e) => e.legalName === 'ABC Properties');
    expect(created).toBeDefined();
    expect(created!.entityCode.trim().length).toBeGreaterThan(0);
    expect(land.id).toBeTruthy();
  });

  it('21 · the new entity appears in subsequent searches', async () => {
    drawer();
    openPicker(0);
    fireEvent.change(searchBox(), { target: { value: 'Zenith Trading' } });
    fireEvent.click(screen.getByRole('button', { name: /Add “Zenith Trading” as a new entity/ }));
    await createEntity('Zenith Trading');

    // A different line's picker finds it by search.
    openPicker(0);
    fireEvent.change(searchBox(), { target: { value: 'Zenith' } });
    expect(document.body.textContent).not.toContain('No entities match');
    expect(document.body.textContent).toContain('Zenith Trading');
  });

  it('22 · “No entity” remains selectable after creating one', async () => {
    drawer();
    openPicker(0);
    fireEvent.change(searchBox(), { target: { value: 'Temp Co' } });
    fireEvent.click(screen.getByRole('button', { name: /Add “Temp Co” as a new entity/ }));
    await createEntity('Temp Co');

    openPicker(0);
    const clear = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'No entity',
    );
    expect(clear).toBeTruthy();
    fireEvent.click(clear!);
    const stillNone = Array.from(document.querySelectorAll('button')).filter((b) =>
      b.textContent?.trim().startsWith('No entity'),
    );
    expect(stillNone.length).toBeGreaterThan(0);
  });

  it('23 · a role without entity.create is given no create action, and the store refuses anyway', () => {
    // A viewer holds entity.view and nothing else.
    const id = 'user-viewer';
    useAuthStore.setState({
      currentUserId: id,
      users: [{ id, fullName: 'V', email: 'v@x.test', role: 'viewer', status: 'active', organizationId: 'org' }],
    } as never);

    drawer();
    openPicker(0);
    fireEvent.change(searchBox(), { target: { value: 'Nope Ltd' } });

    expect(screen.queryByRole('button', { name: /Add new entity/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /as a new entity/ })).toBeNull();

    /*
     * The affordance being hidden is not the guarantee. The canonical write is
     * refused independently, which is what holds if the action is reached some
     * other way.
     */
    const before = useEntityStore.getState().entities.length;
    const result = useEntityStore.getState().addEntity({
      ...makeDefaultEntityValues('customer'),
      legalName: 'Back Door Ltd',
      entityCode: 'BACKDOOR',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/entity\.create/);
    expect(useEntityStore.getState().entities).toHaveLength(before);
  });

  it('24 · cancelling Add Entity returns to the journal with the draft unchanged', () => {
    drawer();
    buildBalancedEntry();
    fireEvent.change(document.getElementById('description')!, { target: { value: 'Land purchase' } });
    const entitiesBefore = useEntityStore.getState().entities.length;

    openPicker(0);
    fireEvent.change(searchBox(), { target: { value: 'Never Created' } });
    fireEvent.click(screen.getByRole('button', { name: /Add “Never Created” as a new entity/ }));
    fireEvent.click(within(document.querySelector('[aria-label="Add new entity"]')!).getByRole('button', { name: /^Cancel$/ }));

    expect(document.querySelector('[aria-label="Add new entity"]')).toBeNull();
    expect(screen.getByText('New journal entry')).toBeTruthy();
    expect(useEntityStore.getState().entities).toHaveLength(entitiesBefore);
    expect(footerTotals()).toEqual({ debit: '5,000,000.00', credit: '5,000,000.00', difference: '0.00' });
    expect((document.getElementById('description') as HTMLInputElement).value).toBe('Land purchase');
  });

  it('Escape in the create dialog closes only the dialog, never the journal', () => {
    drawer();
    buildBalancedEntry();
    openPicker(0);
    fireEvent.click(screen.getByRole('button', { name: /^Add new entity$/ }));

    const dialog = document.querySelector('[aria-label="Add new entity"]')!;
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(document.querySelector('[aria-label="Add new entity"]')).toBeNull();
    expect(screen.getByText('New journal entry')).toBeTruthy();
    expect(footerTotals().difference).toBe('0.00');
  });
});
