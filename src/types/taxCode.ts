/**
 * Tax Code domain types — the centralized tax engine's configuration model.
 *
 * A tax code carries its rate, calculation method, account mappings and
 * reporting-box links. Rates are effective-dated (never overwritten) and every
 * posted line freezes a {@link TaxSnapshot} so historical documents never change
 * when a code is later edited.
 */

export type TaxCategory =
  | 'standard'
  | 'reduced'
  | 'zero-rated'
  | 'exempt'
  | 'out-of-scope'
  | 'reverse-charge'
  | 'import'
  | 'self-assessed'
  | 'withholding'
  | 'custom';

export type TaxDirection =
  | 'sales'
  | 'purchase'
  | 'both'
  | 'withholding-receivable'
  | 'withholding-payable';

export type TaxScope =
  | 'domestic'
  | 'export'
  | 'import'
  | 'intra-region'
  | 'international'
  | 'government'
  | 'custom';

export type TaxStatus = 'active' | 'inactive' | 'archived';

export type TaxRateType = 'percentage' | 'fixed' | 'zero';

export type TaxCalculationMethod = 'exclusive' | 'inclusive' | 'compound' | 'self-assessed';

export type TaxRoundingMethod = 'line' | 'document';

export type WithholdingTiming = 'invoice' | 'bill' | 'receipt' | 'payment';

/** Entity-level configuration of when tax is recognised. */
export type TaxRecognitionBasis = 'invoice' | 'cash';

export interface TaxAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
  by?: string;
}

export interface TaxCode {
  id: string;
  entityId?: string;

  code: string;
  name: string;
  description?: string;

  category: TaxCategory;
  direction: TaxDirection;
  scope: TaxScope;

  status: TaxStatus;

  rate: number;
  rateType: TaxRateType;

  calculationMethod: TaxCalculationMethod;

  roundingMethod: TaxRoundingMethod;
  precision: number;

  outputTaxAccountId?: string;
  inputTaxAccountId?: string;
  taxExpenseAccountId?: string;
  taxReceivableAccountId?: string;
  taxPayableAccountId?: string;
  withholdingAccountId?: string;
  reverseChargeOutputAccountId?: string;
  reverseChargeInputAccountId?: string;

  reportingBoxIds: string[];

  jurisdictionId?: string;
  countryCode?: string;
  regionCode?: string;

  effectiveFrom: string;
  effectiveTo?: string;

  recoverabilityPercent?: number;
  nonRecoverableAccountId?: string;

  withholdingTiming?: WithholdingTiming;

  customerTypes?: string[];
  supplierTypes?: string[];
  productTaxCategories?: string[];

  isDefaultSales?: boolean;
  isDefaultPurchase?: boolean;
  isDefaultExport?: boolean;
  isDefaultImport?: boolean;

  requiresTaxNumber?: boolean;
  requiresReason?: boolean;
  requiresReverseChargeNote?: boolean;

  displayLabel?: string;
  invoiceLabel?: string;
  billLabel?: string;

  auditTrail: TaxAuditEvent[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/**
 * An effective-dated rate + account mapping version. When a rate changes the old
 * version is end-dated and a new one created; periods must never overlap.
 */
export interface TaxRateVersion {
  id: string;
  taxCodeId: string;

  rate: number;
  effectiveFrom: string;
  effectiveTo?: string;

  outputTaxAccountId?: string;
  inputTaxAccountId?: string;
  taxPayableAccountId?: string;
  taxReceivableAccountId?: string;

  createdAt: string;
  createdBy?: string;
}

/** The frozen tax detail captured on a posted line — the reporting source of truth. */
export interface TaxSnapshot {
  taxCodeId: string;
  taxCode: string;
  taxName: string;

  category: TaxCategory;
  direction: TaxDirection;

  rate: number;
  rateType: TaxRateType;
  calculationMethod: TaxCalculationMethod;
  roundingMethod: TaxRoundingMethod;
  precision: number;

  taxableAmount: number;
  taxAmount: number;
  grossAmount: number;

  recoverabilityPercent?: number;
  recoverableTaxAmount?: number;
  nonRecoverableTaxAmount?: number;

  outputTaxAccountId?: string;
  inputTaxAccountId?: string;
  taxExpenseAccountId?: string;
  taxReceivableAccountId?: string;
  taxPayableAccountId?: string;
  withholdingAccountId?: string;
  reverseChargeOutputAccountId?: string;
  reverseChargeInputAccountId?: string;

  reportingBoxIds: string[];

  effectiveFrom: string;
  effectiveTo?: string;
  capturedAt: string;
}

export type TaxGroupCalculationOrder = 'parallel' | 'sequential';

export interface TaxGroup {
  id: string;
  entityId?: string;

  code: string;
  name: string;
  description?: string;

  status: 'active' | 'inactive';
  taxCodeIds: string[];

  calculationOrder: TaxGroupCalculationOrder;

  createdAt: string;
  updatedAt: string;
}

/** Attached to a customer/supplier to drive default tax resolution. */
export interface PartyTaxProfile {
  taxRegistrationNumber?: string;
  taxJurisdictionId?: string;
  taxExempt?: boolean;
  exemptionReason?: string;
  defaultSalesTaxCodeId?: string;
  defaultPurchaseTaxCodeId?: string;
  reverseChargeEligible?: boolean;
  withholdingApplicable?: boolean;
}

export interface ProductTaxCategory {
  id: string;
  code: string;
  name: string;
  defaultSalesTaxCodeId?: string;
  defaultPurchaseTaxCodeId?: string;
}
