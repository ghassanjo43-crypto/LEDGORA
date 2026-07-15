import type { Account, ImportResult } from '@/types';
import { accountsArraySchema, validateChart } from './validation';
import { recomputeLevels } from './accountTree';
import { generateId, nowIso } from './utils';
import { escapeCsv, parseCsv, toBool } from './csv';

/* ─────────────────────────────── CSV columns ────────────────────────────── */

const CSV_COLUMNS = [
  'id',
  'code',
  'name',
  'type',
  'parentId',
  'level',
  'normalBalance',
  'ifrsStatement',
  'ifrsCategory',
  'ifrsSubcategory',
  'cashFlowCategory',
  'profitOrLossCategory',
  'isPostingAccount',
  'isActive',
  'description',
  'industryTag',
  'sortOrder',
  'createdAt',
  'updatedAt',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];

function cellValue(account: Account, column: CsvColumn): string {
  const raw = account[column];
  if (raw === null || raw === undefined) return '';
  return String(raw);
}

/* ─────────────────────────────── Export ─────────────────────────────────── */

export function exportToJson(accounts: Account[]): string {
  return JSON.stringify(accounts, null, 2);
}

export function exportToCsv(accounts: Account[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = accounts.map((acc) =>
    CSV_COLUMNS.map((col) => escapeCsv(cellValue(acc, col))).join(','),
  );
  return [header, ...rows].join('\r\n');
}

/* ─────────────────────────────── Import ─────────────────────────────────── */

/** Parse & validate JSON text into an ImportResult. */
export function importFromJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      accounts: [],
      ok: false,
      issues: [
        {
          id: generateId('iss'),
          accountId: null,
          accountCode: null,
          severity: 'error',
          rule: 'json-parse',
          message: 'File is not valid JSON.',
        },
      ],
    };
  }

  const result = accountsArraySchema.safeParse(parsed);
  if (!result.success) {
    return {
      accounts: [],
      ok: false,
      issues: result.error.issues.slice(0, 20).map((issue) => ({
        id: generateId('iss'),
        accountId: null,
        accountCode: null,
        severity: 'error' as const,
        rule: 'schema',
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }

  const accounts = recomputeLevels(result.data);
  const issues = validateChart(accounts);
  return { accounts, issues, ok: !issues.some((i) => i.severity === 'error') };
}

/** Parse & validate CSV text into an ImportResult. */
export function importFromCsv(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return {
      accounts: [],
      ok: false,
      issues: [
        {
          id: generateId('iss'),
          accountId: null,
          accountCode: null,
          severity: 'error',
          rule: 'csv-empty',
          message: 'CSV must include a header row and at least one data row.',
        },
      ],
    };
  }

  const header = (rows[0] ?? []).map((h) => h.trim());
  const index = (col: CsvColumn): number => header.indexOf(col);
  const missing = (['code', 'name', 'type'] as CsvColumn[]).filter(
    (c) => index(c) === -1,
  );
  if (missing.length) {
    return {
      accounts: [],
      ok: false,
      issues: [
        {
          id: generateId('iss'),
          accountId: null,
          accountCode: null,
          severity: 'error',
          rule: 'csv-header',
          message: `CSV is missing required column(s): ${missing.join(', ')}.`,
        },
      ],
    };
  }

  const get = (row: string[], col: CsvColumn): string => {
    const idx = index(col);
    return idx === -1 ? '' : (row[idx] ?? '').trim();
  };

  const timestamp = nowIso();
  const raw: unknown[] = rows.slice(1).map((row, i) => {
    const pnl = get(row, 'profitOrLossCategory');
    return {
      id: get(row, 'id') || `csv_${i}_${generateId('a')}`,
      code: get(row, 'code'),
      name: get(row, 'name'),
      type: get(row, 'type'),
      parentId: get(row, 'parentId') || null,
      level: Number(get(row, 'level')) || 0,
      normalBalance: get(row, 'normalBalance') || 'DEBIT',
      ifrsStatement: get(row, 'ifrsStatement') || 'NOTES',
      ifrsCategory: get(row, 'ifrsCategory'),
      ifrsSubcategory: get(row, 'ifrsSubcategory'),
      cashFlowCategory: get(row, 'cashFlowCategory') || 'NOT_APPLICABLE',
      ...(pnl ? { profitOrLossCategory: pnl } : {}),
      isPostingAccount: toBool(get(row, 'isPostingAccount')),
      isActive: get(row, 'isActive') === '' ? true : toBool(get(row, 'isActive')),
      description: get(row, 'description'),
      industryTag: get(row, 'industryTag') || 'general',
      sortOrder: Number(get(row, 'sortOrder')) || i,
      createdAt: get(row, 'createdAt') || timestamp,
      updatedAt: get(row, 'updatedAt') || timestamp,
    };
  });

  const result = accountsArraySchema.safeParse(raw);
  if (!result.success) {
    return {
      accounts: [],
      ok: false,
      issues: result.error.issues.slice(0, 20).map((issue) => ({
        id: generateId('iss'),
        accountId: null,
        accountCode: null,
        severity: 'error' as const,
        rule: 'schema',
        message: `Row ${Number(issue.path[0]) + 2}: ${issue.path.slice(1).join('.')} ${issue.message}`,
      })),
    };
  }

  const accounts = recomputeLevels(result.data);
  const issues = validateChart(accounts);
  return { accounts, issues, ok: !issues.some((i) => i.severity === 'error') };
}
