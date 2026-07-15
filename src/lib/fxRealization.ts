import { roundTo } from '@/lib/currencyConversion';

/**
 * Realized FX on settlement (§20–21). Compares the settlement base amount to the
 * proportional carrying base amount of the portion being settled. Partial
 * settlements use proportional carrying — never the full original balance.
 *
 * Sign convention: realizedFx > 0 is a GAIN, < 0 is a LOSS.
 *   Receivable: realizedFx = settlementBase − carryingBaseSettled (receive more base ⇒ gain)
 *   Payable:    realizedFx = carryingBaseSettled − settlementBase (pay less base ⇒ gain)
 */

export type SettlementSide = 'receivable' | 'payable';

export interface RealizedFxInput {
  side: SettlementSide;
  /** Foreign amount being settled now. */
  settledForeign: number;
  /** Original foreign amount of the document. */
  originalForeign: number;
  /** Original base carrying value of the whole document. */
  originalCarryingBase: number;
  /** Rate used at settlement (foreign→base). */
  settlementRate: number;
  /** Base-currency precision (2 default; JOD = 3). */
  basePrecision?: number;
}

export interface RealizedFxResult {
  settlementBase: number;
  carryingBaseSettled: number;
  realizedFx: number; // + gain / − loss
  isGain: boolean;
  isLoss: boolean;
  remainingForeign: number;
  remainingCarryingBase: number;
}

export function calculateRealizedFx(input: RealizedFxInput): RealizedFxResult {
  const p = input.basePrecision ?? 2;
  const settledForeign = Number(input.settledForeign) || 0;
  const originalForeign = Number(input.originalForeign) || 0;
  const originalCarryingBase = Number(input.originalCarryingBase) || 0;

  const settlementBase = roundTo(settledForeign * (Number(input.settlementRate) || 0), p);
  const proportion = originalForeign === 0 ? 0 : settledForeign / originalForeign;
  const carryingBaseSettled = roundTo(originalCarryingBase * proportion, p);

  const realizedFx = roundTo(input.side === 'receivable' ? settlementBase - carryingBaseSettled : carryingBaseSettled - settlementBase, p);

  return {
    settlementBase,
    carryingBaseSettled,
    realizedFx,
    isGain: realizedFx > 0.5 / 10 ** p,
    isLoss: realizedFx < -0.5 / 10 ** p,
    remainingForeign: roundTo(originalForeign - settledForeign, 6),
    remainingCarryingBase: roundTo(originalCarryingBase - carryingBaseSettled, p),
  };
}

/** Explicit partial-settlement helper (same maths; documents the proportional intent). */
export function calculatePartialSettlementFx(input: RealizedFxInput): RealizedFxResult {
  return calculateRealizedFx(input);
}
