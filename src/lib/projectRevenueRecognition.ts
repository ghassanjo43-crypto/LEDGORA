import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { Project } from '@/types/project';
import type { ProjectRecognitionRun, RecognitionPostingConfig } from '@/types/projectRecognition';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { buildContractValueSummary, milestoneBillingSummary } from '@/lib/projectContract';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Revenue-recognition maths (§11). Percentage-of-completion:
 *   completion%  = actual eligible cost / estimated total eligible cost
 *   cumulative   = revised contract value × completion%
 *   current      = cumulative − prior recognised
 * Only the current-period adjustment is posted.
 */

export function calculatePercentageOfCompletion(actualCost: number, estimatedTotalCost: number): number {
  if (!(estimatedTotalCost > 0)) return 0;
  return Math.min(1, Math.max(0, (Number(actualCost) || 0) / estimatedTotalCost));
}

/** GL revenue already recognised for the project up to `asOfDate` (credit − debit on INCOME). */
export function recognizedRevenueToDate(entries: JournalEntry[], accountsById: Map<string, Account>, projectId: string, asOfDate: string, base: string): number {
  let revenue = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.project !== projectId) continue;
    if (entry.entryDate > asOfDate) continue;
    const acc = accountsById.get(line.accountId);
    if (!acc || acc.type !== 'INCOME') continue;
    revenue += convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, base) - convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, base);
  }
  return roundMoney(revenue);
}

export interface RecognitionComputation {
  method: Project['revenueRecognitionMethod'];
  revisedContractValue: number;
  actualCostToDate: number;
  estimatedTotalCost: number;
  completionPercent: number;
  recognizedToDate: number;
  targetCumulative: number;
  currentPeriodAmount: number;
}

export interface RecognitionInput {
  project: Project;
  actualCostToDate: number;
  recognizedToDate: number;
  /** Manual cumulative target (for the manual method). */
  manualCumulative?: number;
}

/** Compute the cumulative target and current-period revenue for a project. */
export function computeRecognition(input: RecognitionInput): RecognitionComputation {
  const { project } = input;
  const contract = buildContractValueSummary(project);
  const revised = contract.revisedContractValue;
  const estimatedTotalCost = roundMoney(project.estimatedTotalCost ?? 0);
  const completion = calculatePercentageOfCompletion(input.actualCostToDate, estimatedTotalCost);
  const method = project.revenueRecognitionMethod ?? 'invoice';

  let target = 0;
  switch (method) {
    case 'percentage-of-completion':
      target = roundMoney(revised * completion);
      break;
    case 'milestone':
      target = milestoneBillingSummary(project).recognizable;
      break;
    case 'cost-recovery':
      target = roundMoney(Math.min(input.actualCostToDate, revised));
      break;
    case 'manual':
      target = roundMoney(input.manualCumulative ?? input.recognizedToDate);
      break;
    case 'invoice':
    default:
      target = roundMoney(input.recognizedToDate); // invoice basis: revenue = as billed, no adjustment
      break;
  }
  return {
    method, revisedContractValue: revised, actualCostToDate: roundMoney(input.actualCostToDate), estimatedTotalCost,
    completionPercent: roundMoney(completion * 100),
    recognizedToDate: roundMoney(input.recognizedToDate),
    targetCumulative: target,
    currentPeriodAmount: roundMoney(target - input.recognizedToDate),
  };
}

/* ─────────────────────────── Posting (§12) ───────────────────────────────── */

function jLine(accountsById: Map<string, Account>, accountId: string, debit: number, credit: number, project: string, memo: string): JournalLineFormValues {
  const acc = accountsById.get(accountId);
  return { accountId, accountCode: acc?.code ?? '', accountName: acc?.name ?? '', description: '', debit: roundMoney(debit), credit: roundMoney(credit), entityId: '', entityName: '', costCenter: '', project, taxCode: '', taxAmount: 0, memo };
}

/**
 * Build the recognition journal for the current-period adjustment:
 *  - recognise more (adjustment > 0): Dr Contract asset / Cr Revenue
 *  - defer (adjustment < 0):          Dr Revenue / Cr Contract liability
 * Balanced, base currency, tagged to the project.
 */
export function buildRecognitionJournalEntry(run: ProjectRecognitionRun, projectCode: string, config: RecognitionPostingConfig, accountsById: Map<string, Account>, baseCurrency = 'USD'): JournalFormValues {
  const amt = run.currentPeriodAmount;
  const lines: JournalLineFormValues[] = [];
  if (amt > 0) {
    lines.push(jLine(accountsById, config.contractAssetAccountId, amt, 0, run.projectId, `Unbilled revenue — ${projectCode}`));
    lines.push(jLine(accountsById, config.revenueAccountId, 0, amt, run.projectId, `Recognised revenue — ${projectCode}`));
  } else {
    const a = -amt;
    lines.push(jLine(accountsById, config.revenueAccountId, a, 0, run.projectId, `Deferred revenue — ${projectCode}`));
    lines.push(jLine(accountsById, config.contractLiabilityAccountId, 0, a, run.projectId, `Deferred revenue — ${projectCode}`));
  }
  return {
    entryNumber: '', entryDate: run.asOfDate, reference: `REVREC-${projectCode}`,
    description: `Revenue recognition ${projectCode} (${run.method}) — ${run.completionPercent}% complete`,
    currency: baseCurrency, exchangeRate: 1, notes: `Cumulative ${run.targetCumulative.toFixed(2)}; period adjustment ${amt.toFixed(2)}.`,
    transactionType: 'Revenue Recognition', createdBy: '', approvedBy: '', lines,
  };
}
