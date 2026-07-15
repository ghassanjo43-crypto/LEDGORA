import type { StatementLine, StatementOfAccount } from '@/types/statementOfAccount';
import { escapeCsv } from '@/lib/csv';
import { STATEMENT_LINE_TYPE_LABELS } from '@/lib/statementLabels';

const CSV_HEADERS = [
  'Date', 'Posting date', 'Type', 'Document number', 'Reference', 'Description',
  'Debit', 'Credit', 'Running balance', 'Currency', 'Base amount', 'Due date', 'Days overdue', 'Status',
] as const;

function amount(n: number | undefined): string {
  return n === undefined ? '' : (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

function row(line: StatementLine): string[] {
  return [
    line.date,
    line.postingDate ?? '',
    STATEMENT_LINE_TYPE_LABELS[line.type],
    line.documentNumber ?? '',
    line.reference ?? '',
    line.description,
    line.debit ? amount(line.debit) : '',
    line.credit ? amount(line.credit) : '',
    amount(line.runningBalance),
    line.currency,
    amount(line.baseCurrencyAmount),
    line.dueDate ?? '',
    line.daysOverdue !== undefined ? String(line.daysOverdue) : '',
    line.status ?? '',
  ];
}

/**
 * CSV export of the statement transactions. The final row echoes the closing
 * balance so a spreadsheet total ties back to the statement.
 */
export function exportStatementCsv(statement: StatementOfAccount): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.map((h) => escapeCsv(h)).join(','));
  for (const l of statement.lines) lines.push(row(l).map((c) => escapeCsv(c)).join(','));
  // Reconciling totals row.
  lines.push('');
  lines.push([`Closing balance (${statement.currency})`, '', '', '', '', '', amount(statement.periodDebits), amount(statement.periodCredits), amount(statement.closingBalance), statement.currency, '', '', '', ''].map((c) => escapeCsv(c)).join(','));
  return lines.join('\r\n');
}

/**
 * Excel-compatible export via a SpreadsheetML/HTML table (opens natively in
 * Excel as an `.xls`). Reuses the same rows and totals as the CSV export.
 */
export function exportStatementExcel(statement: StatementOfAccount): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const th = CSV_HEADERS.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = statement.lines
    .map((l) => `<tr>${row(l).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  const total = `<tr><td colspan="6"><b>Closing balance (${esc(statement.currency)})</b></td><td>${amount(statement.periodDebits)}</td><td>${amount(statement.periodCredits)}</td><td><b>${amount(statement.closingBalance)}</b></td><td colspan="5"></td></tr>`;
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" /></head><body><table border="1"><thead><tr>${th}</tr></thead><tbody>${body}${total}</tbody></table></body></html>`;
}

export function statementExportFilename(statement: StatementOfAccount, ext: 'csv' | 'xls'): string {
  const cust = (statement.customerCode || statement.customerName || 'customer').replace(/[^a-z0-9]+/gi, '-');
  return `statement-${cust}-${statement.periodStart}_${statement.periodEnd}.${ext}`;
}
