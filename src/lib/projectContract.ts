import type { Project, ProjectChangeOrder } from '@/types/project';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Contract-value maths (§9). Approved change orders REVISE the contract value
 * without rewriting the original — the original contract value is preserved and
 * the revised value is derived.
 */

export interface ContractValueSummary {
  originalContractValue: number;
  approvedRevenueChange: number;
  approvedCostChange: number;
  revisedContractValue: number;
  scheduleImpactDays: number;
}

function approved(changeOrders: ProjectChangeOrder[] = []): ProjectChangeOrder[] {
  return changeOrders.filter((c) => c.status === 'approved');
}

export function buildContractValueSummary(project: Project): ContractValueSummary {
  const original = roundMoney(project.contractValue ?? 0);
  const cos = approved(project.changeOrders);
  const revenueChange = roundMoney(cos.reduce((s, c) => s + (Number(c.revenueChange) || 0), 0));
  const costChange = roundMoney(cos.reduce((s, c) => s + (Number(c.costChange) || 0), 0));
  return {
    originalContractValue: original,
    approvedRevenueChange: revenueChange,
    approvedCostChange: costChange,
    revisedContractValue: roundMoney(original + revenueChange),
    scheduleImpactDays: cos.reduce((s, c) => s + (Number(c.scheduleImpactDays) || 0), 0),
  };
}

/** Total milestone billing amount and completed/billed amount. */
export function milestoneBillingSummary(project: Project): { total: number; completed: number; billed: number; recognizable: number } {
  const ms = project.milestones ?? [];
  const total = roundMoney(ms.reduce((s, m) => s + (Number(m.billingAmount) || 0), 0));
  const completed = roundMoney(ms.filter((m) => m.status === 'completed' || m.status === 'billed').reduce((s, m) => s + (Number(m.billingAmount) || 0), 0));
  const billed = roundMoney(ms.filter((m) => m.status === 'billed').reduce((s, m) => s + (Number(m.billingAmount) || 0), 0));
  const recognizable = roundMoney(ms.filter((m) => m.status === 'completed' || m.status === 'billed').reduce((s, m) => s + (Number(m.recognitionAmount ?? m.billingAmount) || 0), 0));
  return { total, completed, billed, recognizable };
}
