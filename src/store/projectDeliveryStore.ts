import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { ProjectTimeEntry } from '@/types/projectTime';
import type { ProjectExpense } from '@/types/projectExpense';
import type { ProjectCommitment } from '@/types/projectCommitment';
import { roundMoney } from '@/lib/journalValidation';
import { generateId, nowIso } from '@/lib/utils';

export interface DeliveryActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

interface DeliveryState {
  timeEntries: ProjectTimeEntry[];
  expenses: ProjectExpense[];
  commitments: ProjectCommitment[];

  /* Time */
  addTimeEntry: (input: { projectId: string; employeeName: string; date: string; hours: number; billingRate: number; costRate: number; billable?: boolean; activity?: string; description?: string }) => DeliveryActionResult;
  approveTime: (id: string) => DeliveryActionResult;
  billTime: (ids: string[], invoiceId: string) => DeliveryActionResult;
  unbilledApprovedTime: (projectId: string) => ProjectTimeEntry[];

  /* Expenses */
  addExpense: (input: { projectId: string; date: string; description: string; amount: number; billable?: boolean; markupPercent?: number; sourceBillId?: string; sourcePaymentId?: string }) => DeliveryActionResult;
  approveExpense: (id: string) => DeliveryActionResult;
  billExpense: (ids: string[], invoiceId: string) => DeliveryActionResult;
  unbilledApprovedExpenses: (projectId: string) => ProjectExpense[];

  /* Commitments */
  addCommitment: (input: { projectId: string; type: ProjectCommitment['type']; reference: string; committedAmount: number; date: string; description?: string }) => DeliveryActionResult;
  recordCommitmentInvoiced: (id: string, amount: number) => DeliveryActionResult;
  closeCommitment: (id: string) => DeliveryActionResult;
  openCommitment: (projectId: string) => number;

  replaceAll: (state: Partial<Pick<DeliveryState, 'timeEntries' | 'expenses' | 'commitments'>>) => void;
  resetToDefault: () => void;
}

export const useProjectDeliveryStore = create<DeliveryState>()(
  persist(
    (set, get) => ({
      timeEntries: [],
      expenses: [],
      commitments: [],

      addTimeEntry: (input) => {
        const now = nowIso();
        const hours = Number(input.hours) || 0;
        const entry: ProjectTimeEntry = {
          id: generateId('ptime'), projectId: input.projectId, employeeName: input.employeeName, date: input.date, hours,
          activity: input.activity, description: input.description, billable: input.billable ?? true, approvalStatus: 'draft',
          billingRate: Number(input.billingRate) || 0, costRate: Number(input.costRate) || 0,
          billableAmount: roundMoney(hours * (Number(input.billingRate) || 0)), costAmount: roundMoney(hours * (Number(input.costRate) || 0)),
          billed: false, createdAt: now, updatedAt: now,
        };
        set({ timeEntries: [...get().timeEntries, entry] });
        return { ok: true, id: entry.id };
      },
      approveTime: (id) => {
        const { timeEntries } = get();
        if (!timeEntries.some((t) => t.id === id)) return { ok: false, error: 'Time entry not found.' };
        set({ timeEntries: timeEntries.map((t) => (t.id === id ? { ...t, approvalStatus: 'approved', updatedAt: nowIso() } : t)) });
        return { ok: true, id };
      },
      billTime: (ids, invoiceId) => {
        const { timeEntries } = get();
        const target = timeEntries.filter((t) => ids.includes(t.id));
        if (target.some((t) => t.billed)) return { ok: false, error: 'One or more time entries are already billed (duplicate billing blocked).' };
        if (target.some((t) => t.approvalStatus !== 'approved')) return { ok: false, error: 'Only approved time entries can be billed.' };
        set({ timeEntries: timeEntries.map((t) => (ids.includes(t.id) ? { ...t, billed: true, invoiceId, updatedAt: nowIso() } : t)) });
        return { ok: true };
      },
      unbilledApprovedTime: (projectId) => get().timeEntries.filter((t) => t.projectId === projectId && t.approvalStatus === 'approved' && !t.billed && t.billable),

      addExpense: (input) => {
        const now = nowIso();
        const amount = roundMoney(Number(input.amount) || 0);
        const markup = 1 + (Number(input.markupPercent) || 0) / 100;
        const expense: ProjectExpense = {
          id: generateId('pexp'), projectId: input.projectId, date: input.date, description: input.description, amount,
          billable: input.billable ?? true, markupPercent: input.markupPercent, billableAmount: roundMoney(amount * markup),
          approvalStatus: 'draft', sourceBillId: input.sourceBillId, sourcePaymentId: input.sourcePaymentId, billed: false, createdAt: now, updatedAt: now,
        };
        set({ expenses: [...get().expenses, expense] });
        return { ok: true, id: expense.id };
      },
      approveExpense: (id) => {
        const { expenses } = get();
        if (!expenses.some((e) => e.id === id)) return { ok: false, error: 'Expense not found.' };
        set({ expenses: expenses.map((e) => (e.id === id ? { ...e, approvalStatus: 'approved', updatedAt: nowIso() } : e)) });
        return { ok: true, id };
      },
      billExpense: (ids, invoiceId) => {
        const { expenses } = get();
        const target = expenses.filter((e) => ids.includes(e.id));
        if (target.some((e) => e.billed)) return { ok: false, error: 'One or more expenses are already billed (duplicate billing blocked).' };
        if (target.some((e) => e.approvalStatus !== 'approved')) return { ok: false, error: 'Only approved expenses can be billed.' };
        set({ expenses: expenses.map((e) => (ids.includes(e.id) ? { ...e, billed: true, invoiceId, updatedAt: nowIso() } : e)) });
        return { ok: true };
      },
      unbilledApprovedExpenses: (projectId) => get().expenses.filter((e) => e.projectId === projectId && e.approvalStatus === 'approved' && !e.billed && e.billable),

      addCommitment: (input) => {
        const now = nowIso();
        const commitment: ProjectCommitment = { id: generateId('pcom'), projectId: input.projectId, type: input.type, reference: input.reference, description: input.description, committedAmount: roundMoney(input.committedAmount), invoicedAmount: 0, date: input.date, status: 'open', createdAt: now, updatedAt: now };
        set({ commitments: [...get().commitments, commitment] });
        return { ok: true, id: commitment.id };
      },
      recordCommitmentInvoiced: (id, amount) => {
        const { commitments } = get();
        const c = commitments.find((x) => x.id === id);
        if (!c) return { ok: false, error: 'Commitment not found.' };
        const invoicedAmount = roundMoney(Math.min(c.committedAmount, c.invoicedAmount + (Number(amount) || 0)));
        set({ commitments: commitments.map((x) => (x.id === id ? { ...x, invoicedAmount, status: invoicedAmount >= c.committedAmount - 0.005 ? 'closed' : 'open', updatedAt: nowIso() } : x)) });
        return { ok: true, id };
      },
      closeCommitment: (id) => {
        const { commitments } = get();
        if (!commitments.some((x) => x.id === id)) return { ok: false, error: 'Commitment not found.' };
        set({ commitments: commitments.map((x) => (x.id === id ? { ...x, status: 'closed', updatedAt: nowIso() } : x)) });
        return { ok: true, id };
      },
      openCommitment: (projectId) => roundMoney(get().commitments.filter((c) => c.projectId === projectId && c.status === 'open').reduce((s, c) => s + Math.max(0, c.committedAmount - c.invoicedAmount), 0)),

      replaceAll: (state) => set((s) => ({ ...s, ...state })),
      resetToDefault: () => set({ timeEntries: [], expenses: [], commitments: [] }),
    }),
    { name: 'ledgerly-project-delivery', storage: businessJSONStorage, version: 1 },
  ),
);
