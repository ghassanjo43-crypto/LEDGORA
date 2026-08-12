// @vitest-environment happy-dom
/**
 * The correction experience: the editor, the gate that stands in front of it,
 * and the history it leaves behind.
 *
 * The store-level rules live in `store/journalAmendment.test.ts`. What these
 * add is the part a user actually meets — that "Edit" on a posted entry does
 * something sensible rather than nothing, that a correction in progress keeps
 * its totals honest, and that the audit panel shows the superseded values
 * rather than merely asserting that a change happened.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { JournalEntryDrawer } from './JournalEntryDrawer';
import { JournalAuditTrail } from './JournalAuditTrail';
import { AmendmentGateDialog } from './AmendmentGateDialog';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useJournalStore, makeDefaultJournalValues, entryToFormValues } from '@/store/journalStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { entryVersion } from '@/lib/journalAmendment';
import type { JournalFormValues } from '@/lib/journalValidation';
import type { Account } from '@/types';

const postingAccounts = (): Account[] =>
  useStore.getState().accounts.filter((a) => a.isPostingAccount && a.isActive);

function balancedValues(): JournalFormValues {
  const [land, cash] = postingAccounts();
  const base = makeDefaultJournalValues('JE-9001', 'AED');
  return {
    ...base,
    entryDate: '2026-08-11',
    description: 'Land purchase',
    createdBy: 'Ahmad',
    lines: [
      { ...base.lines[0]!, accountId: land!.id, accountCode: land!.code, accountName: land!.name, debit: 5_000_000, credit: 0 },
      { ...base.lines[1]!, accountId: cash!.id, accountCode: cash!.code, accountName: cash!.name, debit: 0, credit: 5_000_000 },
    ],
  };
}

function postedEntry(): string {
  const created = useJournalStore.getState().addEntry(balancedValues());
  useJournalStore.getState().postEntry(created.id!);
  return created.id!;
}

const entry = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;

function drawer(mode: Parameters<typeof JournalEntryDrawer>[0]['mode']) {
  return render(
    <ToastProvider>
      <JournalEntryDrawer open mode={mode} onClose={() => {}} />
    </ToastProvider>,
  );
}

const debitInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-col="debit"]'));
const creditInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-col="credit"]'));

function footerTotals(): { debit: string; credit: string; difference: string } {
  const read = (label: string): string => {
    const node = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === label);
    return node?.parentElement?.querySelector('span:last-child')?.textContent ?? '';
  };
  return { debit: read('Total debit'), credit: read('Total credit'), difference: read('Difference') };
}

beforeEach(() => {
  useJournalStore.setState({ entries: [] });
  useInventoryStore.setState({ movements: [] } as never);
  useTaxPeriodStore.setState({ periods: [] } as never);
});
afterEach(() => {
  cleanup();
  useJournalStore.setState({ entries: [] });
  useInventoryStore.setState({ movements: [] } as never);
  useTaxPeriodStore.setState({ periods: [] } as never);
});

/* ══ Editing keeps the numbers honest ══════════════════════════════════════ */

describe('correcting a posted entry in the editor', () => {
  it('opens with the posted values, a version and a mandatory reason field', () => {
    const id = postedEntry();
    drawer({ kind: 'amend', entryId: id, strategy: 'amend' });

    expect(screen.getByText('Correct posted journal entry')).toBeTruthy();
    expect(document.body.textContent).toContain(`version ${entryVersion(entry(id))}`);
    expect(document.getElementById('amendment-reason')).toBeTruthy();
    expect(debitInputs()[0]!.value).toBe('5000000');
    expect(footerTotals()).toEqual({ debit: '5,000,000.00', credit: '5,000,000.00', difference: '0.00' });
  });

  it('updates totals immediately as amounts are edited, and shows the imbalance', () => {
    const id = postedEntry();
    drawer({ kind: 'amend', entryId: id, strategy: 'amend' });

    fireEvent.change(debitInputs()[0]!, { target: { value: '4500000' } });

    // The correction is mid-flight and deliberately unbalanced — the editor
    // says so rather than waiting for the save to fail.
    expect(footerTotals()).toMatchObject({ debit: '4,500,000.00', credit: '5,000,000.00' });
    expect(document.body.textContent).toContain('Unbalanced');

    fireEvent.change(creditInputs()[1]!, { target: { value: '4500000' } });
    expect(footerTotals()).toEqual({ debit: '4,500,000.00', credit: '4,500,000.00', difference: '0.00' });
    expect(document.body.textContent).toContain('Balanced');
  });

  it('refuses to save without a reason, and says so in place', async () => {
    const id = postedEntry();
    drawer({ kind: 'amend', entryId: id, strategy: 'amend' });

    fireEvent.change(debitInputs()[0]!, { target: { value: '4500000' } });
    fireEvent.change(creditInputs()[1]!, { target: { value: '4500000' } });
    fireEvent.click(screen.getByRole('button', { name: /save & close/i }));

    await waitFor(() => expect(document.body.textContent).toMatch(/reason is required/i));
    // Nothing was written.
    expect(entry(id).totalDebit).toBe(5_000_000);
    expect(entryVersion(entry(id))).toBe(2);
  });

  it('applies a reasoned correction and records the previous values', async () => {
    const id = postedEntry();
    drawer({ kind: 'amend', entryId: id, strategy: 'amend' });

    fireEvent.change(debitInputs()[0]!, { target: { value: '4500000' } });
    fireEvent.change(creditInputs()[1]!, { target: { value: '4500000' } });
    fireEvent.change(document.getElementById('amendment-reason')!, {
      target: { value: 'Corrected overstated land cost' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save & close/i }));

    await waitFor(() => expect(entry(id).totalDebit).toBe(4_500_000));

    const amendment = entry(id).amendments!.find((a) => a.kind === 'amended')!;
    expect(amendment.reason).toBe('Corrected overstated land cost');
    expect(amendment.snapshot!.totalDebit).toBe(5_000_000);
  });

  it('shows the concurrency banner instead of overwriting another user’s save', async () => {
    const id = postedEntry();
    drawer({ kind: 'amend', entryId: id, strategy: 'amend' });

    // Another user saves while this editor is open.
    const theirs = entryToFormValues(entry(id));
    theirs.reference = 'THEIRS';
    useJournalStore
      .getState()
      .amendPostedEntry(id, theirs, { reason: 'Their correction', expectedVersion: entryVersion(entry(id)) });

    fireEvent.change(document.getElementById('amendment-reason')!, { target: { value: 'My correction' } });
    fireEvent.click(screen.getByRole('button', { name: /save & close/i }));

    await waitFor(() =>
      expect(document.body.textContent).toContain('was changed by another user while you were editing it'),
    );
    expect(screen.getByRole('button', { name: /review latest version/i })).toBeTruthy();
    // Their reference survived; this save did not land.
    expect(entry(id).reference).toBe('THEIRS');

    // Reviewing loads the latest, and the save then succeeds.
    fireEvent.click(screen.getByRole('button', { name: /review latest version/i }));
    fireEvent.change(document.getElementById('amendment-reason')!, { target: { value: 'My correction, rebased' } });
    fireEvent.click(screen.getByRole('button', { name: /save & close/i }));
    await waitFor(() => expect(entry(id).amendments!.filter((a) => a.kind === 'amended')).toHaveLength(2));
  });
});

/* ══ The gate in front of the editor ═══════════════════════════════════════ */

describe('the amendment gate', () => {
  it('offers “Reverse & edit” when a dependency forbids a direct overwrite', () => {
    const id = postedEntry();
    useInventoryStore.setState({
      movements: [{ id: 'mv1', journalEntryId: id, sourceDocumentType: 'adjustment', sourceDocumentId: 'x' }],
    } as never);

    const assessment = useJournalStore.getState().assessAmendment(id)!;
    const chosen: string[] = [];
    render(<AmendmentGateDialog assessment={assessment} onCancel={() => {}} onReverseAndEdit={(x) => chosen.push(x)} />);

    expect(document.body.textContent).toContain('has dependencies and cannot be overwritten directly');
    expect(document.body.textContent).toContain('Stock movement');
    fireEvent.click(screen.getByRole('button', { name: /reverse & edit/i }));
    expect(chosen).toEqual([id]);
  });

  it('explains a hard block and offers no correction route', () => {
    const id = postedEntry();
    useTaxPeriodStore.setState({
      periods: [
        {
          id: 'tp1', entityId: 'e1', jurisdictionId: 'j1',
          periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'locked',
          auditTrail: [], createdAt: '', updatedAt: '',
        },
      ],
    } as never);

    const assessment = useJournalStore.getState().assessAmendment(id)!;
    render(<AmendmentGateDialog assessment={assessment} onCancel={() => {}} onReverseAndEdit={() => {}} />);

    expect(document.body.textContent).toContain('cannot be corrected here');
    expect(document.body.textContent).toMatch(/Reopen the period/i);
    expect(screen.queryByRole('button', { name: /reverse & edit/i })).toBeNull();
  });
});

/* ══ The audit trail ═══════════════════════════════════════════════════════ */

describe('the audit trail', () => {
  it('shows each version with its actor, reason and before/after values', async () => {
    const id = postedEntry();
    const [, , bank] = postingAccounts();
    const corrected = entryToFormValues(entry(id));
    corrected.lines[1] = { ...corrected.lines[1]!, accountId: bank!.id, accountCode: bank!.code, accountName: bank!.name };

    useJournalStore
      .getState()
      .amendPostedEntry(id, corrected, { reason: 'Corrected cash account', expectedVersion: 2 });

    render(<JournalAuditTrail entry={entry(id)} />);
    const text = document.body.textContent ?? '';

    expect(text).toContain('Version 1 · Created');
    expect(text).toContain('Version 2 · Posted');
    expect(text).toContain('Version 3 · Edited');
    expect(text).toContain('Corrected cash account');
    // Before AND after, not just a claim that something changed.
    expect(text).toContain(bank!.code);
    expect(document.querySelector('[data-testid="journal-audit-trail"]')).toBeTruthy();
  });

  it('links the original, the reversal and the replacement', () => {
    const id = postedEntry();
    useInventoryStore.setState({
      movements: [{ id: 'mv1', journalEntryId: id, sourceDocumentType: 'adjustment', sourceDocumentId: 'x' }],
    } as never);

    const result = useJournalStore
      .getState()
      .reverseAndReplace(id, entryToFormValues(entry(id)), { reason: 'Corrected posting', expectedVersion: 2 });

    const original = entry(id);
    const replacement = entry(result.replacementId!);

    render(<JournalAuditTrail entry={original} />);
    expect(document.body.textContent).toContain('Replaced by');
    expect(document.body.textContent).toContain(replacement.entryNumber);
    cleanup();

    render(<JournalAuditTrail entry={entry(result.reversalId!)} />);
    expect(document.body.textContent).toContain('Reversal of');
    expect(document.body.textContent).toContain(original.entryNumber);
    cleanup();

    render(<JournalAuditTrail entry={replacement} />);
    expect(document.body.textContent).toContain('Replacement for');
    expect(document.body.textContent).toContain(original.entryNumber);
  });
});
