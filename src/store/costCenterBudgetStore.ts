import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { CostCenterBudget, CostCenterBudgetLine } from '@/types/costCenterBudget';
import { isDuplicateBudgetLine } from '@/lib/costCenterBudget';
import { roundMoney } from '@/lib/journalValidation';
import { generateId, nowIso } from '@/lib/utils';
import { PRIMARY_ENTITY_ID } from '@/data/costCenterSeed';

export interface BudgetActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

interface BudgetState {
  budgets: CostCenterBudget[];

  getBudget: (id: string) => CostCenterBudget | undefined;

  createBudget: (patch?: Partial<CostCenterBudget>) => BudgetActionResult;
  updateBudget: (id: string, patch: Partial<CostCenterBudget>) => BudgetActionResult;
  approveBudget: (id: string) => BudgetActionResult;
  lockBudget: (id: string) => BudgetActionResult;

  upsertLine: (budgetId: string, line: CostCenterBudgetLine) => BudgetActionResult;
  removeLine: (budgetId: string, lineId: string) => BudgetActionResult;
  /** Spread an annual amount evenly across the 12 months for a cost center + account. */
  spreadAnnual: (budgetId: string, costCenterId: string, accountId: string, annualAmount: number) => BudgetActionResult;

  replaceAll: (budgets: CostCenterBudget[]) => void;
  resetToDefault: () => void;
}

const EDITABLE: CostCenterBudget['status'][] = ['draft', 'submitted'];

export const useCostCenterBudgetStore = create<BudgetState>()(
  persist(
    (set, get) => ({
      budgets: [],

      getBudget: (id) => get().budgets.find((b) => b.id === id),

      createBudget: (patch) => {
        const now = nowIso();
        const budget: CostCenterBudget = {
          id: generateId('ccb'), entityId: PRIMARY_ENTITY_ID, name: patch?.name ?? 'Budget', fiscalYear: patch?.fiscalYear ?? new Date().getFullYear(),
          scenario: patch?.scenario ?? 'base', currencyCode: patch?.currencyCode ?? 'USD', status: 'draft', lines: patch?.lines ?? [],
          auditTrail: [{ id: generateId('a'), at: now, action: 'budget-created' }], createdAt: now, updatedAt: now,
        };
        set({ budgets: [...get().budgets, budget] });
        return { ok: true, id: budget.id };
      },

      updateBudget: (id, patch) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === id);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'An approved or locked budget is immutable.' };
        set({ budgets: budgets.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: nowIso() } : x)) });
        return { ok: true, id };
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
        const b = budgets.find((x) => x.id === id);
        if (!b) return { ok: false, error: 'Budget not found.' };
        set({ budgets: budgets.map((x) => (x.id === id ? { ...x, status: 'locked', auditTrail: [...x.auditTrail, { id: generateId('a'), at: nowIso(), action: 'budget-locked' }], updatedAt: nowIso() } : x)) });
        return { ok: true, id };
      },

      upsertLine: (budgetId, line) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === budgetId);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'Cannot edit lines on an approved/locked budget.' };
        if (line.month < 1 || line.month > 12) return { ok: false, error: 'Month must be 1–12.' };
        if (isDuplicateBudgetLine(b.lines, line)) return { ok: false, error: 'A budget line already exists for this cost center, account and month.' };
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

      spreadAnnual: (budgetId, costCenterId, accountId, annualAmount) => {
        const { budgets } = get();
        const b = budgets.find((x) => x.id === budgetId);
        if (!b) return { ok: false, error: 'Budget not found.' };
        if (!EDITABLE.includes(b.status)) return { ok: false, error: 'Cannot edit an approved/locked budget.' };
        const monthly = roundMoney(annualAmount / 12);
        const kept = b.lines.filter((l) => !(l.costCenterId === costCenterId && l.accountId === accountId));
        const spread: CostCenterBudgetLine[] = [];
        let running = 0;
        for (let m = 1; m <= 12; m++) {
          const amount = m === 12 ? roundMoney(annualAmount - running) : monthly;
          running = roundMoney(running + amount);
          spread.push({ id: generateId('ccbl'), costCenterId, accountId, month: m, amount });
        }
        set({ budgets: budgets.map((x) => (x.id === budgetId ? { ...x, lines: [...kept, ...spread], updatedAt: nowIso() } : x)) });
        return { ok: true, id: budgetId };
      },

      replaceAll: (budgets) => set({ budgets }),
      resetToDefault: () => set({ budgets: [] }),
    }),
    { name: 'ledgerly-cost-center-budgets', storage: businessJSONStorage, version: 1 },
  ),
);
