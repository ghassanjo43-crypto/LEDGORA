/**
 * Period-end currency revaluation of foreign monetary balances. A run computes
 * the unrealized FX per monetary balance, produces a balanced journal through the
 * existing journal service, and supports an exact reversal.
 */

export type RevaluationStatus = 'draft' | 'reviewed' | 'posted' | 'reversed';

export interface CurrencyRevaluationLine {
  id: string;

  accountId: string;
  accountCode?: string;
  accountName?: string;
  partyId?: string;
  partyName?: string;

  currencyCode: string;
  foreignBalance: number;

  carryingBaseAmount: number;
  closingRate: number;
  revaluedBaseAmount: number;

  unrealizedGain: number;
  unrealizedLoss: number;

  fxGainAccountId?: string;
  fxLossAccountId?: string;
}

export interface CurrencyRevaluationRun {
  id: string;
  entityId: string;

  revaluationDate: string;
  baseCurrencyCode: string;

  currencyCodes: string[];

  status: RevaluationStatus;

  totalGain: number;
  totalLoss: number;
  netFx: number;

  journalEntryId?: string;
  reversalJournalEntryId?: string;

  lines: CurrencyRevaluationLine[];

  auditTrail: { id: string; at: string; action: string; detail?: string }[];
  createdAt: string;
  updatedAt: string;
  postedAt?: string;
  reversedAt?: string;
}
