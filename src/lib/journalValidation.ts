import { z } from 'zod';
import type { Account, BusinessEntity } from '@/types';
import type { JournalIssue, JournalLine } from '@/types/journal';

/* ────────────────────────────── Money helpers ───────────────────────────── */

/** Round to 2 decimal places, avoiding binary FP drift. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface LineTotals {
  totalDebit: number;
  totalCredit: number;
  difference: number;
}

/** Sum debits & credits across lines; difference is debit − credit. */
export function computeTotals(
  lines: Pick<JournalLine, 'debit' | 'credit'>[],
): LineTotals {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    totalDebit += Number(line.debit) || 0;
    totalCredit += Number(line.credit) || 0;
  }
  totalDebit = roundMoney(totalDebit);
  totalCredit = roundMoney(totalCredit);
  return { totalDebit, totalCredit, difference: roundMoney(totalDebit - totalCredit) };
}

/** True when debits equal credits (within rounding tolerance) and non-zero. */
export function isBalanced(lines: Pick<JournalLine, 'debit' | 'credit'>[]): boolean {
  const { totalDebit, totalCredit } = computeTotals(lines);
  return totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;
}

/** Currency rounding tolerance shared by the balance checks. */
export const BALANCE_TOLERANCE = 0.005;

/** Coerce any form value (number or string) to a finite amount, defaulting 0. */
export function toAmount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

export type BalanceStatus = 'not-started' | 'unbalanced' | 'balanced';

/**
 * Footer balance state. Zero/zero is "not started" (a brand-new entry), NOT
 * "unbalanced" — only a non-zero entry whose sides disagree is unbalanced.
 */
export function balanceStatus(totals: LineTotals, tolerance = BALANCE_TOLERANCE): BalanceStatus {
  if (totals.totalDebit === 0 && totals.totalCredit === 0) return 'not-started';
  return Math.abs(totals.difference) < tolerance ? 'balanced' : 'unbalanced';
}

/** Minimal structural shape needed to decide whether a line is a blank placeholder. */
export interface BlankCheckLine {
  accountId?: string;
  debit?: number | string;
  credit?: number | string;
  memo?: string;
  entityId?: string;
  costCenter?: string;
  project?: string;
  taxCode?: string;
  taxAmount?: number | string;
}

/**
 * A completely blank placeholder row: no account, no amounts, no memo, no
 * dimensions. Blank rows are ignored during normal validation and stripped
 * before saving or posting.
 */
export function isBlankJournalLine(line: BlankCheckLine): boolean {
  return (
    !line.accountId?.trim() &&
    toAmount(line.debit) === 0 &&
    toAmount(line.credit) === 0 &&
    !line.memo?.trim() &&
    !line.entityId?.trim() &&
    !line.costCenter?.trim() &&
    !line.project?.trim() &&
    !line.taxCode?.trim() &&
    toAmount(line.taxAmount) === 0
  );
}

/**
 * Single source of truth for "can this account receive a posting?". A leaf
 * posting account qualifies; header/parent accounts do not. Reused by the
 * account picker filter, the posting validator and the store's post logic so
 * the picker can never offer an account the validator would reject.
 */
export function isPostingAccount(account: Account | undefined): boolean {
  if (!account) return false;
  return account.isPostingAccount === true;
}

/* ─────────────────────────────── Zod schemas ────────────────────────────── */

/**
 * Line schema used by the entry form. Lenient enough to let a user SAVE a
 * work-in-progress draft (empty account, unbalanced totals) while still
 * enforcing hard data-integrity rules: non-negative amounts and never a debit
 * and a credit on the same line.
 */
export const journalLineFormSchema = z
  .object({
    accountId: z.string().trim(),
    accountCode: z.string().trim(),
    accountName: z.string().trim(),
    description: z.string().trim().max(240),
    debit: z.coerce.number().min(0, 'Debit cannot be negative').max(1_000_000_000_000),
    credit: z.coerce.number().min(0, 'Credit cannot be negative').max(1_000_000_000_000),
    entityId: z.string().trim(),
    entityName: z.string().trim().max(200),
    costCenter: z.string().trim().max(60),
    project: z.string().trim().max(60),
    taxCode: z.string().trim().max(30),
    taxAmount: z.coerce.number().min(0, 'Tax cannot be negative').max(1_000_000_000_000),
    memo: z.string().trim().max(240),
  })
  .superRefine((line, ctx) => {
    if (line.debit > 0 && line.credit > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['debit'],
        message: 'A line cannot have both a debit and a credit.',
      });
    }
  });

export type JournalLineFormValues = z.infer<typeof journalLineFormSchema>;

/**
 * Entry (header + lines) schema used by React Hook Form + Zod resolver.
 *
 * Deliberately LENIENT so a work-in-progress DRAFT always saves: description is
 * optional and a single line is allowed. Hard data-integrity rules (non-negative
 * amounts, never a debit and a credit on the same line) still apply per line.
 * The stricter requirements for POSTING — description present, at least two
 * active lines, non-zero balanced totals, valid posting accounts — live in
 * {@link validateJournalForPosting} and are enforced only when the user posts.
 */
export const journalFormSchema = z.object({
  entryNumber: z.string().trim().max(30),
  entryDate: z.string().trim().min(1, 'Entry date is required'),
  reference: z.string().trim().max(60),
  description: z.string().trim().max(240).optional().default(''),
  currency: z.string().trim().min(3, 'Currency is required').max(3),
  exchangeRate: z.coerce
    .number()
    .positive('Exchange rate must be greater than zero')
    .max(1_000_000),
  notes: z.string().trim().max(1000),
  transactionType: z.string().trim().max(60),
  createdBy: z.string().trim().max(120),
  approvedBy: z.string().trim().max(120),
  lines: z.array(journalLineFormSchema).min(1, 'At least one journal line is required'),
});

export type JournalFormValues = z.infer<typeof journalFormSchema>;

/* ─────────────────── Persisted-entry schema (for JSON import) ─────────────── */

const journalLineSchema = z.object({
  id: z.string(),
  journalEntryId: z.string(),
  lineNumber: z.number(),
  accountId: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  description: z.string(),
  debit: z.number(),
  credit: z.number(),
  entityId: z.string(),
  entityName: z.string(),
  costCenter: z.string(),
  project: z.string(),
  taxCode: z.string(),
  taxAmount: z.number(),
  memo: z.string(),
});

export const journalEntrySchema = z.object({
  id: z.string(),
  entryNumber: z.string(),
  entryDate: z.string(),
  reference: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'posted', 'void']),
  // Audit / metadata fields added later — optional so older exports still parse.
  transactionType: z.string().optional().default(''),
  currency: z.string(),
  exchangeRate: z.number(),
  totalDebit: z.number(),
  totalCredit: z.number(),
  difference: z.number(),
  createdBy: z.string(),
  updatedBy: z.string().optional().default(''),
  approvedBy: z.string(),
  postedAt: z.string(),
  postedBy: z.string().optional().default(''),
  voidedAt: z.string().optional().default(''),
  voidedBy: z.string().optional().default(''),
  originalEntryId: z.string().optional().default(''),
  reversalEntryId: z.string().optional().default(''),
  approvalStatus: z
    .enum(['not_required', 'pending_review', 'pending_approval', 'approved', 'rejected'])
    .optional(),
  notes: z.string(),
  reversalReference: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(journalLineSchema).min(1),
});

export const journalEntriesArraySchema = z.array(journalEntrySchema);

/* ─────────────────────── Chart-of-accounts snapshotting ──────────────────── */

/**
 * Resolve the current code / name for an account id. Used to (re)populate the
 * snapshot fields on a journal line when an account is selected, and to refresh
 * DRAFT lines from the live chart. Posted entries are never refreshed.
 */
export function accountSnapshot(
  accountId: string,
  accountsById: Map<string, Account>,
): { accountCode: string; accountName: string } {
  const account = accountsById.get(accountId);
  return {
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '',
  };
}

/* ───────────────────────── Posting & warning rules ───────────────────────── */

/**
 * Minimal shape a line needs to be validated. A full {@link JournalLine}
 * satisfies this structurally, as do the lightweight line objects the form
 * builds live while editing.
 */
export interface ValidatableLine {
  lineNumber: number;
  accountId: string;
  debit: number;
  credit: number;
  taxAmount: number;
  entityId: string;
}

/**
 * Hard errors that BLOCK posting. A draft may be saved with these outstanding
 * (they surface live in the form and on the dashboard), but the entry can never
 * be posted until every one is cleared.
 */
export function getPostingErrors(
  entry: { lines: ValidatableLine[] },
  accountsById: Map<string, Account>,
): JournalIssue[] {
  const issues: JournalIssue[] = [];
  const { lines } = entry;

  if (lines.length < 2) {
    issues.push({
      severity: 'error',
      rule: 'min-lines',
      message: 'A journal entry needs at least two lines.',
      lineNumber: null,
    });
  }

  for (const line of lines) {
    const account = line.accountId ? accountsById.get(line.accountId) : undefined;

    if (!line.accountId) {
      issues.push({
        severity: 'error',
        rule: 'account-required',
        message: `Line ${line.lineNumber}: select a posting account.`,
        lineNumber: line.lineNumber,
      });
    } else if (!account) {
      issues.push({
        severity: 'error',
        rule: 'account-missing',
        message: `Line ${line.lineNumber}: the selected account no longer exists in the chart.`,
        lineNumber: line.lineNumber,
      });
    } else {
      if (!isPostingAccount(account)) {
        issues.push({
          severity: 'error',
          rule: 'header-account',
          message: `Line ${line.lineNumber}: "${account.name}" is a header account and cannot receive postings.`,
          lineNumber: line.lineNumber,
        });
      }
      if (!account.isActive) {
        issues.push({
          severity: 'error',
          rule: 'inactive-account',
          message: `Line ${line.lineNumber}: "${account.name}" is inactive and cannot be posted to.`,
          lineNumber: line.lineNumber,
        });
      }
    }

    if (line.debit < 0 || line.credit < 0 || line.taxAmount < 0) {
      issues.push({
        severity: 'error',
        rule: 'negative-amount',
        message: `Line ${line.lineNumber}: amounts cannot be negative.`,
        lineNumber: line.lineNumber,
      });
    }
    if (line.debit > 0 && line.credit > 0) {
      issues.push({
        severity: 'error',
        rule: 'debit-and-credit',
        message: `Line ${line.lineNumber}: a line cannot have both a debit and a credit.`,
        lineNumber: line.lineNumber,
      });
    }
    if ((Number(line.debit) || 0) === 0 && (Number(line.credit) || 0) === 0) {
      issues.push({
        severity: 'error',
        rule: 'zero-amount',
        message: `Line ${line.lineNumber}: enter either a debit or a credit amount.`,
        lineNumber: line.lineNumber,
      });
    }
  }

  const { totalDebit, totalCredit, difference } = computeTotals(lines);
  if (Math.abs(difference) >= 0.005) {
    issues.push({
      severity: 'error',
      rule: 'unbalanced',
      message: `Entry is out of balance by ${roundMoney(difference).toFixed(2)} (debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}).`,
      lineNumber: null,
    });
  } else if (totalDebit === 0) {
    issues.push({
      severity: 'error',
      rule: 'no-amounts',
      message: 'Entry has no debit or credit amounts.',
      lineNumber: null,
    });
  }

  return issues;
}

/**
 * Soft warnings that DO NOT block saving or posting but should be shown to the
 * user: a line that moves an account against its normal balance, or a line
 * that references an inactive entity.
 */
export function getWarnings(
  entry: { lines: ValidatableLine[] },
  accountsById: Map<string, Account>,
  entitiesById: Map<string, BusinessEntity>,
): JournalIssue[] {
  const warnings: JournalIssue[] = [];

  for (const line of entry.lines) {
    const account = line.accountId ? accountsById.get(line.accountId) : undefined;
    if (account) {
      // Assets & expenses normally increase with debits; liabilities, equity
      // and income normally increase with credits. A movement against the
      // account's normal balance is unusual (but legitimate for e.g. refunds).
      if (line.debit > 0 && account.normalBalance === 'CREDIT') {
        warnings.push({
          severity: 'warning',
          rule: 'unusual-debit',
          message: `Line ${line.lineNumber}: debiting "${account.name}" is unusual — it normally increases with credits.`,
          lineNumber: line.lineNumber,
        });
      }
      if (line.credit > 0 && account.normalBalance === 'DEBIT') {
        warnings.push({
          severity: 'warning',
          rule: 'unusual-credit',
          message: `Line ${line.lineNumber}: crediting "${account.name}" is unusual — it normally increases with debits.`,
          lineNumber: line.lineNumber,
        });
      }
    }

    if (line.entityId) {
      const entity = entitiesById.get(line.entityId);
      if (entity && !entity.isActive) {
        warnings.push({
          severity: 'warning',
          rule: 'inactive-entity',
          message: `Line ${line.lineNumber}: "${entity.legalName}" is inactive.`,
          lineNumber: line.lineNumber,
        });
      }
    }
  }

  return warnings;
}

/** Convenience: can this entry be posted right now? */
export function canPost(
  entry: { lines: ValidatableLine[] },
  accountsById: Map<string, Account>,
): boolean {
  return getPostingErrors(entry, accountsById).length === 0;
}

/* ─────────────────────── Draft vs. posting validators ────────────────────── */

/** A form line as edited (amounts may still be strings before coercion). */
export interface FormLikeLine extends BlankCheckLine {
  debit?: number | string;
  credit?: number | string;
  taxAmount?: number | string;
}
export interface FormLikeValues {
  description?: string;
  entryDate?: string;
  lines: FormLikeLine[];
}

function toValidatable(line: FormLikeLine, lineNumber: number): ValidatableLine {
  return {
    lineNumber,
    accountId: line.accountId?.trim() ?? '',
    debit: toAmount(line.debit),
    credit: toAmount(line.credit),
    taxAmount: toAmount(line.taxAmount),
    entityId: line.entityId?.trim() ?? '',
  };
}

/** Active (non-blank) lines, keeping their original 1-based row number. */
export function activeLines(lines: FormLikeLine[]): ValidatableLine[] {
  return lines
    .map((line, i) => ({ line, lineNumber: i + 1 }))
    .filter((x) => !isBlankJournalLine(x.line))
    .map((x) => toValidatable(x.line, x.lineNumber));
}

/**
 * DRAFT validation. A draft may be missing accounts, amounts, be unbalanced or
 * have fewer than two lines. Only hard data-integrity rules are enforced, and
 * only on active (non-blank) lines: no negative amounts, and never a debit and
 * a credit on the same line. Blank placeholder rows are ignored.
 */
export function validateJournalDraft(values: FormLikeValues): JournalIssue[] {
  const issues: JournalIssue[] = [];
  for (const line of activeLines(values.lines)) {
    if (line.debit < 0 || line.credit < 0 || line.taxAmount < 0) {
      issues.push({ severity: 'error', rule: 'negative-amount', message: `Line ${line.lineNumber}: amounts cannot be negative.`, lineNumber: line.lineNumber });
    }
    if (line.debit > 0 && line.credit > 0) {
      issues.push({ severity: 'error', rule: 'debit-and-credit', message: `Line ${line.lineNumber}: a line cannot have both a debit and a credit.`, lineNumber: line.lineNumber });
    }
  }
  return issues;
}

/**
 * POSTING validation. Blank placeholder rows are removed first; the entry then
 * needs a description, at least two active lines, non-zero balanced totals and
 * valid posting accounts. Line numbers refer to the original visible rows.
 */
export function validateJournalForPosting(
  values: FormLikeValues,
  accountsById: Map<string, Account>,
): JournalIssue[] {
  const issues: JournalIssue[] = [];
  if (!values.description?.trim()) {
    issues.push({ severity: 'error', rule: 'description-required', message: 'Enter a description / narration.', lineNumber: null });
  }
  if (!values.entryDate?.trim()) {
    issues.push({ severity: 'error', rule: 'date-required', message: 'Entry date is required.', lineNumber: null });
  }
  issues.push(...getPostingErrors({ lines: activeLines(values.lines) }, accountsById));
  return issues;
}
