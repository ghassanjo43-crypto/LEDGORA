/**
 * Cost-center budgets — management data only (never posted to the General
 * Ledger). Monthly values with an annual roll-up, compared against posted actuals.
 */

export type BudgetScenario = 'base' | 'approved' | 'forecast' | 'reforecast' | 'custom';
export type BudgetStatus = 'draft' | 'submitted' | 'approved' | 'locked' | 'archived';

export interface CostCenterBudgetLine {
  id: string;
  costCenterId: string;
  accountId: string;
  /** 1–12. */
  month: number;
  amount: number;
  notes?: string;
}

export interface CostCenterBudget {
  id: string;
  entityId: string;

  name: string;
  fiscalYear: number;
  scenario: BudgetScenario;
  currencyCode: string;

  status: BudgetStatus;

  lines: CostCenterBudgetLine[];

  auditTrail: { id: string; at: string; action: string; detail?: string }[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
