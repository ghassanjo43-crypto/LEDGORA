/**
 * Project budgets — versioned (scenario) monthly lines by cost category.
 * Management data only (never posted). Approved budgets are immutable (§2).
 */

export type ProjectBudgetScenario = 'original' | 'approved' | 'forecast' | 'reforecast' | 'custom';
export type ProjectBudgetStatus = 'draft' | 'submitted' | 'approved' | 'locked' | 'archived';
export type ProjectBudgetCategory = 'revenue' | 'labor' | 'materials' | 'subcontract' | 'travel' | 'overhead' | 'equipment' | 'other';

export const PROJECT_BUDGET_CATEGORIES: ProjectBudgetCategory[] = ['revenue', 'labor', 'materials', 'subcontract', 'travel', 'overhead', 'equipment', 'other'];

export interface ProjectBudgetLine {
  id: string;
  category: ProjectBudgetCategory;
  /** 1–12. */
  month: number;
  amount: number;
  accountId?: string;
  notes?: string;
}

export interface ProjectBudget {
  id: string;
  entityId: string;
  projectId: string;

  name: string;
  fiscalYear: number;
  scenario: ProjectBudgetScenario;
  currencyCode: string;

  status: ProjectBudgetStatus;

  lines: ProjectBudgetLine[];

  auditTrail: { id: string; at: string; action: string; detail?: string }[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
