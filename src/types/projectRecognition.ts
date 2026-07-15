import type { RevenueRecognitionMethod } from '@/types/project';

/**
 * A revenue-recognition run for a project (§11–12). Computes the current-period
 * revenue adjustment (target cumulative − already-recognised) and posts a
 * balanced journal through the existing journal service, with an exact reversal.
 */
export type RecognitionRunStatus = 'draft' | 'posted' | 'reversed';

export interface ProjectRecognitionRun {
  id: string;
  projectId: string;
  method: RevenueRecognitionMethod;
  asOfDate: string;

  revisedContractValue: number;
  actualCostToDate: number;
  estimatedTotalCost: number;
  completionPercent: number;

  recognizedToDate: number; // already in the GL before this run
  targetCumulative: number;
  currentPeriodAmount: number; // + recognises more revenue, − defers

  status: RecognitionRunStatus;
  journalEntryId?: string;
  reversalJournalEntryId?: string;

  createdAt: string;
  updatedAt: string;
  postedAt?: string;
  reversedAt?: string;
}

/** Chart-of-accounts routing for recognition postings. */
export interface RecognitionPostingConfig {
  revenueAccountId: string;
  /** Unbilled revenue / contract asset (WIP). */
  contractAssetAccountId: string;
  /** Deferred revenue / contract liability. */
  contractLiabilityAccountId: string;
}
