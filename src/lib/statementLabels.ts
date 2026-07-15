import type { StatementLineType, StatementType } from '@/types/statementOfAccount';

export const STATEMENT_LINE_TYPE_LABELS: Record<StatementLineType, string> = {
  'opening-balance': 'Opening balance',
  invoice: 'Invoice',
  'credit-note': 'Credit note',
  receipt: 'Receipt',
  'customer-advance': 'Customer advance',
  refund: 'Refund',
  'journal-adjustment': 'Journal adjustment',
  reversal: 'Reversal',
};

export const STATEMENT_TYPE_LABELS: Record<StatementType, string> = {
  'balance-forward': 'Balance forward',
  'open-item': 'Open item',
  'activity-only': 'Activity only',
};
