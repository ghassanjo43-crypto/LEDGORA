import type { TaxCode, TaxRateVersion, TaxGroup } from '@/types/taxCode';
import type { TaxJurisdiction, TaxReportingBox } from '@/types/taxReporting';

/**
 * Default tax configuration DATA (not business logic). Rates live here as sample
 * data, never hardcoded inside calculation or posting code. Account references
 * use the deterministic seed CoA ids (`seed_<code>`): 2270 VAT control (shared
 * output/input), 2260 tax/withholding payable.
 */

const TS = new Date('2026-01-01T00:00:00.000Z').toISOString();
const VAT = 'seed_2270'; // VAT / sales tax control (output & input)
const WHT = 'seed_2260'; // Current tax / withholding payable

export const SEED_TAX_JURISDICTION: TaxJurisdiction = {
  id: 'jur_GEN',
  code: 'GEN',
  name: 'General VAT jurisdiction',
  taxAuthorityName: 'Tax Authority',
  filingFrequency: 'quarterly',
  status: 'active',
  createdAt: TS,
  updatedAt: TS,
};

export const SEED_TAX_REPORTING_BOXES: TaxReportingBox[] = [
  { id: 'box_1', jurisdictionId: 'jur_GEN', code: 'B1', name: 'Standard-rated sales', reportType: 'sales', amountBasis: 'taxable-base', sign: 'positive', status: 'active', sortOrder: 1 },
  { id: 'box_2', jurisdictionId: 'jur_GEN', code: 'B2', name: 'Output tax due', reportType: 'output-tax', amountBasis: 'tax-amount', sign: 'positive', status: 'active', sortOrder: 2 },
  { id: 'box_3', jurisdictionId: 'jur_GEN', code: 'B3', name: 'Standard-rated purchases', reportType: 'purchases', amountBasis: 'taxable-base', sign: 'positive', status: 'active', sortOrder: 3 },
  { id: 'box_4', jurisdictionId: 'jur_GEN', code: 'B4', name: 'Input tax recoverable', reportType: 'input-tax', amountBasis: 'tax-amount', sign: 'positive', status: 'active', sortOrder: 4 },
  { id: 'box_5', jurisdictionId: 'jur_GEN', code: 'B5', name: 'Reverse-charge tax', reportType: 'reverse-charge', amountBasis: 'tax-amount', sign: 'positive', status: 'active', sortOrder: 5 },
  { id: 'box_6', jurisdictionId: 'jur_GEN', code: 'B6', name: 'Withholding tax', reportType: 'withholding', amountBasis: 'tax-amount', sign: 'positive', status: 'active', sortOrder: 6 },
  { id: 'box_7', jurisdictionId: 'jur_GEN', code: 'B7', name: 'Zero-rated sales', reportType: 'sales', amountBasis: 'taxable-base', sign: 'positive', status: 'active', sortOrder: 7 },
  { id: 'box_8', jurisdictionId: 'jur_GEN', code: 'B8', name: 'Exempt sales', reportType: 'custom', amountBasis: 'taxable-base', sign: 'positive', status: 'active', sortOrder: 8 },
  { id: 'box_9', jurisdictionId: 'jur_GEN', code: 'B9', name: 'Tax adjustments', reportType: 'adjustment', amountBasis: 'tax-amount', sign: 'positive', status: 'active', sortOrder: 9 },
];

interface SeedCodeSpec {
  code: string;
  name: string;
  category: TaxCode['category'];
  direction: TaxCode['direction'];
  scope?: TaxCode['scope'];
  rate: number;
  rateType?: TaxCode['rateType'];
  calc?: TaxCode['calculationMethod'];
  outputTaxAccountId?: string;
  inputTaxAccountId?: string;
  withholdingAccountId?: string;
  reverseChargeOutputAccountId?: string;
  reverseChargeInputAccountId?: string;
  reportingBoxIds: string[];
  isDefaultSales?: boolean;
  isDefaultPurchase?: boolean;
  isDefaultExport?: boolean;
  isDefaultImport?: boolean;
  withholdingTiming?: TaxCode['withholdingTiming'];
}

function makeCode(spec: SeedCodeSpec): TaxCode {
  return {
    id: `tax_${spec.code}`,
    code: spec.code,
    name: spec.name,
    category: spec.category,
    direction: spec.direction,
    scope: spec.scope ?? 'domestic',
    status: 'active',
    rate: spec.rate,
    rateType: spec.rateType ?? (spec.rate === 0 ? 'zero' : 'percentage'),
    calculationMethod: spec.calc ?? 'exclusive',
    roundingMethod: 'line',
    precision: 2,
    outputTaxAccountId: spec.outputTaxAccountId,
    inputTaxAccountId: spec.inputTaxAccountId,
    withholdingAccountId: spec.withholdingAccountId,
    reverseChargeOutputAccountId: spec.reverseChargeOutputAccountId,
    reverseChargeInputAccountId: spec.reverseChargeInputAccountId,
    reportingBoxIds: spec.reportingBoxIds,
    jurisdictionId: 'jur_GEN',
    effectiveFrom: '2026-01-01',
    isDefaultSales: spec.isDefaultSales,
    isDefaultPurchase: spec.isDefaultPurchase,
    isDefaultExport: spec.isDefaultExport,
    isDefaultImport: spec.isDefaultImport,
    withholdingTiming: spec.withholdingTiming,
    invoiceLabel: spec.name,
    billLabel: spec.name,
    auditTrail: [{ id: `taud_${spec.code}`, at: TS, action: 'tax-code-created', detail: 'seed' }],
    createdAt: TS,
    updatedAt: TS,
  };
}

const SEED_SPECS: SeedCodeSpec[] = [
  { code: 'S-STD', name: 'Standard-rated sales (16%)', category: 'standard', direction: 'sales', rate: 16, outputTaxAccountId: VAT, reportingBoxIds: ['box_1', 'box_2'], isDefaultSales: true },
  { code: 'S-ZERO', name: 'Zero-rated sales', category: 'zero-rated', direction: 'sales', scope: 'export', rate: 0, reportingBoxIds: ['box_7'], isDefaultExport: true },
  { code: 'S-EXEMPT', name: 'Exempt sales', category: 'exempt', direction: 'sales', rate: 0, reportingBoxIds: ['box_8'] },
  { code: 'S-OOS', name: 'Out of scope', category: 'out-of-scope', direction: 'both', rate: 0, reportingBoxIds: [] },
  { code: 'P-STD', name: 'Standard-rated purchases (16%)', category: 'standard', direction: 'purchase', rate: 16, inputTaxAccountId: VAT, reportingBoxIds: ['box_3', 'box_4'], isDefaultPurchase: true },
  { code: 'P-RED', name: 'Reduced-rate purchases (8%)', category: 'reduced', direction: 'purchase', rate: 8, inputTaxAccountId: VAT, reportingBoxIds: ['box_3', 'box_4'] },
  { code: 'P-RC', name: 'Reverse-charge services (16%)', category: 'reverse-charge', direction: 'purchase', scope: 'import', rate: 16, inputTaxAccountId: VAT, reverseChargeOutputAccountId: VAT, reverseChargeInputAccountId: VAT, reportingBoxIds: ['box_3', 'box_4', 'box_5'] },
  { code: 'P-IMP', name: 'Import VAT (16%)', category: 'import', direction: 'purchase', scope: 'import', rate: 16, inputTaxAccountId: VAT, reportingBoxIds: ['box_3', 'box_4'], isDefaultImport: true },
  { code: 'WHT-5', name: 'Withholding tax (5%)', category: 'withholding', direction: 'withholding-payable', rate: 5, withholdingAccountId: WHT, withholdingTiming: 'payment', reportingBoxIds: ['box_6'] },
];

export const SEED_TAX_CODES: TaxCode[] = SEED_SPECS.map(makeCode);

/** One initial rate version per seed code (mirrors each code's opening rate). */
export const SEED_TAX_RATE_VERSIONS: TaxRateVersion[] = SEED_TAX_CODES.map((c) => ({
  id: `trv_${c.code}`,
  taxCodeId: c.id,
  rate: c.rate,
  effectiveFrom: c.effectiveFrom,
  outputTaxAccountId: c.outputTaxAccountId,
  inputTaxAccountId: c.inputTaxAccountId,
  createdAt: TS,
}));

export const SEED_TAX_GROUPS: TaxGroup[] = [];
