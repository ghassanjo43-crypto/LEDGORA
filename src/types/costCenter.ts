/**
 * Cost Center domain types — the centralized master data for the cost-center
 * reporting dimension. A cost center is NOT an account: it is a dimension tagged
 * onto posted journal activity. All actual values derive from posted journal
 * lines (never a separate balance store).
 */

export type CostCenterStatus = 'active' | 'inactive' | 'archived';

export type CostCenterType =
  | 'operating'
  | 'administrative'
  | 'sales'
  | 'production'
  | 'service'
  | 'support'
  | 'shared'
  | 'corporate'
  | 'custom';

export interface CostCenterAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
  by?: string;
}

export interface CostCenter {
  id: string;
  entityId: string;

  code: string;
  name: string;
  description?: string;

  type: CostCenterType;
  status: CostCenterStatus;

  parentId?: string;
  hierarchyPath: string[];
  level: number;
  sortOrder: number;

  managerUserId?: string;
  managerName?: string;

  effectiveFrom: string;
  effectiveTo?: string;

  defaultCurrencyCode?: string;

  isPostingAllowed: boolean;
  isBudgetEnabled: boolean;
  isAllocationSource: boolean;
  isAllocationTarget: boolean;

  reportingGroupId?: string;
  departmentId?: string;

  notes?: string;

  auditTrail: CostCenterAuditEvent[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/** A single cost-center tag on a line (100% for a simple assignment). */
export interface CostCenterAssignment {
  costCenterId: string;
  percentage?: number;
  amount?: number;
}

/** Requirement policy for cost centers by account / account-type / transaction. */
export type CostCenterRequirement = 'required' | 'optional' | 'prohibited';

export interface CostCenterRequirementRule {
  id: string;
  entityId: string;

  accountIds?: string[];
  accountTypeIds?: string[];
  transactionTypes?: string[];

  requirement: CostCenterRequirement;

  effectiveFrom: string;
  effectiveTo?: string;

  status: 'active' | 'inactive';
}

/** Frozen cost-center identity captured on a posted line (§47). */
export interface CostCenterSnapshot {
  costCenterId: string;
  code: string;
  name: string;
  hierarchyPath: string[];
  capturedAt: string;
}
