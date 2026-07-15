import type { Account } from '@/types';
import type { CostCenter, CostCenterAssignment, CostCenterRequirementRule } from '@/types/costCenter';
import { validateCostCenterRequirement } from '@/lib/costCenterResolution';
import { validateCostCenterForTransaction } from '@/lib/costCenterValidation';
import { validateCostCenterSplit } from '@/lib/costCenterAllocation';

export interface DocumentLineForCc {
  accountId: string;
  /** Net line amount that the cost center is applied to (revenue/expense taxable amount). */
  amount: number;
  costCenterId?: string;
  costCenterAssignments?: CostCenterAssignment[];
  label?: string;
}

export interface DocumentCcContext {
  entityId: string;
  postingDate: string;
  transactionType?: string;
  accountsById: Map<string, Account>;
  costCentersById: Map<string, CostCenter>;
  requirementRules: CostCenterRequirementRule[];
}

export interface DocumentCcIssue {
  severity: 'error';
  rule: string;
  message: string;
  lineIndex?: number;
}

/**
 * Validate every posting line's cost-center usage BEFORE a source document posts,
 * so a document never passes UI validation and then fails silently during journal
 * creation (§7). Checks: required/optional/prohibited account rules, cost-center
 * entity + active-on-date + posting-allowed, and exact split reconciliation.
 */
export function validateDocumentCostCenters(lines: DocumentLineForCc[], ctx: DocumentCcContext): DocumentCcIssue[] {
  const issues: DocumentCcIssue[] = [];
  lines.forEach((line, idx) => {
    const account = ctx.accountsById.get(line.accountId);
    const assignments = line.costCenterAssignments?.filter((a) => a.costCenterId) ?? [];
    const split = assignments.length > 0;
    const ids = split ? assignments.map((a) => a.costCenterId) : line.costCenterId ? [line.costCenterId] : [];
    const hasCc = ids.length > 0;

    // Account requirement rule (required / optional / prohibited).
    for (const r of validateCostCenterRequirement(account, hasCc, ctx.requirementRules, ctx.postingDate, ctx.transactionType)) {
      issues.push({ severity: 'error', rule: r.rule, message: `${line.label ? `${line.label}: ` : ''}${r.message}`, lineIndex: idx });
    }

    // Each selected cost center must be usable on this document.
    for (const id of ids) {
      const cc = ctx.costCentersById.get(id);
      for (const v of validateCostCenterForTransaction(cc, { entityId: ctx.entityId, postingDate: ctx.postingDate })) {
        issues.push({ severity: 'error', rule: v.rule, message: v.message, lineIndex: idx });
      }
    }

    // Split totals must reconcile exactly to the line amount.
    if (split) {
      for (const s of validateCostCenterSplit(line.amount, assignments)) {
        if (s.severity === 'error') issues.push({ severity: 'error', rule: s.rule, message: `${line.label ? `${line.label}: ` : ''}${s.message}`, lineIndex: idx });
      }
    }
  });
  return issues;
}
