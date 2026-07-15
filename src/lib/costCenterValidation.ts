import type { CostCenter } from '@/types/costCenter';
import { checkDuplicateCostCenterCode, isCostCenterActiveOnDate, validateCostCenterHierarchy } from '@/lib/costCenterHierarchy';

export interface CostCenterIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

/** Drafts may be incomplete — only flag corrupt data. */
export function validateCostCenterDraft(center: Pick<CostCenter, 'sortOrder'>): CostCenterIssue[] {
  const issues: CostCenterIssue[] = [];
  if (Number(center.sortOrder) < 0) issues.push({ severity: 'error', rule: 'sort', message: 'Sort order cannot be negative.' });
  return issues;
}

export interface ActivationContext {
  existing: CostCenter[];
}

/** Full activation validation (§52): unique code, name, type, dates, valid parent, no cycle. */
export function validateCostCenterForActivation(center: CostCenter, ctx: ActivationContext): CostCenterIssue[] {
  const issues: CostCenterIssue[] = [...validateCostCenterDraft(center)];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });
  if (!center.entityId) err('entity', 'An entity is required.');
  if (!center.code.trim()) err('code', 'A cost-center code is required.');
  else if (checkDuplicateCostCenterCode(ctx.existing, center.code, center.entityId, center.id)) err('code-unique', `Cost-center code "${center.code}" already exists in this entity.`);
  if (!center.name.trim()) err('name', 'A cost-center name is required.');
  if (!center.type) err('type', 'A cost-center type is required.');
  if (!center.effectiveFrom) err('effective-from', 'An effective-from date is required.');
  if (center.effectiveTo && center.effectiveTo < center.effectiveFrom) err('effective-range', 'Effective-to cannot precede effective-from.');
  for (const h of validateCostCenterHierarchy(ctx.existing, center, center.parentId)) issues.push(h);
  return issues;
}

export function canActivateCostCenter(center: CostCenter, ctx: ActivationContext): boolean {
  return validateCostCenterForActivation(center, ctx).every((i) => i.severity !== 'error');
}

export interface TransactionContext {
  entityId: string;
  postingDate: string;
}

/** Validate a cost center is usable on a transaction line (§52). */
export function validateCostCenterForTransaction(center: CostCenter | undefined, ctx: TransactionContext): CostCenterIssue[] {
  if (!center) return [{ severity: 'error', rule: 'missing', message: 'The selected cost center no longer exists.' }];
  const issues: CostCenterIssue[] = [];
  if (center.entityId !== ctx.entityId) issues.push({ severity: 'error', rule: 'entity', message: `Cost center ${center.code} belongs to a different entity.` });
  if (center.status === 'archived') issues.push({ severity: 'error', rule: 'archived', message: `Cost center ${center.code} is archived and cannot be used on new transactions.` });
  else if (!isCostCenterActiveOnDate(center, ctx.postingDate)) issues.push({ severity: 'error', rule: 'inactive', message: `Cost center ${center.code} is not active on ${ctx.postingDate}.` });
  if (!center.isPostingAllowed) issues.push({ severity: 'error', rule: 'summary', message: `Cost center ${center.code} is a summary node — posting is not allowed.` });
  return issues;
}
