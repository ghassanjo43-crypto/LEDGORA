import type { AccountType } from '@/types';
import type { BadgeTone } from '@/data/ifrsOptions';

/**
 * Colour coding for account families — a fast visual cue used in the journal
 * grid, pickers and hover cards. Follows the common accounting convention:
 * assets green, liabilities red, equity violet, revenue blue, expenses amber.
 *
 * `dot` is a solid background class for the small indicator; `tone` maps to the
 * shared {@link BadgeTone} palette for chips.
 */
export interface AccountColor {
  /** Short family label, e.g. "Asset", "Revenue", "Expense". */
  family: string;
  /** Tailwind background class for the indicator dot. */
  dot: string;
  /** Shared badge tone for the family chip. */
  tone: BadgeTone;
}

export const ACCOUNT_COLOR: Record<AccountType, AccountColor> = {
  ASSET: { family: 'Asset', dot: 'bg-emerald-500', tone: 'green' },
  LIABILITY: { family: 'Liability', dot: 'bg-red-500', tone: 'red' },
  EQUITY: { family: 'Equity', dot: 'bg-violet-500', tone: 'violet' },
  INCOME: { family: 'Revenue', dot: 'bg-blue-500', tone: 'blue' },
  COST_OF_SALES: { family: 'Cost of sales', dot: 'bg-amber-500', tone: 'amber' },
  OPERATING_EXPENSE: { family: 'Expense', dot: 'bg-orange-500', tone: 'amber' },
  OTHER_INCOME_EXPENSE: { family: 'Other', dot: 'bg-teal-500', tone: 'teal' },
  FINANCE: { family: 'Finance', dot: 'bg-cyan-500', tone: 'cyan' },
  TAX: { family: 'Tax', dot: 'bg-indigo-500', tone: 'indigo' },
  DISCONTINUED_OPERATIONS: { family: 'Discontinued', dot: 'bg-slate-400', tone: 'slate' },
  OCI: { family: 'OCI', dot: 'bg-teal-500', tone: 'teal' },
  CONTROL: { family: 'Control', dot: 'bg-slate-400', tone: 'slate' },
};

/** Resolve colour info for a type, falling back to a neutral scheme. */
export function accountColor(type: AccountType | undefined): AccountColor {
  return type ? ACCOUNT_COLOR[type] : { family: 'Account', dot: 'bg-slate-300', tone: 'slate' };
}
