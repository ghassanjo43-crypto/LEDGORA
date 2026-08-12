import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { CostCenter, CostCenterAuditEvent, CostCenterRequirementRule, CostCenterType } from '@/types/costCenter';
import { moveCostCenter as moveInTree } from '@/lib/costCenterHierarchy';
import { validateCostCenterForActivation } from '@/lib/costCenterValidation';
import { SEED_COST_CENTERS, SEED_REQUIREMENT_RULES, PRIMARY_ENTITY_ID } from '@/data/costCenterSeed';
import { generateId, nowIso } from '@/lib/utils';
import type { OrganizationRole } from '@/types/roles';
import { assertCostCenterPermission } from '@/lib/costCenterPermissions';
import { getCurrentUser } from '@/store/authStore';
import { isPlatformAdminFullAccess } from '@/store/platformFullAccess';

const ACTOR = 'Finance Manager';

/** Effective organization role. Same resolution as every other module store. */
function currentRole(): OrganizationRole {
  if (isPlatformAdminFullAccess()) return 'admin';
  return getCurrentUser()?.role ?? 'owner';
}

/** Whether the current role may open new cost centers. UI affordances only. */
export function canCreateCostCenter(): boolean {
  return assertCostCenterPermission(currentRole(), 'cost_centers.create').ok;
}

export interface CostCenterActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function audit(action: string, detail?: string): CostCenterAuditEvent {
  return { id: generateId('ccaud'), at: nowIso(), action, detail, by: ACTOR };
}

function defaultCostCenter(entityId: string): CostCenter {
  const now = nowIso();
  return {
    id: generateId('cc'), entityId, code: '', name: '', type: 'operating', status: 'inactive',
    hierarchyPath: [], level: 0, sortOrder: 0, effectiveFrom: now.slice(0, 10),
    isPostingAllowed: true, isBudgetEnabled: true, isAllocationSource: false, isAllocationTarget: true,
    auditTrail: [audit('cost-center-created')], createdAt: now, updatedAt: now, createdBy: ACTOR,
  };
}

interface CostCenterState {
  costCenters: CostCenter[];
  requirementRules: CostCenterRequirementRule[];

  getCostCenter: (id: string) => CostCenter | undefined;
  centersForEntity: (entityId: string) => CostCenter[];

  createCostCenter: (patch?: Partial<CostCenter>) => CostCenterActionResult;
  updateCostCenter: (id: string, patch: Partial<CostCenter>) => CostCenterActionResult;
  setStatus: (id: string, status: CostCenter['status']) => CostCenterActionResult;
  moveCostCenter: (id: string, newParentId: string | undefined) => CostCenterActionResult;
  activateCostCenter: (id: string) => CostCenterActionResult;

  upsertRequirementRule: (rule: CostCenterRequirementRule) => CostCenterActionResult;

  /** Append imported cost centers (from a committed dry-run) and re-path. */
  importCostCenters: (created: CostCenter[]) => CostCenterActionResult;

  replaceAll: (state: Partial<Pick<CostCenterState, 'costCenters' | 'requirementRules'>>) => void;
  resetToDefault: () => void;
}

/** Recompute hierarchyPath + level for the whole set (parents before children). */
function recomputePaths(centers: CostCenter[]): CostCenter[] {
  const byId = new Map(centers.map((c) => [c.id, { ...c }]));
  const resolve = (c: CostCenter, guard: Set<string>): { path: string[]; level: number } => {
    if (!c.parentId || guard.has(c.id)) return { path: [c.id], level: 0 };
    const parent = byId.get(c.parentId);
    if (!parent) return { path: [c.id], level: 0 };
    guard.add(c.id);
    const p = resolve(parent, guard);
    return { path: [...p.path, c.id], level: p.level + 1 };
  };
  for (const c of byId.values()) { const r = resolve(c, new Set()); c.hierarchyPath = r.path; c.level = r.level; }
  return [...byId.values()];
}

export const useCostCenterStore = create<CostCenterState>()(
  persist(
    (set, get) => ({
      costCenters: SEED_COST_CENTERS,
      requirementRules: SEED_REQUIREMENT_RULES,

      getCostCenter: (id) => get().costCenters.find((c) => c.id === id),
      centersForEntity: (entityId) => get().costCenters.filter((c) => c.entityId === entityId),

      createCostCenter: (patch) => {
        // The gate lives on the WRITE, so it holds however the action is reached.
        const permitted = assertCostCenterPermission(currentRole(), 'cost_centers.create');
        if (!permitted.ok) return { ok: false, error: permitted.error };
        const cc = { ...defaultCostCenter(patch?.entityId ?? PRIMARY_ENTITY_ID), ...patch };
        set({ costCenters: recomputePaths([...get().costCenters, cc]) });
        return { ok: true, id: cc.id };
      },

      updateCostCenter: (id, patch) => {
        const { costCenters } = get();
        const existing = costCenters.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Cost center not found.' };
        if (existing.status === 'archived') return { ok: false, error: 'Archived cost centers cannot be edited.' };
        const changed: string[] = [];
        for (const k of ['code', 'name', 'parentId', 'managerName', 'isPostingAllowed', 'effectiveFrom', 'effectiveTo'] as const) {
          if (k in patch && JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((existing as unknown as Record<string, unknown>)[k])) changed.push(k);
        }
        const trail = changed.length ? [...existing.auditTrail, audit('cost-center-updated', changed.join(', '))] : existing.auditTrail;
        const merged = { ...existing, ...patch, auditTrail: trail, updatedAt: nowIso(), updatedBy: ACTOR };
        set({ costCenters: recomputePaths(costCenters.map((c) => (c.id === id ? merged : c))) });
        return { ok: true, id };
      },

      setStatus: (id, status) => {
        const { costCenters } = get();
        const existing = costCenters.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Cost center not found.' };
        set({ costCenters: costCenters.map((c) => (c.id === id ? { ...c, status, auditTrail: [...c.auditTrail, audit(`cost-center-${status}`)], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      moveCostCenter: (id, newParentId) => {
        const res = moveInTree(get().costCenters, id, newParentId);
        if (!res.ok) return { ok: false, error: res.error };
        const withAudit = res.centers.map((c) => (c.id === id ? { ...c, auditTrail: [...c.auditTrail, audit('parent-changed', newParentId ?? 'root')], updatedAt: nowIso() } : c));
        set({ costCenters: withAudit });
        return { ok: true, id };
      },

      activateCostCenter: (id) => {
        const { costCenters } = get();
        const cc = costCenters.find((c) => c.id === id);
        if (!cc) return { ok: false, error: 'Cost center not found.' };
        const issues = validateCostCenterForActivation({ ...cc, status: 'active' }, { existing: costCenters });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        set({ costCenters: costCenters.map((c) => (c.id === id ? { ...c, status: 'active', auditTrail: [...c.auditTrail, audit('activated')], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      upsertRequirementRule: (rule) => {
        const { requirementRules } = get();
        const exists = requirementRules.some((r) => r.id === rule.id);
        set({ requirementRules: exists ? requirementRules.map((r) => (r.id === rule.id ? rule : r)) : [...requirementRules, rule] });
        return { ok: true, id: rule.id };
      },

      importCostCenters: (created) => {
        if (created.length === 0) return { ok: false, error: 'No cost centers to import.' };
        set({ costCenters: recomputePaths([...get().costCenters, ...created]) });
        return { ok: true, id: `${created.length}` };
      },

      replaceAll: (state) => set((s) => ({ ...s, ...state })),
      resetToDefault: () => set({ costCenters: SEED_COST_CENTERS.map((c) => ({ ...c })), requirementRules: SEED_REQUIREMENT_RULES.map((r) => ({ ...r })) }),
    }),
    { name: 'ledgerly-cost-centers', storage: businessJSONStorage, version: 1 },
  ),
);

export type { CostCenterType };
