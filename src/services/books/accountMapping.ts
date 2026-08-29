/**
 * Translating between the server's account and the chart of accounts' account.
 *
 * ══ Why two account types exist at all ═══════════════════════════════════════
 *
 * The ledger has FIVE account types, because double-entry has five. The chart
 * of accounts screen has TWELVE presentation classes, because IFRS presentation
 * distinguishes cost of sales from operating expense from finance cost from tax
 * — all four of which are `expense` to a ledger.
 *
 * Mapping twelve onto five is easy and lossy. Mapping back is the problem: an
 * account created as a finance cost would return as a plain expense, and a
 * chart that changes shape every time it is reloaded is not authoritative
 * wherever it is stored. So BOTH travel. `accountType` drives every statement;
 * `presentationType` is carried alongside and is what the screen reads back.
 *
 * The derivation is one-way and used only when the server row has no
 * presentation recorded — an account created through the API by another
 * caller, or one written before this column existed. Then the ledger type is
 * the honest best answer, and it is not a guess dressed up as data.
 */
import type { Account, AccountType, CashFlowCategory, IFRSStatement, NormalBalance, ProfitOrLossCategory } from '@/types';
import type { AccountFormValues } from '@/lib/validation';
import { ACCOUNT_TYPE_META } from '@/data/ifrsOptions';
import type { ServerAccount, ServerAccountInput, ServerAccountType } from '@/services/api/accountingApi';

/** Which of the ledger's five types a presentation class posts as. */
const LEDGER_TYPE: Record<AccountType, ServerAccountType> = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  INCOME: 'income',
  COST_OF_SALES: 'expense',
  OPERATING_EXPENSE: 'expense',
  FINANCE: 'expense',
  TAX: 'expense',
  /*
   * These three can fall either side, and the ledger has to pick one.
   *
   * `OTHER_INCOME_EXPENSE` and `OCI` are recorded as income because their
   * normal balance is a credit and an account whose ledger type contradicts its
   * normal balance produces a sign error in every statement. A debit-balance
   * account of either kind still posts correctly — it simply carries a debit
   * against an income-type account, which is what a loss IS.
   *
   * `CONTROL` is a bookkeeping device rather than a statement line; `asset` is
   * the conventional home and keeps its balance on the debit side.
   */
  OTHER_INCOME_EXPENSE: 'income',
  OCI: 'income',
  DISCONTINUED_OPERATIONS: 'income',
  CONTROL: 'asset',
};

/** The presentation class to assume when the server row records none. */
const PRESENTATION_FALLBACK: Record<ServerAccountType, AccountType> = {
  asset: 'ASSET',
  liability: 'LIABILITY',
  equity: 'EQUITY',
  income: 'INCOME',
  expense: 'OPERATING_EXPENSE',
};

const KNOWN_PRESENTATION = new Set(Object.keys(LEDGER_TYPE));

export function ledgerTypeFor(type: AccountType): ServerAccountType {
  return LEDGER_TYPE[type];
}

/**
 * The chart of accounts' view of a server account.
 *
 * `level` is left at 0: it is derived from the tree by `recomputeLevels`, which
 * the caller runs once over the whole chart rather than per account. Computing
 * it here would need every other account anyway.
 */
export function toAccount(server: ServerAccount): Account {
  const presentation = KNOWN_PRESENTATION.has(server.presentationType)
    ? (server.presentationType as AccountType)
    : PRESENTATION_FALLBACK[server.accountType];

  const meta = ACCOUNT_TYPE_META[presentation];
  const ifrsStatement = (server.ifrsStatement || meta.defaultStatement) as IFRSStatement;
  const profitOrLoss = (server.profitOrLossCategory || 'NOT_APPLICABLE') as ProfitOrLossCategory;

  return {
    id: server.id,
    code: server.accountCode,
    name: server.accountName,
    type: presentation,
    parentId: server.parentAccountId,
    level: 0,
    normalBalance: server.normalBalance.toUpperCase() as NormalBalance,
    ifrsStatement,
    ifrsCategory: server.ifrsCategory,
    ifrsSubcategory: server.ifrsSubcategory,
    cashFlowCategory: (server.cashFlowCategory || 'NOT_APPLICABLE') as CashFlowCategory,
    cashClassification: server.cashClassification,
    isPostingAccount: server.isPostable,
    isActive: server.active,
    isBlocked: server.blocked,
    isArchived: server.archived,
    description: server.description,
    industryTag: server.industryTag || 'general',
    sortOrder: server.sortOrder,
    /*
     * The server does not return these, and inventing a plausible timestamp
     * would be worse than an empty one: a date that looks real and is not is
     * the kind of field somebody eventually reports on.
     */
    createdAt: '',
    updatedAt: '',
    ...(ifrsStatement === 'PROFIT_OR_LOSS' ? { profitOrLossCategory: profitOrLoss } : {}),
  };
}

/**
 * A form submission as the server wants it.
 *
 * Both classifications are sent. `cashClassification` is passed through
 * untouched — including a value this build does not recognise, so the SERVER
 * refuses it rather than the browser silently dropping it to `none` and storing
 * an account that is quietly not cash.
 */
export function toServerAccountInput(
  values: AccountFormValues,
  options: { parentId?: string | null; cashClassification?: string; sortOrder?: number } = {},
): ServerAccountInput {
  const input: ServerAccountInput = {
    accountCode: values.code.trim(),
    accountName: values.name.trim(),
    accountType: ledgerTypeFor(values.type),
    normalBalance: values.normalBalance.toLowerCase() as 'debit' | 'credit',
    presentationType: values.type,
    ifrsStatement: values.ifrsStatement,
    ifrsCategory: values.ifrsCategory.trim(),
    ifrsSubcategory: values.ifrsSubcategory.trim(),
    cashFlowCategory: values.cashFlowCategory,
    profitOrLossCategory:
      values.ifrsStatement === 'PROFIT_OR_LOSS'
        ? values.profitOrLossCategory ?? 'NOT_APPLICABLE'
        : 'NOT_APPLICABLE',
    description: values.description.trim(),
    industryTag: values.industryTag.trim() || 'general',
    isPostable: values.isPostingAccount,
    active: values.isActive,
  };
  if (options.parentId !== undefined) input.parentAccountId = options.parentId;
  if (options.cashClassification !== undefined) input.cashClassification = options.cashClassification;
  if (options.sortOrder !== undefined) input.sortOrder = options.sortOrder;
  return input;
}
