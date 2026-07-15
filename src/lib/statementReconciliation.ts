import type { JournalEntry } from '@/types/journal';
import type { StatementCurrencyMode } from '@/types/statementOfAccount';
import { roundMoney, BALANCE_TOLERANCE } from '@/lib/journalValidation';

export interface SubledgerBalanceParams {
  journalEntries: JournalEntry[];
  receivableAccountId: string;
  customerId: string;
  asOfDate: string;
  currencyMode: StatementCurrencyMode;
  currency: string;
}

/**
 * The customer's receivable subledger balance from POSTED journals only: the
 * signed sum (debit − credit) of every posted line hitting the customer's
 * receivable control account up to `asOfDate`. This is the independent source of
 * truth the document-derived statement is reconciled against — never a stored,
 * duplicated balance.
 */
export function calculateCustomerSubledgerBalance(p: SubledgerBalanceParams): number {
  let balance = 0;
  for (const entry of p.journalEntries) {
    if (entry.status !== 'posted') continue;
    if (entry.entryDate > p.asOfDate) continue;
    if (p.currencyMode === 'single-currency' && entry.currency !== p.currency) continue;
    const rate = p.currencyMode === 'single-currency' ? 1 : Number(entry.exchangeRate) || 1;
    for (const line of entry.lines) {
      if (line.accountId !== p.receivableAccountId) continue;
      if (line.entityId !== p.customerId) continue;
      balance += ((Number(line.debit) || 0) - (Number(line.credit) || 0)) * rate;
    }
  }
  return roundMoney(balance);
}

export interface ReconciliationResult {
  difference: number;
  isReconciled: boolean;
  warnings: string[];
}

/** Compare the calculated closing balance to the subledger balance (never insert a balancing line). */
export function validateStatementReconciliation(
  calculatedClosing: number,
  subledgerBalance: number,
  tolerance = BALANCE_TOLERANCE,
): ReconciliationResult {
  const difference = roundMoney(calculatedClosing - subledgerBalance);
  const isReconciled = Math.abs(difference) <= tolerance;
  return {
    difference,
    isReconciled,
    warnings: isReconciled
      ? []
      : [
          `Statement does not reconcile to the customer subledger (difference ${difference.toFixed(2)}). ` +
            'Possible causes: a duplicated document/journal event, a reversed receipt still counted, a draft document included, a currency or date-basis mismatch, or a missing allocation.',
        ],
  };
}
