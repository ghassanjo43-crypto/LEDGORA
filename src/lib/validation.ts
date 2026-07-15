import { z } from 'zod';
import type {
  Account,
  AccountType,
  ValidationIssue,
} from '@/types';
import { ACCOUNT_TYPE_META } from '@/data/ifrsOptions';
import { generateId } from './utils';

/* ────────────────────────────── Zod schemas ────────────────────────────── */

export const accountTypeEnum = z.enum([
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'INCOME',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_INCOME_EXPENSE',
  'FINANCE',
  'TAX',
  'DISCONTINUED_OPERATIONS',
  'OCI',
  'CONTROL',
]);

export const ifrsStatementEnum = z.enum([
  'STATEMENT_OF_FINANCIAL_POSITION',
  'PROFIT_OR_LOSS',
  'OCI',
  'STATEMENT_OF_CHANGES_IN_EQUITY',
  'CASH_FLOW',
  'NOTES',
  'CONTROL',
]);

export const normalBalanceEnum = z.enum(['DEBIT', 'CREDIT']);

export const cashFlowEnum = z.enum([
  'OPERATING',
  'INVESTING',
  'FINANCING',
  'NON_CASH',
  'NOT_APPLICABLE',
]);

export const profitOrLossEnum = z.enum([
  'OPERATING',
  'INVESTING',
  'FINANCING',
  'INCOME_TAXES',
  'DISCONTINUED_OPERATIONS',
  'NOT_APPLICABLE',
]);

/** Schema used by the create/edit form (React Hook Form + Zod resolver). */
export const accountFormSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{3,6}$/u, 'Code must be 3–6 digits'),
    name: z.string().trim().min(2, 'Name is required').max(120),
    type: accountTypeEnum,
    parentId: z.string().nullable(),
    normalBalance: normalBalanceEnum,
    ifrsStatement: ifrsStatementEnum,
    ifrsCategory: z.string().trim().min(1, 'IFRS category is required').max(120),
    ifrsSubcategory: z.string().trim().max(120),
    cashFlowCategory: cashFlowEnum,
    profitOrLossCategory: profitOrLossEnum.optional(),
    isPostingAccount: z.boolean(),
    isActive: z.boolean(),
    description: z.string().trim().max(500),
    industryTag: z.string().trim().max(60),
  })
  .superRefine((val, ctx) => {
    // Account type must match the leading digit of the code range.
    const [min, max] = ACCOUNT_TYPE_META[val.type].codeRange;
    const numeric = Number(val.code);
    if (!Number.isNaN(numeric) && (numeric < min || numeric > max)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: `Code for ${ACCOUNT_TYPE_META[val.type].label} should be within ${min}–${max}`,
      });
    }
  });

export type AccountFormValues = z.infer<typeof accountFormSchema>;

/** Schema for a persisted account (used to validate imported JSON). */
export const accountSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  type: accountTypeEnum,
  parentId: z.string().nullable(),
  level: z.number().int().min(0),
  normalBalance: normalBalanceEnum,
  ifrsStatement: ifrsStatementEnum,
  ifrsCategory: z.string(),
  ifrsSubcategory: z.string(),
  cashFlowCategory: cashFlowEnum,
  profitOrLossCategory: profitOrLossEnum.optional(),
  isPostingAccount: z.boolean(),
  isActive: z.boolean(),
  description: z.string(),
  industryTag: z.string(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const accountsArraySchema = z.array(accountSchema);

/* ────────────────────────── Cross-account rules ─────────────────────────── */

/** Does the numeric code fall within the type's allowed range? */
export function codeMatchesType(code: string, type: AccountType): boolean {
  const [min, max] = ACCOUNT_TYPE_META[type].codeRange;
  const numeric = Number(code);
  if (Number.isNaN(numeric)) return false;
  return numeric >= min && numeric <= max;
}

/** Expected normal balance given the account type. */
export function expectedNormalBalance(type: AccountType): 'DEBIT' | 'CREDIT' {
  return ACCOUNT_TYPE_META[type].defaultNormalBalance;
}

function isCashRelated(account: Account): boolean {
  const hay = `${account.name} ${account.ifrsSubcategory}`.toLowerCase();
  return (
    hay.includes('cash') ||
    hay.includes('bank') ||
    account.ifrsSubcategory.toLowerCase().includes('cash and cash equivalents')
  );
}

/**
 * Validate the whole chart of accounts and return a flat list of issues.
 * This is the single source of truth for the Validation Panel and Dashboard.
 */
export function validateChart(accounts: Account[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const codeCounts = new Map<string, Account[]>();
  const childrenByParent = new Map<string, Account[]>();

  for (const acc of accounts) {
    const list = codeCounts.get(acc.code) ?? [];
    list.push(acc);
    codeCounts.set(acc.code, list);

    if (acc.parentId) {
      const kids = childrenByParent.get(acc.parentId) ?? [];
      kids.push(acc);
      childrenByParent.set(acc.parentId, kids);
    }
  }

  const push = (
    account: Account | null,
    severity: ValidationIssue['severity'],
    rule: string,
    message: string,
  ): void => {
    issues.push({
      id: generateId('iss'),
      accountId: account?.id ?? null,
      accountCode: account?.code ?? null,
      severity,
      rule,
      message,
    });
  };

  // Rule: unique account codes.
  for (const [code, list] of codeCounts) {
    if (list.length > 1) {
      for (const acc of list) {
        push(acc, 'error', 'unique-code', `Duplicate account code "${code}" (used ${list.length} times).`);
      }
    }
  }

  for (const acc of accounts) {
    const children = childrenByParent.get(acc.id) ?? [];

    // Rule: parent must exist.
    if (acc.parentId && !byId.has(acc.parentId)) {
      push(acc, 'error', 'parent-exists', `Parent account "${acc.parentId}" does not exist.`);
    }

    // Rule: no self-parenting.
    if (acc.parentId === acc.id) {
      push(acc, 'error', 'no-self-parent', 'Account cannot be its own parent.');
    }

    // Rule: posting accounts cannot have children.
    if (acc.isPostingAccount && children.length > 0) {
      push(acc, 'error', 'posting-no-children', `Posting account "${acc.name}" has ${children.length} child account(s). Convert it to a header or move the children.`);
    }

    // Rule: header accounts cannot receive postings (must be non-posting).
    // Encoded as: a non-posting header with no children is likely incomplete.
    if (!acc.isPostingAccount && children.length === 0) {
      push(acc, 'warning', 'empty-header', `Header account "${acc.name}" has no child accounts. Add children or mark it as a posting account.`);
    }

    // Rule: account type must match code range.
    if (!codeMatchesType(acc.code, acc.type)) {
      const [min, max] = ACCOUNT_TYPE_META[acc.type].codeRange;
      push(acc, 'error', 'code-range', `Code "${acc.code}" is outside the ${min}–${max} range expected for ${ACCOUNT_TYPE_META[acc.type].label}.`);
    }

    // Rule: normal balance convention (warning — contra accounts legitimately differ).
    if (acc.normalBalance !== expectedNormalBalance(acc.type)) {
      push(acc, 'warning', 'normal-balance', `"${acc.name}" has a ${acc.normalBalance.toLowerCase()} balance, but ${ACCOUNT_TYPE_META[acc.type].label} normally carry a ${expectedNormalBalance(acc.type).toLowerCase()} balance (acceptable for contra accounts).`);
    }

    // Rule: IFRS statement mapping required (schema guarantees a value, but flag CONTROL misuse).
    if (!acc.ifrsStatement) {
      push(acc, 'error', 'statement-required', 'IFRS statement mapping is required.');
    }

    // Rule: cash-related accounts must declare a cash flow category.
    if (isCashRelated(acc) && acc.isPostingAccount && acc.cashFlowCategory === 'NOT_APPLICABLE') {
      push(acc, 'warning', 'cashflow-required', `Cash-related account "${acc.name}" should have a statement of cash flows category.`);
    }

    // Rule: IFRS 18 P&L accounts should carry a profit-or-loss category.
    const isPnl = acc.ifrsStatement === 'PROFIT_OR_LOSS' && acc.isPostingAccount;
    if (isPnl && (!acc.profitOrLossCategory || acc.profitOrLossCategory === 'NOT_APPLICABLE')) {
      push(acc, 'warning', 'pnl-category', `P&L account "${acc.name}" has no IFRS 18 profit-or-loss category assigned.`);
    }
  }

  // Stable ordering: errors first, then by code.
  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return (a.accountCode ?? '').localeCompare(b.accountCode ?? '');
  });
}
