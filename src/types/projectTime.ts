/** Project time record (§6). Billing & cost rates are frozen; billing prevents duplicates. */
export type TimeApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface ProjectTimeEntry {
  id: string;
  projectId: string;
  employeeName: string;
  date: string;
  hours: number;
  activity?: string;
  description?: string;
  billable: boolean;
  approvalStatus: TimeApprovalStatus;
  /** Frozen at entry. */
  billingRate: number;
  costRate: number;
  billableAmount: number;
  costAmount: number;
  invoiceId?: string;
  billed: boolean;
  createdAt: string;
  updatedAt: string;
}
