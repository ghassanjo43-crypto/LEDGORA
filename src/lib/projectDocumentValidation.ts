import type { Account } from '@/types';
import type { Project, ProjectRequirementRule } from '@/types/project';
import { validateProjectRequirement, validateProjectForTransaction } from '@/lib/projectValidation';

export interface DocumentLineForProject {
  accountId: string;
  projectId?: string;
  label?: string;
}

export interface DocumentProjectContext {
  entityId: string;
  postingDate: string;
  transactionType?: string;
  accountsById: Map<string, Account>;
  projectsById: Map<string, Project>;
  requirementRules: ProjectRequirementRule[];
}

export interface DocumentProjectIssue {
  severity: 'error';
  rule: string;
  message: string;
  lineIndex?: number;
}

/**
 * Validate every posting line's project usage BEFORE a source document posts, so a
 * document never passes UI validation then fails during journal creation (§1).
 * Checks required/optional/prohibited account rules and project entity + open-on-date.
 */
export function validateDocumentProjects(lines: DocumentLineForProject[], ctx: DocumentProjectContext): DocumentProjectIssue[] {
  const issues: DocumentProjectIssue[] = [];
  lines.forEach((line, idx) => {
    const account = ctx.accountsById.get(line.accountId);
    const hasProject = !!line.projectId;
    for (const r of validateProjectRequirement(account, hasProject, ctx.requirementRules, ctx.postingDate, ctx.transactionType)) {
      issues.push({ severity: 'error', rule: r.rule, message: `${line.label ? `${line.label}: ` : ''}${r.message}`, lineIndex: idx });
    }
    if (line.projectId) {
      const project = ctx.projectsById.get(line.projectId);
      for (const v of validateProjectForTransaction(project, { entityId: ctx.entityId, postingDate: ctx.postingDate })) {
        issues.push({ severity: 'error', rule: v.rule, message: v.message, lineIndex: idx });
      }
    }
  });
  return issues;
}
