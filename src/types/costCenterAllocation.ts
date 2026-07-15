/**
 * Shared-cost allocation across cost centers. A run reallocates a source
 * cost-center balance to target cost centers via a balanced journal that nets to
 * zero at the entity level (§13, §60).
 */

export type CostCenterAllocationMethod =
  | 'percentage'
  | 'fixed-amount'
  | 'headcount'
  | 'floor-area'
  | 'revenue'
  | 'usage'
  | 'units-produced'
  | 'custom-driver';

export type AllocationRuleStatus = 'draft' | 'active' | 'inactive' | 'archived';
export type AllocationRunStatus = 'draft' | 'reviewed' | 'posted' | 'reversed';
export type AllocationFrequency = 'manual' | 'monthly' | 'quarterly' | 'annual';

export interface CostCenterAllocationTarget {
  costCenterId: string;
  percentage?: number;
  fixedAmount?: number;
  driverValue?: number;
  sortOrder: number;
}

export interface CostCenterAllocationRule {
  id: string;
  entityId: string;

  code: string;
  name: string;
  description?: string;

  status: AllocationRuleStatus;

  sourceCostCenterId?: string;
  sourceAccountIds?: string[];
  sourceAccountTypeIds?: string[];

  method: CostCenterAllocationMethod;
  targets: CostCenterAllocationTarget[];

  frequency: AllocationFrequency;

  effectiveFrom: string;
  effectiveTo?: string;

  /** The expense/clearing account the allocation debits/credits (default: the source account). */
  allocationAccountId?: string;
  clearingAccountId?: string;

  createdAt: string;
  updatedAt: string;
}

export interface CostCenterAllocationRunLine {
  id: string;
  sourceCostCenterId?: string;
  sourceAccountId: string;
  targetCostCenterId: string;
  targetAccountId: string;
  basisValue?: number;
  percentage?: number;
  debitAmount: number;
  creditAmount: number;
  memo?: string;
}

export interface CostCenterAllocationRun {
  id: string;
  entityId: string;
  ruleId: string;

  periodStart: string;
  periodEnd: string;
  postingDate: string;

  status: AllocationRunStatus;

  sourceAmount: number;
  allocatedAmount: number;
  unallocatedAmount: number;

  lines: CostCenterAllocationRunLine[];

  journalEntryId?: string;
  reversalJournalEntryId?: string;

  auditTrail: { id: string; at: string; action: string; detail?: string }[];
  createdAt: string;
  updatedAt: string;
  postedAt?: string;
  reversedAt?: string;
}
