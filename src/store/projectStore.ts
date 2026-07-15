import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Project, ProjectAuditEvent, ProjectChangeOrder, ProjectMilestone, ProjectRequirementRule, ProjectStatus } from '@/types/project';
import { validateProjectForActivation } from '@/lib/projectValidation';
import { SEED_PROJECTS, SEED_PROJECT_REQUIREMENT_RULES, PRIMARY_ENTITY_ID } from '@/data/projectSeed';
import { generateId, nowIso } from '@/lib/utils';

const ACTOR = 'Finance Manager';

export interface ProjectActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function audit(action: string, detail?: string): ProjectAuditEvent {
  return { id: generateId('paud'), at: nowIso(), action, detail, by: ACTOR };
}

function defaultProject(entityId: string): Project {
  const now = nowIso();
  return {
    id: generateId('prj'), entityId, code: '', name: '', status: 'planning',
    startDate: now.slice(0, 10), currencyCode: 'USD', isBillable: true,
    auditTrail: [audit('project-created')], createdAt: now, updatedAt: now, createdBy: ACTOR,
  };
}

interface ProjectState {
  projects: Project[];
  requirementRules: ProjectRequirementRule[];

  getProject: (id: string) => Project | undefined;

  createProject: (patch?: Partial<Project>) => ProjectActionResult;
  updateProject: (id: string, patch: Partial<Project>) => ProjectActionResult;
  setStatus: (id: string, status: ProjectStatus) => ProjectActionResult;
  activateProject: (id: string) => ProjectActionResult;

  upsertRequirementRule: (rule: ProjectRequirementRule) => ProjectActionResult;

  addChangeOrder: (projectId: string, co: Omit<ProjectChangeOrder, 'id'>) => ProjectActionResult;
  approveChangeOrder: (projectId: string, changeOrderId: string) => ProjectActionResult;
  upsertMilestone: (projectId: string, milestone: ProjectMilestone) => ProjectActionResult;
  setMilestoneStatus: (projectId: string, milestoneId: string, status: ProjectMilestone['status']) => ProjectActionResult;

  closeProject: (id: string, opts?: { force?: boolean; canClose?: boolean }) => ProjectActionResult;
  reopenProject: (id: string, reason: string) => ProjectActionResult;

  replaceAll: (state: Partial<Pick<ProjectState, 'projects' | 'requirementRules'>>) => void;
  resetToDefault: () => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: SEED_PROJECTS,
      requirementRules: SEED_PROJECT_REQUIREMENT_RULES,

      getProject: (id) => get().projects.find((p) => p.id === id),

      createProject: (patch) => {
        const project = { ...defaultProject(patch?.entityId ?? PRIMARY_ENTITY_ID), ...patch };
        set({ projects: [...get().projects, project] });
        return { ok: true, id: project.id };
      },

      updateProject: (id, patch) => {
        const { projects } = get();
        const existing = projects.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Project not found.' };
        if (existing.status === 'archived') return { ok: false, error: 'Archived projects cannot be edited.' };
        const changed: string[] = [];
        for (const k of ['code', 'name', 'status', 'startDate', 'endDate', 'budgetAmount', 'managerName'] as const) {
          if (k in patch && JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((existing as unknown as Record<string, unknown>)[k])) changed.push(k);
        }
        const trail = changed.length ? [...existing.auditTrail, audit('project-updated', changed.join(', '))] : existing.auditTrail;
        set({ projects: projects.map((p) => (p.id === id ? { ...existing, ...patch, auditTrail: trail, updatedAt: nowIso(), updatedBy: ACTOR } : p)) });
        return { ok: true, id };
      },

      setStatus: (id, status) => {
        const { projects } = get();
        if (!projects.some((p) => p.id === id)) return { ok: false, error: 'Project not found.' };
        set({ projects: projects.map((p) => (p.id === id ? { ...p, status, auditTrail: [...p.auditTrail, audit(`project-${status}`)], updatedAt: nowIso() } : p)) });
        return { ok: true, id };
      },

      activateProject: (id) => {
        const { projects } = get();
        const project = projects.find((p) => p.id === id);
        if (!project) return { ok: false, error: 'Project not found.' };
        const issues = validateProjectForActivation({ ...project, status: 'active' }, { existing: projects });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        set({ projects: projects.map((p) => (p.id === id ? { ...p, status: 'active', auditTrail: [...p.auditTrail, audit('activated')], updatedAt: nowIso() } : p)) });
        return { ok: true, id };
      },

      upsertRequirementRule: (rule) => {
        const { requirementRules } = get();
        const exists = requirementRules.some((r) => r.id === rule.id);
        set({ requirementRules: exists ? requirementRules.map((r) => (r.id === rule.id ? rule : r)) : [...requirementRules, rule] });
        return { ok: true, id: rule.id };
      },

      addChangeOrder: (projectId, co) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return { ok: false, error: 'Project not found.' };
        const change: ProjectChangeOrder = { ...co, id: generateId('pco') };
        return get().updateProject(projectId, { changeOrders: [...(project.changeOrders ?? []), change] }).ok ? { ok: true, id: change.id } : { ok: false, error: 'Could not add change order.' };
      },
      approveChangeOrder: (projectId, changeOrderId) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return { ok: false, error: 'Project not found.' };
        const changeOrders = (project.changeOrders ?? []).map((c) => (c.id === changeOrderId ? { ...c, status: 'approved' as const, approvedAt: nowIso() } : c));
        set({ projects: get().projects.map((p) => (p.id === projectId ? { ...p, changeOrders, auditTrail: [...p.auditTrail, audit('change-order-approved', changeOrderId)], updatedAt: nowIso() } : p)) });
        return { ok: true, id: changeOrderId };
      },
      upsertMilestone: (projectId, milestone) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return { ok: false, error: 'Project not found.' };
        const list = project.milestones ?? [];
        const milestones = list.some((m) => m.id === milestone.id) ? list.map((m) => (m.id === milestone.id ? milestone : m)) : [...list, milestone];
        return get().updateProject(projectId, { milestones }).ok ? { ok: true, id: milestone.id } : { ok: false, error: 'Could not save milestone.' };
      },
      setMilestoneStatus: (projectId, milestoneId, status) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return { ok: false, error: 'Project not found.' };
        const milestones = (project.milestones ?? []).map((m) => (m.id === milestoneId ? { ...m, status, completedDate: status === 'completed' || status === 'billed' ? (m.completedDate ?? nowIso().slice(0, 10)) : m.completedDate } : m));
        set({ projects: get().projects.map((p) => (p.id === projectId ? { ...p, milestones, updatedAt: nowIso() } : p)) });
        return { ok: true, id: milestoneId };
      },

      closeProject: (id, opts) => {
        const { projects } = get();
        const project = projects.find((p) => p.id === id);
        if (!project) return { ok: false, error: 'Project not found.' };
        if (project.status === 'closed') return { ok: false, error: 'Project is already closed.' };
        // Caller computes the close-out checklist (needs delivery + profitability data).
        if (opts?.canClose === false && !opts?.force) return { ok: false, error: 'Close-out checks are not satisfied — resolve unbilled time/expenses or override.' };
        set({ projects: projects.map((p) => (p.id === id ? { ...p, status: 'closed', auditTrail: [...p.auditTrail, audit('project-closed', opts?.force ? 'override' : undefined)], updatedAt: nowIso() } : p)) });
        return { ok: true, id };
      },
      reopenProject: (id, reason) => {
        const { projects } = get();
        const project = projects.find((p) => p.id === id);
        if (!project) return { ok: false, error: 'Project not found.' };
        if (project.status !== 'closed') return { ok: false, error: 'Only a closed project can be reopened.' };
        if (!reason.trim()) return { ok: false, error: 'A reason is required to reopen a project.' };
        set({ projects: projects.map((p) => (p.id === id ? { ...p, status: 'active', auditTrail: [...p.auditTrail, audit('project-reopened', reason.trim())], updatedAt: nowIso() } : p)) });
        return { ok: true, id };
      },

      replaceAll: (state) => set((s) => ({ ...s, ...state })),
      resetToDefault: () => set({ projects: SEED_PROJECTS.map((p) => ({ ...p })), requirementRules: SEED_PROJECT_REQUIREMENT_RULES.map((r) => ({ ...r })) }),
    }),
    { name: 'ledgerly-projects', version: 2 },
  ),
);
