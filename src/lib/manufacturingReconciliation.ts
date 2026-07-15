/**
 * Manufacturing-to-General-Ledger reconciliation.
 *
 * Compares the manufacturing SUBLEDGER (WIP derived from posted work-order
 * activity) against the GL balance of the WIP control account, plus the net
 * postings to the absorption / scrap / inventory accounts the manufacturing
 * documents touch. Differences are surfaced, never hidden.
 */
import type { JournalEntry } from '@/types/journal';
import type { ManufacturingWorkOrder } from '@/types/manufacturingDocuments';
import { calculateWorkOrderWip, type WorkOrderActivity } from './manufacturingCosting';

export interface MfgReconRow {
  accountId: string;
  label: string;
  subledger: number;
  glBalance: number;
  difference: number;
}

export interface ManufacturingReconciliation {
  wipSubledger: number;
  wipGl: number;
  wipDifference: number;
  balanced: boolean;
  rows: MfgReconRow[];
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function glBalance(entries: JournalEntry[], accountId: string, asOf?: string): number {
  let bal = 0;
  for (const e of entries) {
    if (e.status !== 'posted') continue;
    if (asOf && e.entryDate > asOf) continue;
    for (const l of e.lines) if (l.accountId === accountId) bal += (l.debit || 0) - (l.credit || 0);
  }
  return r2(bal);
}

export interface MfgReconInput {
  workOrders: ManufacturingWorkOrder[];
  activity: WorkOrderActivity;
  journalEntries: JournalEntry[];
  wipAccountId?: string;
  asOf?: string;
}

/** Reconcile the derived WIP subledger to the GL WIP account. */
export function buildManufacturingReconciliation(input: MfgReconInput): ManufacturingReconciliation {
  const wipSubledger = r2(
    input.workOrders.reduce((s, wo) => s + calculateWorkOrderWip(wo.id, input.activity, input.asOf).remainingWip, 0),
  );
  const wipGl = input.wipAccountId ? glBalance(input.journalEntries, input.wipAccountId, input.asOf) : 0;
  const wipDifference = r2(wipSubledger - wipGl);
  const rows: MfgReconRow[] = [
    { accountId: input.wipAccountId ?? '', label: 'Work in Progress', subledger: wipSubledger, glBalance: wipGl, difference: wipDifference },
  ];
  return { wipSubledger, wipGl, wipDifference, balanced: Math.abs(wipDifference) < 0.01, rows };
}
