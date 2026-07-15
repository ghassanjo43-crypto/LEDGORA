import type { StatementLine } from '@/types/statementOfAccount';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Opening balance = the customer subledger balance immediately before the period
 * start, derived from ALL valid receivable-affecting events dated before it
 * (never assumed zero, never taken only from open invoices).
 */
export function calculateCustomerOpeningBalance(allLines: StatementLine[], periodStart: string): number {
  return roundMoney(
    allLines
      .filter((l) => l.type !== 'opening-balance' && l.date < periodStart)
      .reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0),
  );
}
