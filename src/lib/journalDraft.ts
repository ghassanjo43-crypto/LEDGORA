/**
 * THE canonical draft representation of an open journal entry.
 *
 * ══ The defect this module exists to make impossible ══════════════════════════
 *
 * The entry drawer used to derive its totals and its validation like this:
 *
 *     const watchedLines = watch('lines');
 *     const liveLines   = useMemo(() => watchedLines.map(…), [watchedLines]);
 *     const totals      = useMemo(() => computeTotals(liveLines), [liveLines]);
 *     const postingErrors = useMemo(() => validate(…), [watchedLines, …]);
 *
 * React Hook Form's `watch(name)` hands back the SAME array object on every
 * render and mutates it in place as the user types. So `watchedLines` was
 * always the live data — and its identity never changed, which meant every
 * `useMemo` keyed on it never recomputed. The component re-rendered with
 * correct values and then displayed a cache captured at mount: totals frozen at
 * 0.00, and "needs at least two lines" / "no debit or credit amounts" frozen on
 * screen while two complete lines sat right above them.
 *
 * The lesson is not "add a dependency". It is that **a mutable reference is not
 * a cache key**. Everything below therefore derives from VALUES:
 * {@link draftSignature} renders the draft to a string, and that string is what
 * memoisation keys on. A reference that mutates in place produces a different
 * signature the moment its contents differ, so a stale derivation is not
 * something a caller has to remember to avoid — it is unrepresentable.
 *
 * ══ One representation, every consumer ═══════════════════════════════════════
 *
 * `lineCount`, `totalDebit`, `totalCredit`, `difference`, `validation`, the save
 * payload and the post payload all come from {@link deriveJournalDraft} over the
 * same {@link DraftLine}s. There is deliberately no second copy for display.
 *
 * ══ Money ════════════════════════════════════════════════════════════════════
 *
 * Amounts are summed and compared with `lib/decimal` (BigInt-backed fixed-point),
 * never with floating point. `0.1 + 0.2 !== 0.3` is not a curiosity in a ledger:
 * it is an entry that will not balance. Amounts are carried as decimal STRINGS
 * end to end, so a typed "5000000" never round-trips through a float on its way
 * to the balance check.
 */
import type { Account, BusinessEntity } from '@/types';
import type { JournalIssue } from '@/types/journal';
import { decAbs, decCmp, decIsZero, decNormalize, decSub, decSum, decToFixed, decToNumber, isDecimal } from '@/lib/decimal';
import {
  balanceStatus,
  getWarnings,
  isBlankJournalLine,
  type BalanceStatus,
  type BlankCheckLine,
  type ValidatableLine,
} from '@/lib/journalValidation';
import { getPostingErrors } from '@/lib/journalValidation';

/* ────────────────────────────── Amount parsing ──────────────────────────── */

/**
 * Any amount a field can hold, as a canonical decimal STRING.
 *
 * Handles what actually arrives from a form: a number, a numeric string, an
 * empty string from a cleared input, a grouped paste like `5,000,000.00`, and
 * the stray non-numeric. Grouping separators and spaces are stripped rather
 * than rejected, because `Number('5,000,000')` is `NaN` — and silently scoring
 * a pasted five-million as zero is exactly the class of bug this file exists to
 * prevent.
 *
 * Never returns a value that later throws in `decimal`: anything unparseable
 * becomes `'0'`.
 */
export function toDecimalAmount(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? decNormalize(value) : '0';
  const raw = String(value ?? '').trim();
  if (!raw) return '0';
  // Thousands separators and internal whitespace only; the decimal point stays.
  const cleaned = raw.replace(/[,\s_]/g, '');
  return isDecimal(cleaned) ? decNormalize(cleaned) : '0';
}

/** Display/back-compat numeric view of an amount. */
export function toAmountNumber(value: unknown): number {
  return decToNumber(toDecimalAmount(value));
}

/* ─────────────────────────────── The draft ──────────────────────────────── */

/** One line of the open entry — the single shape every consumer reads. */
export interface DraftLine {
  /**
   * Stable identity for the row, taken from the field array's own key. Amount
   * updates address a line by id rather than by position, so reordering or
   * removing a row can never write into a different line's amount.
   */
  id: string;
  /** 1-based position as displayed, preserved through filtering so messages point at the visible row. */
  lineNumber: number;
  accountId: string;
  /** `null` is a first-class value: a journal line does not require an entity. */
  entityId: string | null;
  /** Decimal strings — never floats. */
  debit: string;
  credit: string;
  taxAmount: string;
  memo: string;
  costCenter: string;
  project: string;
  taxCode: string;
}

/**
 * The loosely-typed line shape a form hands over before normalisation.
 *
 * Deliberately NOT `extends BlankCheckLine`: `entityId` here admits `null`,
 * because "no entity" is a real state a caller may express that way, and the
 * blank-check shape models it only as an absent string.
 */
export interface RawDraftLine extends Omit<BlankCheckLine, 'entityId'> {
  id?: string;
  accountId?: string;
  entityId?: string | null;
  debit?: number | string;
  credit?: number | string;
  taxAmount?: number | string;
  memo?: string;
  costCenter?: string;
  project?: string;
  taxCode?: string;
}

export interface RawDraft {
  description?: string;
  entryDate?: string;
  lines: RawDraftLine[];
}

/**
 * Normalise the form's lines into canonical draft lines.
 *
 * `fieldIds` are the field-array keys, supplied positionally by the component
 * so a line keeps one identity for its whole life. When absent (tests, imports)
 * the index is used, which is stable enough for a pure derivation.
 */
export function toDraftLines(lines: readonly RawDraftLine[], fieldIds?: readonly string[]): DraftLine[] {
  return lines.map((line, index) => ({
    id: line.id ?? fieldIds?.[index] ?? `line-${index}`,
    lineNumber: index + 1,
    accountId: line.accountId?.trim() ?? '',
    // '' and null both mean "no entity"; normalised to null so one value means one thing.
    entityId: line.entityId?.trim() ? line.entityId.trim() : null,
    debit: toDecimalAmount(line.debit),
    credit: toDecimalAmount(line.credit),
    taxAmount: toDecimalAmount(line.taxAmount),
    memo: line.memo ?? '',
    costCenter: line.costCenter ?? '',
    project: line.project ?? '',
    taxCode: line.taxCode ?? '',
  }));
}

/**
 * A value signature of the draft, for memo keys.
 *
 * Covers exactly the fields any derived value depends on. Two drafts that would
 * produce the same totals, the same validation and the same payload share a
 * signature; anything that would change one of those changes the string.
 */
export function draftSignature(draft: RawDraft): string {
  const lines = toDraftLines(draft.lines ?? []);
  return JSON.stringify([
    draft.description ?? '',
    draft.entryDate ?? '',
    lines.map((l) => [l.accountId, l.entityId ?? '', l.debit, l.credit, l.taxAmount, l.memo, l.costCenter, l.project, l.taxCode]),
  ]);
}

/* ───────────────────────────── Derived values ───────────────────────────── */

/** Decimal-exact totals. Strings are authoritative; numbers are for display. */
export interface DraftTotals {
  totalDebit: string;
  totalCredit: string;
  /** debit − credit. */
  difference: string;
  totalDebitNumber: number;
  totalCreditNumber: number;
  differenceNumber: number;
  balanced: boolean;
}

/**
 * Sum and compare in decimal.
 *
 * `balanced` is an EXACT decimal comparison, not a tolerance: the inputs are
 * fixed-point strings, so there is no representation error for a tolerance to
 * absorb. A tolerance here would silently accept a genuinely unbalanced entry
 * that happens to be out by less than half a cent.
 */
export function computeDraftTotals(lines: readonly DraftLine[]): DraftTotals {
  const totalDebit = decSum(lines.map((l) => l.debit));
  const totalCredit = decSum(lines.map((l) => l.credit));
  const difference = decSub(totalDebit, totalCredit);
  return {
    totalDebit,
    totalCredit,
    difference,
    totalDebitNumber: decToNumber(totalDebit),
    totalCreditNumber: decToNumber(totalCredit),
    differenceNumber: decToNumber(difference),
    balanced: decCmp(totalDebit, totalCredit) === 0,
  };
}

/**
 * Lines that count as journal lines.
 *
 * A completely blank placeholder row is not a journal line and is not counted,
 * saved or posted. Crucially, a MISSING ENTITY is not blankness: `entityId` is
 * absent from every test below, because "no entity" is a valid, complete state
 * for a journal line and dropping such a line would silently discard real work.
 */
export function activeDraftLines(lines: readonly DraftLine[]): DraftLine[] {
  return lines.filter(
    (line) =>
      !isBlankJournalLine({
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
        memo: line.memo,
        // Deliberately passed: a row whose ONLY content is an entity is still
        // not blank, so it stays visible and countable rather than vanishing.
        entityId: line.entityId ?? '',
        costCenter: line.costCenter,
        project: line.project,
        taxCode: line.taxCode,
        taxAmount: line.taxAmount,
      }),
  );
}

/** The shape `journalValidation` consumes, built from canonical lines. */
function toValidatable(line: DraftLine): ValidatableLine {
  return {
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    debit: decToNumber(line.debit),
    credit: decToNumber(line.credit),
    taxAmount: decToNumber(line.taxAmount),
    entityId: line.entityId ?? '',
  };
}

export interface DerivedDraft {
  /** Every row, including blank placeholders (what the grid renders). */
  lines: DraftLine[];
  /** Rows that count as journal lines. */
  activeLines: DraftLine[];
  /** Number of counted lines — never the placeholder count. */
  lineCount: number;
  totals: DraftTotals;
  status: BalanceStatus;
  postingErrors: JournalIssue[];
  warnings: JournalIssue[];
  canPost: boolean;
}

/**
 * The one derivation. Everything the drawer shows or sends comes from here.
 */
export function deriveJournalDraft(
  draft: RawDraft,
  accountsById: Map<string, Account>,
  entitiesById: Map<string, BusinessEntity>,
  fieldIds?: readonly string[],
): DerivedDraft {
  const lines = toDraftLines(draft.lines ?? [], fieldIds);
  const active = activeDraftLines(lines);
  const totals = computeDraftTotals(active);
  const validatable = active.map(toValidatable);

  const postingErrors: JournalIssue[] = [];
  if (!draft.description?.trim()) {
    postingErrors.push({ severity: 'error', rule: 'description-required', message: 'Enter a description / narration.', lineNumber: null });
  }
  if (!draft.entryDate?.trim()) {
    postingErrors.push({ severity: 'error', rule: 'date-required', message: 'Entry date is required.', lineNumber: null });
  }
  postingErrors.push(...getPostingErrors({ lines: validatable }, accountsById));

  /*
   * The balance verdict is re-decided in DECIMAL, replacing the float-based one
   * `getPostingErrors` contributes. Both rules are dropped and exactly one is
   * re-added, so the entry can never be told it balances by one component and
   * not by another.
   */
  const issues = postingErrors.filter((i) => i.rule !== 'unbalanced' && i.rule !== 'no-amounts');
  if (!totals.balanced) {
    issues.push({
      severity: 'error',
      rule: 'unbalanced',
      message: `Entry is out of balance by ${decToFixed(decAbs(totals.difference), 2)} (debits ${decToFixed(totals.totalDebit, 2)} vs credits ${decToFixed(totals.totalCredit, 2)}).`,
      lineNumber: null,
    });
  } else if (decIsZero(totals.totalDebit)) {
    issues.push({
      severity: 'error',
      rule: 'no-amounts',
      message: 'Entry has no debit or credit amounts.',
      lineNumber: null,
    });
  }

  return {
    lines,
    activeLines: active,
    lineCount: active.length,
    totals,
    status: balanceStatus({
      totalDebit: totals.totalDebitNumber,
      totalCredit: totals.totalCreditNumber,
      difference: totals.differenceNumber,
    }),
    postingErrors: issues,
    warnings: getWarnings({ lines: validatable }, accountsById, entitiesById),
    canPost: issues.length === 0,
  };
}
