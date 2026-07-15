import type { TaxCode, TaxSnapshot } from '@/types/taxCode';
import type { ResolvedRateVersion } from '@/lib/taxResolution';
import { calculateTaxLine, calculateRecoverableTax } from '@/lib/taxCalculations';

export interface CreateSnapshotInput {
  code: TaxCode;
  version: ResolvedRateVersion;
  /** Line amount before tax (net for exclusive, gross for inclusive). */
  amount: number;
  discountAmount?: number;
  capturedAt: string;
}

/**
 * Freeze a tax snapshot for a posted line. The snapshot captures the resolved
 * rate, method, accounts and reporting boxes AS AT posting — later edits to the
 * tax code never alter it (§6). Reversals, credits and reporting read the snapshot.
 */
export function createTaxSnapshot(input: CreateSnapshotInput): TaxSnapshot {
  const { code, version } = input;
  const result = calculateTaxLine({
    amount: input.amount,
    discountAmount: input.discountAmount,
    rate: version.rate,
    category: code.category,
    method: code.calculationMethod,
    precision: code.precision,
    recoverabilityPercent: code.recoverabilityPercent,
  });
  return {
    taxCodeId: code.id,
    taxCode: code.code,
    taxName: code.name,
    category: code.category,
    direction: code.direction,
    rate: version.rate,
    rateType: code.rateType,
    calculationMethod: code.calculationMethod,
    roundingMethod: code.roundingMethod,
    precision: code.precision,
    taxableAmount: result.taxableAmount,
    taxAmount: result.taxAmount,
    grossAmount: result.grossAmount,
    recoverabilityPercent: code.recoverabilityPercent,
    recoverableTaxAmount: result.recoverableTaxAmount,
    nonRecoverableTaxAmount: result.nonRecoverableTaxAmount,
    outputTaxAccountId: version.outputTaxAccountId ?? code.outputTaxAccountId,
    inputTaxAccountId: version.inputTaxAccountId ?? code.inputTaxAccountId,
    taxExpenseAccountId: code.taxExpenseAccountId,
    taxReceivableAccountId: version.taxReceivableAccountId ?? code.taxReceivableAccountId,
    taxPayableAccountId: version.taxPayableAccountId ?? code.taxPayableAccountId,
    withholdingAccountId: code.withholdingAccountId,
    reverseChargeOutputAccountId: code.reverseChargeOutputAccountId,
    reverseChargeInputAccountId: code.reverseChargeInputAccountId,
    reportingBoxIds: [...code.reportingBoxIds],
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    capturedAt: input.capturedAt,
  };
}

/**
 * A reversal snapshot for a credit note / supplier credit: reuses the ORIGINAL
 * snapshot's rate, method and accounts, re-scaling the amounts to the portion
 * being reversed. Never resolves today's rate (§14).
 */
export function createReversalSnapshot(original: TaxSnapshot, reversedTaxableAmount: number, capturedAt: string): TaxSnapshot {
  const taxableAmount = reversedTaxableAmount;
  const taxAmount = original.taxableAmount === 0 ? 0 : Math.round((taxableAmount / original.taxableAmount) * original.taxAmount * 100) / 100;
  const { recoverableTaxAmount, nonRecoverableTaxAmount } = calculateRecoverableTax(taxAmount, original.recoverabilityPercent ?? 100, original.precision);
  return {
    ...original,
    taxableAmount,
    taxAmount,
    grossAmount: Math.round((taxableAmount + taxAmount) * 100) / 100,
    recoverableTaxAmount,
    nonRecoverableTaxAmount,
    capturedAt,
  };
}
