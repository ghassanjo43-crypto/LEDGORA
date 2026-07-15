import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { TaxCode, TaxDirection } from '@/types/taxCode';
import type {
  TaxAdjustment,
  TaxBoxTotal,
  TaxLineRecord,
  TaxReportingBox,
  TaxSummaryReport,
  TaxSummaryRow,
} from '@/types/taxReporting';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { roundTo } from '@/lib/taxRounding';

/* ─────────────────────────────── Filtering ──────────────────────────────── */

export interface TaxReportFilters {
  entityId?: string;
  jurisdictionId?: string;
  from?: string;
  to?: string;
  taxCodeId?: string;
  direction?: TaxDirection;
  category?: string;
  currency?: string;
  partyId?: string;
  documentType?: string;
}

export function filterTaxRecords(records: TaxLineRecord[], f: TaxReportFilters): TaxLineRecord[] {
  return records.filter((r) => {
    if (f.entityId && r.entityId !== f.entityId) return false;
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (f.taxCodeId && r.taxCodeId !== f.taxCodeId) return false;
    if (f.direction && r.direction !== f.direction) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.currency && r.currency !== f.currency) return false;
    if (f.partyId && r.partyId !== f.partyId) return false;
    if (f.documentType && r.documentType !== f.documentType) return false;
    return true;
  });
}

/* ─────────────────────────── Direction classification ───────────────────── */

function isOutputDirection(d: TaxDirection): boolean {
  return d === 'sales' || d === 'withholding-receivable';
}

/* ──────────────────────────────── Summary ───────────────────────────────── */

/** Group tax records by code into a summary with output/input split and net payable. */
export function buildTaxSummaryReport(records: TaxLineRecord[]): TaxSummaryReport {
  const byCode = new Map<string, TaxSummaryRow>();
  const docKeys = new Map<string, Set<string>>();

  for (const r of records) {
    let row = byCode.get(r.taxCodeId);
    if (!row) {
      row = {
        taxCodeId: r.taxCodeId, taxCode: r.taxCode, taxName: r.taxName, category: r.category, direction: r.direction, rate: r.rate,
        taxableBase: 0, taxAmount: 0, recoverableAmount: 0, nonRecoverableAmount: 0, outputTax: 0, inputTax: 0, reportingBoxIds: r.reportingBoxIds, documentCount: 0,
      };
      byCode.set(r.taxCodeId, row);
      docKeys.set(r.taxCodeId, new Set());
    }
    const output = isOutputDirection(r.direction) || r.category === 'reverse-charge';
    row.taxableBase = roundTo(row.taxableBase + r.baseTaxableAmount, 2);
    row.taxAmount = roundTo(row.taxAmount + r.baseTaxAmount, 2);
    row.recoverableAmount = roundTo(row.recoverableAmount + r.recoverableTaxAmount * r.exchangeRate, 2);
    row.nonRecoverableAmount = roundTo(row.nonRecoverableAmount + r.nonRecoverableTaxAmount * r.exchangeRate, 2);
    if (output) row.outputTax = roundTo(row.outputTax + r.baseTaxAmount, 2);
    else row.inputTax = roundTo(row.inputTax + r.baseTaxAmount, 2);
    if (r.documentNumber) docKeys.get(r.taxCodeId)!.add(`${r.documentType}:${r.documentNumber}`);
  }
  for (const [id, row] of byCode) row.documentCount = docKeys.get(id)!.size || records.filter((r) => r.taxCodeId === id).length;

  const rows = [...byCode.values()].sort((a, b) => a.taxCode.localeCompare(b.taxCode));
  const outputTaxTotal = roundTo(rows.reduce((s, r) => s + r.outputTax, 0), 2);
  const inputTaxTotal = roundTo(rows.reduce((s, r) => s + r.inputTax, 0), 2);
  const recoverableTotal = roundTo(rows.reduce((s, r) => s + r.recoverableAmount, 0), 2);
  const nonRecoverableTotal = roundTo(rows.reduce((s, r) => s + r.nonRecoverableAmount, 0), 2);
  return {
    rows,
    outputTaxTotal,
    inputTaxTotal,
    recoverableTotal,
    nonRecoverableTotal,
    // Net = output − recoverable input. When records don't split recoverability,
    // the recoverable input is the input tax less any non-recoverable portion.
    netPayable: roundTo(outputTaxTotal - (inputTaxTotal - nonRecoverableTotal), 2),
    taxableBaseTotal: roundTo(rows.reduce((s, r) => s + r.taxableBase, 0), 2),
    documentCount: new Set(records.filter((r) => r.documentNumber).map((r) => `${r.documentType}:${r.documentNumber}`)).size,
  };
}

/* ──────────────────────────────── Detail ────────────────────────────────── */

/** Chronological detail rows (already carry drill-down journalEntryId + document metadata). */
export function buildTaxDetailReport(records: TaxLineRecord[]): TaxLineRecord[] {
  return [...records].sort((a, b) => a.date.localeCompare(b.date) || (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''));
}

/* ──────────────────────────── Reporting boxes ───────────────────────────── */

/** Total each reporting box across the records, honouring its amount basis & sign. */
export function buildTaxBoxTotals(records: TaxLineRecord[], boxes: TaxReportingBox[]): TaxBoxTotal[] {
  return boxes
    .filter((b) => b.status === 'active')
    .map((box) => {
      let amount = 0;
      for (const r of records) {
        if (!r.reportingBoxIds.includes(box.id)) continue;
        const basis = box.amountBasis === 'taxable-base' ? r.baseTaxableAmount : box.amountBasis === 'gross-amount' ? roundTo(r.baseTaxableAmount + r.baseTaxAmount, 2) : r.baseTaxAmount;
        amount += basis;
      }
      amount = roundTo(box.sign === 'negative' ? -amount : amount, 2);
      return { boxId: box.id, boxCode: box.code, boxName: box.name, reportType: box.reportType, amountBasis: box.amountBasis, amount };
    });
}

/* ──────────────────────────────── Collectors ────────────────────────────── */

/** Turn tax adjustments into reportable records. */
export function collectRecordsFromAdjustments(adjustments: TaxAdjustment[], codesById: Map<string, TaxCode>): TaxLineRecord[] {
  return adjustments.map((adj) => {
    const code = adj.taxCodeId ? codesById.get(adj.taxCodeId) : undefined;
    const rate = code?.rate ?? 0;
    const exchangeRate = adj.exchangeRate || 1;
    return {
      id: adj.id, date: adj.date, documentType: 'adjustment', documentNumber: adj.journalEntryId, entityId: adj.entityId,
      taxCodeId: adj.taxCodeId ?? 'ADJUSTMENT', taxCode: code?.code ?? 'ADJ', taxName: code?.name ?? `Adjustment — ${adj.type}`,
      category: code?.category ?? 'custom', direction: code?.direction ?? 'both', rate,
      taxableAmount: adj.taxableAmount ?? 0, taxAmount: adj.amount, grossAmount: roundTo((adj.taxableAmount ?? 0) + adj.amount, 2),
      recoverableTaxAmount: 0, nonRecoverableTaxAmount: 0,
      taxAccountId: adj.taxAccountId, reportingBoxIds: adj.reportingBoxId ? [adj.reportingBoxId] : code?.reportingBoxIds ?? [],
      journalEntryId: adj.journalEntryId, status: 'posted',
      currency: adj.currency, exchangeRate,
      baseTaxableAmount: roundTo((adj.taxableAmount ?? 0) * exchangeRate, 2), baseTaxAmount: roundTo(adj.amount * exchangeRate, 2),
    };
  });
}

/**
 * Extract manual General Journal tax records: posted journal lines hitting a tax
 * account and carrying a `taxCode`, excluding document-generated journals so
 * document tax is never double-counted (§36, test 30).
 */
export function extractManualJournalTaxRecords(
  entries: JournalEntry[],
  opts: { taxAccountIds: Set<string>; codesByCode: Map<string, TaxCode>; excludeJournalIds?: Set<string>; baseCurrency: string },
): TaxLineRecord[] {
  const out: TaxLineRecord[] = [];
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (opts.excludeJournalIds?.has(entry.id)) continue;
    if (!opts.taxAccountIds.has(line.accountId)) continue;
    if (!line.taxCode) continue; // untagged lines surface in reconciliation, not the report
    const code = opts.codesByCode.get(line.taxCode);
    const taxAmount = roundTo(Math.abs((Number(line.debit) || 0) - (Number(line.credit) || 0)), 2);
    if (taxAmount === 0) continue;
    const baseTax = convertToBaseCurrency(taxAmount, entry.currency, entry.exchangeRate, opts.baseCurrency);
    const taxableAmount = roundTo(Number(line.taxAmount) || 0, 2);
    out.push({
      id: line.id, date: entry.entryDate, documentType: 'journal', documentNumber: entry.entryNumber, entityId: 'primary',
      partyId: line.entityId || undefined, partyName: line.entityName || undefined,
      taxCodeId: code?.id ?? line.taxCode, taxCode: code?.code ?? line.taxCode, taxName: code?.name ?? line.taxCode,
      category: code?.category ?? 'custom', direction: code?.direction ?? 'both', rate: code?.rate ?? 0,
      taxableAmount, taxAmount, grossAmount: roundTo(taxableAmount + taxAmount, 2),
      recoverableTaxAmount: 0, nonRecoverableTaxAmount: 0,
      taxAccountId: line.accountId, reportingBoxIds: code?.reportingBoxIds ?? [],
      journalEntryId: entry.id, status: 'posted',
      currency: entry.currency, exchangeRate: entry.exchangeRate || 1,
      baseTaxableAmount: convertToBaseCurrency(taxableAmount, entry.currency, entry.exchangeRate, opts.baseCurrency), baseTaxAmount: baseTax,
    });
  }
  return out;
}

/** The set of account ids used as tax control accounts across the active tax codes. */
export function collectTaxAccountIds(codes: TaxCode[]): Set<string> {
  const ids = new Set<string>();
  for (const c of codes) {
    for (const id of [c.outputTaxAccountId, c.inputTaxAccountId, c.taxPayableAccountId, c.taxReceivableAccountId, c.withholdingAccountId, c.reverseChargeOutputAccountId, c.reverseChargeInputAccountId, c.nonRecoverableAccountId]) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Convenience: tax accounts present in the chart, for the reconciliation view. */
export function taxControlAccounts(accounts: Account[], codes: TaxCode[]): Account[] {
  const ids = collectTaxAccountIds(codes);
  return accounts.filter((a) => ids.has(a.id));
}

/**
 * Assemble the reportable tax records from every available source: tax
 * adjustments and manual General Journal tax lines. Document-generated journals
 * are excluded from the manual-journal pass so document tax is never
 * double-counted; document snapshots feed the report through their own
 * collectors as they are integrated.
 */
export function assembleTaxRecords(input: {
  entries: JournalEntry[];
  adjustments: TaxAdjustment[];
  taxCodes: TaxCode[];
  baseCurrency: string;
  linkedDocumentJournalIds?: Set<string>;
}): TaxLineRecord[] {
  const codesById = new Map(input.taxCodes.map((c) => [c.id, c]));
  const codesByCode = new Map(input.taxCodes.map((c) => [c.code, c]));
  const fromAdjustments = collectRecordsFromAdjustments(input.adjustments, codesById);
  const fromJournals = extractManualJournalTaxRecords(input.entries, {
    taxAccountIds: collectTaxAccountIds(input.taxCodes),
    codesByCode,
    excludeJournalIds: input.linkedDocumentJournalIds,
    baseCurrency: input.baseCurrency,
  });
  return [...fromAdjustments, ...fromJournals];
}
