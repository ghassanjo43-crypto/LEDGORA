import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProjectBudget, ProjectBudgetCategory, ProjectBudgetLine, ProjectBudgetScenario } from '@/types/projectBudget';
import { isDuplicateProjectBudgetLine } from '@/lib/projectBudget';
import { roundMoney } from '@/lib/journalValidation';
import { generateId, nowIso } from '@/lib/utils';
import { PRIMARY_ENTITY_ID } from '@/data/projectSeed';

export interface ProjectBudgetActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const EDITABLE: ProjectBudget['status'][] = ['draft', 'submitted'];

interface ProjectBudgetState {
  budgets: ProjectBudget[];

  getBudget: (id: string) => ProjectBudget | undefined;
  budgetsForProject: (projectId: string) => ProjectBudget[];

  createBudget: (patch: Partial<ProjectBudget> & { projectId: string }) => ProjectBudgetActionResult;
  approveBudget: (id: string) => ProjectBudgetActionResult;
  lockBudget: (id: string) => ProjectBudgetActionResult;

  upsertLine: (budgetId: string, line: ProjectBudgetLine) => ProjectBudgetActionResult;
  removeLine: (budgetId: string, lineId: string) => ProjectBudgetActionResult;
  spreadAnnual: (budgetId: string, category: ProjectBudgetCategory, annualAmount: number, accountId?: string) => ProjectBudgetActionResult;
  applyGrowth: (budgetId: string, percent: number) => ProjectBudgetActionResult;
  copyFrom: (sourceId: string, scenario: ProjectBudgetScenario, name: string) => ProjectBudgetActionResult;

  replaceAll: (budgets: ProjectBudget[]) => void;
  resetToDefault: () => void;
}

export const useProjectBudgetStore = create<ProjectBudgetState>()(
  persist(
    (set, get) => ({
      budgets: [],

      getBudget: (id) => get().budgets.find((b) => b.id === id),
      budgetsForProject: (projectId) => get().budgets.filter((b) => b.projectId === projectId),

      createBudget: (patch) => {
        const now = nowIso();
        const budget: ProjectBudget = {
          id: generateId('pbud'), entityId: patch.entityId ?? PRIMARY_ENTITY_ID, projectId: patch.projectId,
          name: patch.name ?? 'Project budget', fiscalYear: patch.fiscalYear ?? new Date().getFullYear(),
          scenario: patch.scenario ?? 'original', currencyCode: patch.currencyCode ?? 'USD', status: 'draft', lines: patch.lines ?? [],
          auditTrail: [{ id: generateId('a'), at: now, action: 'budget-created' }], createdAt: now, updatedAt: now,
        };
        set({ budgets: [...get().budgets, budget] });
        return { ok: true, id: budget.id };
      },

      approveBudget: (id) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === id);
        if (!b) return { ok: false, error: 'Budget not found.' };
        const now = nowIso();
        set({ budgets: budgets.map((x) => (x.id === id ? { ...x, status: 'approved', approvedAt: now, auditTrail: [...x.auditTrail, { id: generateId('a'), at: now, action: 'budget-approved' }], updatedAt: now } : x)) });
        return { ok: true, id };
      },
      lockBudget: (id) => {
        const { budgets } = get();
        if (!budgets.some((x) => x.id === id)) return { ok: false, error: 'Budget not found.' };
        set({ budgets: budgets.map((x) => (x.id === id ? { ...x, status: 'locked', auditTrail: [...x.auditTrail, { id: generateId('a'), at: nowIso(), action: 'budget-locked' }], updatedAt: nowIso() } : x)) });
        return { ok: true, id };
      },

      upsertLine: (budgetId, line) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === budgetId);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'An approved or locked budget is immutable.' };
        if (line.month < 1 || line.month > 12) return { ok: false, error: 'Month must be 1–12.' };
        if (isDuplicateProjectBudgetLine(b.lines, line)) return { ok: false, error: 'A budget line already exists for this category, account and month.' };
        const exists = b.lines.some((l) => l.id === line.id);
        const lines = exists ? b.lines.map((l) => (l.id === line.id ? line : l)) : [...b.lines, line];
        set({ budgets: budgets.map((x) => (x.id === budgetId ? { ...x, lines, updatedAt: nowIso() } : x)) });
        return { ok: true, id: line.id };
      },

      removeLine: (budgetId, lineId) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === budgetId);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'Cannot edit an approved/locked budget.' };
        set({ budgets: budgets.map((x) => (x.id === budgetId ? { ...x, lines: x.lines.filter((l) => l.id !== lineId), updatedAt: nowIso() } : x)) });
        return { ok: true, id: lineId };
      },

      spreadAnnual: (budgetId, category, annualAmount, accountId) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === budgetId);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'Cannot edit an approved/locked budget.' };
        const monthly = roundMoney(annualAmount / 12);
        const kept = b.lines.filter((l) => !(l.category === category && (l.accountId ?? '') === (accountId ?? '')));
        const spread: ProjectBudgetLine[] = [];
        let running = 0;
        for (let m = 1; m <= 12; m++) {
          const amount = m === 12 ? roundMoney(annualAmount - running) : monthly;
          running = roundMoney(running + amount);
          spread.push({ id: generateId('pbl'), category, month: m, amount, accountId });
        }
        set({ budgets: budgets.map((x) => (x.id === budgetId ? { ...x, lines: [...kept, ...spread], updatedAt: nowIso() } : x)) });
        return { ok: true, id: budgetId };
      },

      applyGrowth: (budgetId, percent) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === budgetId);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'Cannot edit an approved/locked budget.' };
        const factor = 1 + (Number(percent) || 0) / 100;
        set({ budgets: budgets.map((x) => (x.id === budgetId ? { ...x, lines: x.lines.map((l) => ({ ...l, amount: roundMoney(l.amount * factor) })), updatedAt: nowIso() } : x)) });
        return { ok: true, id: budgetId };
      },

      copyFrom: (sourceId, scenario, name) => {
        const src = get().budgets.find((b) => b.id === sourceId);
        if (!src) return { ok: false, error: 'Source budget not found.' };
        return get().createBudget({ projectId: src.projectId, entityId: src.entityId, fiscalYear: src.fiscalYear, currencyCode: src.currencyCode, scenario, name, lines: src.lines.map((l) => ({ ...l, id: generateId('pbl') })) });
      },

      replaceAll: (budgets) => set({ budgets }),
      resetToDefault: () => set({ budgets: [] }),
    }),
    { name: 'ledgerly-project-budgets', version: 1 },
  ),
);
