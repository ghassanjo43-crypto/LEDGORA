/**
 * Journal entry editing, conflict control and audit history.
 *
 * ══ The rule under test ══════════════════════════════════════════════════════
 *
 * An authorized user may correct any journal entry, as long as the correction
 * does not conflict with another transaction, an accounting dependency, a
 * locked period, a regulatory record, or a concurrent edit.
 *
 * Two failure modes matter more than the rest, and most of this file is aimed
 * at them:
 *
 *   silent loss   — a correction that overwrites a posted figure, or another
 *                   user's save, leaving no trace of what was there before;
 *   false safety  — a correction refused (or allowed) for a reason that is not
 *                   actually about this entry. "Another journal uses the same
 *                   account" is the canonical example, and it has its own test,
 *                   because treating it as a conflict would make every entry in
 *                   an active ledger permanently uncorrectable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useJournalStore, makeDefaultJournalValues, entryToFormValues } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useAuthStore } from '@/store/authStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { assessAmendment, assertExpectedVersion, entryVersion, CONCURRENT_EDIT_MESSAGE } from '@/lib/journalAmendment';
import type { JournalFormValues } from '@/lib/journalValidation';
import type { Account } from '@/types';

/* ─────────────────────────────── Harness ────────────────────────────────── */

const ENTRY_DATE = '2026-08-11';

function postingAccounts(): Account[] {
  return useStore.getState().accounts.filter((a) => a.isPostingAccount && a.isActive);
}

/** A balanced two-line form: 5,000,000 debit / credit. */
function balancedValues(overrides: Partial<JournalFormValues> = {}): JournalFormValues {
  const [land, cash] = postingAccounts();
  const base = makeDefaultJournalValues('JE-9001', 'AED');
  return {
    ...base,
    entryDate: ENTRY_DATE,
    description: 'Land purchase',
    createdBy: 'Ahmad',
    ...overrides,
    lines: overrides.lines ?? [
      { ...base.lines[0]!, accountId: land!.id, accountCode: land!.code, accountName: land!.name, debit: 5_000_000, credit: 0 },
      { ...base.lines[1]!, accountId: cash!.id, accountCode: cash!.code, accountName: cash!.name, debit: 0, credit: 5_000_000 },
    ],
  };
}

/** Create and post an entry, returning its id. */
function postedEntry(values: JournalFormValues = balancedValues()): string {
  const created = useJournalStore.getState().addEntry(values);
  expect(created.ok, created.error).toBe(true);
  const posted = useJournalStore.getState().postEntry(created.id!);
  expect(posted.ok, posted.error).toBe(true);
  return created.id!;
}

const entry = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;

/** Sign in as a role. No user at all resolves to `owner`. */
function signInAs(role: string | null): void {
  if (!role) {
    useAuthStore.setState({ currentUserId: null } as never);
    return;
  }
  useAuthStore.setState({
    currentUserId: 'u1',
    users: [{ id: 'u1', fullName: 'Test User', email: 't@x.test', role, status: 'active', organizationId: 'org' }],
  } as never);
}

function lockTaxPeriod(status: 'locked' | 'filed' | 'prepared' | 'open'): void {
  useTaxPeriodStore.setState({
    periods: [
      {
        id: 'tp1',
        entityId: 'e1',
        jurisdictionId: 'j1',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        status,
        auditTrail: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  } as never);
}

beforeEach(() => {
  useJournalStore.setState({ entries: [] });
  useTaxPeriodStore.setState({ periods: [] } as never);
  useInvoiceStore.setState({ invoices: [] } as never);
  useInventoryStore.setState({ movements: [] } as never);
  signInAs(null);
});

afterEach(() => {
  useJournalStore.setState({ entries: [] });
  useTaxPeriodStore.setState({ periods: [] } as never);
  useInvoiceStore.setState({ invoices: [] } as never);
  useInventoryStore.setState({ movements: [] } as never);
  signInAs(null);
});

/* ══ Permission ════════════════════════════════════════════════════════════ */

describe('permission', () => {
  it('an authorized user can edit a draft journal', () => {
    signInAs('accountant');
    const created = useJournalStore.getState().addEntry(balancedValues());
    expect(created.ok).toBe(true);

    const result = useJournalStore
      .getState()
      .updateEntry(created.id!, balancedValues({ description: 'Corrected narration' }), { expectedVersion: 1 });

    expect(result.ok, result.error).toBe(true);
    expect(entry(created.id!).description).toBe('Corrected narration');
  });

  it('an unauthorized user cannot edit, amend, post or reverse', () => {
    const id = postedEntry();
    const draft = useJournalStore.getState().addEntry(balancedValues({ entryNumber: 'JE-9002' }));

    signInAs('viewer');

    const edit = useJournalStore.getState().updateEntry(draft.id!, balancedValues(), { expectedVersion: 1 });
    expect(edit.ok).toBe(false);
    expect(edit.error).toMatch(/journal\.edit/);

    const amend = useJournalStore
      .getState()
      .amendPostedEntry(id, balancedValues(), { reason: 'Corrected cash account', expectedVersion: 2 });
    expect(amend.ok).toBe(false);
    expect(amend.error).toMatch(/journal\.edit/);

    const replace = useJournalStore
      .getState()
      .reverseAndReplace(id, balancedValues(), { reason: 'Corrected cash account', expectedVersion: 2 });
    expect(replace.ok).toBe(false);

    // And nothing was written by any of them.
    expect(useJournalStore.getState().entries).toHaveLength(2);
  });

  it('an accountant may edit and post but not reverse', () => {
    signInAs('accountant');
    const id = postedEntry();
    const result = useJournalStore.getState().reverseEntry(id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/journal\.reverse/);
  });
});

/* ══ Controlled amendment of a posted entry ═══════════════════════════════ */

describe('amending a standalone posted entry', () => {
  it('applies the correction and keeps the original version in history', () => {
    const id = postedEntry();
    const original = entry(id);
    expect(original.status).toBe('posted');
    expect(original.lines[1]!.debit).toBe(0);

    const [, , bank] = postingAccounts();
    const corrected = balancedValues({
      lines: [
        { ...entryToFormValues(original).lines[0]! },
        { ...entryToFormValues(original).lines[1]!, accountId: bank!.id, accountCode: bank!.code, accountName: bank!.name },
      ],
    });

    const result = useJournalStore
      .getState()
      .amendPostedEntry(id, corrected, { reason: 'Corrected cash account', expectedVersion: entryVersion(original) });

    expect(result.ok, result.error).toBe(true);

    const after = entry(id);
    expect(after.status).toBe('posted');
    expect(after.lines[1]!.accountId).toBe(bank!.id);
    expect(entryVersion(after)).toBe(entryVersion(original) + 1);

    /*
     * The original posting survives IN FULL — not as a description of what
     * changed, but as a restorable snapshot. This is the assertion that would
     * fail if an amendment ever started overwriting history.
     */
    const amendment = after.amendments!.find((a) => a.kind === 'amended')!;
    expect(amendment.snapshot).toBeDefined();
    expect(amendment.snapshot!.lines[1]!.accountId).toBe(original.lines[1]!.accountId);
    expect(amendment.reason).toBe('Corrected cash account');
  });

  it('records before/after values, the actor and the timestamp', () => {
    const id = postedEntry();
    const before = entry(id);
    const [, , bank] = postingAccounts();
    const corrected = entryToFormValues(before);
    corrected.lines[1] = { ...corrected.lines[1]!, accountId: bank!.id, accountCode: bank!.code, accountName: bank!.name };

    useJournalStore.getState().amendPostedEntry(id, corrected, { reason: 'Corrected cash account', expectedVersion: 2 });

    const record = entry(id).amendments!.find((a) => a.kind === 'amended')!;
    const accountChange = record.changes.find((c) => c.field.endsWith('accountId'))!;

    expect(accountChange.label).toMatch(/Line 2 · Account/);
    expect(accountChange.before).toContain(before.lines[1]!.accountCode);
    expect(accountChange.after).toContain(bank!.code);
    expect(record.actor.length).toBeGreaterThan(0);
    expect(Date.parse(record.at)).not.toBeNaN();
  });

  it('requires a reason', () => {
    const id = postedEntry();
    const values = entryToFormValues(entry(id));

    for (const reason of [undefined, '', '   ', 'x']) {
      const result = useJournalStore.getState().amendPostedEntry(id, values, { reason, expectedVersion: 2 });
      expect(result.ok, `reason ${JSON.stringify(reason)} must be refused`).toBe(false);
      expect(result.error).toMatch(/reason is required/i);
    }
    // Untouched.
    expect(entryVersion(entry(id))).toBe(2);
  });

  it('refuses a correction that would not be valid for posting', () => {
    const id = postedEntry();
    const unbalanced = entryToFormValues(entry(id));
    unbalanced.lines[0] = { ...unbalanced.lines[0]!, debit: 4_000_000 };

    const result = useJournalStore
      .getState()
      .amendPostedEntry(id, unbalanced, { reason: 'Attempted bad edit', expectedVersion: 2 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/out of balance/i);
    // The posted figures are unchanged.
    expect(entry(id).lines[0]!.debit).toBe(5_000_000);
  });

  it('never deletes a history record', () => {
    const id = postedEntry();
    const versionsSeen: number[][] = [];

    for (let i = 0; i < 3; i += 1) {
      const values = entryToFormValues(entry(id));
      values.reference = `REF-${i}`;
      const result = useJournalStore
        .getState()
        .amendPostedEntry(id, values, { reason: `Correction number ${i}`, expectedVersion: entryVersion(entry(id)) });
      expect(result.ok, result.error).toBe(true);
      versionsSeen.push(entry(id).amendments!.map((a) => a.version));
    }

    // Each round strictly extends the previous history; nothing is dropped.
    expect(versionsSeen[0]!.length).toBeLessThan(versionsSeen[1]!.length);
    expect(versionsSeen[1]!.length).toBeLessThan(versionsSeen[2]!.length);
    expect(entry(id).amendments!.filter((a) => a.kind === 'amended')).toHaveLength(3);
    expect(entry(id).amendments![0]!.kind).toBe('created');
  });
});

/* ══ Reversal and replacement ═════════════════════════════════════════════ */

describe('reverse and replace', () => {
  /** Give the entry a downstream dependency that forbids direct overwriting. */
  function withInventoryDependency(entryId: string): void {
    useInventoryStore.setState({
      movements: [{ id: 'mv1', journalEntryId: entryId, sourceDocumentType: 'adjustment', sourceDocumentId: 'x' }],
    } as never);
  }

  it('is the offered mode when a derived record depends on the entry', () => {
    const id = postedEntry();
    withInventoryDependency(id);

    const assessment = useJournalStore.getState().assessAmendment(id)!;
    expect(assessment.mode).toBe('reverse_and_replace');
    expect(assessment.reasonRequired).toBe(true);
    expect(assessment.explanation).toMatch(/reverse it and create a corrected replacement/i);
  });

  it('writes three linked entries and leaves the original figures untouched', () => {
    const id = postedEntry();
    withInventoryDependency(id);
    const original = entry(id);

    const corrected = entryToFormValues(original);
    corrected.lines[0] = { ...corrected.lines[0]!, debit: 4_500_000 };
    corrected.lines[1] = { ...corrected.lines[1]!, credit: 4_500_000 };

    const result = useJournalStore
      .getState()
      .reverseAndReplace(id, corrected, { reason: 'Overstated land cost', expectedVersion: entryVersion(original) });

    expect(result.ok, result.error).toBe(true);

    const after = entry(id);
    const reversal = entry(result.reversalId!);
    const replacement = entry(result.replacementId!);

    // The original keeps every figure it was posted with.
    expect(after.lines[0]!.debit).toBe(5_000_000);
    expect(after.totalDebit).toBe(5_000_000);
    expect(after.status).toBe('posted');

    // Links in all three directions.
    expect(after.reversalEntryId).toBe(reversal.id);
    expect(after.replacementEntryId).toBe(replacement.id);
    expect(reversal.originalEntryId).toBe(id);
    expect(replacement.replacedEntryId).toBe(id);

    // The reversal withdraws exactly what the original posted.
    expect(reversal.totalDebit).toBe(original.totalCredit);
    expect(reversal.totalCredit).toBe(original.totalDebit);
    expect(reversal.lines[0]!.credit).toBe(original.lines[0]!.debit);

    // The replacement carries the corrected figures.
    expect(replacement.totalDebit).toBe(4_500_000);
  });

  it('leaves reversal and replacement balanced and posted', () => {
    const id = postedEntry();
    withInventoryDependency(id);
    const corrected = entryToFormValues(entry(id));
    corrected.lines[0] = { ...corrected.lines[0]!, debit: 4_500_000 };
    corrected.lines[1] = { ...corrected.lines[1]!, credit: 4_500_000 };

    const result = useJournalStore
      .getState()
      .reverseAndReplace(id, corrected, { reason: 'Overstated land cost', expectedVersion: 2 });

    for (const written of [entry(result.reversalId!), entry(result.replacementId!)]) {
      expect(written.status).toBe('posted');
      expect(written.difference).toBe(0);
      expect(written.totalDebit).toBe(written.totalCredit);
      expect(written.totalDebit).toBeGreaterThan(0);
    }
  });

  it('requires a reason, and writes nothing without one', () => {
    const id = postedEntry();
    withInventoryDependency(id);
    const before = useJournalStore.getState().entries.length;

    const result = useJournalStore.getState().reverseAndReplace(id, entryToFormValues(entry(id)), { expectedVersion: 2 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason is required/i);
    expect(useJournalStore.getState().entries).toHaveLength(before);
  });

  it('records the correction in all three histories', () => {
    const id = postedEntry();
    withInventoryDependency(id);
    const result = useJournalStore
      .getState()
      .reverseAndReplace(id, entryToFormValues(entry(id)), { reason: 'Corrected posting', expectedVersion: 2 });

    expect(entry(id).amendments!.some((a) => a.kind === 'replaced' && a.relatedEntryId === result.replacementId)).toBe(true);
    expect(entry(result.reversalId!).amendments!.some((a) => a.kind === 'reversed' && a.relatedEntryId === id)).toBe(true);
    expect(entry(result.replacementId!).amendments!.some((a) => a.kind === 'replacement' && a.relatedEntryId === id)).toBe(true);
  });

  it('directs a plain edit to the reverse-and-replace flow rather than failing silently', () => {
    const id = postedEntry();
    withInventoryDependency(id);
    const result = useJournalStore.getState().updateEntry(id, entryToFormValues(entry(id)), { expectedVersion: 2 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Reverse & edit/);
  });
});

/* ══ Conflicts ════════════════════════════════════════════════════════════ */

describe('what counts as a conflict', () => {
  it('two journals using the same account are NOT a conflict', () => {
    /*
     * The load-bearing negative case. Every cash transaction in a business
     * posts to the same cash account; if that were a dependency, no entry in an
     * active ledger could ever be corrected.
     */
    const first = postedEntry(balancedValues({ entryNumber: 'JE-9101' }));
    const second = postedEntry(balancedValues({ entryNumber: 'JE-9102', description: 'Another land purchase' }));

    const sharedAccounts = entry(first).lines.map((l) => l.accountId);
    expect(entry(second).lines.map((l) => l.accountId)).toEqual(sharedAccounts);

    for (const id of [first, second]) {
      const assessment = useJournalStore.getState().assessAmendment(id)!;
      expect(assessment.mode, 'a shared account must not block a correction').toBe('amend_in_place');
      expect(assessment.dependencies).toHaveLength(0);
    }

    const result = useJournalStore
      .getState()
      .amendPostedEntry(first, entryToFormValues(entry(first)), { reason: 'Corrected narration', expectedVersion: 2 });
    expect(result.ok, result.error).toBe(true);
  });

  it('a locked accounting period blocks the correction and journal.edit cannot bypass it', () => {
    const id = postedEntry();
    lockTaxPeriod('locked');

    const assessment = useJournalStore.getState().assessAmendment(id)!;
    expect(assessment.mode).toBe('blocked');
    expect(assessment.blockers[0]!.kind).toBe('locked_period');
    expect(assessment.explanation).toMatch(/Reopen the period/i);

    // Even as an owner — the strongest role — and even asking for the amendment
    // path directly.
    signInAs('owner');
    const amend = useJournalStore
      .getState()
      .amendPostedEntry(id, entryToFormValues(entry(id)), { reason: 'Trying anyway', expectedVersion: 2 });
    expect(amend.ok).toBe(false);
    expect(amend.error).toMatch(/Reopen the period/i);

    const replace = useJournalStore
      .getState()
      .reverseAndReplace(id, entryToFormValues(entry(id)), { reason: 'Trying anyway', expectedVersion: 2 });
    expect(replace.ok).toBe(false);
  });

  it('a filed tax return blocks the correction', () => {
    const id = postedEntry();
    lockTaxPeriod('filed');
    const assessment = useJournalStore.getState().assessAmendment(id)!;
    expect(assessment.mode).toBe('blocked');
    expect(assessment.blockers[0]!.kind).toBe('filed_tax_return');
  });

  it('a source-generated journal cannot be made inconsistent with its source', () => {
    const id = postedEntry();
    useInvoiceStore.setState({
      invoices: [{ id: 'inv1', invoiceNumber: 'INV-0042', journalEntryId: id, payments: [] }],
    } as never);

    const assessment = useJournalStore.getState().assessAmendment(id)!;
    expect(assessment.mode).toBe('blocked');
    expect(assessment.blockers[0]!.kind).toBe('source_document');
    // And it says where the correction actually belongs.
    expect(assessment.correctAt?.module).toBe('invoices');
    expect(assessment.correctAt?.label).toMatch(/INV-0042/);

    const amend = useJournalStore
      .getState()
      .amendPostedEntry(id, entryToFormValues(entry(id)), { reason: 'Corrected amount', expectedVersion: 2 });
    expect(amend.ok).toBe(false);
    expect(amend.error).toMatch(/Correct the sales invoice instead/i);

    // Not even reverse-and-replace: that would leave the journal disagreeing
    // with the invoice too.
    const replace = useJournalStore
      .getState()
      .reverseAndReplace(id, entryToFormValues(entry(id)), { reason: 'Corrected amount', expectedVersion: 2 });
    expect(replace.ok).toBe(false);
    expect(entry(id).totalDebit).toBe(5_000_000);
  });

  it('a reconciled/derived record cannot be destructively overwritten', () => {
    const id = postedEntry();
    useInventoryStore.setState({
      movements: [{ id: 'mv1', journalEntryId: id, sourceDocumentType: 'adjustment', sourceDocumentId: 'x' }],
    } as never);

    const overwrite = useJournalStore
      .getState()
      .amendPostedEntry(id, entryToFormValues(entry(id)), { reason: 'Direct overwrite attempt', expectedVersion: 2 });

    expect(overwrite.ok).toBe(false);
    expect(overwrite.error).toMatch(/reverse it and create a corrected replacement/i);
    // The posted figures survive the attempt.
    expect(entry(id).totalDebit).toBe(5_000_000);
    expect(entryVersion(entry(id))).toBe(2);
  });

  it('a draft dated inside a locked period cannot be saved into it', () => {
    const created = useJournalStore.getState().addEntry(balancedValues());
    lockTaxPeriod('locked');

    const result = useJournalStore
      .getState()
      .updateEntry(created.id!, balancedValues({ description: 'Edited' }), { expectedVersion: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Reopen the period/i);
  });

  it('posting into a locked period is refused', () => {
    lockTaxPeriod('locked');
    const created = useJournalStore.getState().addEntry(balancedValues());
    const posted = useJournalStore.getState().postEntry(created.id!);
    expect(posted.ok).toBe(false);
    expect(posted.error).toMatch(/Reopen the period/i);
  });
});

/* ══ Optimistic concurrency ═══════════════════════════════════════════════ */

describe('concurrent editing', () => {
  it('rejects a stale update with the required message and does not overwrite', () => {
    const id = postedEntry();

    // Sarah opens version 2.
    const sarahOpenedVersion = entryVersion(entry(id));
    const sarahValues = entryToFormValues(entry(id));
    sarahValues.reference = 'SARAH';

    // Ahmad saves first.
    const ahmadValues = entryToFormValues(entry(id));
    ahmadValues.reference = 'AHMAD';
    const ahmad = useJournalStore
      .getState()
      .amendPostedEntry(id, ahmadValues, { reason: 'Ahmad correction', expectedVersion: sarahOpenedVersion });
    expect(ahmad.ok, ahmad.error).toBe(true);

    // Sarah's save still claims the version she opened.
    const sarah = useJournalStore
      .getState()
      .amendPostedEntry(id, sarahValues, { reason: 'Sarah correction', expectedVersion: sarahOpenedVersion });

    expect(sarah.ok).toBe(false);
    expect(sarah.error).toBe(CONCURRENT_EDIT_MESSAGE);
    expect(sarah.conflict).toEqual({ currentVersion: sarahOpenedVersion + 1, expectedVersion: sarahOpenedVersion });

    // Ahmad's work is intact — Sarah's save did not silently win.
    expect(entry(id).reference).toBe('AHMAD');
    expect(entry(id).amendments!.filter((a) => a.kind === 'amended')).toHaveLength(1);
  });

  it('accepts the save once it is based on the current version', () => {
    const id = postedEntry();
    const first = useJournalStore
      .getState()
      .amendPostedEntry(id, entryToFormValues(entry(id)), { reason: 'First correction', expectedVersion: 2 });
    expect(first.ok).toBe(true);

    const refreshed = entryToFormValues(entry(id));
    refreshed.reference = 'AFTER-REVIEW';
    const second = useJournalStore
      .getState()
      .amendPostedEntry(id, refreshed, { reason: 'Second correction', expectedVersion: entryVersion(entry(id)) });

    expect(second.ok, second.error).toBe(true);
    expect(entry(id).reference).toBe('AFTER-REVIEW');
  });

  it('an omitted version token is refused rather than treated as "no check"', () => {
    const id = postedEntry();
    const result = useJournalStore
      .getState()
      .amendPostedEntry(id, entryToFormValues(entry(id)), { reason: 'No token supplied' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(CONCURRENT_EDIT_MESSAGE);
  });

  it('treats an entry written before versioning existed as version 1', () => {
    const id = postedEntry();
    // Simulate a persisted record from before the field existed.
    useJournalStore.setState({
      entries: useJournalStore.getState().entries.map((e) =>
        e.id === id ? { ...e, version: undefined, amendments: undefined } : e,
      ),
    });

    expect(entryVersion(entry(id))).toBe(1);
    expect(assertExpectedVersion(entry(id), 1).ok).toBe(true);

    const result = useJournalStore
      .getState()
      .amendPostedEntry(id, entryToFormValues(entry(id)), { reason: 'Legacy record correction', expectedVersion: 1 });
    expect(result.ok, result.error).toBe(true);

    /*
     * The synthesised history is not empty: an audit panel showing nothing for
     * an entry that was demonstrably created and posted would read as though
     * the history had been deleted.
     */
    const history = entry(id).amendments!;
    expect(history.some((a) => a.kind === 'created')).toBe(true);
    expect(history.some((a) => a.kind === 'amended')).toBe(true);
  });
});

/* ══ The pure assessor ════════════════════════════════════════════════════ */

describe('assessAmendment', () => {
  const base = { id: 'je1', entryNumber: 'JE-0001', version: 3 };

  it('lets a draft through, and reports a posted standalone entry as amendable', () => {
    expect(assessAmendment({ ...base, status: 'draft' }, []).mode).toBe('direct_edit');
    expect(assessAmendment({ ...base, status: 'posted' }, []).mode).toBe('amend_in_place');
  });

  it('reports a hard block even when a reversal-grade dependency is also present', () => {
    /*
     * The operator's next action differs completely between the two — reopen a
     * period versus correct an entry — so the more serious verdict has to win,
     * or they are sent down a path that ends in a second refusal.
     */
    const assessment = assessAmendment({ ...base, status: 'posted' }, [
      { kind: 'inventory_costing', severity: 'requires_reversal', sourceType: 'Stock movement', sourceId: 'm', sourceLabel: 'Stock movement', message: 'derived' },
      { kind: 'locked_period', severity: 'blocks', sourceType: 'Tax period', sourceId: 'p', sourceLabel: 'Period', message: 'locked' },
    ]);
    expect(assessment.mode).toBe('blocked');
    // Both are still reported — nothing is summarised away.
    expect(assessment.dependencies).toHaveLength(2);
  });

  it('carries the version through, defaulting to 1', () => {
    expect(assessAmendment({ ...base, status: 'posted' }, []).version).toBe(3);
    expect(assessAmendment({ id: 'x', entryNumber: 'JE-2', status: 'posted' }, []).version).toBe(1);
  });

  it('refuses to correct a voided entry', () => {
    expect(assessAmendment({ ...base, status: 'void' }, []).mode).toBe('blocked');
  });
});
