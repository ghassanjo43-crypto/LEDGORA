/**
 * Core domain types for the IFRS-aligned Chart of Accounts.
 *
 * NOTE ON IFRS: IFRS does not mandate a single universal chart of accounts.
 * The codes produced here are INTERNAL management/accounting codes that are
 * aligned with IFRS presentation principles (IAS 1 / IFRS 18). They are not
 * "official IFRS codes".
 */

/** High-level account category. Drives default code range & normal balance. */
export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'INCOME'
  | 'COST_OF_SALES'
  | 'OPERATING_EXPENSE'
  | 'OTHER_INCOME_EXPENSE'
  | 'FINANCE'
  | 'TAX'
  | 'DISCONTINUED_OPERATIONS'
  | 'OCI'
  | 'CONTROL';

/** IFRS-style financial statement an account is presented in. */
export type IFRSStatement =
  | 'STATEMENT_OF_FINANCIAL_POSITION'
  | 'PROFIT_OR_LOSS'
  | 'OCI'
  | 'STATEMENT_OF_CHANGES_IN_EQUITY'
  | 'CASH_FLOW'
  | 'NOTES'
  | 'CONTROL';

/** Debit or credit normal balance. */
export type NormalBalance = 'DEBIT' | 'CREDIT';

/** Statement of cash flows classification (IAS 7). */
export type CashFlowCategory =
  | 'OPERATING'
  | 'INVESTING'
  | 'FINANCING'
  | 'NON_CASH'
  | 'NOT_APPLICABLE';

/**
 * IFRS 18 profit-or-loss category. Only relevant for income & expense accounts
 * when the company operates in IFRS 18 presentation mode.
 */
export type ProfitOrLossCategory =
  | 'OPERATING'
  | 'INVESTING'
  | 'FINANCING'
  | 'INCOME_TAXES'
  | 'DISCONTINUED_OPERATIONS'
  | 'NOT_APPLICABLE';

/** A single account in the chart of accounts. */
export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  level: number;
  normalBalance: NormalBalance;
  ifrsStatement: IFRSStatement;
  ifrsCategory: string;
  ifrsSubcategory: string;
  cashFlowCategory: CashFlowCategory;
  /** IFRS 18 presentation. Optional; used only in IFRS 18 mode for P&L accounts. */
  profitOrLossCategory?: ProfitOrLossCategory;
  /** True = leaf account that can receive journal postings. False = header. */
  isPostingAccount: boolean;
  isActive: boolean;
  description: string;
  industryTag: string;
  /** Manual ordering index among siblings. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** IFRS presentation mode for profit or loss. */
export type PresentationMode = 'IAS_1' | 'IFRS_18';

/** Whether the books are kept on an accrual or cash basis. */
export type AccountingBasis = 'accrual' | 'cash';

/** Financial reporting framework the entity reports under. */
export type ReportingFramework = 'IFRS' | 'IFRS_FOR_SMES' | 'US_GAAP' | 'OTHER';

/**
 * The organisation the books are kept for. Holds the conventional information
 * needed to start bookkeeping: identity, registration & tax, contact/address,
 * and the accounting/reporting configuration.
 */
export interface CompanySettings {
  /* Identity */
  companyName: string; // registered legal name
  tradingName: string; // brand / "trading as"
  organizationType: string; // LLC, Sole Proprietor, Partnership, PJSC…
  industryType: string;
  /** Company default logo as a persistent data URL (used across documents). */
  logoUrl?: string;

  /* Registration & tax */
  registrationNumber: string; // commercial / company registration number
  taxRegistered: boolean;
  taxRegistrationNumber: string; // VAT / TRN / tax ID
  defaultTaxRate: number; // % applied by default (e.g. VAT rate)

  /* Contact & address */
  email: string;
  phone: string;
  website: string;
  country: string;
  stateProvince: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;

  /* Accounting & reporting */
  baseCurrency: string;
  /** ISO month-day, e.g. "01-01" for a calendar-year start. */
  fiscalYearStart: string;
  /** ISO date the books open / opening balances are dated. */
  booksStartDate: string;
  accountingBasis: AccountingBasis;
  reportingFramework: ReportingFramework;
  presentationMode: PresentationMode;
}

/** Severity of a validation issue. */
export type ValidationSeverity = 'error' | 'warning';

/** A single validation finding against the chart of accounts. */
export interface ValidationIssue {
  id: string;
  accountId: string | null;
  accountCode: string | null;
  severity: ValidationSeverity;
  rule: string;
  message: string;
}

/** UI navigation sections. */
export type ViewKey =
  | 'dashboard'
  | 'tree'
  | 'mapping'
  | 'entities'
  | 'customers'
  | 'suppliers'
  | 'journal'
  | 'import-export'
  | 'settings'
  // Future modules — routed to a "Coming soon" placeholder for now.
  | 'general-ledger'
  | 'trial-balance'
  | 'income-statement'
  | 'balance-sheet'
  | 'cash-flow'
  | 'financial-statements'
  | 'invoices'
  | 'invoice-templates'
  | 'credit-notes'
  | 'receipts'
  | 'statements'
  | 'bills'
  | 'payments'
  | 'tax-codes'
  | 'tax-groups'
  | 'tax-jurisdictions'
  | 'tax-periods'
  | 'tax-summary'
  | 'tax-detail'
  | 'tax-reconciliation'
  | 'exchange-rates'
  | 'currency-revaluation'
  | 'fx-gain-loss'
  | 'currencies'
  | 'cost-centers'
  | 'cost-center-budgets'
  | 'cost-center-allocations'
  | 'cost-center-reports'
  | 'project-reports'
  | 'project-delivery'
  | 'projects'
  // Inventory (shared module — Phase 1)
  | 'inventory-dashboard'
  | 'inventory-items'
  | 'inventory-categories'
  | 'inventory-units'
  | 'inventory-warehouses'
  | 'inventory-movements'
  | 'inventory-receipts'
  | 'inventory-issues'
  | 'inventory-transfers'
  | 'inventory-adjustments'
  | 'inventory-counts'
  | 'inventory-reports'
  // Inventory placeholders (future phases)
  | 'inventory-stock-movements'
  | 'inventory-lots-serials'
  | 'inventory-valuation'
  // Manufacturing Essentials — Phase 1
  | 'manufacturing-dashboard'
  | 'manufacturing-plants'
  | 'manufacturing-lines'
  | 'manufacturing-work-centers'
  | 'manufacturing-bom'
  | 'manufacturing-routings'
  | 'manufacturing-work-orders'
  | 'manufacturing-material-issues'
  | 'manufacturing-material-returns'
  | 'manufacturing-production-receipts'
  | 'manufacturing-scrap'
  | 'manufacturing-costing'
  // Manufacturing — deferred placeholders (not exposed in nav)
  | 'manufacturing-items'
  | 'manufacturing-planning'
  | 'manufacturing-mrp'
  | 'manufacturing-scrap-rework'
  | 'manufacturing-quality'
  | 'manufacturing-maintenance'
  | 'manufacturing-reports'
  | 'subscription'
  | 'members'
  | 'super-admin'
  | 'module-unavailable';

/** Result of an import parse + validation step. */
export interface ImportResult {
  accounts: Account[];
  issues: ValidationIssue[];
  ok: boolean;
}

/* ───────────────────────────── Business Entities ─────────────────────────── */

/**
 * A single shared party the business transacts with. The SAME entity can be a
 * customer (we invoice them), a supplier (they invoice us) or both — there is
 * never a duplicate record for a party that plays both roles.
 */
export type EntityType = 'customer' | 'supplier' | 'both';

/** How customer invoices are delivered. */
export type InvoiceDeliveryMethod = 'email' | 'portal' | 'post' | 'edi';

/** Preferred way to settle supplier bills. */
export type PaymentMethod =
  | 'bank_transfer'
  | 'cheque'
  | 'cash'
  | 'card'
  | 'letter_of_credit';

/** Standard payment terms. Empty string = "use the entity default". */
export type PaymentTerms =
  | 'DUE_ON_RECEIPT'
  | 'NET_7'
  | 'NET_15'
  | 'NET_30'
  | 'NET_45'
  | 'NET_60'
  | 'NET_90';

export interface BusinessEntity {
  id: string;
  entityCode: string;
  legalName: string;
  tradingName: string;
  entityType: EntityType;

  // Primary contact
  contactPerson: string;
  jobTitle: string;
  email: string;
  phone: string;
  mobile: string;
  website: string;

  // Address
  country: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;

  // Registration & commercial
  taxRegistrationNumber: string;
  commercialRegistrationNumber: string;
  paymentTerms: PaymentTerms;
  defaultCurrency: string;

  // Banking
  bankName: string;
  bankAccountName: string;
  iban: string;
  swiftCode: string;

  notes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;

  // Customer-specific (relevant when entityType is 'customer' | 'both')
  customerCategory: string;
  creditLimit: number;
  /** Chart-of-accounts account id used to post customer revenue. */
  defaultRevenueAccount: string;
  /** Chart-of-accounts account id for Accounts Receivable control. */
  defaultReceivableAccount: string;
  /** Preferred invoice template id ('' = use the company/entity default). Stored on the customer. */
  defaultInvoiceTemplateId: string;
  invoiceDeliveryMethod: InvoiceDeliveryMethod | '';
  customerPaymentTerms: PaymentTerms | '';

  // Supplier-specific (relevant when entityType is 'supplier' | 'both')
  supplierCategory: string;
  /** Chart-of-accounts account id used to post supplier expenses. */
  defaultExpenseAccount: string;
  /** Chart-of-accounts account id for Accounts Payable control. */
  defaultPayableAccount: string;
  supplierPaymentTerms: PaymentTerms | '';
  withholdingTaxApplicable: boolean;
  preferredPaymentMethod: PaymentMethod | '';
}

/** Severity-tagged finding against the entity directory. */
export interface EntityValidationIssue {
  id: string;
  entityId: string | null;
  entityCode: string | null;
  severity: ValidationSeverity;
  rule: string;
  message: string;
}

/** Result of parsing + validating an entity import file. */
export interface EntityImportResult {
  entities: BusinessEntity[];
  issues: EntityValidationIssue[];
  ok: boolean;
}
