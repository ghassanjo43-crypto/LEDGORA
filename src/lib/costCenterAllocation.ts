import type { CostCenterAssignment } from '@/types/costCenter';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Split-allocation maths (§8–9). Distributing one amount across cost centers must
 * always preserve the original total — the final line absorbs any rounding
 * residual so the parts sum exactly to the source amount.
 */

export interface AllocatedLine {
  costCenterId: string;
  amount: number;
  percentage: number;
}

export interface SplitResult {
  lines: AllocatedLine[];
  total: number;
  ok: boolean;
  error?: string;
}

const TOLERANCE = 0.005;

/**
 * Allocate `total` across assignments. Percentage assignments distribute pro-rata
 * (last line absorbs the residual); fixed-amount assignments are used directly.
 */
export function allocateAmountAcrossCostCenters(total: number, assignments: CostCenterAssignment[], precision = 2): SplitResult {
  const src = roundMoney(Number(total) || 0);
  const usesPercentage = assignments.some((a) => a.percentage !== undefined && a.percentage !== null);
  const lines: AllocatedLine[] = [];

  if (usesPercentage) {
    let running = 0;
    assignments.forEach((a, idx) => {
      const pct = Number(a.percentage) || 0;
      const isLast = idx === assignments.length - 1;
      const amount = isLast ? roundMoney(src - running) : roundMoney((src * pct) / 100);
      running = roundMoney(running + amount);
      lines.push({ costCenterId: a.costCenterId, amount, percentage: pct });
    });
  } else {
    for (const a of assignments) {
      const amount = roundMoney(Number(a.amount) || 0);
      lines.push({ costCenterId: a.costCenterId, amount, percentage: src === 0 ? 0 : roundMoney((amount / src) * 100) });
    }
  }

  const sum = roundMoney(lines.reduce((s, l) => s + l.amount, 0));
  void precision;
  return { lines, total: sum, ok: Math.abs(sum - src) <= TOLERANCE, error: Math.abs(sum - src) > TOLERANCE ? `Split total (${sum.toFixed(2)}) does not equal the source amount (${src.toFixed(2)}).` : undefined };
}

export interface SplitIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

/** Validate a cost-center split (§9): percentages total 100 or fixed amounts total the source. */
export function validateCostCenterSplit(total: number, assignments: CostCenterAssignment[]): SplitIssue[] {
  const issues: SplitIssue[] = [];
  if (assignments.length === 0) return issues;
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });

  for (const a of assignments) {
    if (!a.costCenterId) err('missing-cc', 'Every split line needs a cost center.');
    if (a.percentage !== undefined && Number(a.percentage) < 0) err('negative-pct', 'Percentages cannot be negative.');
    if (a.percentage !== undefined && Number(a.percentage) > 100) err('over-100', 'A single percentage cannot exceed 100%.');
    if (a.amount !== undefined && Number(a.amount) < 0) err('negative-amount', 'Split amounts cannot be negative.');
  }
  const dupes = new Set<string>();
  for (const a of assignments) { if (dupes.has(a.costCenterId)) err('duplicate', 'A cost center appears more than once in the split.'); dupes.add(a.costCenterId); }

  const usesPercentage = assignments.some((a) => a.percentage !== undefined);
  if (usesPercentage) {
    const pctTotal = roundMoney(assignments.reduce((s, a) => s + (Number(a.percentage) || 0), 0));
    if (Math.abs(pctTotal - 100) > 0.01) err('pct-total', `Split percentages total ${pctTotal}% — they must total 100%.`);
  } else {
    const amtTotal = roundMoney(assignments.reduce((s, a) => s + (Number(a.amount) || 0), 0));
    if (Math.abs(amtTotal - roundMoney(total)) > TOLERANCE) err('amount-total', `Split amounts total ${amtTotal.toFixed(2)} — they must total the source amount ${roundMoney(total).toFixed(2)}.`);
  }
  return issues;
}
