import type {
  Account,
  AccountType,
  CashFlowCategory,
  IFRSStatement,
  NormalBalance,
  ProfitOrLossCategory,
} from '@/types';
import { ACCOUNT_TYPE_META } from './ifrsOptions';

/**
 * Compact seed specification. The full Account objects (ids, levels, parent ids,
 * timestamps, sort order) are derived from this tree by {@link buildSeedAccounts}.
 *
 * IMPORTANT: these codes are INTERNAL management codes aligned with IFRS
 * presentation principles — they are not official IFRS codes.
 */
interface SeedSpec {
  code: string;
  name: string;
  type: AccountType;
  /** Leaf accounts that can receive postings. Headers group and roll up. */
  posting: boolean;
  category: string;
  subcategory?: string;
  cashFlow?: CashFlowCategory;
  normalBalance?: NormalBalance;
  statement?: IFRSStatement;
  pnl?: ProfitOrLossCategory;
  description?: string;
  children?: SeedSpec[];
}

const tree: SeedSpec[] = [
  // ────────────────────────────── ASSETS 1000 ──────────────────────────────
  {
    code: '1000',
    name: 'Assets',
    type: 'ASSET',
    posting: false,
    category: 'Assets',
    children: [
      {
        code: '1100',
        name: 'Non-current assets',
        type: 'ASSET',
        posting: false,
        category: 'Non-current assets',
        children: [
          {
            code: '1110',
            name: 'Property, plant and equipment',
            type: 'ASSET',
            posting: false,
            category: 'Non-current assets',
            subcategory: 'Property, plant and equipment',
            cashFlow: 'INVESTING',
            children: [
              { code: '1111', name: 'Land and buildings', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Property, plant and equipment', cashFlow: 'INVESTING' },
              { code: '1112', name: 'Plant and machinery', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Property, plant and equipment', cashFlow: 'INVESTING' },
              { code: '1113', name: 'Motor vehicles', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Property, plant and equipment', cashFlow: 'INVESTING' },
              { code: '1114', name: 'Furniture, fixtures and equipment', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Property, plant and equipment', cashFlow: 'INVESTING' },
              { code: '1119', name: 'Accumulated depreciation — PP&E', type: 'ASSET', posting: true, normalBalance: 'CREDIT', category: 'Non-current assets', subcategory: 'Property, plant and equipment', cashFlow: 'NON_CASH', description: 'Contra-asset accumulating depreciation.' },
            ],
          },
          { code: '1120', name: 'Right-of-use assets', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Right-of-use assets', cashFlow: 'INVESTING', description: 'IFRS 16 lease right-of-use assets.' },
          { code: '1130', name: 'Investment property', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Investment property', cashFlow: 'INVESTING' },
          {
            code: '1140',
            name: 'Intangible assets',
            type: 'ASSET',
            posting: false,
            category: 'Non-current assets',
            subcategory: 'Intangible assets',
            cashFlow: 'INVESTING',
            children: [
              { code: '1141', name: 'Software and licences', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Intangible assets', cashFlow: 'INVESTING' },
              { code: '1142', name: 'Patents and trademarks', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Intangible assets', cashFlow: 'INVESTING' },
              { code: '1149', name: 'Accumulated amortisation — intangibles', type: 'ASSET', posting: true, normalBalance: 'CREDIT', category: 'Non-current assets', subcategory: 'Intangible assets', cashFlow: 'NON_CASH' },
            ],
          },
          { code: '1150', name: 'Goodwill', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Goodwill', cashFlow: 'INVESTING' },
          { code: '1160', name: 'Investments in associates and joint ventures', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Equity-accounted investees', cashFlow: 'INVESTING' },
          { code: '1170', name: 'Deferred tax assets', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Deferred tax assets', cashFlow: 'NON_CASH' },
          { code: '1190', name: 'Other non-current assets', type: 'ASSET', posting: true, category: 'Non-current assets', subcategory: 'Other non-current assets', cashFlow: 'INVESTING' },
        ],
      },
      {
        code: '1200',
        name: 'Current assets',
        type: 'ASSET',
        posting: false,
        category: 'Current assets',
        children: [
          {
            code: '1210',
            name: 'Inventories',
            type: 'ASSET',
            posting: false,
            category: 'Current assets',
            subcategory: 'Inventories',
            cashFlow: 'OPERATING',
            children: [
              { code: '1211', name: 'Raw materials', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Inventories', cashFlow: 'OPERATING' },
              { code: '1212', name: 'Work in progress', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Inventories', cashFlow: 'OPERATING' },
              { code: '1213', name: 'Finished goods', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Inventories', cashFlow: 'OPERATING' },
              { code: '1219', name: 'Provision for inventory obsolescence', type: 'ASSET', posting: true, normalBalance: 'CREDIT', category: 'Current assets', subcategory: 'Inventories', cashFlow: 'NON_CASH' },
            ],
          },
          {
            code: '1220',
            name: 'Trade and other receivables',
            type: 'ASSET',
            posting: false,
            category: 'Current assets',
            subcategory: 'Trade receivables',
            cashFlow: 'OPERATING',
            children: [
              { code: '1221', name: 'Trade receivables', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Trade receivables', cashFlow: 'OPERATING' },
              { code: '1222', name: 'Allowance for expected credit losses', type: 'ASSET', posting: true, normalBalance: 'CREDIT', category: 'Current assets', subcategory: 'Trade receivables', cashFlow: 'NON_CASH', description: 'IFRS 9 ECL contra-receivable.' },
              { code: '1223', name: 'Other receivables', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Other receivables', cashFlow: 'OPERATING' },
            ],
          },
          { code: '1230', name: 'Contract assets', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Contract assets', cashFlow: 'OPERATING', description: 'IFRS 15 unbilled revenue.' },
          { code: '1240', name: 'Prepayments', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Prepayments', cashFlow: 'OPERATING' },
          {
            code: '1250',
            name: 'Cash and cash equivalents',
            type: 'ASSET',
            posting: false,
            category: 'Current assets',
            subcategory: 'Cash and cash equivalents',
            cashFlow: 'OPERATING',
            children: [
              { code: '1251', name: 'Cash on hand', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Cash and cash equivalents', cashFlow: 'OPERATING' },
              { code: '1252', name: 'Bank current accounts', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Cash and cash equivalents', cashFlow: 'OPERATING' },
              { code: '1253', name: 'Bank deposits (≤ 3 months)', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Cash and cash equivalents', cashFlow: 'OPERATING' },
            ],
          },
          { code: '1260', name: 'Short-term investments', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Short-term investments', cashFlow: 'INVESTING' },
          { code: '1290', name: 'Other current assets', type: 'ASSET', posting: true, category: 'Current assets', subcategory: 'Other current assets', cashFlow: 'OPERATING' },
        ],
      },
    ],
  },

  // ──────────────────────────── LIABILITIES 2000 ───────────────────────────
  {
    code: '2000',
    name: 'Liabilities',
    type: 'LIABILITY',
    posting: false,
    category: 'Liabilities',
    children: [
      {
        code: '2100',
        name: 'Non-current liabilities',
        type: 'LIABILITY',
        posting: false,
        category: 'Non-current liabilities',
        children: [
          { code: '2110', name: 'Long-term borrowings', type: 'LIABILITY', posting: true, category: 'Non-current liabilities', subcategory: 'Borrowings', cashFlow: 'FINANCING' },
          { code: '2120', name: 'Lease liabilities — non-current', type: 'LIABILITY', posting: true, category: 'Non-current liabilities', subcategory: 'Lease liabilities', cashFlow: 'FINANCING' },
          { code: '2130', name: 'Deferred tax liabilities', type: 'LIABILITY', posting: true, category: 'Non-current liabilities', subcategory: 'Deferred tax liabilities', cashFlow: 'NON_CASH' },
          { code: '2140', name: 'Provisions — non-current', type: 'LIABILITY', posting: true, category: 'Non-current liabilities', subcategory: 'Provisions', cashFlow: 'OPERATING' },
          { code: '2150', name: 'Employee benefit obligations', type: 'LIABILITY', posting: true, category: 'Non-current liabilities', subcategory: 'Employee benefits', cashFlow: 'OPERATING' },
          { code: '2190', name: 'Other non-current liabilities', type: 'LIABILITY', posting: true, category: 'Non-current liabilities', subcategory: 'Other non-current liabilities', cashFlow: 'OPERATING' },
        ],
      },
      {
        code: '2200',
        name: 'Current liabilities',
        type: 'LIABILITY',
        posting: false,
        category: 'Current liabilities',
        children: [
          { code: '2210', name: 'Trade payables', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Trade payables', cashFlow: 'OPERATING' },
          { code: '2220', name: 'Accrued expenses', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Accruals', cashFlow: 'OPERATING' },
          { code: '2230', name: 'Contract liabilities', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Contract liabilities', cashFlow: 'OPERATING', description: 'IFRS 15 deferred revenue.' },
          { code: '2240', name: 'Short-term borrowings', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Borrowings', cashFlow: 'FINANCING' },
          { code: '2250', name: 'Current portion of lease liabilities', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Lease liabilities', cashFlow: 'FINANCING' },
          { code: '2260', name: 'Current tax payable', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Tax payable', cashFlow: 'OPERATING' },
          { code: '2270', name: 'VAT / sales tax payable', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Tax payable', cashFlow: 'OPERATING' },
          { code: '2280', name: 'Provisions — current', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Provisions', cashFlow: 'OPERATING' },
          { code: '2290', name: 'Other current liabilities', type: 'LIABILITY', posting: true, category: 'Current liabilities', subcategory: 'Other current liabilities', cashFlow: 'OPERATING' },
        ],
      },
    ],
  },

  // ────────────────────────────── EQUITY 3000 ──────────────────────────────
  {
    code: '3000',
    name: 'Equity',
    type: 'EQUITY',
    posting: false,
    category: 'Equity',
    children: [
      { code: '3100', name: 'Share capital', type: 'EQUITY', posting: true, category: 'Equity', subcategory: 'Share capital', cashFlow: 'FINANCING' },
      { code: '3200', name: 'Share premium', type: 'EQUITY', posting: true, category: 'Equity', subcategory: 'Share premium', cashFlow: 'FINANCING' },
      { code: '3300', name: 'Retained earnings', type: 'EQUITY', posting: true, category: 'Equity', subcategory: 'Retained earnings', cashFlow: 'NOT_APPLICABLE' },
      { code: '3350', name: 'Dividends declared', type: 'EQUITY', posting: true, normalBalance: 'DEBIT', category: 'Equity', subcategory: 'Retained earnings', cashFlow: 'FINANCING' },
      { code: '3400', name: 'Other reserves', type: 'EQUITY', posting: true, category: 'Equity', subcategory: 'Other reserves', cashFlow: 'NOT_APPLICABLE' },
      { code: '3500', name: 'Revaluation reserve', type: 'EQUITY', posting: true, category: 'Equity', subcategory: 'Revaluation reserve', cashFlow: 'NON_CASH' },
      { code: '3600', name: 'Foreign currency translation reserve', type: 'EQUITY', posting: true, category: 'Equity', subcategory: 'Translation reserve', cashFlow: 'NON_CASH' },
      { code: '3700', name: 'Non-controlling interests', type: 'EQUITY', posting: true, category: 'Non-controlling interests', subcategory: 'Non-controlling interests', cashFlow: 'NOT_APPLICABLE' },
    ],
  },

  // ────────────────────────── REVENUE / INCOME 4000 ────────────────────────
  {
    code: '4000',
    name: 'Revenue / Income',
    type: 'INCOME',
    posting: false,
    category: 'Revenue',
    pnl: 'OPERATING',
    children: [
      {
        code: '4100',
        name: 'Revenue from contracts with customers',
        type: 'INCOME',
        posting: false,
        category: 'Revenue',
        subcategory: 'Revenue from contracts with customers',
        pnl: 'OPERATING',
        children: [
          { code: '4110', name: 'Product sales', type: 'INCOME', posting: true, category: 'Revenue', subcategory: 'Product sales', pnl: 'OPERATING' },
          { code: '4120', name: 'Service revenue', type: 'INCOME', posting: true, category: 'Revenue', subcategory: 'Service revenue', pnl: 'OPERATING' },
          { code: '4130', name: 'Sales returns and allowances', type: 'INCOME', posting: true, normalBalance: 'DEBIT', category: 'Revenue', subcategory: 'Revenue adjustments', pnl: 'OPERATING' },
          { code: '4140', name: 'Sales discounts', type: 'INCOME', posting: true, normalBalance: 'DEBIT', category: 'Revenue', subcategory: 'Revenue adjustments', pnl: 'OPERATING' },
        ],
      },
      { code: '4200', name: 'Rental income', type: 'INCOME', posting: true, category: 'Other operating income', subcategory: 'Rental income', pnl: 'OPERATING' },
      { code: '4300', name: 'Other operating income', type: 'INCOME', posting: true, category: 'Other operating income', subcategory: 'Other operating income', pnl: 'OPERATING' },
    ],
  },

  // ─────────────────── COST OF SALES / DIRECT COSTS 5000 ────────────────────
  {
    code: '5000',
    name: 'Cost of sales / Direct costs',
    type: 'COST_OF_SALES',
    posting: false,
    category: 'Cost of sales',
    pnl: 'OPERATING',
    children: [
      { code: '5100', name: 'Direct materials', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Materials', pnl: 'OPERATING' },
      { code: '5200', name: 'Direct labour', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Labour', pnl: 'OPERATING' },
      { code: '5300', name: 'Subcontractor costs', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Subcontractors', pnl: 'OPERATING' },
      { code: '5400', name: 'Project / job costs', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Project costs', pnl: 'OPERATING' },
      { code: '5500', name: 'Cost of goods sold', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Cost of goods sold', pnl: 'OPERATING' },
      { code: '5600', name: 'Inventory write-downs', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Inventory write-downs', pnl: 'OPERATING' },
      { code: '5700', name: 'Production overheads', type: 'COST_OF_SALES', posting: true, category: 'Cost of sales', subcategory: 'Overheads', pnl: 'OPERATING' },
    ],
  },

  // ──────────────────────── OPERATING EXPENSES 6000 ────────────────────────
  {
    code: '6000',
    name: 'Operating expenses',
    type: 'OPERATING_EXPENSE',
    posting: false,
    category: 'Operating expenses',
    pnl: 'OPERATING',
    children: [
      {
        code: '6100',
        name: 'Salaries and employee benefits',
        type: 'OPERATING_EXPENSE',
        posting: false,
        category: 'Administrative expenses',
        subcategory: 'Staff costs',
        pnl: 'OPERATING',
        children: [
          { code: '6110', name: 'Salaries and wages', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Staff costs', pnl: 'OPERATING' },
          { code: '6120', name: 'Employee benefits', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Staff costs', pnl: 'OPERATING' },
          { code: '6130', name: 'Social security and payroll taxes', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Staff costs', pnl: 'OPERATING' },
          { code: '6140', name: 'Staff training and development', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Staff costs', pnl: 'OPERATING' },
        ],
      },
      { code: '6200', name: 'Rent and utilities', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Premises', pnl: 'OPERATING' },
      { code: '6300', name: 'Professional and legal fees', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Professional fees', pnl: 'OPERATING' },
      { code: '6400', name: 'Marketing and advertising', type: 'OPERATING_EXPENSE', posting: true, category: 'Distribution expenses', subcategory: 'Marketing', pnl: 'OPERATING' },
      { code: '6500', name: 'Travel and entertainment', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Travel', pnl: 'OPERATING' },
      { code: '6600', name: 'Depreciation expense', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Depreciation', cashFlow: 'NON_CASH', pnl: 'OPERATING' },
      { code: '6700', name: 'Amortisation expense', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Amortisation', cashFlow: 'NON_CASH', pnl: 'OPERATING' },
      { code: '6800', name: 'Expected credit loss expense', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Impairment losses', cashFlow: 'NON_CASH', pnl: 'OPERATING' },
      { code: '6850', name: 'Repairs and maintenance', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Premises', pnl: 'OPERATING' },
      { code: '6860', name: 'IT and communication', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'IT', pnl: 'OPERATING' },
      { code: '6870', name: 'Insurance', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Insurance', pnl: 'OPERATING' },
      { code: '6900', name: 'General administrative expenses', type: 'OPERATING_EXPENSE', posting: true, category: 'Administrative expenses', subcategory: 'Other administrative', pnl: 'OPERATING' },
    ],
  },

  // ───────────── OTHER INCOME / EXPENSES & FINANCE 7000 ─────────────────────
  {
    code: '7000',
    name: 'Other income, expenses & finance',
    type: 'OTHER_INCOME_EXPENSE',
    posting: false,
    category: 'Other income and expenses',
    pnl: 'OPERATING',
    children: [
      { code: '7100', name: 'Finance income', type: 'FINANCE', posting: true, normalBalance: 'CREDIT', category: 'Finance income', subcategory: 'Interest income', cashFlow: 'INVESTING', pnl: 'FINANCING' },
      { code: '7200', name: 'Finance costs', type: 'FINANCE', posting: true, category: 'Finance costs', subcategory: 'Interest expense', cashFlow: 'FINANCING', pnl: 'FINANCING' },
      { code: '7250', name: 'Interest on lease liabilities', type: 'FINANCE', posting: true, category: 'Finance costs', subcategory: 'Lease interest', cashFlow: 'FINANCING', pnl: 'FINANCING' },
      { code: '7300', name: 'Foreign exchange gains and losses', type: 'OTHER_INCOME_EXPENSE', posting: true, category: 'Other income and expenses', subcategory: 'Foreign exchange', pnl: 'OPERATING' },
      { code: '7400', name: 'Gain / loss on disposal of assets', type: 'OTHER_INCOME_EXPENSE', posting: true, category: 'Other income and expenses', subcategory: 'Disposals', cashFlow: 'INVESTING', pnl: 'INVESTING' },
      { code: '7500', name: 'Investment income', type: 'OTHER_INCOME_EXPENSE', posting: true, normalBalance: 'CREDIT', category: 'Other income and expenses', subcategory: 'Investment income', cashFlow: 'INVESTING', pnl: 'INVESTING' },
      { code: '7600', name: 'Share of profit of associates and JVs', type: 'OTHER_INCOME_EXPENSE', posting: true, normalBalance: 'CREDIT', category: 'Other income and expenses', subcategory: 'Equity-accounted results', pnl: 'INVESTING' },
    ],
  },

  // ────────────── TAXATION, DISCONTINUED OPS & OCI 8000 ─────────────────────
  {
    code: '8000',
    name: 'Taxation, discontinued operations & OCI',
    type: 'TAX',
    posting: false,
    category: 'Taxation',
    pnl: 'INCOME_TAXES',
    children: [
      { code: '8100', name: 'Income tax expense — current', type: 'TAX', posting: true, category: 'Income tax', subcategory: 'Current tax', cashFlow: 'OPERATING', pnl: 'INCOME_TAXES' },
      { code: '8200', name: 'Deferred tax expense / (income)', type: 'TAX', posting: true, category: 'Income tax', subcategory: 'Deferred tax', cashFlow: 'NON_CASH', pnl: 'INCOME_TAXES' },
      { code: '8300', name: 'Profit / (loss) from discontinued operations', type: 'DISCONTINUED_OPERATIONS', posting: true, normalBalance: 'CREDIT', category: 'Discontinued operations', subcategory: 'Discontinued operations', pnl: 'DISCONTINUED_OPERATIONS' },
      {
        code: '8400',
        name: 'Other comprehensive income',
        type: 'OCI',
        posting: false,
        category: 'Other comprehensive income',
        statement: 'OCI',
        children: [
          { code: '8410', name: 'Revaluation surplus movement (OCI)', type: 'OCI', posting: true, category: 'OCI — not reclassified', subcategory: 'Revaluation surplus', statement: 'OCI', cashFlow: 'NON_CASH', pnl: 'NOT_APPLICABLE' },
          { code: '8420', name: 'FX translation differences (OCI)', type: 'OCI', posting: true, category: 'OCI — may be reclassified', subcategory: 'Translation differences', statement: 'OCI', cashFlow: 'NON_CASH', pnl: 'NOT_APPLICABLE' },
          { code: '8430', name: 'Remeasurement of defined benefit plans (OCI)', type: 'OCI', posting: true, category: 'OCI — not reclassified', subcategory: 'Defined benefit remeasurement', statement: 'OCI', cashFlow: 'NON_CASH', pnl: 'NOT_APPLICABLE' },
          { code: '8440', name: 'Cash flow hedge reserve movement (OCI)', type: 'OCI', posting: true, category: 'OCI — may be reclassified', subcategory: 'Cash flow hedges', statement: 'OCI', cashFlow: 'NON_CASH', pnl: 'NOT_APPLICABLE' },
        ],
      },
    ],
  },

  // ───────────────── CONTROL / SUSPENSE / SYSTEM 9000 ───────────────────────
  {
    code: '9000',
    name: 'Control, suspense & system accounts',
    type: 'CONTROL',
    posting: false,
    category: 'Control accounts',
    statement: 'CONTROL',
    children: [
      { code: '9100', name: 'Suspense account', type: 'CONTROL', posting: true, category: 'Suspense & clearing', subcategory: 'Suspense', statement: 'CONTROL' },
      { code: '9200', name: 'Bank clearing account', type: 'CONTROL', posting: true, category: 'Suspense & clearing', subcategory: 'Clearing', statement: 'CONTROL' },
      { code: '9300', name: 'Inter-company control', type: 'CONTROL', posting: true, category: 'Control accounts', subcategory: 'Inter-company', statement: 'CONTROL' },
      { code: '9400', name: 'Opening balance equity', type: 'CONTROL', posting: true, normalBalance: 'CREDIT', category: 'Control accounts', subcategory: 'Opening balances', statement: 'CONTROL' },
      { code: '9500', name: 'Payroll clearing', type: 'CONTROL', posting: true, category: 'Suspense & clearing', subcategory: 'Clearing', statement: 'CONTROL' },
      { code: '9900', name: 'Rounding / system account', type: 'CONTROL', posting: true, category: 'Control accounts', subcategory: 'System', statement: 'CONTROL' },
    ],
  },
];

/** Derive the default P&L (IFRS 18) category for an income/expense type. */
function defaultPnl(type: AccountType): ProfitOrLossCategory | undefined {
  switch (type) {
    case 'INCOME':
    case 'COST_OF_SALES':
    case 'OPERATING_EXPENSE':
    case 'OTHER_INCOME_EXPENSE':
      return 'OPERATING';
    case 'FINANCE':
      return 'FINANCING';
    case 'TAX':
      return 'INCOME_TAXES';
    case 'DISCONTINUED_OPERATIONS':
      return 'DISCONTINUED_OPERATIONS';
    default:
      return undefined;
  }
}

/**
 * Flatten the seed spec tree into fully-formed {@link Account} objects with
 * deterministic ids (so re-seeding is stable), levels and parent references.
 */
export function buildSeedAccounts(): Account[] {
  const timestamp = new Date('2024-01-01T00:00:00.000Z').toISOString();
  const accounts: Account[] = [];

  const walk = (
    spec: SeedSpec,
    parentId: string | null,
    level: number,
    sortOrder: number,
  ): void => {
    const meta = ACCOUNT_TYPE_META[spec.type];
    const id = `seed_${spec.code}`;
    const pnl = spec.pnl ?? defaultPnl(spec.type);

    const account: Account = {
      id,
      code: spec.code,
      name: spec.name,
      type: spec.type,
      parentId,
      level,
      normalBalance: spec.normalBalance ?? meta.defaultNormalBalance,
      ifrsStatement: spec.statement ?? meta.defaultStatement,
      ifrsCategory: spec.category,
      ifrsSubcategory: spec.subcategory ?? '',
      cashFlowCategory: spec.cashFlow ?? 'NOT_APPLICABLE',
      isPostingAccount: spec.posting,
      isActive: true,
      description: spec.description ?? '',
      industryTag: 'general',
      sortOrder,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(pnl ? { profitOrLossCategory: pnl } : {}),
    };

    accounts.push(account);

    spec.children?.forEach((child, idx) => walk(child, id, level + 1, idx));
  };

  tree.forEach((root, idx) => walk(root, null, 0, idx));
  return accounts;
}

/** Convenience constant: a freshly built default chart of accounts. */
export const SEED_ACCOUNTS: Account[] = buildSeedAccounts();
