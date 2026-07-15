import type { CostCenterAssignment } from '@/types/costCenter';
import { allocateAmountAcrossCostCenters } from '@/lib/costCenterAllocation';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Shared cost-center line-posting helper. Expands a single source line amount into
 * one or more cost-center-tagged amounts, preserving the original total exactly
 * (the final split line absorbs any rounding residual). Used by invoice, bill,
 * credit-note and supplier-credit posting so the split logic lives in ONE place.
 */

export interface LineCostCenterInput {
  costCenterId?: string;
  costCenterAssignments?: CostCenterAssignment[];
}

export interface CostCenterAmount {
  costCenterId: string;
  amount: number;
}

/** True when the line carries a real multi-target split. */
export function hasCostCenterSplit(input: LineCostCenterInput): boolean {
  return (input.costCenterAssignments?.filter((a) => a.costCenterId).length ?? 0) > 0;
}

/**
 * Expand a line amount into cost-center amounts:
 *  - split assignments → allocated pro-rata (or by fixed amount), summing to `amount`
 *  - single costCenterId → one entry
 *  - none → one untagged entry (empty costCenterId)
 */
export function expandLineCostCenters(amount: number, input: LineCostCenterInput): CostCenterAmount[] {
  const total = roundMoney(amount);
  const assignments = input.costCenterAssignments?.filter((a) => a.costCenterId) ?? [];
  if (assignments.length > 0) {
    const split = allocateAmountAcrossCostCenters(total, assignments);
    return split.lines.map((l) => ({ costCenterId: l.costCenterId, amount: l.amount }));
  }
  return [{ costCenterId: input.costCenterId ?? '', amount: total }];
}
