import { describe, it, expect } from 'vitest';
import type { Account, AccountType, CashFlowCategory, NormalBalance } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import {
  buildCashFlowStatement,
  selectCashAccounts,
  calculateOpeningCash,
  calculateClosingCash,
  calculateWorkingCapitalChanges,
  calculateNonCashAdjustments,
  accountActivity,
} from './cashFlowCalculations';
import { DEFAULT_CASH_FLOW_POLICY } from '@/types/cashFlow';
import { buildIncomeStatement } from './incomeStatementCalculations';
import { SEED_JOURNAL_ENTRIES } from '@/data/journalSeed';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';

interface AccOpts { cat?: string; sub?: string; cash?: CashFlowCategory }
function acc(id: string, type: AccountType, nb: NormalBalance, o: AccOpts = {}): Account {
  return {
    id, code: id, name: `Acct ${id}`, type, parentId: null, level: 1, normalBalance: nb,
    ifrsStatement: 'PROFIT_OR_LOSS', ifrsCategory: o.cat ?? '', ifrsSubcategory: o.sub ?? '',
    cashFlowCategory: o.cash ?? 'NOT_APPLICABLE', isPostingAccount: true, isActive: true, description: '',
    industryTag: 'general', sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}
const BANK = acc('bank', 'ASSET', 'DEBIT', { cat: 'Current assets', sub: 'Cash and cash equivalents' });
const PETTY = acc('petty', 'ASSET', 'DEBIT', { cat: 'Current assets', sub: 'Cash and cash equivalents' });
const AR = acc('ar', 'ASSET', 'DEBIT', { cat: 'Current assets', sub: 'Trade receivables' });
const INV = acc('inv', 'ASSET', 'DEBIT', { cat: 'Current assets', sub: 'Inventories' });
const AP = acc('ap', 'LIABILITY', 'CREDIT', { cat: 'Current liabilities', sub: 'Trade payables' });
const EQUIP = acc('equip', 'ASSET', 'DEBIT', { cat: 'Non-current assets', sub: 'Property, plant and equipment' });
const ACCDEP = acc('accdep', 'ASSET', 'CREDIT', { cat: 'Non-current assets', sub: 'Property, plant and equipment', cash: 'NON_CASH' });
const LOAN = acc('loan', 'LIABILITY', 'CREDIT', { cat: 'Non-current liabilities', sub: 'Borrowings' });
const CAP = acc('cap', 'EQUITY', 'CREDIT', { cat: 'Equity', sub: 'Share capital' });
const REV = acc('rev', 'INCOME', 'CREDIT', { cat: 'Revenue' });
const EXP = acc('exp', 'OPERATING_EXPENSE', 'DEBIT', { cat: 'Administrative expenses' });
const DEP = acc('dep', 'OPERATING_EXPENSE', 'DEBIT', { cat: 'Administrative expenses', cash: 'NON_CASH' });
const FINCOST = acc('fincost', 'FINANCE', 'DEBIT', { cat: 'Finance costs' });
const ACCOUNTS = [BANK, PETTY, AR, INV, AP, EQUIP, ACCDEP, LOAN, CAP, REV, EXP, DEP, FINCOST];

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
  entry('CAP', '2026-01-05', 'posted', [ln('bank', 100000, 0), ln('cap', 0, 100000)]),      // financing +100,000
  entry('BUY', '2026-01-10', 'posted', [ln('equip', 30000, 0), ln('bank', 0, 30000)]),       // investing (30,000)
  entry('LOAN', '2026-01-12', 'posted', [ln('bank', 40000, 0), ln('loan', 0, 40000)]),        // financing +40,000
  entry('SALE', '2026-02-01', 'posted', [ln('ar', 50000, 0, 'c1'), ln('rev', 0, 50000)]),      // no cash
  entry('RCPT', '2026-02-05', 'posted', [ln('bank', 20000, 0), ln('ar', 0, 20000, 'c1')]),      // operating +20,000
  entry('RENT', '2026-02-10', 'posted', [ln('exp', 5000, 0), ln('bank', 0, 5000)]),             // operating (5,000)
  entry('BUYINV', '2026-02-15', 'posted', [ln('inv', 8000, 0), ln('bank', 0, 8000)]),           // operating (8,000) inventory
  entry('DEP', '2026-03-01', 'posted', [ln('dep', 2000, 0), ln('accdep', 0, 2000)]),            // non-cash
  entry('XFER', '2026-03-05', 'posted', [ln('petty', 1000, 0), ln('bank', 0, 1000)]),           // internal transfer
  entry('DRAFT', '2026-03-10', 'draft', [ln('bank', 99999, 0), ln('rev', 0, 99999)]),           // excluded
  entry('VOID', '2026-03-11', 'void', [ln('exp', 8888, 0), ln('bank', 0, 8888)]),               // excluded
];
const PERIOD = { periodStart: '2026-01-01', periodEnd: '2026-12-31', base: 'USD' };
const cf = buildCashFlowStatement(ACCOUNTS, ENTRIES, PERIOD);
const cashIds = new Set(selectCashAccounts(ACCOUNTS).map((a) => a.id));

describe('cash accounts & balances', () => {
  it('selects cash accounts by metadata (bank + petty, not receivables)', () => {
    const ids = selectCashAccounts(ACCOUNTS).map((a) => a.id).sort();
    expect(ids).toEqual(['bank', 'petty']);
  });
  it('opening cash is calculated before the period (zero here)', () => {
    expect(calculateOpeningCash(ENTRIES, cashIds, '2026-01-01', 'USD')).toBe(0);
  });
  it('closing cash = bank 116,000 + petty 1,000 = 117,000', () => {
    // bank: +100k −30k +40k +20k −5k −8k −1k(xfer) = 116,000 ; petty +1,000
    expect(calculateClosingCash(ENTRIES, cashIds, '2026-12-31', 'USD')).toBe(117000);
  });
});

describe('exclusions & filtering', () => {
  it('excludes drafts and voids (closing cash unaffected by 99,999 / 8,888)', () => {
    expect(cf.balanceSheetClosingCash).toBe(117000);
  });
  it('reporting-period filtering (nothing before Feb)', () => {
    const janOnly = buildCashFlowStatement(ACCOUNTS, ENTRIES, { periodStart: '2026-02-01', periodEnd: '2026-02-28', base: 'USD' });
    expect(janOnly.openingCash).toBe(110000); // 100k −30k +40k as at 31 Jan
  });
  it('entity filtering restricts to tagged lines', () => {
    const wc = calculateWorkingCapitalChanges(ACCOUNTS, ENTRIES, { start: '2026-01-01', end: '2026-12-31' }, 'USD', 'c1', DEFAULT_CASH_FLOW_POLICY);
    const ar = wc.find((l) => l.accountIds[0] === 'ar')!;
    // AR tagged c1: +50,000 −20,000 = 30,000 increase → adjustment −30,000
    expect(ar.amount).toBe(-30000);
  });
});

describe('cash direction & transfers', () => {
  it('cash-account debit paired with financing is an inflow', () => {
    const capLine = cf.financingActivities.find((l) => l.accountIds[0] === 'cap')!;
    expect(capLine.amount).toBe(100000);
  });
  it('cash-account credit paired with investing is an outflow', () => {
    const equipLine = cf.investingActivities.find((l) => l.accountIds[0] === 'equip')!;
    expect(equipLine.amount).toBe(-30000);
  });
  it('cash-to-cash transfers are excluded (petty↔bank not a flow)', () => {
    const all = [...cf.investingActivities, ...cf.financingActivities];
    expect(all.some((l) => l.journalEntryIds.includes('XFER'))).toBe(false);
    // total cash still moved internally but net change excludes it
  });
});

describe('working-capital sign rules', () => {
  const wc = calculateWorkingCapitalChanges(ACCOUNTS, ENTRIES, { start: '2026-01-01', end: '2026-12-31' }, 'USD', undefined, DEFAULT_CASH_FLOW_POLICY);
  it('increase in an operating asset → negative adjustment', () => {
    expect(wc.find((l) => l.accountIds[0] === 'ar')!.amount).toBe(-30000); // AR up 30,000
    expect(wc.find((l) => l.accountIds[0] === 'inv')!.amount).toBe(-8000); // inventory up 8,000
  });
  it('increase in an operating liability → positive adjustment', () => {
    // no AP movement here → not present; verify formula via a decrease scenario
    const e2 = [...ENTRIES, entry('PAYSUP', '2026-04-01', 'posted', [ln('ap', 0, 12000), ln('bank', 12000, 0)])];
    const wc2 = calculateWorkingCapitalChanges(ACCOUNTS, e2, { start: '2026-01-01', end: '2026-12-31' }, 'USD', undefined, DEFAULT_CASH_FLOW_POLICY);
    expect(wc2.find((l) => l.accountIds[0] === 'ap')!.amount).toBe(12000); // liability up 12,000 → +12,000 inflow
  });
});

describe('non-cash adjustments', () => {
  it('depreciation is added back (+2,000)', () => {
    const adj = calculateNonCashAdjustments(ACCOUNTS, ENTRIES, { start: '2026-01-01', end: '2026-12-31' }, 'USD');
    expect(adj.find((l) => l.accountIds[0] === 'dep')!.amount).toBe(2000);
  });
});

describe('activity classification & policy', () => {
  it('non-current asset purchase is investing', () => {
    expect(accountActivity(EQUIP, DEFAULT_CASH_FLOW_POLICY)).toBe('investing');
  });
  it('capital and borrowings are financing', () => {
    expect(accountActivity(CAP, DEFAULT_CASH_FLOW_POLICY)).toBe('financing');
    expect(accountActivity(LOAN, DEFAULT_CASH_FLOW_POLICY)).toBe('financing');
  });
  it('borrowing principal (financing) is separated from interest (finance cost policy)', () => {
    expect(accountActivity(FINCOST, DEFAULT_CASH_FLOW_POLICY)).toBe('operating'); // interestPaid: operating
    expect(accountActivity(FINCOST, { ...DEFAULT_CASH_FLOW_POLICY, interestPaid: 'financing' })).toBe('financing');
  });
});

describe('reconciliation & profit', () => {
  it('net profit agrees with the Income Statement', () => {
    const is = buildIncomeStatement(ACCOUNTS, ENTRIES, { from: '2026-01-01', to: '2026-12-31' }, 'USD', { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false });
    expect(cf.profitForPeriod).toBe(is.totals.netProfit);
  });
  it('closing cash agrees with the Balance Sheet and reconciles to 0.00', () => {
    expect(cf.calculatedClosingCash).toBe(cf.balanceSheetClosingCash);
    expect(cf.reconciliationDifference).toBe(0);
    expect(cf.isReconciled).toBe(true);
  });
  it('net change in cash = 117,000 (operating + investing + financing)', () => {
    expect(cf.netChangeInCash).toBe(117000);
    expect(round(cf.netOperatingCashFlow + cf.netInvestingCashFlow + cf.netFinancingCashFlow)).toBe(117000);
  });
});

function round(n: number): number { return Math.round(n * 100) / 100; }

describe('comparative & empty', () => {
  it('comparative period is calculated independently', () => {
    const withComp = buildCashFlowStatement(ACCOUNTS, ENTRIES, { ...PERIOD, comparativePeriod: { start: '2025-01-01', end: '2025-12-31' } });
    expect(withComp.hasComparative).toBe(true);
    expect(withComp.comparativeTotals!.netChangeInCash).toBe(0); // no 2025 activity
  });
  it('empty dataset renders safely', () => {
    const empty = buildCashFlowStatement(ACCOUNTS, [], PERIOD);
    expect(empty.netChangeInCash).toBe(0);
    expect(empty.isReconciled).toBe(true);
    expect(empty.openingCash).toBe(0);
  });
});

describe('seed data (10 dummy transactions)', () => {
  const seed = buildCashFlowStatement(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, { periodStart: '2026-01-01', periodEnd: '2026-07-31', base: 'USD' });
  it('reconciles to the Balance Sheet cash with difference 0.00', () => {
    expect(seed.calculatedClosingCash).toBe(seed.balanceSheetClosingCash);
    expect(seed.reconciliationDifference).toBe(0);
    expect(seed.isReconciled).toBe(true);
  });
  it('bank movement is +223,500 (draft BANK-0726 excluded)', () => {
    expect(seed.netChangeInCash).toBe(223500);
    expect(seed.balanceSheetClosingCash).toBe(223500);
    expect(seed.openingCash).toBe(0);
  });
  it('net profit equals the Income Statement (a 27,750 loss for this dataset)', () => {
    const is = buildIncomeStatement(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, { from: '2026-01-01', to: '2026-07-31' }, 'USD', { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false });
    expect(seed.profitForPeriod).toBe(is.totals.netProfit);
    expect(seed.profitForPeriod).toBe(-27750);
  });
  it('operating 3,500 · investing (30,000) · financing 250,000', () => {
    expect(seed.netOperatingCashFlow).toBe(3500);
    expect(seed.netInvestingCashFlow).toBe(-30000);
    expect(seed.netFinancingCashFlow).toBe(250000);
  });
});
