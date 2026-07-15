import type { TaxCategory, TaxDirection } from '@/types/taxCode';

/**
 * Tax reporting & administration types — jurisdictions, registrations, reporting
 * boxes, periods, adjustments and the report/reconciliation result shapes. Return
 * boxes are data (never hardcoded in transaction components).
 */

export type FilingFrequency = 'monthly' | 'quarterly' | 'annual' | 'custom';

export interface TaxJurisdiction {
  id: string;
  code: string;
  name: string;

  countryCode?: string;
  regionCode?: string;

  taxAuthorityName?: string;
  baseCurrency?: string;

  filingFrequency?: FilingFrequency;

  status: 'active' | 'inactive';

  createdAt: string;
  updatedAt: string;
}

export interface TaxRegistration {
  id: string;
  entityId: string;
  jurisdictionId: string;

  registrationNumber: string;
  registrationName?: string;

  effectiveFrom: string;
  effectiveTo?: string;

  filingFrequency: FilingFrequency;

  status: 'active' | 'inactive';

  createdAt: string;
  updatedAt: string;
}

export type TaxReportType =
  | 'sales'
  | 'purchases'
  | 'output-tax'
  | 'input-tax'
  | 'reverse-charge'
  | 'withholding'
  | 'adjustment'
  | 'custom';

export type TaxBoxAmountBasis = 'taxable-base' | 'tax-amount' | 'gross-amount';

export interface TaxReportingBox {
  id: string;
  jurisdictionId: string;

  code: string;
  name: string;
  description?: string;

  reportType: TaxReportType;
  amountBasis: TaxBoxAmountBasis;

  sign: 'positive' | 'negative';
  status: 'active' | 'inactive';
  sortOrder: number;
}

export type TaxPeriodStatus = 'open' | 'prepared' | 'filed' | 'locked' | 'reopened';

export interface TaxPeriodAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
  by?: string;
}

export interface TaxPeriod {
  id: string;
  entityId: string;
  jurisdictionId: string;

  periodStart: string;
  periodEnd: string;
  filingDueDate?: string;

  status: TaxPeriodStatus;

  filedAt?: string;
  filedReference?: string;

  auditTrail: TaxPeriodAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

export type TaxAdjustmentType =
  | 'rounding'
  | 'bad-debt-relief'
  | 'prior-period'
  | 'partial-exemption'
  | 'capital-goods'
  | 'error-correction'
  | 'other';

export interface TaxAdjustment {
  id: string;
  entityId: string;
  jurisdictionId?: string;
  taxPeriodId?: string;

  type: TaxAdjustmentType;
  taxCodeId?: string;
  reportingBoxId?: string;
  taxAccountId?: string;

  date: string;
  amount: number;
  taxableAmount?: number;
  currency: string;
  exchangeRate: number;

  reason: string;
  journalEntryId?: string;

  createdAt: string;
  createdBy?: string;
}

/**
 * A single tax-bearing record used by the summary/detail reports. Produced from
 * frozen document snapshots, tax adjustments, or posted journal tax metadata.
 */
export interface TaxLineRecord {
  id: string;
  date: string;
  documentType: 'invoice' | 'credit-note' | 'bill' | 'supplier-credit' | 'receipt' | 'payment' | 'journal' | 'adjustment';
  documentNumber?: string;
  entityId: string;
  partyId?: string;
  partyName?: string;

  taxCodeId: string;
  taxCode: string;
  taxName: string;
  category: TaxCategory;
  direction: TaxDirection;
  rate: number;

  taxableAmount: number;
  taxAmount: number;
  grossAmount: number;
  recoverableTaxAmount: number;
  nonRecoverableTaxAmount: number;

  taxAccountId?: string;
  reportingBoxIds: string[];

  journalEntryId?: string;
  status: string;

  currency: string;
  exchangeRate: number;
  baseTaxableAmount: number;
  baseTaxAmount: number;
}

export interface TaxSummaryRow {
  taxCodeId: string;
  taxCode: string;
  taxName: string;
  category: TaxCategory;
  direction: TaxDirection;
  rate: number;
  taxableBase: number;
  taxAmount: number;
  recoverableAmount: number;
  nonRecoverableAmount: number;
  outputTax: number;
  inputTax: number;
  reportingBoxIds: string[];
  documentCount: number;
}

export interface TaxSummaryReport {
  rows: TaxSummaryRow[];
  outputTaxTotal: number;
  inputTaxTotal: number;
  recoverableTotal: number;
  nonRecoverableTotal: number;
  netPayable: number; // output − recoverable input (positive = payable, negative = refundable)
  taxableBaseTotal: number;
  documentCount: number;
}

export interface TaxBoxTotal {
  boxId: string;
  boxCode: string;
  boxName: string;
  reportType: TaxReportType;
  amountBasis: TaxBoxAmountBasis;
  amount: number;
}

export interface TaxReconciliationLine {
  key: string;
  label: string;
  reportTotal: number;
  glBalance: number;
  difference: number;
  reconciled: boolean;
}

export interface TaxReconciliationResult {
  lines: TaxReconciliationLine[];
  /** Posted journal lines hitting a tax account but carrying no tax code metadata. */
  unmappedTaxJournalLines: {
    journalEntryId: string;
    entryNumber: string;
    date: string;
    accountId: string;
    accountCode: string;
    amount: number;
  }[];
  /** Tax records whose tax code no longer resolves to a mapped account. */
  unmappedTaxRecords: { id: string; documentNumber?: string; taxCode: string }[];
  isReconciled: boolean;
}
