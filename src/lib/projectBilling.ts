import type { Project } from '@/types/project';
import type { ProjectTimeEntry } from '@/types/projectTime';
import type { ProjectExpense } from '@/types/projectExpense';
import { buildContractValueSummary, milestoneBillingSummary } from '@/lib/projectContract';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Billing calculators (§8). These SUGGEST an amount to bill; the actual customer
 * invoice is always created through the existing invoice module (no second invoice
 * engine). Fixed price is capped at the revised contract less already billed;
 * cost-plus applies markup; time & materials sums billable time + expenses.
 */

export interface BillingSuggestion {
  method: Project['billingMethod'];
  amount: number;
  timeAmount: number;
  expenseAmount: number;
  note?: string;
}

export interface BillingInput {
  project: Project;
  timeEntries: ProjectTimeEntry[];
  expenses: ProjectExpense[];
  /** Amount already billed on the contract to date (for the fixed-price cap). */
  alreadyBilled: number;
}

const approvedUnbilledTime = (entries: ProjectTimeEntry[]): ProjectTimeEntry[] => entries.filter((t) => t.approvalStatus === 'approved' && !t.billed && t.billable);
const approvedUnbilledExpenses = (expenses: ProjectExpense[]): ProjectExpense[] => expenses.filter((e) => e.approvalStatus === 'approved' && !e.billed && e.billable);

/** Time-and-materials: Σ billable time + Σ billable expenses (with markup). */
export function calculateTimeAndMaterials(input: BillingInput): BillingSuggestion {
  const timeAmount = roundMoney(approvedUnbilledTime(input.timeEntries).reduce((s, t) => s + t.billableAmount, 0));
  const expenseAmount = roundMoney(approvedUnbilledExpenses(input.expenses).reduce((s, e) => s + e.billableAmount, 0));
  return { method: 'time-and-materials', amount: roundMoney(timeAmount + expenseAmount), timeAmount, expenseAmount };
}

/** Cost-plus: (unbilled approved cost) × (1 + markup%). Time uses cost rate; expenses use raw cost. */
export function calculateCostPlus(input: BillingInput): BillingSuggestion {
  const timeCost = approvedUnbilledTime(input.timeEntries).reduce((s, t) => s + t.costAmount, 0);
  const expenseCost = approvedUnbilledExpenses(input.expenses).reduce((s, e) => s + e.amount, 0);
  const markup = 1 + (Number(input.project.markupPercent) || 0) / 100;
  const timeAmount = roundMoney(timeCost * markup);
  const expenseAmount = roundMoney(expenseCost * markup);
  return { method: 'cost-plus', amount: roundMoney(timeAmount + expenseAmount), timeAmount, expenseAmount, note: `Markup ${input.project.markupPercent ?? 0}%` };
}

/** Fixed-price: suggest the remaining contract value, capped so total billing never exceeds the revised contract. */
export function calculateFixedPrice(input: BillingInput): BillingSuggestion {
  const revised = buildContractValueSummary(input.project).revisedContractValue;
  const remaining = roundMoney(Math.max(0, revised - roundMoney(input.alreadyBilled)));
  return { method: 'fixed-price', amount: remaining, timeAmount: 0, expenseAmount: 0, note: `Capped at revised contract ${revised.toFixed(2)}` };
}

/** Milestone: Σ completed-not-yet-billed milestone amounts. */
export function calculateMilestoneBilling(project: Project): BillingSuggestion {
  const ms = milestoneBillingSummary(project);
  return { method: 'milestone', amount: roundMoney(ms.completed - ms.billed), timeAmount: 0, expenseAmount: 0 };
}

/** Suggest a billing amount using the project's configured billing method. */
export function buildProjectBillingSuggestion(input: BillingInput): BillingSuggestion {
  switch (input.project.billingMethod) {
    case 'time-and-materials': return calculateTimeAndMaterials(input);
    case 'cost-plus': return calculateCostPlus(input);
    case 'fixed-price':
    case 'progress': return calculateFixedPrice(input);
    case 'milestone': return calculateMilestoneBilling(input.project);
    case 'retainer': return { method: 'retainer', amount: 0, timeAmount: 0, expenseAmount: 0, note: 'Retainer billing is scheduled, not usage-based.' };
    case 'non-billable':
    default: return { method: input.project.billingMethod ?? 'non-billable', amount: 0, timeAmount: 0, expenseAmount: 0 };
  }
}
