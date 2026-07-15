import type { Account } from '@/types';
import type { CostCenter, CostCenterRequirement, CostCenterRequirementRule } from '@/types/costCenter';

/**
 * Cost-center requirement resolution (§26) and default resolution (§27).
 * Requirement priority: account-specific rule → account-type rule → optional.
 */

function ruleActive(rule: CostCenterRequirementRule, date: string): boolean {
  return rule.status === 'active' && rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date);
}

export interface RequirementResolution {
  requirement: CostCenterRequirement;
  source: 'account' | 'account-type' | 'transaction-type' | 'default';
}

/** Resolve whether a cost center is required/optional/prohibited for an account. */
export function resolveCostCenterRequirement(
  account: Account | undefined,
  rules: CostCenterRequirementRule[],
  date: string,
  transactionType?: string,
): RequirementResolution {
  const active = rules.filter((r) => ruleActive(r, date));
  if (account) {
    const byAccount = active.find((r) => r.accountIds?.includes(account.id));
    if (byAccount) return { requirement: byAccount.requirement, source: 'account' };
  }
  if (transactionType) {
    const byTxn = active.find((r) => r.transactionTypes?.includes(transactionType));
    if (byTxn) return { requirement: byTxn.requirement, source: 'transaction-type' };
  }
  if (account) {
    const byType = active.find((r) => r.accountTypeIds?.includes(account.type));
    if (byType) return { requirement: byType.requirement, source: 'account-type' };
  }
  return { requirement: 'optional', source: 'default' };
}

export interface RequirementIssue {
  severity: 'error';
  rule: string;
  message: string;
}

/** Validate a line's cost-center presence against the resolved requirement. */
export function validateCostCenterRequirement(
  account: Account | undefined,
  hasCostCenter: boolean,
  rules: CostCenterRequirementRule[],
  date: string,
  transactionType?: string,
): RequirementIssue[] {
  const { requirement } = resolveCostCenterRequirement(account, rules, date, transactionType);
  const label = account ? `${account.code} ${account.name}` : 'this line';
  if (requirement === 'required' && !hasCostCenter) return [{ severity: 'error', rule: 'required', message: `A cost center is required for ${label}.` }];
  if (requirement === 'prohibited' && hasCostCenter) return [{ severity: 'error', rule: 'prohibited', message: `A cost center is not allowed on ${label}.` }];
  return [];
}

/* ───────────────────────── Default resolution ───────────────────────────── */

export type CostCenterDefaultSource = 'explicit' | 'product' | 'employee' | 'supplier' | 'customer' | 'project' | 'department' | 'account' | 'entity' | 'none';

export interface DefaultCostCenterResolution {
  costCenterId?: string;
  source: CostCenterDefaultSource;
}

export interface ResolveDefaultParams {
  explicitCostCenterId?: string;
  productCostCenterId?: string;
  employeeCostCenterId?: string;
  partyCostCenterId?: string;
  partyKind?: 'supplier' | 'customer';
  projectCostCenterId?: string;
  departmentCostCenterId?: string;
  accountDefaultCostCenterId?: string;
  entityDefaultCostCenterId?: string;
}

/** Resolve the default cost center by priority (§27). Never overrides an explicit selection. */
export function resolveDefaultCostCenter(params: ResolveDefaultParams): DefaultCostCenterResolution {
  if (params.explicitCostCenterId) return { costCenterId: params.explicitCostCenterId, source: 'explicit' };
  if (params.productCostCenterId) return { costCenterId: params.productCostCenterId, source: 'product' };
  if (params.employeeCostCenterId) return { costCenterId: params.employeeCostCenterId, source: 'employee' };
  if (params.partyCostCenterId) return { costCenterId: params.partyCostCenterId, source: params.partyKind === 'customer' ? 'customer' : 'supplier' };
  if (params.projectCostCenterId) return { costCenterId: params.projectCostCenterId, source: 'project' };
  if (params.departmentCostCenterId) return { costCenterId: params.departmentCostCenterId, source: 'department' };
  if (params.accountDefaultCostCenterId) return { costCenterId: params.accountDefaultCostCenterId, source: 'account' };
  if (params.entityDefaultCostCenterId) return { costCenterId: params.entityDefaultCostCenterId, source: 'entity' };
  return { source: 'none' };
}

/** Selectable posting cost centers active on a date. */
export function selectablePostingCostCenters(centers: CostCenter[], date: string, includeInactive = false): CostCenter[] {
  return centers.filter((c) => {
    if (!c.isPostingAllowed) return false;
    if (includeInactive) return true;
    if (c.status !== 'active') return false;
    if (c.effectiveFrom > date) return false;
    if (c.effectiveTo && c.effectiveTo < date) return false;
    return true;
  });
}
