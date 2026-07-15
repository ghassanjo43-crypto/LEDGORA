import type { Project } from '@/types/project';
import type { ProjectTimeEntry } from '@/types/projectTime';
import type { ProjectExpense } from '@/types/projectExpense';
import type { ProjectCommitment } from '@/types/projectCommitment';
import type { ProjectProfitability } from '@/lib/projectProfitability';

/**
 * Project close-out checklist (§14). Closing blocks new project postings; each
 * check surfaces an outstanding item. A blocking check prevents closing until
 * resolved (or an override is used).
 */
export interface CloseoutCheck {
  key: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail?: string;
}

export interface CloseoutInput {
  project: Project;
  timeEntries: ProjectTimeEntry[];
  expenses: ProjectExpense[];
  commitments: ProjectCommitment[];
  profitability: ProjectProfitability;
}

export function buildCloseoutChecklist(input: CloseoutInput): { checks: CloseoutCheck[]; canClose: boolean } {
  const unbilledTime = input.timeEntries.filter((t) => t.projectId === input.project.id && t.approvalStatus === 'approved' && !t.billed && t.billable);
  const unbilledExp = input.expenses.filter((e) => e.projectId === input.project.id && e.approvalStatus === 'approved' && !e.billed && e.billable);
  const openCommitments = input.commitments.filter((c) => c.projectId === input.project.id && c.status === 'open');
  const p = input.profitability;

  const checks: CloseoutCheck[] = [
    { key: 'unbilled-time', label: 'No unbilled approved time', ok: unbilledTime.length === 0, blocking: true, detail: `${unbilledTime.length} entries` },
    { key: 'unbilled-expenses', label: 'No unbilled approved expenses', ok: unbilledExp.length === 0, blocking: true, detail: `${unbilledExp.length} expenses` },
    { key: 'open-commitments', label: 'Open commitments reviewed', ok: openCommitments.length === 0, blocking: false, detail: `${openCommitments.length} open` },
    { key: 'revenue-recognised', label: 'Revenue recognition completed', ok: Math.abs(p.recognizedRevenue - p.revisedContractValue) < 0.01 || p.revisedContractValue === 0, blocking: false },
    { key: 'receivables', label: 'Outstanding receivables disclosed', ok: true, blocking: false, detail: p.receivableBalance.toFixed(2) },
    { key: 'payables', label: 'Outstanding payables disclosed', ok: true, blocking: false, detail: p.payableBalance.toFixed(2) },
  ];
  return { checks, canClose: checks.filter((c) => c.blocking).every((c) => c.ok) };
}
