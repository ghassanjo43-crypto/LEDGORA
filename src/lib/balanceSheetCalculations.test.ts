import { describe, it, expect } from 'vitest';
import type { Account, AccountType, NormalBalance } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import {
  buildBalanceSheet,
  selectPostedBalancesAsOf,
  calculateCurrentPeriodProfit,
  detectAbnormal,
  fiscalYearStartDate,
} from './balanceSheetCalculations';
import { buildIncomeStatement } from './incomeStatementCalculations';
import { SEED_JOURNAL_ENTRIES } from '@/data/journalSeed';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';

interface AccOpts { cat?: string; sub?: string; posting?: boolean }
function acc(id: string, type: AccountType, nb: NormalBalance, o: AccOpts = {}): Account {
  return {
    id, code: id, name: `Acct ${id}`, type, parentId: null, level: 1, normalBalance: nb,
    ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: o.cat ?? '', ifrsSubcategory: o.sub ?? '',
    cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: o.posting ?? true, isActive: true, description: '',
    industryTag: 'general', sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}
const BANK = acc('bank', 'ASSET', 'DEBIT', { cat: 'Current assets', sub: 'Cash and cash equivalents' });
const EQUIP = acc('equip', 'ASSET', 'DEBIT', { cat: 'Non-current assets', sub: 'Property, plant and equipment' });
const ACCUMDEP = acc('accdep', 'ASSET', 'CREDIT', { cat: 'Non-current assets', sub: 'Property, plant and equipment' }); // contra
const AR = acc('ar', 'ASSET', 'DEBIT', { cat: 'Current assets', sub: 'Trade receivables' });
const AP = acc('ap', 'LIABILITY', 'CREDIT', { cat: 'Current liabilities', sub: 'Trade payables' });
const LOAN = acc('loan', 'LIABILITY', 'CREDIT', { cat: 'Non-current liabilities', sub: 'Borrowings' });
const CAP = acc('cap', 'EQUITY', 'CREDIT', { cat: 'Equity', sub: 'Share capital' });
const REV = acc('rev', 'INCOME', 'CREDIT', { cat: 'Revenue' });
const EXP = acc('exp', 'OPERATING_EXPENSE', 'DEBIT', { cat: 'Administrative expenses' });
const ACCOUNTS = [BANK, EQUIP, ACCUMDEP, AR, AP, LOAN, CAP, REV, EXP];

let seq = 0;
function ln(accountId: string, debit: number, credit: number, entityId = ''): JournalLine {
  seq += 1;
  return { id: `l${seq}`, journalEntryId: '', lineNumber: 0, accountId, accountCode: accountId, accountName: accountId, description: '', debit, credit, entityId, entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' };
}
function entry(id: string, date: string, status: JournalStatus, lines: JournalLine[]): JournalEntry {
  lines.forEach((l, i) => { l.lineNumber = i + 1; });
  const td = lines.reduce((s, l) => s + l.debit, 0);
  const tc = lines.reduce((s, l) => s + l.credit, 0);
  return {
    id, entryNumber: id, entryDate: date, reference: id, description: id, status, transactionType: '',
    currency: 'USD', exchangeRate: 1, totalDebit: td, totalCredit: tc, difference: td - tc,
    notes: '', reversalReference: '', lines,
    createdAt: `${date}T00:00:00Z`, createdBy: 'T', updatedAt: `${date}T00:00:00Z`, updatedBy: 'T',
    postedAt: status === 'posted' ? `${date}T10:00:00Z` : '', postedBy: '', approvedBy: '', voidedAt: '', voidedBy: '', originalEntryId: '', reversalEntryId: '',
  };
}

const ENTRIES: JournalEntry[] = [
  entry('CAP', '2026-01-05', 'posted', [ln('bank', 100000, 0), ln('cap', 0, 100000)]),
  entry('BUY', '2026-01-10', 'posted', [ln('equip', 30000, 0), ln('bank', 0, 30000)]),
  entry('DEP', '2026-01-31', 'posted', [ln('exp', 2000, 0), ln('accdep', 0, 2000)]),
  entry('SALE', '2026-02-01', 'posted', [ln('ar', 50000, 0, 'cust1'), ln('rev', 0, 50000)]),
  entry('RCPT', '2026-02-10', 'posted', [ln('bank', 20000, 0), ln('ar', 0, 20000, 'cust1')]),
  entry('BILL', '2026-02-15', 'posted', [ln('exp', 8000, 0), ln('ap', 0, 8000)]),
  entry('LOAN', '2026-02-20', 'posted', [ln('bank', 40000, 0), ln('loan', 0, 40000)]),
  entry('DRAFT', '2026-02-25', 'draft', [ln('bank', 99999, 0), ln('rev', 0, 99999)]),
  entry('VOID', '2026-02-26', 'void', [ln('exp', 8888, 0), ln('bank', 0, 8888)]),
];
const OPTS = { asOfDate: '2026-12-31', entityId: '', base: 'USD', fiscalYearStart: '01-01', detail: true, includeZero: false };
const report = buildBalanceSheet(ACCOUNTS, ENTRIES, OPTS);

describe('balance equation', () => {
  it('total assets equal total equity and liabilities', () => {
    expect(report.totalAssets).toBe(report.totalEquityAndLiabilities);
    expect(report.difference).toBe(0);
    expect(report.isBalanced).toBe(true);
  });
});

describe('exclusions & filtering', () => {
  it('excludes draft entries (bank not inflated by 99,999)', () => {
    // bank = 100,000 − 30,000 + 20,000 + 40,000 = 130,000
    const bal = selectPostedBalancesAsOf(ENTRIES, '2026-12-31', 'USD');
    expect(bal.get('bank')).toBe(130000);
  });
  it('excludes void entries (expense unaffected by 8,888)', () => {
    const p = calculateCurrentPeriodProfit(ACCOUNTS, ENTRIES, '2026-12-31', '01-01', 'USD');
    // revenue 50,000 − expenses (2,000 + 8,000) = 40,000
    expect(p).toBe(40000);
  });
  it('respects the as-at date (before the sale, no receivables)', () => {
    const bal = selectPostedBalancesAsOf(ENTRIES, '2026-01-31', 'USD');
    expect(bal.get('ar')).toBeUndefined();
    expect(bal.get('bank')).toBe(70000); // 100,000 − 30,000
  });
  it('filters by entity (only lines tagged to cust1)', () => {
    const bal = selectPostedBalancesAsOf(ENTRIES, '2026-12-31', 'USD', 'cust1');
    expect(bal.get('ar')).toBe(30000); // 50,000 − 20,000, both tagged cust1
    expect(bal.get('bank')).toBeUndefined(); // capital/receipt lines untagged
  });
});

describe('contra assets & abnormal balances', () => {
  it('contra-asset reduces the gross asset group', () => {
    const nonCurrent = report.assets.find((s) => s.id === 'non-current-assets')!;
    const ppe = nonCurrent.groups.find((g) => g.label === 'Property, plant and equipment')!;
    // 30,000 equipment − 2,000 accumulated depreciation = 28,000
    expect(ppe.subtotal).toBe(28000);
  });
  it('detects an abnormal balance (asset with a credit balance)', () => {
    expect(detectAbnormal(BANK, -500).isAbnormal).toBe(true);
    expect(detectAbnormal(BANK, -500).side).toBe('credit');
    expect(detectAbnormal(ACCUMDEP, -2000).isAbnormal).toBe(false); // credit is normal for the contra
    expect(detectAbnormal(BANK, 500).isAbnormal).toBe(false);
  });
});

describe('current-period profit reconciles with the Income Statement', () => {
  it('uses the same figure as buildIncomeStatement', () => {
    const is = buildIncomeStatement(ACCOUNTS, ENTRIES, { from: '2026-01-01', to: '2026-12-31' }, 'USD', { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false });
    expect(report.currentPeriodProfit).toBe(is.totals.netProfit);
    expect(report.currentPeriodProfit).toBe(40000);
  });
});

describe('comparative period', () => {
  it('computes each date independently from closing balances', () => {
    const withComp = buildBalanceSheet(ACCOUNTS, ENTRIES, { ...OPTS, comparativeDate: '2026-01-31' });
    expect(withComp.hasComparative).toBe(true);
    // As at 31 Jan: bank 70,000, equipment 30,000, accdep 2,000 → assets 98,000; balances
    expect(withComp.comparativeTotals!.totalAssets).toBe(98000);
    expect(withComp.comparativeTotals!.difference).toBe(0);
  });
});

describe('empty dataset', () => {
  it('renders safely with no entries', () => {
    const empty = buildBalanceSheet(ACCOUNTS, [], OPTS);
    expect(empty.totalAssets).toBe(0);
    expect(empty.isBalanced).toBe(true);
    expect(empty.difference).toBe(0);
  });
});

describe('fiscal year helper', () => {
  it('resolves the most recent fiscal-year start', () => {
    expect(fiscalYearStartDate('2026-07-31', '01-01')).toBe('2026-01-01');
    expect(fiscalYearStartDate('2026-02-15', '04-01')).toBe('2025-04-01');
  });
});

describe('seed data (10 dummy transactions)', () => {
  const seed = buildBalanceSheet(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, { asOfDate: '2026-07-31', entityId: '', base: 'USD', fiscalYearStart: '01-01', detail: true, includeZero: false });
  it('is balanced with difference 0.00', () => {
    expect(seed.totalAssets).toBe(seed.totalEquityAndLiabilities);
    expect(seed.difference).toBe(0);
    expect(seed.isBalanced).toBe(true);
  });
  it('bank net movement is +223,500 (draft BANK-0726 excluded)', () => {
    const bal = selectPostedBalancesAsOf(SEED_JOURNAL_ENTRIES, '2026-07-31', 'USD');
    const bankId = SEED_ACCOUNTS.find((a) => a.code === '1252')!.id;
    expect(bal.get(bankId)).toBe(223500);
  });
  it('current-period profit equals the Income Statement net result (a 27,750 loss for this dataset)', () => {
    const is = buildIncomeStatement(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, { from: '2026-01-01', to: '2026-07-31' }, 'USD', { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false });
    expect(seed.currentPeriodProfit).toBe(is.totals.netProfit);
    expect(seed.currentPeriodProfit).toBe(-27750);
  });
  it('total assets equal 267,250 (net PPE 28,750 + AR 15,000 + bank 223,500)', () => {
    expect(seed.totalAssets).toBe(267250);
  });
});
