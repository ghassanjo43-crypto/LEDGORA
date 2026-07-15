import type { Account } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { CostCenterAllocationRule, CostCenterAllocationRun, CostCenterAllocationRunLine } from '@/types/costCenterAllocation';
import { allocateAmountAcrossCostCenters } from '@/lib/costCenterAllocation';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Shared-cost allocation run + journal (§12–13). Reallocates a source
 * cost-center balance to target cost centers on the SAME expense account, so the
 * account total is unchanged and the journal nets to zero at the entity level.
 */

export interface BuildRunParams {
  rule: CostCenterAllocationRule;
  sourceAmount: number;
  periodStart: string;
  periodEnd: string;
  postingDate: string;
}

export interface BuildRunResult {
  run: CostCenterAllocationRun;
  ok: boolean;
  error?: string;
}

/** Build a draft allocation run from a rule and the measured source amount. */
export function buildCostCenterAllocationRun(params: BuildRunParams): BuildRunResult {
  const { rule } = params;
  const account = rule.allocationAccountId ?? (rule.sourceAccountIds && rule.sourceAccountIds[0]);
  if (!account) return { run: emptyRun(params), ok: false, error: 'The allocation rule needs a source/allocation account.' };

  const usesFixed = rule.method === 'fixed-amount';
  const source = usesFixed ? roundMoney(rule.targets.reduce((s, t) => s + (Number(t.fixedAmount) || 0), 0)) : roundMoney(params.sourceAmount);

  const assignments = rule.targets
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => (usesFixed ? { costCenterId: t.costCenterId, amount: t.fixedAmount } : { costCenterId: t.costCenterId, percentage: t.percentage }));
  const split = allocateAmountAcrossCostCenters(source, assignments);
  if (!split.ok) return { run: emptyRun(params), ok: false, error: split.error };

  const now = new Date().toISOString();
  const lines: CostCenterAllocationRunLine[] = split.lines.map((l, idx) => ({
    id: `arl-${idx}`, sourceCostCenterId: rule.sourceCostCenterId, sourceAccountId: account,
    targetCostCenterId: l.costCenterId, targetAccountId: account,
    percentage: l.percentage, debitAmount: l.amount, creditAmount: 0,
    memo: `Allocation ${rule.code} → target`,
  }));
  // The single source credit line.
  lines.push({ id: 'arl-source', sourceCostCenterId: rule.sourceCostCenterId, sourceAccountId: account, targetCostCenterId: rule.sourceCostCenterId ?? '', targetAccountId: account, debitAmount: 0, creditAmount: source, memo: `Allocation ${rule.code} — source relief` });

  const run: CostCenterAllocationRun = {
    id: '', entityId: rule.entityId, ruleId: rule.id, periodStart: params.periodStart, periodEnd: params.periodEnd, postingDate: params.postingDate,
    status: 'draft', sourceAmount: source, allocatedAmount: roundMoney(split.lines.reduce((s, l) => s + l.amount, 0)), unallocatedAmount: 0,
    lines, auditTrail: [{ id: 'a', at: now, action: 'allocation-built' }], createdAt: now, updatedAt: now,
  };
  return { run, ok: true };
}

function emptyRun(params: BuildRunParams): CostCenterAllocationRun {
  const now = new Date().toISOString();
  return { id: '', entityId: params.rule.entityId, ruleId: params.rule.id, periodStart: params.periodStart, periodEnd: params.periodEnd, postingDate: params.postingDate, status: 'draft', sourceAmount: 0, allocatedAmount: 0, unallocatedAmount: 0, lines: [], auditTrail: [], createdAt: now, updatedAt: now };
}

function jLine(accountsById: Map<string, Account>, accountId: string, debit: number, credit: number, costCenter: string, memo: string): JournalLineFormValues {
  const acc = accountsById.get(accountId);
  return { accountId, accountCode: acc?.code ?? '', accountName: acc?.name ?? '', description: '', debit: roundMoney(debit), credit: roundMoney(credit), entityId: '', entityName: '', costCenter, project: '', taxCode: '', taxAmount: 0, memo };
}

/**
 * Build the balanced allocation journal: one debit per target cost center and a
 * single credit to the source cost center, all on the same account. Nets to zero
 * at the entity level; only the cost-center dimension shifts.
 */
export function buildCostCenterAllocationJournal(run: CostCenterAllocationRun, rule: CostCenterAllocationRule, accountsById: Map<string, Account>, baseCurrency = 'USD'): JournalFormValues {
  const lines: JournalLineFormValues[] = [];
  for (const l of run.lines) {
    if (l.debitAmount > 0) lines.push(jLine(accountsById, l.targetAccountId, l.debitAmount, 0, l.targetCostCenterId, l.memo ?? `Allocation ${rule.code}`));
  }
  for (const l of run.lines) {
    if (l.creditAmount > 0) lines.push(jLine(accountsById, l.sourceAccountId, 0, l.creditAmount, l.sourceCostCenterId ?? '', l.memo ?? `Allocation ${rule.code}`));
  }
  return {
    entryNumber: '', entryDate: run.postingDate, reference: `ALLOC-${rule.code}`,
    description: `Cost allocation ${rule.code} — ${rule.name}`, currency: baseCurrency, exchangeRate: 1,
    notes: `Shared-cost reallocation. Source ${run.sourceAmount.toFixed(2)}.`, transactionType: 'Cost Allocation', createdBy: '', approvedBy: '', lines,
  };
}
