/** Right-aligned amount formatting for the Trial Balance (blank when zero). */
const NF = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function tbAmount(n: number): string {
  return Math.abs(n) < 0.005 ? '' : NF.format(n);
}

/** Always render a figure (used in totals/footers where 0.00 is meaningful). */
export function tbAmountAlways(n: number): string {
  return NF.format(n || 0);
}
