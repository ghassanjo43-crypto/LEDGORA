import type { BusinessEntity, EntityImportResult } from '@/types';
import { entitiesArraySchema, validateEntities } from './entityValidation';
import { generateId, nowIso } from './utils';
import { escapeCsv, parseCsv, toBool } from './csv';

const CSV_COLUMNS = [
  'id',
  'entityCode',
  'legalName',
  'tradingName',
  'entityType',
  'contactPerson',
  'jobTitle',
  'email',
  'phone',
  'mobile',
  'website',
  'country',
  'city',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'taxRegistrationNumber',
  'commercialRegistrationNumber',
  'paymentTerms',
  'defaultCurrency',
  'bankName',
  'bankAccountName',
  'iban',
  'swiftCode',
  'notes',
  'isActive',
  'customerCategory',
  'creditLimit',
  'defaultRevenueAccount',
  'defaultReceivableAccount',
  'defaultInvoiceTemplateId',
  'invoiceDeliveryMethod',
  'customerPaymentTerms',
  'supplierCategory',
  'defaultExpenseAccount',
  'defaultPayableAccount',
  'supplierPaymentTerms',
  'withholdingTaxApplicable',
  'preferredPaymentMethod',
  'createdAt',
  'updatedAt',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];

/* ─────────────────────────────── Export ─────────────────────────────────── */

export function exportEntitiesToJson(entities: BusinessEntity[]): string {
  return JSON.stringify(entities, null, 2);
}

export function exportEntitiesToCsv(entities: BusinessEntity[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = entities.map((e) =>
    CSV_COLUMNS.map((col) => escapeCsv(String(e[col] ?? ''))).join(','),
  );
  return [header, ...rows].join('\r\n');
}

/* ─────────────────────────────── Import ─────────────────────────────────── */

function issue(rule: string, message: string): EntityImportResult['issues'][number] {
  return { id: generateId('eiss'), entityId: null, entityCode: null, severity: 'error', rule, message };
}

function finalize(raw: unknown): EntityImportResult {
  const result = entitiesArraySchema.safeParse(raw);
  if (!result.success) {
    return {
      entities: [],
      ok: false,
      issues: result.error.issues.slice(0, 25).map((i) => ({
        id: generateId('eiss'),
        entityId: null,
        entityCode: null,
        severity: 'error' as const,
        rule: 'schema',
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
    };
  }
  const issues = validateEntities(result.data);
  return { entities: result.data, issues, ok: !issues.some((i) => i.severity === 'error') };
}

export function importEntitiesFromJson(text: string): EntityImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entities: [], ok: false, issues: [issue('json-parse', 'File is not valid JSON.')] };
  }
  if (!Array.isArray(parsed)) {
    return { entities: [], ok: false, issues: [issue('json-shape', 'JSON must be an array of entities.')] };
  }
  return finalize(parsed);
}

export function importEntitiesFromCsv(text: string): EntityImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { entities: [], ok: false, issues: [issue('csv-empty', 'CSV needs a header row and at least one data row.')] };
  }

  const header = (rows[0] ?? []).map((h) => h.trim());
  const index = (col: CsvColumn): number => header.indexOf(col);
  const missing = (['entityCode', 'legalName', 'entityType', 'email'] as CsvColumn[]).filter(
    (c) => index(c) === -1,
  );
  if (missing.length) {
    return {
      entities: [],
      ok: false,
      issues: [issue('csv-header', `CSV is missing required column(s): ${missing.join(', ')}.`)],
    };
  }

  const get = (row: string[], col: CsvColumn): string => {
    const idx = index(col);
    return idx === -1 ? '' : (row[idx] ?? '').trim();
  };

  const timestamp = nowIso();
  const raw = rows.slice(1).map((row, i) => ({
    id: get(row, 'id') || `csvent_${i}_${generateId('e')}`,
    entityCode: get(row, 'entityCode'),
    legalName: get(row, 'legalName'),
    tradingName: get(row, 'tradingName'),
    entityType: get(row, 'entityType') || 'customer',
    contactPerson: get(row, 'contactPerson'),
    jobTitle: get(row, 'jobTitle'),
    email: get(row, 'email'),
    phone: get(row, 'phone'),
    mobile: get(row, 'mobile'),
    website: get(row, 'website'),
    country: get(row, 'country'),
    city: get(row, 'city'),
    addressLine1: get(row, 'addressLine1'),
    addressLine2: get(row, 'addressLine2'),
    postalCode: get(row, 'postalCode'),
    taxRegistrationNumber: get(row, 'taxRegistrationNumber'),
    commercialRegistrationNumber: get(row, 'commercialRegistrationNumber'),
    paymentTerms: get(row, 'paymentTerms') || 'NET_30',
    defaultCurrency: get(row, 'defaultCurrency') || 'USD',
    bankName: get(row, 'bankName'),
    bankAccountName: get(row, 'bankAccountName'),
    iban: get(row, 'iban'),
    swiftCode: get(row, 'swiftCode'),
    notes: get(row, 'notes'),
    isActive: get(row, 'isActive') === '' ? true : toBool(get(row, 'isActive')),
    customerCategory: get(row, 'customerCategory'),
    creditLimit: Number(get(row, 'creditLimit')) || 0,
    defaultRevenueAccount: get(row, 'defaultRevenueAccount'),
    defaultReceivableAccount: get(row, 'defaultReceivableAccount'),
    defaultInvoiceTemplateId: get(row, 'defaultInvoiceTemplateId'),
    invoiceDeliveryMethod: get(row, 'invoiceDeliveryMethod'),
    customerPaymentTerms: get(row, 'customerPaymentTerms'),
    supplierCategory: get(row, 'supplierCategory'),
    defaultExpenseAccount: get(row, 'defaultExpenseAccount'),
    defaultPayableAccount: get(row, 'defaultPayableAccount'),
    supplierPaymentTerms: get(row, 'supplierPaymentTerms'),
    withholdingTaxApplicable: toBool(get(row, 'withholdingTaxApplicable')),
    preferredPaymentMethod: get(row, 'preferredPaymentMethod'),
    createdAt: get(row, 'createdAt') || timestamp,
    updatedAt: get(row, 'updatedAt') || timestamp,
  }));

  return finalize(raw);
}
