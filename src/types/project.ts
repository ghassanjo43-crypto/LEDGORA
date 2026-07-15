/**
 * Project domain types. A project is a management-reporting dimension for a
 * temporary initiative, contract or job — distinct from a cost center (which is
 * the responsible organisational unit). All actual values derive from posted
 * journal lines tagged with the project id (`line.project`); no separate balances.
 */

export type ProjectStatus = 'planning' | 'active' | 'on-hold' | 'completed' | 'cancelled' | 'archived' | 'closed';

export type BillingMethod = 'fixed-price' | 'time-and-materials' | 'cost-plus' | 'milestone' | 'progress' | 'retainer' | 'non-billable';

export type RevenueRecognitionMethod = 'invoice' | 'milestone' | 'percentage-of-completion' | 'cost-recovery' | 'manual';

/** A contract change order — revises the contract value without rewriting the original (§9). */
export interface ProjectChangeOrder {
  id: string;
  number: string;
  description?: string;
  revenueChange: number;
  costChange: number;
  scheduleImpactDays?: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  date: string;
  approvedAt?: string;
}

/** A billing/recognition milestone (§9). */
export interface ProjectMilestone {
  id: string;
  name: string;
  plannedDate?: string;
  completedDate?: string;
  status: 'planned' | 'in-progress' | 'completed' | 'billed';
  billingAmount: number;
  recognitionAmount?: number;
  invoiceId?: string;
}

export interface ProjectAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
  by?: string;
}

export interface Project {
  id: string;
  entityId: string;

  code: string;
  name: string;
  description?: string;

  status: ProjectStatus;

  /** Optional link to the customer the project is delivered for. */
  customerId?: string;
  managerName?: string;

  startDate: string;
  endDate?: string;

  /** Optional overall budget for the project (management data, never posted). */
  budgetAmount?: number;
  currencyCode?: string;

  /** Original signed contract value; change orders revise it without rewriting it (§9). */
  contractValue?: number;
  /** How revenue is recognised for this project (§11). */
  revenueRecognitionMethod?: RevenueRecognitionMethod;
  /** Estimated total eligible cost — the denominator for percentage-of-completion. */
  estimatedTotalCost?: number;

  billingMethod?: BillingMethod;
  /** Markup % for cost-plus / billable expenses. */
  markupPercent?: number;

  isBillable?: boolean;

  changeOrders?: ProjectChangeOrder[];
  milestones?: ProjectMilestone[];

  auditTrail: ProjectAuditEvent[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/** Frozen project identity captured on a posted line (historical reporting). */
export interface ProjectSnapshot {
  projectId: string;
  code: string;
  name: string;
  capturedAt: string;
}

/** Requirement policy for the project dimension by account / type / transaction. */
export type ProjectRequirement = 'required' | 'optional' | 'prohibited';

export interface ProjectRequirementRule {
  id: string;
  entityId: string;
  accountIds?: string[];
  accountTypeIds?: string[];
  transactionTypes?: string[];
  requirement: ProjectRequirement;
  effectiveFrom: string;
  effectiveTo?: string;
  status: 'active' | 'inactive';
}
