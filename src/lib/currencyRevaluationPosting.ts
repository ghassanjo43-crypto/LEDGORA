import type { Account } from '@/types';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import type { CurrencyRevaluationRun } from '@/types/currencyRevaluation';
import { roundTo } from '@/lib/currencyConversion';

function jLine(accountsById: Map<string, Account>, accountId: string, debit: number, credit: number, opts: { entityId?: string; memo?: string } = {}): JournalLineFormValues {
  const acc = accountsById.get(accountId);
  return {
    accountId, accountCode: acc?.code ?? '', accountName: acc?.name ?? '', description: '',
    debit: roundTo(debit, 2), credit: roundTo(credit, 2), entityId: opts.entityId ?? '', entityName: '',
    costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: opts.memo ?? '',
  };
}

/**
 * Build the balanced period-end revaluation journal (§30) in base currency,
 * posting through the existing journal service. Each monetary balance is adjusted
 * to its revalued base value, with the difference going to the unrealized FX
 * gain/loss account. Sign is handled generically (debit-positive `unrealized`).
 */
export function buildRevaluationJournalEntry(run: CurrencyRevaluationRun, accountsById: Map<string, Account>): JournalFormValues {
  const lines: JournalLineFormValues[] = [];
  for (const l of run.lines) {
    const memo = `FX revaluation ${l.currencyCode} @ ${l.closingRate}`;
    if (l.unrealizedGain > 0) {
      lines.push(jLine(accountsById, l.accountId, l.unrealizedGain, 0, { entityId: l.partyId, memo }));
      if (l.fxGainAccountId) lines.push(jLine(accountsById, l.fxGainAccountId, 0, l.unrealizedGain, { memo: `Unrealized FX gain — ${l.currencyCode}` }));
    } else if (l.unrealizedLoss > 0) {
      lines.push(jLine(accountsById, l.accountId, 0, l.unrealizedLoss, { entityId: l.partyId, memo }));
      if (l.fxLossAccountId) lines.push(jLine(accountsById, l.fxLossAccountId, l.unrealizedLoss, 0, { memo: `Unrealized FX loss — ${l.currencyCode}` }));
    }
  }
  return {
    entryNumber: '', entryDate: run.revaluationDate, reference: `REVAL-${run.revaluationDate}`,
    description: `Currency revaluation as at ${run.revaluationDate}`,
    currency: run.baseCurrencyCode, exchangeRate: 1, notes: `Unrealized FX. Net ${run.netFx.toFixed(2)}.`,
    transactionType: 'FX Revaluation', createdBy: '', approvedBy: '', lines,
  };
}
