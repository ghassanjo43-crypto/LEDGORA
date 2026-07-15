import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { TaxCode } from '@/types/taxCode';
import type { TaxLineRecord, TaxReconciliationResult, TaxReconciliationLine } from '@/types/taxReporting';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { buildTaxSummaryReport } from '@/lib/taxReporting';
import { roundTo } from '@/lib/taxRounding';

export const TAX_TOLERANCE = 0.01;

interface AccountBuckets {
  output: Set<string>;
  input: Set<string>;
  withholding: Set<string>;
  all: Set<string>;
}

function accountBuckets(codes: TaxCode[]): AccountBuckets {
  const output = new Set<string>();
  const input = new Set<string>();
  const withholding = new Set<string>();
  for (const c of codes) {
    for (const id of [c.outputTaxAccountId, c.reverseChargeOutputAccountId, c.taxPayableAccountId]) if (id) output.add(id);
    for (const id of [c.inputTaxAccountId, c.reverseChargeInputAccountId, c.taxReceivableAccountId, c.nonRecoverableAccountId]) if (id) input.add(id);
    if (c.withholdingAccountId) withholding.add(c.withholdingAccountId);
  }
  const all = new Set<string>([...output, ...input, ...withholding]);
  return { output, input, withholding, all };
}

export interface ReconcileParams {
  records: TaxLineRecord[];
  entries: JournalEntry[];
  accounts: Account[];
  taxCodes: TaxCode[];
  baseCurrency: string;
  /** Journal ids already represented by `records` (excluded from GL double counting is NOT needed — GL is authoritative). */
  from?: string;
  to?: string;
}

/**
 * Reconcile the tax report totals against the tax control-account balances in the
 * General Ledger (§25). For a shared VAT control account the credit side is
 * treated as output tax and the debit side as input tax. Never creates balancing
 * entries — only surfaces differences and unmapped items.
 */
export function reconcileTaxControlAccounts(params: ReconcileParams): TaxReconciliationResult {
  const buckets = accountBuckets(params.taxCodes);
  const inWindow = (date: string): boolean => (!params.from || date >= params.from) && (!params.to || date <= params.to);

  // GL side — split shared control accounts by debit/credit.
  let glOutput = 0;
  let glInput = 0;
  let glWithholding = 0;
  const unmappedTaxJournalLines: TaxReconciliationResult['unmappedTaxJournalLines'] = [];
  for (const { entry, line } of getPostedJournalLines(params.entries)) {
    if (!buckets.all.has(line.accountId) || !inWindow(entry.entryDate)) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, params.baseCurrency);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, params.baseCurrency);
    if (buckets.output.has(line.accountId)) glOutput += credit;
    if (buckets.input.has(line.accountId)) glInput += debit;
    if (buckets.withholding.has(line.accountId)) glWithholding += credit;
    if (!line.taxCode) {
      const acc = params.accounts.find((a) => a.id === line.accountId);
      unmappedTaxJournalLines.push({ journalEntryId: entry.id, entryNumber: entry.entryNumber, date: entry.entryDate, accountId: line.accountId, accountCode: acc?.code ?? '', amount: roundTo(debit - credit, 2) });
    }
  }

  // Report side — from the summary over the records.
  const summary = buildTaxSummaryReport(params.records);
  const reportWithholding = roundTo(
    params.records.filter((r) => r.category === 'withholding' || r.direction === 'withholding-payable' || r.direction === 'withholding-receivable').reduce((s, r) => s + r.baseTaxAmount, 0),
    2,
  );

  const mk = (key: string, label: string, reportTotal: number, glBalance: number): TaxReconciliationLine => {
    const difference = roundTo(reportTotal - glBalance, 2);
    return { key, label, reportTotal: roundTo(reportTotal, 2), glBalance: roundTo(glBalance, 2), difference, reconciled: Math.abs(difference) <= TAX_TOLERANCE };
  };

  const lines: TaxReconciliationLine[] = [
    mk('output', 'Output tax', summary.outputTaxTotal, glOutput),
    mk('input', 'Input tax (recoverable)', summary.inputTaxTotal, glInput),
    mk('withholding', 'Withholding tax', reportWithholding, glWithholding),
    mk('net', 'Net tax payable', summary.netPayable, roundTo(glOutput - glInput, 2)),
  ];

  const codeIds = new Set(params.taxCodes.map((c) => c.id));
  const unmappedTaxRecords = params.records
    .filter((r) => !codeIds.has(r.taxCodeId))
    .map((r) => ({ id: r.id, documentNumber: r.documentNumber, taxCode: r.taxCode }));

  return {
    lines,
    unmappedTaxJournalLines,
    unmappedTaxRecords,
    isReconciled: lines.every((l) => l.reconciled) && unmappedTaxJournalLines.length === 0,
  };
}
