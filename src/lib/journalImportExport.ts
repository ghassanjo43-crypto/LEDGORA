import type { Account } from '@/types';
import type {
  JournalEntry,
  JournalImportResult,
  JournalIssue,
  JournalLine,
} from '@/types/journal';
import { journalEntriesArraySchema, computeTotals } from './journalValidation';
import { escapeCsv, parseCsv } from './csv';
import { generateId, nowIso } from './utils';

/* ─────────────────────────────── CSV columns ────────────────────────────── */

const CSV_COLUMNS = [
  'entryNumber',
  'entryDate',
  'reference',
  'description',
  'status',
  'currency',
  'exchangeRate',
  'notes',
  'createdBy',
  'approvedBy',
  'lineNumber',
  'accountId',
  'accountCode',
  'accountName',
  'lineDescription',
  'debit',
  'credit',
  'entityId',
  'entityName',
  'costCenter',
  'project',
  'taxCode',
  'taxAmount',
  'memo',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];

/* ─────────────────────────────── Export ─────────────────────────────────── */

export function exportJournalToJson(entries: JournalEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

export function exportJournalToCsv(entries: JournalEntry[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows: string[] = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      const cells: Record<CsvColumn, string> = {
        entryNumber: entry.entryNumber,
        entryDate: entry.entryDate,
        reference: entry.reference,
        description: entry.description,
        status: entry.status,
        currency: entry.currency,
        exchangeRate: String(entry.exchangeRate),
        notes: entry.notes,
        createdBy: entry.createdBy,
        approvedBy: entry.approvedBy,
        lineNumber: String(line.lineNumber),
        accountId: line.accountId,
        accountCode: line.accountCode,
        accountName: line.accountName,
        lineDescription: line.description,
        debit: String(line.debit),
        credit: String(line.credit),
        entityId: line.entityId,
        entityName: line.entityName,
        costCenter: line.costCenter,
        project: line.project,
        taxCode: line.taxCode,
        taxAmount: String(line.taxAmount),
        memo: line.memo,
      };
      rows.push(CSV_COLUMNS.map((col) => escapeCsv(cells[col])).join(','));
    }
  }
  return [header, ...rows].join('\r\n');
}

/* ─────────────────────────────── Import ─────────────────────────────────── */

function issue(rule: string, message: string): JournalIssue {
  return { severity: 'error', rule, message, lineNumber: null };
}

/** Build a fresh DRAFT entry from partial parts, wiring ids & recomputed totals. */
function makeDraftEntry(
  header: {
    entryNumber: string;
    entryDate: string;
    reference: string;
    description: string;
    currency: string;
    exchangeRate: number;
    notes: string;
    createdBy: string;
    approvedBy: string;
  },
  rawLines: Omit<JournalLine, 'id' | 'journalEntryId' | 'lineNumber'>[],
): JournalEntry {
  const now = nowIso();
  const id = generateId('je');
  const lines: JournalLine[] = rawLines.map((line, idx) => ({
    ...line,
    id: generateId('jl'),
    journalEntryId: id,
    lineNumber: idx + 1,
  }));
  const totals = computeTotals(lines);
  return {
    id,
    entryNumber: header.entryNumber,
    entryDate: header.entryDate,
    reference: header.reference,
    description: header.description,
    status: 'draft',
    transactionType: '',
    currency: header.currency || 'USD',
    exchangeRate: header.exchangeRate || 1,
    totalDebit: totals.totalDebit,
    totalCredit: totals.totalCredit,
    difference: totals.difference,
    notes: header.notes,
    reversalReference: '',
    lines,
    createdAt: now,
    createdBy: header.createdBy,
    updatedAt: now,
    updatedBy: header.createdBy,
    postedAt: '',
    postedBy: '',
    approvedBy: '',
    voidedAt: '',
    voidedBy: '',
    originalEntryId: '',
    reversalEntryId: '',
  };
}

/** Parse & validate JSON text into draft entries. */
export function importJournalFromJson(text: string): JournalImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], ok: false, issues: [issue('json-parse', 'File is not valid JSON.')] };
  }

  const result = journalEntriesArraySchema.safeParse(parsed);
  if (!result.success) {
    return {
      entries: [],
      ok: false,
      issues: result.error.issues.slice(0, 20).map((i) => ({
        severity: 'error' as const,
        rule: 'schema',
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
        lineNumber: null,
      })),
    };
  }

  const entries = result.data.map((entry) =>
    makeDraftEntry(
      {
        entryNumber: entry.entryNumber,
        entryDate: entry.entryDate,
        reference: entry.reference,
        description: entry.description,
        currency: entry.currency,
        exchangeRate: entry.exchangeRate,
        notes: entry.notes,
        createdBy: entry.createdBy,
        approvedBy: entry.approvedBy,
      },
      entry.lines.map((l) => ({
        accountId: l.accountId,
        accountCode: l.accountCode,
        accountName: l.accountName,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
        entityId: l.entityId,
        entityName: l.entityName,
        costCenter: l.costCenter,
        project: l.project,
        taxCode: l.taxCode,
        taxAmount: l.taxAmount,
        memo: l.memo,
      })),
    ),
  );

  return { entries, issues: [], ok: entries.length > 0 };
}

/**
 * Parse & validate CSV text (one row per line) into draft entries. Rows are
 * grouped by `entryNumber`. When `accountsByCode` is supplied, a blank
 * `accountId` is resolved from the `accountCode` column so imported lines stay
 * linked to the live chart of accounts.
 */
export function importJournalFromCsv(
  text: string,
  accountsByCode?: Map<string, Account>,
): JournalImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return {
      entries: [],
      ok: false,
      issues: [issue('csv-empty', 'CSV must include a header row and at least one data row.')],
    };
  }

  const header = (rows[0] ?? []).map((h) => h.trim());
  const index = (col: CsvColumn): number => header.indexOf(col);
  const missing = (['entryNumber', 'entryDate'] as CsvColumn[]).filter((c) => index(c) === -1);
  if (missing.length) {
    return {
      entries: [],
      ok: false,
      issues: [issue('csv-header', `CSV is missing required column(s): ${missing.join(', ')}.`)],
    };
  }

  const get = (row: string[], col: CsvColumn): string => {
    const idx = index(col);
    return idx === -1 ? '' : (row[idx] ?? '').trim();
  };
  const num = (row: string[], col: CsvColumn): number => {
    const value = Number(get(row, col));
    return Number.isFinite(value) ? value : 0;
  };

  interface Group {
    order: number;
    header: Parameters<typeof makeDraftEntry>[0];
    lines: Omit<JournalLine, 'id' | 'journalEntryId' | 'lineNumber'>[];
  }
  const groups = new Map<string, Group>();
  let order = 0;

  for (const row of rows.slice(1)) {
    const entryNumber = get(row, 'entryNumber');
    if (!entryNumber) continue;

    let group = groups.get(entryNumber);
    if (!group) {
      group = {
        order: order++,
        header: {
          entryNumber,
          entryDate: get(row, 'entryDate'),
          reference: get(row, 'reference'),
          description: get(row, 'description'),
          currency: get(row, 'currency') || 'USD',
          exchangeRate: num(row, 'exchangeRate') || 1,
          notes: get(row, 'notes'),
          createdBy: get(row, 'createdBy'),
          approvedBy: get(row, 'approvedBy'),
        },
        lines: [],
      };
      groups.set(entryNumber, group);
    }

    const accountCode = get(row, 'accountCode');
    let accountId = get(row, 'accountId');
    let accountName = get(row, 'accountName');
    if (!accountId && accountCode && accountsByCode) {
      const match = accountsByCode.get(accountCode);
      if (match) {
        accountId = match.id;
        accountName = accountName || match.name;
      }
    }

    group.lines.push({
      accountId,
      accountCode,
      accountName,
      description: get(row, 'lineDescription'),
      debit: num(row, 'debit'),
      credit: num(row, 'credit'),
      entityId: get(row, 'entityId'),
      entityName: get(row, 'entityName'),
      costCenter: get(row, 'costCenter'),
      project: get(row, 'project'),
      taxCode: get(row, 'taxCode'),
      taxAmount: num(row, 'taxAmount'),
      memo: get(row, 'memo'),
    });
  }

  const ordered = [...groups.values()].sort((a, b) => a.order - b.order);
  const invalid = ordered.filter((g) => g.lines.length < 2);
  if (invalid.length) {
    return {
      entries: [],
      ok: false,
      issues: invalid.map((g) =>
        issue('min-lines', `Entry "${g.header.entryNumber}" has fewer than two lines.`),
      ),
    };
  }

  const entries = ordered.map((g) => makeDraftEntry(g.header, g.lines));
  return { entries, issues: [], ok: entries.length > 0 };
}
