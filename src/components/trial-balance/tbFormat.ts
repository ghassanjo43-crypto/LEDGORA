/** Right-aligned amount formatting for the Trial Balance (blank when zero). */
import { companyMonetaryDecimals, smallestUnit, companyCurrencyCode } from '@/lib/monetaryPrecision';

/**
 * A number formatter at the ACTIVE COMPANY's monetary precision.
 *
 * Built per call, never captured at module load: a captured formatter freezes
 * the first company's precision for the whole session, so opening a USD company
 * after a JOD one would keep showing three decimals (and the reverse would drop
 * a fils).
 */
function moneyFormat(): Intl.NumberFormat {
  const decimals = companyMonetaryDecimals();
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Below half the currency's smallest unit — genuinely nothing to show. */
function isEffectivelyZero(n: number): boolean {
  return Math.abs(n) < smallestUnit(companyCurrencyCode()) / 2;
}

export function tbAmount(n: number): string {
  return isEffectivelyZero(n) ? '' : moneyFormat().format(n);
}

/** Always render a figure (used in totals/footers where zero is meaningful). */
export function tbAmountAlways(n: number): string {
  return moneyFormat().format(n || 0);
}
