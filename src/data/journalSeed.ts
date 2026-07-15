import type { Account, BusinessEntity } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import { SEED_ACCOUNTS } from './seedAccounts';
import { SEED_ENTITIES } from './seedEntities';
import { computeTotals } from '@/lib/journalValidation';

/**
 * Demo General Journal — 10 realistic, balanced dummy transactions built from
 * EXISTING chart-of-accounts and business-entity records. Nine entries are
 * posted and one (bank charges) is left as an editable draft, so the General
 * Ledger (which derives from posted entries only) shows exactly nine.
 *
 * Accounts and entities are resolved by a safe lookup with aliases/fallbacks —
 * never by hard-coded ids — and nothing new is created.
 */

/* ─────────────────────────── Safe lookup helpers ─────────────────────────── */

/** Find a posting account by preferred name, then alias, then partial match. */
function resolveAccount(aliases: string[]): Account {
  for (const alias of aliases) {
    const hit = SEED_ACCOUNTS.find((a) => a.isPostingAccount && a.name.toLowerCase() === alias.toLowerCase());
    if (hit) return hit;
  }
  for (const alias of aliases) {
    const hit = SEED_ACCOUNTS.find((a) => a.isPostingAccount && a.name.toLowerCase().includes(alias.toLowerCase()));
    if (hit) return hit;
  }
  throw new Error(`journalSeed: no posting account found for aliases: ${aliases.join(' | ')}`);
}

/** Match an entity of the given role by legal name, else fall back to a known id. */
function resolveEntity(preferred: string[], role: 'customer' | 'supplier', fallbackId: string): BusinessEntity {
  const roleOk = (e: BusinessEntity): boolean =>
    role === 'customer' ? e.entityType === 'customer' || e.entityType === 'both' : e.entityType === 'supplier' || e.entityType === 'both';

  for (const name of preferred) {
    const exact = SEED_ENTITIES.find((e) => roleOk(e) && e.legalName.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }
  for (const name of preferred) {
    const partial = SEED_ENTITIES.find((e) => roleOk(e) && e.legalName.toLowerCase().includes(name.toLowerCase()));
    if (partial) return partial;
  }
  const fb = SEED_ENTITIES.find((e) => e.id === fallbackId && roleOk(e));
  if (fb) return fb;
  const anyRole = SEED_ENTITIES.find(roleOk);
  if (!anyRole) throw new Error(`journalSeed: no ${role} entity available for ${preferred[0]}`);
  return anyRole;
}

// Accounts (resolved once).
const BANK = resolveAccount(['Bank current accounts', 'Bank Current Account', 'Bank Account', 'Cash at Bank']);
const SHARE_CAPITAL = resolveAccount(['Share capital', 'Share Capital']);
const RENT = resolveAccount(['Rent and utilities', 'Rent Expense', 'Rent and Utilities']);
const AR = resolveAccount(['Trade receivables', 'Accounts Receivable']);
const REVENUE = resolveAccount(['Service revenue', 'Revenue from Contracts with Customers', 'Service Revenue']);
const OFFICE_EXP = resolveAccount(['General administrative expenses', 'Office Supplies Expense', 'General Administrative Expense']);
const AP = resolveAccount(['Trade payables', 'Accounts Payable']);
const EQUIPMENT = resolveAccount(['Furniture, fixtures and equipment', 'Office Equipment', 'Property, Plant and Equipment']);
const SALARIES = resolveAccount(['Salaries and wages', 'Salaries and Benefits', 'Salaries Expense']);
const ACCRUALS = resolveAccount(['Accrued expenses', 'Salaries Payable']);
const DEPRECIATION = resolveAccount(['Depreciation expense', 'Depreciation Expense']);
const ACCUM_DEP = resolveAccount(['Accumulated depreciation — PP&E', 'Accumulated Depreciation']);
const FINANCE_COST = resolveAccount(['Finance costs', 'Bank Charges Expense', 'Bank Charges']);

// Entities (resolved once, existing records only).
const CUST_GULF = resolveEntity(['Gulf Horizon Trading LLC', 'Gulf Horizon', 'Horizon'], 'customer', 'seedent_ENT-2004');
const SUPP_OASIS = resolveEntity(['Oasis Facilities Management LLC', 'Oasis Facilities Management', 'Facilities'], 'supplier', 'seedent_ENT-1001');
const SUPP_OFFICE = resolveEntity(['Al Noor Office Supplies', 'Office Supplies'], 'supplier', 'seedent_ENT-3001');
const SUPP_EQUIP = resolveEntity(['Prime Equipment Rentals', 'Equipment'], 'supplier', 'seedent_ENT-3007');

/* ───────────────────────────── Transaction specs ─────────────────────────── */

interface LineSpec {
  account: Account;
  debit?: number;
  credit?: number;
  entity?: BusinessEntity;
  memo?: string;
}

interface TxnSpec {
  number: string;
  date: string; // yyyy-mm-dd
  reference: string;
  description: string;
  transactionType: string;
  status: Extract<JournalStatus, 'draft' | 'posted'>;
  lines: LineSpec[];
}

const SPECS: TxnSpec[] = [
  {
    number: 'JE-0001',
    date: '2026-07-01',
    reference: 'CAP-001',
    description: 'Initial owner capital deposited into the business bank account',
    transactionType: 'Opening Capital',
    status: 'posted',
    lines: [
      { account: BANK, debit: 250000, memo: 'Owner capital injection' },
      { account: SHARE_CAPITAL, credit: 250000, memo: 'Issue of share capital' },
    ],
  },
  {
    number: 'JE-0002',
    date: '2026-07-02',
    reference: 'RENT-0726',
    description: 'Office rent paid for July 2026',
    transactionType: 'Expense Payment',
    status: 'posted',
    lines: [
      { account: RENT, debit: 12000, entity: SUPP_OASIS, memo: 'July 2026 office rent' },
      { account: BANK, credit: 12000, memo: 'Rent paid to landlord' },
    ],
  },
  {
    number: 'JE-0003',
    date: '2026-07-03',
    reference: 'INV-1001',
    description: 'Consulting services provided on credit',
    transactionType: 'Sales Invoice',
    status: 'posted',
    lines: [
      { account: AR, debit: 35000, entity: CUST_GULF, memo: 'Invoice INV-1001' },
      { account: REVENUE, credit: 35000, memo: 'Consulting service revenue' },
    ],
  },
  {
    number: 'JE-0004',
    date: '2026-07-05',
    reference: 'RCP-1001',
    description: `Partial payment received from ${CUST_GULF.legalName}`,
    transactionType: 'Customer Receipt',
    status: 'posted',
    lines: [
      { account: BANK, debit: 20000, memo: 'Customer receipt banked' },
      { account: AR, credit: 20000, entity: CUST_GULF, memo: 'Part-settle INV-1001' },
    ],
  },
  {
    number: 'JE-0005',
    date: '2026-07-06',
    reference: 'BILL-2001',
    description: 'Office supplies purchased on credit',
    transactionType: 'Supplier Bill',
    status: 'posted',
    lines: [
      { account: OFFICE_EXP, debit: 4500, memo: 'Office supplies' },
      { account: AP, credit: 4500, entity: SUPP_OFFICE, memo: 'Bill BILL-2001' },
    ],
  },
  {
    number: 'JE-0006',
    date: '2026-07-08',
    reference: 'PAY-2001',
    description: `Payment made to ${SUPP_OFFICE.legalName}`,
    transactionType: 'Supplier Payment',
    status: 'posted',
    lines: [
      { account: AP, debit: 4500, entity: SUPP_OFFICE, memo: 'Settle BILL-2001' },
      { account: BANK, credit: 4500, memo: 'Bank transfer to supplier' },
    ],
  },
  {
    number: 'JE-0007',
    date: '2026-07-10',
    reference: 'FA-0001',
    description: 'Purchase of office equipment paid through bank',
    transactionType: 'Fixed Asset Purchase',
    status: 'posted',
    lines: [
      { account: EQUIPMENT, debit: 30000, entity: SUPP_EQUIP, memo: 'Office equipment' },
      { account: BANK, credit: 30000, memo: 'Paid via bank' },
    ],
  },
  {
    number: 'JE-0008',
    date: '2026-07-31',
    reference: 'PAYROLL-0726',
    description: 'July salaries accrued but not yet paid',
    transactionType: 'Payroll Accrual',
    status: 'posted',
    lines: [
      { account: SALARIES, debit: 45000, memo: 'July payroll expense' },
      { account: ACCRUALS, credit: 45000, memo: 'Salaries payable accrual' },
    ],
  },
  {
    number: 'JE-0009',
    date: '2026-07-31',
    reference: 'DEP-0726',
    description: 'Monthly depreciation of office equipment',
    transactionType: 'Depreciation',
    status: 'posted',
    lines: [
      { account: DEPRECIATION, debit: 1250, memo: 'July depreciation charge' },
      { account: ACCUM_DEP, credit: 1250, memo: 'Accumulated depreciation — equipment' },
    ],
  },
  {
    number: 'JE-0010',
    date: '2026-07-31',
    reference: 'BANK-0726',
    description: 'Monthly bank service charges pending review',
    transactionType: 'Bank Charge',
    status: 'draft',
    lines: [
      { account: FINANCE_COST, debit: 175, memo: 'Account maintenance & charges' },
      { account: BANK, credit: 175, memo: 'Bank charges debited' },
    ],
  },
];

/* ───────────────────────────── Entry builder ─────────────────────────────── */

const TS = new Date('2026-07-31T09:00:00.000Z').toISOString();

function buildEntry(spec: TxnSpec): JournalEntry {
  const id = `seedje_${spec.number}`;
  const lines: JournalLine[] = spec.lines.map((l, idx) => ({
    id: `${id}_l${idx + 1}`,
    journalEntryId: id,
    lineNumber: idx + 1,
    accountId: l.account.id,
    accountCode: l.account.code,
    accountName: l.account.name,
    description: l.memo ?? '',
    debit: l.debit ?? 0,
    credit: l.credit ?? 0,
    entityId: l.entity?.id ?? '',
    entityName: l.entity?.legalName ?? '',
    costCenter: '',
    project: '',
    taxCode: '',
    taxAmount: 0,
    memo: l.memo ?? '',
  }));

  const totals = computeTotals(lines);
  const posted = spec.status === 'posted';
  const postedAt = posted ? new Date(`${spec.date}T10:00:00.000Z`).toISOString() : '';

  return {
    id,
    entryNumber: spec.number,
    entryDate: spec.date,
    reference: spec.reference,
    description: spec.description,
    status: spec.status,
    transactionType: spec.transactionType,
    currency: 'USD',
    exchangeRate: 1,
    totalDebit: totals.totalDebit,
    totalCredit: totals.totalCredit,
    difference: totals.difference,
    notes: '',
    reversalReference: '',
    lines,
    createdAt: TS,
    createdBy: 'System',
    updatedAt: TS,
    updatedBy: 'System',
    postedAt,
    postedBy: posted ? 'Finance Manager' : '',
    approvedBy: posted ? 'Finance Manager' : '',
    voidedAt: '',
    voidedBy: '',
    originalEntryId: '',
    reversalEntryId: '',
  };
}

export function buildSeedJournalEntries(): JournalEntry[] {
  return SPECS.map(buildEntry);
}

export const SEED_JOURNAL_ENTRIES: JournalEntry[] = buildSeedJournalEntries();
