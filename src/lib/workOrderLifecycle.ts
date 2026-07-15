/**
 * Work-order lifecycle state machine.
 *
 *   draft → planned → released → in-progress → partially-completed → completed → closed
 *   planned/released/in-progress → on-hold ; on-hold → released/in-progress
 *   draft/planned → cancelled
 *
 * `released`+ statuses may only be reached through `releaseWorkOrder` (which
 * snapshots BOM/routing/rates); this table governs the manual transitions.
 */
import type { WorkOrderStatus } from '@/types/manufacturingDocuments';

const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['released', 'on-hold', 'cancelled'],
  released: ['in-progress', 'on-hold'],
  'in-progress': ['partially-completed', 'completed', 'on-hold'],
  'partially-completed': ['completed', 'in-progress', 'on-hold'],
  completed: ['closed'],
  closed: [],
  'on-hold': ['released', 'in-progress'],
  cancelled: [],
};

export function canTransition(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedTransitions(from: WorkOrderStatus): WorkOrderStatus[] {
  return [...(TRANSITIONS[from] ?? [])];
}

/** Statuses that permit posting production activity (issue/receipt/scrap). */
export function acceptsProductionActivity(status: WorkOrderStatus): boolean {
  return status === 'released' || status === 'in-progress' || status === 'partially-completed';
}

/** Derive the completion status from posted vs planned quantity. */
export function completionStatus(planned: number, completed: number, current: WorkOrderStatus): WorkOrderStatus {
  if (current === 'closed' || current === 'cancelled') return current;
  if (completed <= 0) return current === 'released' ? 'released' : 'in-progress';
  if (completed >= planned) return 'completed';
  return 'partially-completed';
}
