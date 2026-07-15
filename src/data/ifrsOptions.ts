import type {
  AccountType,
  CashFlowCategory,
  IFRSStatement,
  NormalBalance,
  ProfitOrLossCategory,
} from '@/types';

export interface Option<T extends string> {
  value: T;
  label: string;
}

/** Metadata describing each account type. */
export interface AccountTypeMeta {
  type: AccountType;
  label: string;
  /** Inclusive top-level code range. */
  codeRange: [number, number];
  defaultNormalBalance: NormalBalance;
  defaultStatement: IFRSStatement;
  /** Short accent colour name used for badges. */
  accent: BadgeTone;
}

export type BadgeTone =
  | 'blue'
  | 'amber'
  | 'violet'
  | 'green'
  | 'red'
  | 'teal'
  | 'slate'
  | 'indigo'
  | 'rose'
  | 'cyan';

export const ACCOUNT_TYPE_META: Record<AccountType, AccountTypeMeta> = {
  ASSET: {
    type: 'ASSET',
    label: 'Assets',
    codeRange: [1000, 1999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'STATEMENT_OF_FINANCIAL_POSITION',
    accent: 'blue',
  },
  LIABILITY: {
    type: 'LIABILITY',
    label: 'Liabilities',
    codeRange: [2000, 2999],
    defaultNormalBalance: 'CREDIT',
    defaultStatement: 'STATEMENT_OF_FINANCIAL_POSITION',
    accent: 'amber',
  },
  EQUITY: {
    type: 'EQUITY',
    label: 'Equity',
    codeRange: [3000, 3999],
    defaultNormalBalance: 'CREDIT',
    defaultStatement: 'STATEMENT_OF_CHANGES_IN_EQUITY',
    accent: 'violet',
  },
  INCOME: {
    type: 'INCOME',
    label: 'Revenue / Income',
    codeRange: [4000, 4999],
    defaultNormalBalance: 'CREDIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'green',
  },
  COST_OF_SALES: {
    type: 'COST_OF_SALES',
    label: 'Cost of Sales / Direct Costs',
    codeRange: [5000, 5999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'red',
  },
  OPERATING_EXPENSE: {
    type: 'OPERATING_EXPENSE',
    label: 'Operating Expenses',
    codeRange: [6000, 6999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'rose',
  },
  OTHER_INCOME_EXPENSE: {
    type: 'OTHER_INCOME_EXPENSE',
    label: 'Other Income / Expenses',
    codeRange: [7000, 7999],
    defaultNormalBalance: 'CREDIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'teal',
  },
  FINANCE: {
    type: 'FINANCE',
    label: 'Finance Income / Costs',
    codeRange: [7000, 7999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'cyan',
  },
  TAX: {
    type: 'TAX',
    label: 'Taxation',
    codeRange: [8000, 8999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'indigo',
  },
  DISCONTINUED_OPERATIONS: {
    type: 'DISCONTINUED_OPERATIONS',
    label: 'Discontinued Operations',
    codeRange: [8000, 8999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'PROFIT_OR_LOSS',
    accent: 'slate',
  },
  OCI: {
    type: 'OCI',
    label: 'Other Comprehensive Income',
    codeRange: [8000, 8999],
    defaultNormalBalance: 'CREDIT',
    defaultStatement: 'OCI',
    accent: 'teal',
  },
  CONTROL: {
    type: 'CONTROL',
    label: 'Control / Suspense',
    codeRange: [9000, 9999],
    defaultNormalBalance: 'DEBIT',
    defaultStatement: 'CONTROL',
    accent: 'slate',
  },
};

export const ACCOUNT_TYPE_OPTIONS: Option<AccountType>[] = (
  Object.keys(ACCOUNT_TYPE_META) as AccountType[]
).map((t) => ({ value: t, label: ACCOUNT_TYPE_META[t].label }));

export const IFRS_STATEMENT_META: Record<
  IFRSStatement,
  { label: string; short: string; tone: BadgeTone }
> = {
  STATEMENT_OF_FINANCIAL_POSITION: {
    label: 'Statement of Financial Position',
    short: 'SoFP',
    tone: 'blue',
  },
  PROFIT_OR_LOSS: { label: 'Profit or Loss', short: 'P&L', tone: 'green' },
  OCI: { label: 'Other Comprehensive Income', short: 'OCI', tone: 'teal' },
  STATEMENT_OF_CHANGES_IN_EQUITY: {
    label: 'Statement of Changes in Equity',
    short: 'SoCE',
    tone: 'violet',
  },
  CASH_FLOW: { label: 'Statement of Cash Flows', short: 'Cash Flow', tone: 'cyan' },
  NOTES: { label: 'Notes to the Financial Statements', short: 'Notes', tone: 'slate' },
  CONTROL: { label: 'Control / System', short: 'Control', tone: 'slate' },
};

export const IFRS_STATEMENT_OPTIONS: Option<IFRSStatement>[] = (
  Object.keys(IFRS_STATEMENT_META) as IFRSStatement[]
).map((s) => ({ value: s, label: IFRS_STATEMENT_META[s].label }));

export const NORMAL_BALANCE_OPTIONS: Option<NormalBalance>[] = [
  { value: 'DEBIT', label: 'Debit' },
  { value: 'CREDIT', label: 'Credit' },
];

export const CASH_FLOW_OPTIONS: Option<CashFlowCategory>[] = [
  { value: 'OPERATING', label: 'Operating' },
  { value: 'INVESTING', label: 'Investing' },
  { value: 'FINANCING', label: 'Financing' },
  { value: 'NON_CASH', label: 'Non-cash' },
  { value: 'NOT_APPLICABLE', label: 'Not applicable' },
];

export const PROFIT_OR_LOSS_CATEGORY_OPTIONS: Option<ProfitOrLossCategory>[] = [
  { value: 'OPERATING', label: 'Operating' },
  { value: 'INVESTING', label: 'Investing' },
  { value: 'FINANCING', label: 'Financing' },
  { value: 'INCOME_TAXES', label: 'Income taxes' },
  { value: 'DISCONTINUED_OPERATIONS', label: 'Discontinued operations' },
  { value: 'NOT_APPLICABLE', label: 'Not applicable' },
];

/**
 * Suggested IFRS categories & subcategories per account type. Used to populate
 * dropdowns in the form; the user can still type a custom value.
 */
export const IFRS_CATEGORY_SUGGESTIONS: Record<AccountType, string[]> = {
  ASSET: ['Non-current assets', 'Current assets'],
  LIABILITY: ['Non-current liabilities', 'Current liabilities'],
  EQUITY: ['Equity attributable to owners', 'Non-controlling interests'],
  INCOME: ['Revenue', 'Other operating income'],
  COST_OF_SALES: ['Cost of sales', 'Direct costs'],
  OPERATING_EXPENSE: ['Administrative expenses', 'Distribution expenses', 'Other operating expenses'],
  OTHER_INCOME_EXPENSE: ['Other income', 'Other expenses'],
  FINANCE: ['Finance income', 'Finance costs'],
  TAX: ['Income tax', 'Deferred tax'],
  DISCONTINUED_OPERATIONS: ['Discontinued operations'],
  OCI: [
    'Items that will not be reclassified to P&L',
    'Items that may be reclassified to P&L',
  ],
  CONTROL: ['Control accounts', 'Suspense & clearing'],
};

export const INDUSTRY_OPTIONS: Option<string>[] = [
  { value: 'general', label: 'General / Cross-industry' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'retail', label: 'Retail & Wholesale' },
  { value: 'construction', label: 'Construction & Contracting' },
  { value: 'services', label: 'Professional Services' },
  { value: 'technology', label: 'Technology / SaaS' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'financial_services', label: 'Financial Services' },
];

export const CURRENCY_OPTIONS: Option<string>[] = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'SAR', label: 'SAR — Saudi Riyal' },
  { value: 'JOD', label: 'JOD — Jordanian Dinar' },
  { value: 'EGP', label: 'EGP — Egyptian Pound' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'INR', label: 'INR — Indian Rupee' },
];

/* ───────────────────────────── Company setup ────────────────────────────── */

export const ORGANIZATION_TYPE_OPTIONS: Option<string>[] = [
  { value: 'LLC', label: 'Limited Liability Company (LLC)' },
  { value: 'SOLE_PROPRIETOR', label: 'Sole Proprietorship' },
  { value: 'PARTNERSHIP', label: 'Partnership' },
  { value: 'PRIVATE_LTD', label: 'Private Limited Company' },
  { value: 'PUBLIC_LTD', label: 'Public / Joint-Stock Company' },
  { value: 'FREE_ZONE', label: 'Free Zone Establishment' },
  { value: 'BRANCH', label: 'Branch of a Foreign Company' },
  { value: 'NON_PROFIT', label: 'Non-profit / NGO' },
  { value: 'OTHER', label: 'Other' },
];

export const ACCOUNTING_BASIS_OPTIONS: Option<'accrual' | 'cash'>[] = [
  { value: 'accrual', label: 'Accrual basis' },
  { value: 'cash', label: 'Cash basis' },
];

export const REPORTING_FRAMEWORK_OPTIONS: Option<
  'IFRS' | 'IFRS_FOR_SMES' | 'US_GAAP' | 'OTHER'
>[] = [
  { value: 'IFRS', label: 'IFRS (full)' },
  { value: 'IFRS_FOR_SMES', label: 'IFRS for SMEs' },
  { value: 'US_GAAP', label: 'US GAAP' },
  { value: 'OTHER', label: 'Other / Local GAAP' },
];

export function accountTypeLabel(type: AccountType): string {
  return ACCOUNT_TYPE_META[type].label;
}

export function statementLabel(statement: IFRSStatement): string {
  return IFRS_STATEMENT_META[statement].label;
}
