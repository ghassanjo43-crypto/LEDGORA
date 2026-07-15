import type { Account } from '@/types';
import type { Project, ProjectRequirement, ProjectRequirementRule } from '@/types/project';

export interface ProjectIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

/** Case-insensitive duplicate-code check within an entity. */
export function checkDuplicateProjectCode(projects: Project[], code: string, entityId: string, excludeId?: string): boolean {
  const norm = code.trim().toLowerCase();
  return projects.some((p) => p.id !== excludeId && p.entityId === entityId && p.code.trim().toLowerCase() === norm);
}

/** Drafts may be incomplete — only flag corrupt data. */
export function validateProjectDraft(project: Pick<Project, 'budgetAmount'>): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  if (project.budgetAmount !== undefined && Number(project.budgetAmount) < 0) issues.push({ severity: 'error', rule: 'budget', message: 'Budget cannot be negative.' });
  return issues;
}

export interface ProjectActivationContext {
  existing: Project[];
}

/** Full activation validation: unique code, name, dates. */
export function validateProjectForActivation(project: Project, ctx: ProjectActivationContext): ProjectIssue[] {
  const issues: ProjectIssue[] = [...validateProjectDraft(project)];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });
  if (!project.entityId) err('entity', 'An entity is required.');
  if (!project.code.trim()) err('code', 'A project code is required.');
  else if (checkDuplicateProjectCode(ctx.existing, project.code, project.entityId, project.id)) err('code-unique', `Project code "${project.code}" already exists in this entity.`);
  if (!project.name.trim()) err('name', 'A project name is required.');
  if (!project.startDate) err('start', 'A start date is required.');
  if (project.endDate && project.endDate < project.startDate) err('date-range', 'End date cannot precede start date.');
  return issues;
}

export function canActivateProject(project: Project, ctx: ProjectActivationContext): boolean {
  return validateProjectForActivation(project, ctx).every((i) => i.severity !== 'error');
}

/** A project is usable on a transaction when open and within its date window. */
export function isProjectActiveOnDate(project: Project | undefined, date: string): boolean {
  if (!project) return false;
  if (project.status === 'archived' || project.status === 'cancelled' || project.status === 'completed' || project.status === 'closed') return false;
  if (project.startDate > date) return false;
  if (project.endDate && project.endDate < date) return false;
  return true;
}

export interface ProjectTransactionContext {
  entityId: string;
  postingDate: string;
}

/** Validate a project is usable on a transaction line. */
export function validateProjectForTransaction(project: Project | undefined, ctx: ProjectTransactionContext): ProjectIssue[] {
  if (!project) return [{ severity: 'error', rule: 'missing', message: 'The selected project no longer exists.' }];
  const issues: ProjectIssue[] = [];
  if (project.entityId !== ctx.entityId) issues.push({ severity: 'error', rule: 'entity', message: `Project ${project.code} belongs to a different entity.` });
  if (!isProjectActiveOnDate(project, ctx.postingDate)) issues.push({ severity: 'error', rule: 'inactive', message: `Project ${project.code} is not open on ${ctx.postingDate}.` });
  return issues;
}

/* ─────────────────────── Requirement rules (§1) ──────────────────────────── */

function ruleActive(rule: ProjectRequirementRule, date: string): boolean {
  return rule.status === 'active' && rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date);
}

/** Resolve the project requirement for an account (account rule → txn type → account type → optional). */
export function resolveProjectRequirement(account: Account | undefined, rules: ProjectRequirementRule[], date: string, transactionType?: string): ProjectRequirement {
  const active = rules.filter((r) => ruleActive(r, date));
  if (account) {
    const byAccount = active.find((r) => r.accountIds?.includes(account.id));
    if (byAccount) return byAccount.requirement;
  }
  if (transactionType) {
    const byTxn = active.find((r) => r.transactionTypes?.includes(transactionType));
    if (byTxn) return byTxn.requirement;
  }
  if (account) {
    const byType = active.find((r) => r.accountTypeIds?.includes(account.type));
    if (byType) return byType.requirement;
  }
  return 'optional';
}

/** Validate a line's project presence against the resolved requirement. */
export function validateProjectRequirement(account: Account | undefined, hasProject: boolean, rules: ProjectRequirementRule[], date: string, transactionType?: string): ProjectIssue[] {
  const requirement = resolveProjectRequirement(account, rules, date, transactionType);
  const label = account ? `${account.code} ${account.name}` : 'this line';
  if (requirement === 'required' && !hasProject) return [{ severity: 'error', rule: 'required', message: `A project is required for ${label}.` }];
  if (requirement === 'prohibited' && hasProject) return [{ severity: 'error', rule: 'prohibited', message: `A project is not allowed on ${label}.` }];
  return [];
}
