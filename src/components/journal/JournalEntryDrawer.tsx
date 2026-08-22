import { useEffect, useMemo, useState } from 'react';
import { useForm, useFieldArray, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Check, TriangleAlert, Send, ChevronDown, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import type { Account, BusinessEntity } from '@/types';
import {
  journalFormSchema,
  isBlankJournalLine,
  type JournalFormValues,
  type BalanceStatus,
} from '@/lib/journalValidation';
import { deriveJournalDraft, draftSignature, toDecimalAmount } from '@/lib/journalDraft';
import {
  CONCURRENT_EDIT_MESSAGE,
  REASON_REQUIRED_MESSAGE,
  entryVersion,
  validateReason,
} from '@/lib/journalAmendment';
import { decCmp } from '@/lib/decimal';
import { formatMoney } from '@/lib/journalSelectors';
import { TRANSACTION_TYPE_OPTIONS } from '@/lib/journalMeta';
import {
  entryToFormValues,
  makeDefaultJournalValues,
  makeEmptyLine,
  nextEntryNumber,
  useJournalStore,
  type JournalActionResult,
} from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { ReadOnlyValue } from '@/components/ui/ReadOnlyValue';
import { useTransactionCurrency } from '@/lib/transactionCurrency';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { AccountSelect } from './AccountSelect';
import { useCostCenterStore } from '@/store/costCenterStore';
import { CostCenterPicker } from '@/components/cost-centers/CostCenterPicker';
import { useProjectStore } from '@/store/projectStore';
import { ProjectPicker } from '@/components/projects/ProjectPicker';
import { useHasModule } from '@/store/entitlementHooks';
import { useMonetaryPrecision } from '@/lib/useMonetaryPrecision';
import { EntityPicker } from '@/components/shared/EntityPicker';

export type JournalFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; entryId: string }
  /**
   * Correcting a POSTED entry. `amend` rewrites it as a new version; `replace`
   * reverses it and writes a corrected replacement. Which one applies is
   * decided by the store's assessment, never by the caller — see
   * `GeneralJournal.openEditor`.
   */
  | { kind: 'amend'; entryId: string; strategy: 'amend' | 'replace' };

interface JournalEntryDrawerProps {
  open: boolean;
  mode: JournalFormMode | null;
  onClose: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</h3>
  );
}

/** Grid template shared by the line header and each line row for alignment. */
const LINE_GRID =
  'grid grid-cols-[1.5rem_minmax(9rem,4fr)_minmax(6rem,2.5fr)_6.75rem_6.75rem_4.75rem] items-center gap-2';

export function JournalEntryDrawer({ open, mode, onClose }: JournalEntryDrawerProps) {
  const entries = useJournalStore((s) => s.entries);
  const addEntry = useJournalStore((s) => s.addEntry);
  const updateEntry = useJournalStore((s) => s.updateEntry);
  const amendPostedEntry = useJournalStore((s) => s.amendPostedEntry);
  const reverseAndReplace = useJournalStore((s) => s.reverseAndReplace);
  const postEntry = useJournalStore((s) => s.postEntry);
  const accounts = useStore((s) => s.accounts);
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  /** The company's own currency — shown beside the amounts, never chosen. */
  const companyCurrency = useTransactionCurrency();
  const businessEntities = useEntityStore((s) => s.entities);
  const { notify } = useToast();

  const accountsById = useMemo(
    () => new Map<string, Account>(accounts.map((a) => [a.id, a])),
    [accounts],
  );
  const entitiesById = useMemo(
    () => new Map(businessEntities.map((e) => [e.id, e])),
    [businessEntities],
  );

  const targetId = mode && mode.kind !== 'create' ? mode.entryId : undefined;
  const editing = targetId ? entries.find((e) => e.id === targetId) : undefined;

  /** Correcting a posted entry: a reason is mandatory and history is written. */
  const amending = mode?.kind === 'amend';
  const strategy = mode?.kind === 'amend' ? mode.strategy : undefined;

  /**
   * The concurrency token, captured ONCE when the editor opens.
   *
   * Deliberately not re-read from the store on later renders: it has to record
   * the version this user actually looked at. Refreshing it would make the
   * check pass against a change they never saw, which is precisely the silent
   * overwrite optimistic concurrency exists to prevent.
   */
  const [openedVersion, setOpenedVersion] = useState<number | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentVersion: number } | null>(null);

  const defaultValues = useMemo<JournalFormValues>(() => {
    if (editing) return entryToFormValues(editing);
    return makeDefaultJournalValues(nextEntryNumber(entries), baseCurrency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editing?.id, baseCurrency]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<JournalFormValues>({
    resolver: zodResolver(journalFormSchema),
    defaultValues,
  });

  const { fields, append, remove, move } = useFieldArray({ control, name: 'lines' });

  /**
   * Once a brand-new entry has been saved (via "Save draft (keep editing)" or
   * "Save & new" flows), remember its id so subsequent saves UPDATE it rather
   * than inserting a duplicate.
   */
  const [savedId, setSavedId] = useState<string | null>(null);
  const [showDiscard, setShowDiscard] = useState(false);
  /**
   * Whether the user has tried to post. The full blocking validation summary is
   * hidden until then, so a brand-new empty entry never opens covered in errors.
   */
  const [postAttempted, setPostAttempted] = useState(false);

  useEffect(() => {
    if (open) {
      reset(defaultValues);
      setSavedId(null);
      setShowDiscard(false);
      setPostAttempted(false);
      setReason('');
      setReasonError(null);
      setConflict(null);
      // The version this user is looking at, frozen for the life of the editor.
      setOpenedVersion(editing ? entryVersion(editing) : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultValues, reset]);

  /** The id being edited: an explicit edit entry, or a just-created draft. */
  const editId = targetId ?? savedId;

  /*
   * ── The canonical draft ───────────────────────────────────────────────────
   *
   * `useWatch` — not `watch` — is the subscription that re-renders this
   * component when any line field changes, including the amount inputs, which
   * are registered directly rather than through a Controller.
   *
   * The values it returns are owned by React Hook Form and may be handed back
   * as the SAME array, mutated in place. So nothing below keys a memo on their
   * identity: `draftSignature` renders the draft to a string and that string is
   * the cache key. This is the fix for the defect — totals and validation
   * cannot lag behind the inputs, because a changed value IS a changed key.
   */
  const watchedLines = useWatch({ control, name: 'lines' }) as JournalFormValues['lines'] | undefined;
  const description = useWatch({ control, name: 'description' }) ?? '';
  const entryDate = useWatch({ control, name: 'entryDate' }) ?? '';

  const rawDraft = { description, entryDate, lines: watchedLines ?? [] };
  const signature = draftSignature(rawDraft);

  const draft = useMemo(
    () => deriveJournalDraft(rawDraft, accountsById, entitiesById),
    // Keyed on the VALUE signature, never on the array reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, accountsById, entitiesById],
  );

  const { totals, status, postingErrors, warnings, canPost } = draft;

  /** Line numbers (1-based) carrying account / amount errors, for field highlighting. */
  const accountErrorLines = useMemo(
    () => new Set(postingErrors.filter((i) => i.lineNumber && ['account-required', 'account-missing', 'header-account', 'inactive-account'].includes(i.rule)).map((i) => i.lineNumber)),
    [postingErrors],
  );
  const amountErrorLines = useMemo(
    () => new Set(postingErrors.filter((i) => i.lineNumber && ['zero-amount', 'negative-amount', 'debit-and-credit'].includes(i.rule)).map((i) => i.lineNumber)),
    [postingErrors],
  );

  /** Move focus/scroll to the first field the posting validator flagged. */
  const focusFirstInvalid = (): void => {
    const first = postingErrors[0];
    if (!first) return;
    if (first.rule === 'description-required') { document.getElementById('description')?.focus(); return; }
    if (first.rule === 'date-required') { document.getElementById('entryDate')?.focus(); return; }
    if (first.lineNumber) {
      const idx = first.lineNumber - 1;
      const el = document.getElementById(`account-${idx}`) ?? document.querySelector<HTMLElement>(`[data-line="${idx}"][data-col="debit"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus();
    }
  };

  /** Excel-style: move focus to the same column on an adjacent line. */
  const focusCell = (index: number, col: 'debit' | 'credit'): void => {
    const el = document.querySelector<HTMLInputElement>(
      `[data-line="${index}"][data-col="${col}"]`,
    );
    if (el) {
      el.focus();
      el.select();
    }
  };

  /** Enter on an amount cell advances to the next line, adding one if needed. */
  const handleAmountEnter = (index: number, col: 'debit' | 'credit'): void => {
    if (index >= fields.length - 1) {
      append(makeEmptyLine());
      window.setTimeout(() => focusCell(index + 1, col), 0);
    } else {
      focusCell(index + 1, col);
    }
  };

  /** Drop completely blank placeholder rows before persisting (keep ≥1 line). */
  const stripBlankLines = (values: JournalFormValues): JournalFormValues => {
    const active = values.lines.filter((line) => !isBlankJournalLine(line));
    return { ...values, lines: active.length > 0 ? active : values.lines.slice(0, 1) };
  };

  /**
   * Persist the form.
   *
   * Three destinations, and the caller never picks between the last two: the
   * STRATEGY came from the store's own assessment when the editor opened, and
   * the store re-assesses again on the way in. A drawer that decided for itself
   * could be looking at a dependency snapshot minutes out of date.
   */
  const persistDraft = (values: JournalFormValues): JournalActionResult => {
    const cleaned = stripBlankLines(values);

    let result: JournalActionResult;
    if (amending && editId) {
      const trimmed = reason.trim();
      const check = validateReason(trimmed);
      if (!check.ok) {
        setReasonError(check.error ?? REASON_REQUIRED_MESSAGE);
        return { ok: false, error: check.error };
      }
      setReasonError(null);
      const options = { reason: trimmed, expectedVersion: openedVersion };
      result =
        strategy === 'replace'
          ? reverseAndReplace(editId, cleaned, options)
          : amendPostedEntry(editId, cleaned, options);
    } else if (editId) {
      result = updateEntry(editId, cleaned, { expectedVersion: openedVersion });
    } else {
      result = addEntry(cleaned);
    }

    if (result.ok && result.id && !editId) setSavedId(result.id);
    if (!result.ok) {
      // A concurrency refusal gets its own banner rather than a toast that
      // scrolls away — the user has to decide what to do about it.
      if (result.conflict) setConflict({ currentVersion: result.conflict.currentVersion });
      else notify(result.error ?? 'Could not save the journal entry.', 'error');
    }
    return result;
  };

  const onSaveAndClose = (values: JournalFormValues): void => {
    if (persistDraft(values).ok) {
      notify(
        amending
          ? strategy === 'replace'
            ? 'Entry reversed and a corrected replacement posted.'
            : 'Correction applied. The previous version is kept in the history.'
          : 'Draft journal entry saved.',
        'success',
      );
      onClose();
    }
  };

  const onSaveKeepEditing = (values: JournalFormValues): void => {
    if (persistDraft(values).ok) {
      notify('Draft saved.', 'success');
      setPostAttempted(false);
      reset(values); // clear the dirty flag; stay open
    }
  };

  const onSaveAndNew = (values: JournalFormValues): void => {
    if (persistDraft(values).ok) {
      notify('Draft saved. Ready for the next entry.', 'success');
      const fresh = makeDefaultJournalValues(
        nextEntryNumber(useJournalStore.getState().entries),
        baseCurrency,
      );
      setSavedId(null);
      setPostAttempted(false);
      reset(fresh);
    }
  };

  const onSaveAndPost = (values: JournalFormValues): void => {
    const result = persistDraft(values);
    if (!result.ok || !result.id) return;
    const posted = postEntry(result.id);
    if (posted.ok) {
      notify('Journal entry posted.', 'success');
      onClose();
    } else {
      notify(posted.error ?? 'Saved as draft — could not post yet.', 'warning');
    }
  };

  /**
   * Post click: mark the attempt (revealing the validation summary), and only
   * proceed to save+post when the active lines actually pass posting validation.
   */
  const handlePost = (): void => {
    setPostAttempted(true);
    if (postingErrors.length > 0) {
      window.setTimeout(focusFirstInvalid, 0);
      return;
    }
    void handleSubmit(onSaveAndPost)();
  };

  /** Guard closing when there are unsaved edits. */
  const requestClose = (): void => {
    if (isDirty) setShowDiscard(true);
    else onClose();
  };

  /**
   * Entering an amount on one side clears the other.
   *
   * This is the existing UX for "a line cannot hold both a debit and a credit",
   * and it writes through `setValue` — the same canonical form state every
   * derived value reads — so the totals move with the clear, not after it.
   */
  const handleAmount = (index: number, side: 'debit' | 'credit', value: string): void => {
    if (decCmp(toDecimalAmount(value), '0') > 0) {
      const other = side === 'debit' ? 'credit' : 'debit';
      setValue(`lines.${index}.${other}`, 0, { shouldDirty: true, shouldTouch: true });
    }
  };

  // Keyboard shortcuts: Ctrl/Cmd+S save draft · Ctrl/Cmd+Enter post · Alt+A add line.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSubmit(onSaveKeepEditing)();
      } else if (mod && (e.key === 'Enter' || e.key.toLowerCase() === 'p')) {
        // Ctrl/Cmd+Enter or Ctrl/Cmd+P → attempt to post the entry.
        e.preventDefault();
        handlePost();
      } else if (e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        append(makeEmptyLine());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canPost, mode]);

  const entryNumber = watch('entryNumber');

  return (
    <Drawer
      open={open}
      onClose={requestClose}
      widthClassName="max-w-5xl"
      title={
        amending
          ? strategy === 'replace'
            ? 'Reverse & edit journal entry'
            : 'Correct posted journal entry'
          : mode?.kind === 'edit'
            ? 'Edit draft journal entry'
            : 'New journal entry'
      }
      description={
        editing
          ? `${editing.entryNumber} — ${editing.description || (amending ? 'Posted' : 'Draft')}`
          : `${entryNumber} — record a balanced double-entry transaction`
      }
      footer={
        <StickyTotals
          totalDebit={totals.totalDebitNumber}
          totalCredit={totals.totalCreditNumber}
          difference={totals.differenceNumber}
          status={status}
          canPost={canPost}
          saving={isSubmitting}
          onCancel={requestClose}
          onSaveAndClose={() => void handleSubmit(onSaveAndClose)()}
          onSaveKeepEditing={() => void handleSubmit(onSaveKeepEditing)()}
          onSaveAndNew={() => void handleSubmit(onSaveAndNew)()}
          onPost={handlePost}
        />
      }
    >
      <form onSubmit={handleSubmit(onSaveAndClose)} className="space-y-6">
        {/*
          The concurrency refusal. Shown in place rather than as a toast: the
          user's edits are still on screen and still theirs to keep, and the
          decision about whose version survives is a human one.
        */}
        {conflict && (
          <section
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10"
          >
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
              <TriangleAlert className="h-4 w-4" /> {CONCURRENT_EDIT_MESSAGE}
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300/90">
              You opened version {openedVersion}. The saved entry is now version {conflict.currentVersion}. Your changes
              have not been discarded — nothing was written.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  // Load the latest and start again from it. The user's own
                  // edits are visible until they press this, so nothing is lost
                  // without them choosing it.
                  const latest = useJournalStore.getState().entries.find((e) => e.id === editId);
                  if (latest) {
                    reset(entryToFormValues(latest));
                    setOpenedVersion(entryVersion(latest));
                  }
                  setConflict(null);
                }}
              >
                Review latest version
              </Button>
            </div>
          </section>
        )}

        {/*
          The mandatory reason. Present only when the entry is posted, because
          that is when a correction rewrites something somebody already relied
          on and the audit trail has to be able to say why.
        */}
        {amending && (
          <section className="rounded-lg border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-500/30 dark:bg-brand-500/10">
            <p className="text-xs font-semibold text-brand-800 dark:text-brand-200">
              {strategy === 'replace'
                ? `Reversing ${editing?.entryNumber} and posting a corrected replacement`
                : `Correcting posted entry ${editing?.entryNumber} (version ${openedVersion})`}
            </p>
            <p className="mt-0.5 text-xs text-brand-700/90 dark:text-brand-300/90">
              {strategy === 'replace'
                ? 'The original stays exactly as posted. A reversal and a replacement are written and linked to it.'
                : 'The current version is kept in full in the entry’s history.'}
            </p>
            <Field
              label="Reason for the correction"
              required
              className="mt-2"
              error={reasonError ?? undefined}
              htmlFor="amendment-reason"
            >
              <Input
                id="amendment-reason"
                placeholder="e.g. Corrected cash account"
                hasError={!!reasonError}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (reasonError) setReasonError(null);
                }}
              />
            </Field>
          </section>
        )}

        {/* Header */}
        <section className="space-y-3">
          <SectionTitle>Entry details</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Entry number" htmlFor="entryNumber" hint="Auto-assigned sequence">
              <Input id="entryNumber" readOnly className="font-mono" {...register('entryNumber')} />
            </Field>
            <Field label="Entry date" required error={errors.entryDate?.message} htmlFor="entryDate">
              <Input id="entryDate" type="date" hasError={!!errors.entryDate} {...register('entryDate')} />
            </Field>
            <Field label="Reference" error={errors.reference?.message} htmlFor="reference">
              <Input id="reference" placeholder="e.g. INV-001" {...register('reference')} />
            </Field>
            <Field label="Transaction type" htmlFor="transactionType" hint="Leave on Auto to classify from the reference">
              <Select id="transactionType" options={TRANSACTION_TYPE_OPTIONS} {...register('transactionType')} />
            </Field>
            <Field
              label="Description / narration"
              required
              className="sm:col-span-3"
              error={errors.description?.message}
              htmlFor="description"
            >
              <Input
                id="description"
                placeholder="What does this entry record?"
                hasError={!!errors.description}
                {...register('description')}
              />
            </Field>
            {/*
              The company's own currency, shown and not chosen.

              An ordinary journal entry is denominated in the company's
              functional currency at par, so there is nothing here to decide.
              The value is read from the company rather than held as form state,
              which is what stops a saved entry from disagreeing with the
              company that owns it. The exchange-rate field went with it: at par
              it could only ever be 1, and an editable 1 is an invitation.
            */}
            <Field label="Currency">
              <ReadOnlyValue data-testid="journal-currency">{companyCurrency.label}</ReadOnlyValue>
            </Field>
            <Field label="Created by" error={errors.createdBy?.message} htmlFor="createdBy">
              <Input id="createdBy" placeholder="Preparer name" {...register('createdBy')} />
            </Field>
            <Field label="Notes" className="sm:col-span-3" error={errors.notes?.message} htmlFor="notes">
              <Input id="notes" placeholder="Optional internal notes" {...register('notes')} />
            </Field>
          </div>
        </section>

        {/* Lines — spreadsheet-style grid */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <SectionTitle>Journal lines</SectionTitle>
            <Button type="button" variant="outline" size="sm" onClick={() => append(makeEmptyLine())}>
              <Plus className="h-4 w-4" /> Add line
              <kbd className="ml-1 rounded border border-slate-200 px-1 text-[10px] text-slate-400 dark:border-slate-600">Alt A</kbd>
            </Button>
          </div>
          {typeof errors.lines?.message === 'string' && (
            <p className="text-xs text-red-600 dark:text-red-400">{errors.lines.message}</p>
          )}

          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
            {/* Column header */}
            <div className={cn(LINE_GRID, 'border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800 dark:bg-slate-800/40')}>
              <span className="text-center">#</span>
              <span>Account</span>
              <span>Entity</span>
              <span className="text-right">Debit</span>
              <span className="text-right">Credit</span>
              <span />
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {fields.map((field, index) => (
                <LineRow
                  key={field.id}
                  index={index}
                  accounts={accounts}
                  entities={businessEntities}
                  canRemove={fields.length > 2}
                  canMoveUp={index > 0}
                  canMoveDown={index < fields.length - 1}
                  onRemove={() => remove(index)}
                  onMoveUp={() => move(index, index - 1)}
                  onMoveDown={() => move(index, index + 1)}
                  onAmount={handleAmount}
                  onAmountEnter={handleAmountEnter}
                  control={control}
                  register={register}
                  setValue={setValue}
                  hasAccountError={postAttempted && accountErrorLines.has(index + 1)}
                  hasAmountError={postAttempted && amountErrorLines.has(index + 1)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Live validation feedback — the blocking summary only appears after a post attempt. */}
        {((postAttempted && postingErrors.length > 0) || warnings.length > 0) && (
          <section className="space-y-2">
            {postAttempted && postingErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/10">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
                  <TriangleAlert className="h-4 w-4" /> Must fix before posting ({postingErrors.length})
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-red-700 dark:text-red-300">
                  {postingErrors.map((issue, i) => (
                    <li key={`${issue.rule}-${i}`}>• {issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="h-4 w-4" /> Warnings ({warnings.length}) — won’t block saving
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-amber-700 dark:text-amber-300">
                  {warnings.map((issue, i) => (
                    <li key={`${issue.rule}-${i}`}>• {issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </form>

      <ConfirmDialog
        open={showDiscard}
        title="Discard unsaved changes?"
        message="You have unsaved changes to this journal entry. Discard them?"
        confirmLabel="Discard changes"
        cancelLabel="Continue editing"
        destructive
        onConfirm={() => {
          setShowDiscard(false);
          onClose();
        }}
        onCancel={() => setShowDiscard(false)}
      />
    </Drawer>
  );
}

/* ─────────────────────────────── Line row ───────────────────────────────── */

interface LineRowProps {
  index: number;
  accounts: Account[];
  entities: BusinessEntity[];
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAmount: (index: number, side: 'debit' | 'credit', value: string) => void;
  onAmountEnter: (index: number, col: 'debit' | 'credit') => void;
  hasAccountError: boolean;
  hasAmountError: boolean;
  control: import('react-hook-form').Control<JournalFormValues>;
  register: import('react-hook-form').UseFormRegister<JournalFormValues>;
  setValue: import('react-hook-form').UseFormSetValue<JournalFormValues>;
}

function LineRow({
  index,
  accounts,
  entities,
  canRemove,
  canMoveUp,
  canMoveDown,
  onRemove,
  onMoveUp,
  onMoveDown,
  onAmount,
  onAmountEnter,
  hasAccountError,
  hasAmountError,
  control,
  register,
  setValue,
}: LineRowProps) {
  const debitReg = register(`lines.${index}.debit`);
  const creditReg = register(`lines.${index}.credit`);
  /*
   * The company's monetary precision drives the stepper and the placeholder, so
   * a JOD line offers thousandths (step 0.001, "0.000") and a JPY line whole
   * units. The schema refuses anything finer; this makes the field agree with
   * it rather than inviting a value the save would reject.
   */
  const moneyDecimals = useMonetaryPrecision();
  const moneyStep = 10 ** -moneyDecimals;
  const moneyPlaceholder = moneyDecimals > 0 ? `0.${'0'.repeat(moneyDecimals)}` : '0';
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const projects = useProjectStore((s) => s.projects);
  // Only expose a dimension field when the organization owns its module.
  const showCostCenter = useHasModule('cost_centers');
  const showProject = useHasModule('projects');

  return (
    <div className="px-3 py-2 transition-colors hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
      <div className={LINE_GRID}>
        <span className="text-center font-mono text-[11px] text-slate-400">{index + 1}</span>

        <Controller
          control={control}
          name={`lines.${index}.accountId`}
          render={({ field }) => (
            <AccountSelect
              id={`account-${index}`}
              value={field.value}
              accounts={accounts}
              hasError={hasAccountError}
              onChange={(account) => {
                field.onChange(account.id);
                setValue(`lines.${index}.accountCode`, account.code);
                setValue(`lines.${index}.accountName`, account.name);
              }}
            />
          )}
        />

        <Controller
          control={control}
          name={`lines.${index}.entityId`}
          render={({ field }) => (
            <EntityPicker
              value={field.value}
              entities={entities}
              onChange={(entity) => {
                field.onChange(entity?.id ?? '');
                setValue(`lines.${index}.entityName`, entity?.legalName ?? '');
              }}
            />
          )}
        />

        <Input
          type="number"
          step={moneyStep} data-money="true"
          min={0}
          placeholder={moneyPlaceholder}
          data-line={index}
          data-col="debit"
          hasError={hasAmountError}
          className="h-9 text-right font-mono text-sm"
          {...debitReg}
          onChange={(e) => {
            debitReg.onChange(e);
            onAmount(index, 'debit', e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAmountEnter(index, 'debit');
            }
          }}
        />
        <Input
          type="number"
          step={moneyStep} data-money="true"
          min={0}
          placeholder={moneyPlaceholder}
          data-line={index}
          data-col="credit"
          hasError={hasAmountError}
          className="h-9 text-right font-mono text-sm"
          {...creditReg}
          onChange={(e) => {
            creditReg.onChange(e);
            onAmount(index, 'credit', e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAmountEnter(index, 'credit');
            }
          }}
        />

        <div className="flex items-center justify-end gap-0.5">
          <LineIconButton label="Move line up" disabled={!canMoveUp} onClick={onMoveUp}>
            <ArrowUp className="h-4 w-4" />
          </LineIconButton>
          <LineIconButton label="Move line down" disabled={!canMoveDown} onClick={onMoveDown}>
            <ArrowDown className="h-4 w-4" />
          </LineIconButton>
          <LineIconButton
            label={canRemove ? 'Remove line' : 'At least two lines are required'}
            disabled={!canRemove}
            danger
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </LineIconButton>
        </div>
      </div>

      {/* Memo + advanced fields (compact secondary row) */}
      <div className="mt-1.5 grid grid-cols-2 gap-2 pl-[1.5rem] sm:grid-cols-5">
        <Input placeholder="Line memo" className="h-8 text-xs sm:col-span-2" {...register(`lines.${index}.memo`)} />
        {showCostCenter && (
          <Controller
            control={control}
            name={`lines.${index}.costCenter`}
            render={({ field }) => (
              <CostCenterPicker value={field.value ?? ''} costCenters={costCenters} onChange={field.onChange} allowClear />
            )}
          />
        )}
        {showProject && (
          <Controller
            control={control}
            name={`lines.${index}.project`}
            render={({ field }) => (
              <ProjectPicker value={field.value ?? ''} projects={projects} onChange={field.onChange} allowClear />
            )}
          />
        )}
        <div className="flex gap-2">
          <Input placeholder="Tax" className="h-8 text-xs" {...register(`lines.${index}.taxCode`)} />
          {/* Tax amount is money too, so it follows the same precision. */}
          <Input type="number" step={moneyStep} data-money="true" min={0} placeholder="Tax amt" className="h-8 w-20 text-right font-mono text-xs" {...register(`lines.${index}.taxAmount`)} />
        </div>
      </div>
    </div>
  );
}

function LineIconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'focus-ring flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors disabled:cursor-not-allowed disabled:opacity-30',
        danger
          ? 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10'
          : 'hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

/* ──────────────────────────── Sticky totals bar ──────────────────────────── */

function StickyTotals({
  totalDebit,
  totalCredit,
  difference,
  status,
  canPost,
  saving,
  onCancel,
  onSaveAndClose,
  onSaveKeepEditing,
  onSaveAndNew,
  onPost,
}: {
  totalDebit: number;
  totalCredit: number;
  difference: number;
  status: BalanceStatus;
  canPost: boolean;
  saving: boolean;
  onCancel: () => void;
  onSaveAndClose: () => void;
  onSaveKeepEditing: () => void;
  onSaveAndNew: () => void;
  onPost: () => void;
}) {
  const statusStyle =
    status === 'balanced'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300'
      : status === 'unbalanced'
        ? 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300'
        : 'bg-slate-100 text-slate-500 ring-slate-400/20 dark:bg-slate-800 dark:text-slate-400';
  const statusLabel = status === 'balanced' ? 'Balanced' : status === 'unbalanced' ? 'Unbalanced' : 'Not started';
  return (
    <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Total label="Total debit" value={totalDebit} />
        <Total label="Total credit" value={totalCredit} />
        <div className="flex flex-col">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Difference</span>
          <span className={cn('font-mono font-semibold', status === 'unbalanced' ? 'text-red-600 dark:text-red-400' : 'text-slate-500')}>
            {formatMoney(Math.abs(difference))}
          </span>
        </div>
        <span className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 ring-inset', statusStyle)}>
          {status === 'balanced' ? <Check className="h-3.5 w-3.5" /> : status === 'unbalanced' ? <TriangleAlert className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
          {statusLabel}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        {/* Split save button: primary "Save & close" + menu for other flows. */}
        <div className="flex items-stretch">
          <Button
            variant="secondary"
            onClick={onSaveAndClose}
            disabled={saving}
            className="rounded-r-none"
          >
            Save &amp; close
          </Button>
          <Dropdown
            label="More save options"
            panelClassName="w-56"
            trigger={(o) => (
              <span
                className={cn(
                  'flex h-10 items-center rounded-lg rounded-l-none border border-l-0 border-slate-300 bg-slate-100 px-1.5 text-slate-700 transition-colors hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
                  o && 'bg-slate-200 dark:bg-slate-700',
                )}
              >
                <ChevronDown className="h-4 w-4" />
              </span>
            )}
          >
            <MenuItem onClick={onSaveKeepEditing} shortcut="Ctrl S">
              Save draft (keep editing)
            </MenuItem>
            <MenuItem onClick={onSaveAndNew}>Save &amp; new</MenuItem>
          </Dropdown>
        </div>
        <Button onClick={onPost} disabled={saving} title={canPost ? 'Save and post' : 'Click to see what needs fixing before posting'}>
          <Send className="h-4 w-4" /> Post entry
        </Button>
      </div>
    </div>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="font-mono text-base font-semibold text-slate-800 dark:text-slate-100">{formatMoney(value)}</span>
    </div>
  );
}
