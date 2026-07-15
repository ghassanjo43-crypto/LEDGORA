import { describe, it, expect } from 'vitest';
import type { Account } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import type { BusinessEntity } from '@/types';
import {
  calculateAccountBalance,
  calculateCashAndBankBalance,
  calculatePeriodIncome,
  calculatePeriodExpenses,
  calculateNetIncome,
  calculateReceivablesBalance,
  calculatePayablesBalance,
  calculateTopExpenses,
  convertToBase,
  resolvePeriod,
} from './dashboardCalculations';

const REF = new Date('2026-07-10T00:00:00');
const YEAR = resolvePeriod('this-year', REF); // 2026-01-01 .. 2026-12-31

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function acc(p: Partial<Account> & Pick<Account, 'id' | 'code' | 'name' | 'type' | 'normalBalance'>): Account {
  return {
    parentId: null,
    level: 1,
    ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION',
    ifrsCategory: '',
    ifrsSubcategory: '',
    cashFlowCategory: 'NOT_APPLICABLE',
    isPostingAccount: true,
    isActive: true,
    description: '',
    industryTag: 'general',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

const BANK = acc({ id: 'bank', code: '1252', name: 'Bank current accounts', type: 'ASSET', normalBalance: 'DEBIT', ifrsSubcategory: 'Cash and cash equivalents' });
const CASH = acc({ id: 'cash', code: '1251', name: 'Cash on hand', type: 'ASSET', normalBalance: 'DEBIT', ifrsSubcategory: 'Cash and cash equivalents' });
const AR = acc({ id: 'ar', code: '1221', name: 'Trade receivables', type: 'ASSET', normalBalance: 'DEBIT', ifrsSubcategory: 'Trade receivables' });
const AP = acc({ id: 'ap', code: '2210', name: 'Trade payables', type: 'LIABILITY', normalBalance: 'CREDIT', ifrsSubcategory: 'Trade payables' });
const REV = acc({ id: 'rev', code: '4120', name: 'Service revenue', type: 'INCOME', normalBalance: 'CREDIT', ifrsStatement: 'PROFIT_OR_LOSS' });
const RENT = acc({ id: 'rent', code: '6200', name: 'Rent', type: 'OPERATING_EXPENSE', normalBalance: 'DEBIT', ifrsStatement: 'PROFIT_OR_LOSS' });
const SAL = acc({ id: 'sal', code: '6110', name: 'Salaries', type: 'OPERATING_EXPENSE', normalBalance: 'DEBIT', ifrsStatement: 'PROFIT_OR_LOSS' });

const ACCOUNTS = [BANK, CASH, AR, AP, REV, RENT, SAL];

function ent(id: string, legalName: string, type: BusinessEntity['entityType']): BusinessEntity {
  return {
    id, entityCode: id, legalName, tradingName: '', entityType: type,
    contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '', website: '',
    country: '', city: '', addressLine1: '', addressLine2: '', postalCode: '',
    taxRegistrationNumber: '', commercialRegistrationNumber: '', paymentTerms: 'NET_30', defaultCurrency: 'USD',
    bankName: '', bankAccountName: '', iban: '', swiftCode: '', notes: '', isActive: true,
    customerCategory: '', creditLimit: 0, defaultRevenueAccount: '', defaultReceivableAccount: '', defaultInvoiceTemplateId: '',
    invoiceDeliveryMethod: '', customerPaymentTerms: '', supplierCategory: '', defaultExpenseAccount: '',
    defaultPayableAccount: '', supplierPaymentTerms: '', withholdingTaxApplicable: false, preferredPaymentMethod: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
const C1 = ent('c1', 'Customer One', 'customer');
const S1 = ent('s1', 'Supplier One', 'supplier');
const ENTITIES = [C1, S1];

let seq = 0;
function line(accountId: string, debit: number, credit: number, entityId = ''): JournalLine {
  seq += 1;
  return {
    id: `l${seq}`, journalEntryId: '', lineNumber: 0, accountId, accountCode: '', accountName: '',
    description: '', debit, credit, entityId, entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '',
  };
}
function entry(
  id: string, date: string, status: JournalStatus, lines: JournalLine[],
  opts: { currency?: string; rate?: number } = {},
): JournalEntry {
  return {
    id, entryNumber: id, entryDate: date, reference: '', description: id, status,
    transactionType: '', currency: opts.currency ?? 'USD', exchangeRate: opts.rate ?? 1,
    totalDebit: 0, totalCredit: 0, difference: 0, notes: '', reversalReference: '', lines,
    createdAt: `${date}T00:00:00.000Z`, createdBy: 'T', updatedAt: `${date}T00:00:00.000Z`, updatedBy: 'T',
    postedAt: status === 'posted' ? `${date}T00:00:00.000Z` : '', postedBy: '', approvedBy: '',
    voidedAt: status === 'void' ? `${date}T00:00:00.000Z` : '', voidedBy: '',
    originalEntryId: '', reversalEntryId: '',
  };
}

const ENTRIES: JournalEntry[] = [
  entry('JE-P1', '2026-02-01', 'posted', [line('bank', 1000, 0), line('rev', 0, 1000)]),
  entry('JE-P2', '2026-02-05', 'posted', [line('rent', 500, 0), line('bank', 0, 500)]),
  entry('JE-P3', '2026-02-06', 'posted', [line('sal', 700, 0), line('cash', 0, 700)]),
  entry('JE-AR', '2026-02-10', 'posted', [line('ar', 800, 0, 'c1'), line('rev', 0, 800)]),
  entry('JE-REC', '2026-02-20', 'posted', [line('bank', 300, 0), line('ar', 0, 300, 'c1')]),
  entry('JE-AP', '2026-02-12', 'posted', [line('rent', 400, 0), line('ap', 0, 400, 's1')]),
  // Excluded from financials:
  entry('JE-DRAFT', '2026-02-15', 'draft', [line('bank', 5000, 0), line('rev', 0, 5000)]),
  entry('JE-VOID', '2026-02-16', 'void', [line('bank', 9999, 0), line('rev', 0, 9999)]),
  // Prior year — excluded from 2026 period:
  entry('JE-2025', '2025-12-31', 'posted', [line('rev', 0, 4444), line('bank', 4444, 0)]),
];

const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('currency conversion', () => {
  it('does not touch base-currency amounts', () => {
    expect(convertToBase(100, 'USD', 1, 'USD')).toBe(100);
  });
  it('applies the entry rate for foreign amounts', () => {
    expect(convertToBase(100, 'EUR', 1.1, 'USD')).toBeCloseTo(110);
  });
});

describe('sign handling', () => {
  it('debit-normal account = debits − credits (bank, point-in-time incl. prior year)', () => {
    // 1000 in − 500 out + 300 in + 4444 (2025) = 5244
    expect(calculateAccountBalance('bank', ENTRIES, byId, 'USD')).toBe(5244);
  });
  it('credit-normal revenue is positive', () => {
    // 1000 + 800 + 4444 (2025) = 6244
    expect(calculateAccountBalance('rev', ENTRIES, byId, 'USD')).toBe(6244);
  });
  it('credit-normal payables positive', () => {
    expect(calculateAccountBalance('ap', ENTRIES, byId, 'USD')).toBe(400);
  });
});

describe('financial summaries exclude drafts and voids', () => {
  it('income counts posted revenue only, in period', () => {
    // 1000 + 800 (draft 5000 and void 9999 and 2025 excluded)
    expect(calculatePeriodIncome(ENTRIES, ACCOUNTS, YEAR, 'USD')).toBe(1800);
  });
  it('expenses count posted expense accounts', () => {
    // rent 500 + 400, salaries 700 = 1600
    expect(calculatePeriodExpenses(ENTRIES, ACCOUNTS, YEAR, 'USD')).toBe(1600);
  });
  it('net income = income − expenses', () => {
    expect(calculateNetIncome(ENTRIES, ACCOUNTS, YEAR, 'USD', REF).net).toBe(200);
  });
});

describe('period filtering', () => {
  it('excludes prior-year postings from this-year', () => {
    const feb = resolvePeriod('custom', REF, { from: '2026-02-01', to: '2026-02-28' });
    expect(calculatePeriodIncome(ENTRIES, ACCOUNTS, feb, 'USD')).toBe(1800);
    const march = resolvePeriod('custom', REF, { from: '2026-03-01', to: '2026-03-31' });
    expect(calculatePeriodIncome(ENTRIES, ACCOUNTS, march, 'USD')).toBe(0);
  });
});

describe('cash & bank', () => {
  it('derives from cash-classified accounts only', () => {
    const s = calculateCashAndBankBalance(ENTRIES, ACCOUNTS, 'USD');
    expect(s.bank).toBe(5244); // bank net incl. prior year
    expect(s.cashOnHand).toBe(-700); // cash paid out
    expect(s.total).toBe(4544);
    expect(s.accountCount).toBe(2);
  });
});

describe('receivables & payables', () => {
  it('receivables derive from AR lines per customer', () => {
    const r = calculateReceivablesBalance(ENTRIES, ACCOUNTS, ENTITIES, 'USD');
    expect(r.total).toBe(500); // 800 − 300
    expect(r.customerCount).toBe(1);
    expect(r.topBalances[0]).toMatchObject({ entityId: 'c1', amount: 500 });
    expect(r.agingAvailable).toBe(false);
  });
  it('payables derive from AP lines per supplier', () => {
    const p = calculatePayablesBalance(ENTRIES, ACCOUNTS, ENTITIES, 'USD');
    expect(p.total).toBe(400);
    expect(p.topBalances[0]).toMatchObject({ entityId: 's1', amount: 400 });
  });
});

describe('top expenses', () => {
  it('ranks expense accounts by amount', () => {
    const top = calculateTopExpenses(ENTRIES, ACCOUNTS, YEAR, 'USD');
    expect(top[0]).toMatchObject({ accountId: 'rent', amount: 900 }); // 500 + 400
    expect(top[1]).toMatchObject({ accountId: 'sal', amount: 700 });
    const totalPct = top.reduce((s, t) => s + t.pctOfTotal, 0);
    expect(Math.round(totalPct)).toBe(100);
  });
});

describe('foreign currency', () => {
  it('converts foreign revenue before summing', () => {
    const fx = [entry('JE-EUR', '2026-02-02', 'posted', [line('bank', 0, 100), line('rev', 0, 100)], { currency: 'EUR', rate: 1.1 })];
    // revenue 100 EUR → 110 base
    expect(calculatePeriodIncome(fx, ACCOUNTS, YEAR, 'USD')).toBe(110);
  });
});
