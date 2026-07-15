/** Billable project expense (§7). Links a source bill/payment rather than duplicating accounting. */
export type ExpenseApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface ProjectExpense {
  id: string;
  projectId: string;
  date: string;
  description: string;
  amount: number;
  billable: boolean;
  markupPercent?: number;
  billableAmount: number;
  approvalStatus: ExpenseApprovalStatus;
  /** Source accounting record — the expense reuses it, never duplicating the transaction. */
  sourceBillId?: string;
  sourcePaymentId?: string;
  invoiceId?: string;
  billed: boolean;
  createdAt: string;
  updatedAt: string;
}
