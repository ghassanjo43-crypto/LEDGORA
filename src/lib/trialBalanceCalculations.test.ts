import { describe, it, expect } from 'vitest';
import type { Account, AccountType, NormalBalance } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import {
  buildTrialBalanceRows,
  filterTrialBalanceRows,
  groupTrialBalanceRows,
  calculateTrialBalanceTotals,
  detectAbnormalBalance,
  buildTrialBalanceExceptions,
  reconcileTrialBalance,
  convertLineToBaseCurrency,
} from './trialBalanceCalculations';
import { SEED_JOURNAL_ENTRIES } from '@/data/journalSeed';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';

function acc(id: string, type: AccountType, normalBalance: NormalBalance, posting = true): Account {
  return {
    id, code: id, name: `Acct ${id}`, type, parentId: null, level: 1, normalBalance,
    ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: '', ifrsSubcategory: '',
    cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: posting, isActive: true, description: '',
    industryTag: 'general', sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}
const BANK = acc('bank', 'ASSET', 'DEBIT');
const REV = acc('rev', 'INCOME', 'CREDIT');
const AR = acc('ar', 'ASSET', 'DEBIT');
const AP = acc('ap', 'LIABILITY', 'CREDIT');
const RENT = acc('rent', 'OPERATING_EXPENSE', 'DEBIT');
const INS = acc('ins', 'ASSET', 'DEBIT'); // no activity
const HEADER = acc('hdr', 'ASSET', 'DEBIT', false); // non-posting
const ACCOUNTS = [BANK, REV, AR, AP, RENT, INS, HEADER];

let seq = 0;
function ln(accountId: string, debit: number, credit: number): JournalLine {
  seq += 1;
  return { id: `l${seq}`, journalEntryId: '', lineNumber: 0, accountId, accountCode: accountId, accountName: accountId, description: '', debit, credit, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' };
}
function entry(id: string, date: string, status: JournalStatus, lines: JournalLine[], o: { currency?: string; rate?: number; reversalReference?: string } = {}): JournalEntry {
  lines.forEach((l, i) => { l.lineNumber = i + 1; });
  const td = lines.reduce((s, l) => s + l.debit, 0);
  const tc = lines.reduce((s, l) => s + l.credit, 0);
  return {
    id, entryNumber: id, entryDate: date, reference: id, description: id, status, transactionType: '',
    currency: o.currency ?? 'USD', exchangeRate: o.rate ?? 1, totalDebit: td, totalCredit: tc, difference: td - tc,
    notes: '', reversalReference: o.reversalReference ?? '', lines,
    createdAt: `${date}T00:00:00Z`, createdBy: 'T', updatedAt: `${date}T00:00:00Z`, updatedBy: 'T',
    postedAt: status === 'posted' ? `${date}T10:00:00Z` : '', postedBy: '', approvedBy: '', voidedAt: '', voidedBy: '', originalEntryId: '', reversalEntryId: '',
  };
}

const ENTRIES: JournalEntry[] = [
  entry('BEFORE', '2025-12-31', 'posted', [ln('bank', 2000, 0), ln('rev', 0, 2000)]),
  entry('E1', '2026-01-05', 'posted', [ln('ar', 35000, 0), ln('rev', 0, 35000)]),
  entry('E2', '2026-01-10', 'posted', [ln('bank', 20000, 0), ln('ar', 0, 20000)]),
  entry('E3', '2026-01-12', 'posted', [ln('rent', 500, 0), ln('bank', 0, 500)]),
  entry('BILL', '2026-01-15', 'posted', [ln('rent', 400, 0), ln('ap', 0, 400)]),
  entry('PAY', '2026-01-16', 'posted', [ln('ap', 400, 0), ln('bank', 0, 400)]),
  entry('REVSL', '2026-01-20', 'posted', [ln('rev', 200, 0), ln('ar', 0, 200)], { reversalReference: 'REV-E1' }),
  entry('DRAFT', '2026-01-18', 'draft', [ln('bank', 9999, 0), ln('rev', 0, 9999)]),
  entry('VOID', '2026-01-19', 'void', [ln('bank', 8888, 0), ln('rev', 0, 8888)]),
  entry('FX', '2026-01-25', 'posted', [ln('rent', 100, 0), ln('bank', 0, 100)], { currency: 'EUR', rate: 1.1 }),
  entry('FXBAD', '2026-01-26', 'posted', [ln('rent', 50, 0), ln('bank', 0, 50)], { currency: 'EUR', rate: 0 }),
];
const YEAR = { from: '2026-01-01', to: '2026-12-31' };
const rows = buildTrialBalanceRows(ACCOUNTS, ENTRIES, YEAR, 'USD');
const row = (id: string) => rows.find((r) => r.accountId === id)!;

describe('currency', () => {
  it('converts foreign amounts by the entry rate', () => {
    expect(convertLineToBaseCurrency(100, 'EUR', 1.1, 'USD')).toBeCloseTo(110);
  });
});

describe('posted-only source', () => {
  it('excludes drafts and voids from account figures', () => {
    // bank would be huge if draft/void counted; expected closing 20,940
    expect(row('bank').closingDebit).toBe(20940);
  });
  it('excludes non-posting header accounts entirely', () => {
    expect(rows.find((r) => r.accountId === 'hdr')).toBeUndefined();
  });
  it('includes reversal entries', () => {
    // AR: 35,000 − 20,000 − 200 (reversal) = 14,800 Dr
    expect(row('ar').closingDebit).toBe(14800);
  });
});

describe('opening / period / closing', () => {
  it('opening balance from pre-period activity', () => {
    expect(row('bank').openingDebit).toBe(2000);
    expect(row('rev').openingCredit).toBe(2000);
  });
  it('period movement (debits & credits)', () => {
    expect(row('rent').periodDebits).toBe(1060); // 500 + 400 + 110 (FX) + 50 (FXBAD@1)
    expect(row('bank').periodCredits).toBe(1060);
  });
  it('closing split into the true debit/credit side', () => {
    expect(row('rev').closingCredit).toBe(36800);
    expect(row('rev').closingDebit).toBe(0);
    expect(row('ap').closingDebit).toBe(0);
    expect(row('ap').closingCredit).toBe(0);
  });
});

describe('zero-balance handling', () => {
  it('keeps an account that had activity but closed at zero (AP)', () => {
    const filtered = filterTrialBalanceRows(rows, { search: '', type: 'ALL', includeZero: false, active: 'active' });
    expect(filtered.some((r) => r.accountId === 'ap')).toBe(true);
  });
  it('hides an account with no activity (INS) when zeros are off', () => {
    const filtered = filterTrialBalanceRows(rows, { search: '', type: 'ALL', includeZero: false, active: 'active' });
    expect(filtered.some((r) => r.accountId === 'ins')).toBe(false);
  });
  it('shows it when zeros are on', () => {
    const filtered = filterTrialBalanceRows(rows, { search: '', type: 'ALL', includeZero: true, active: 'active' });
    expect(filtered.some((r) => r.accountId === 'ins')).toBe(true);
  });
});

describe('totals & grouping', () => {
  it('grand closing debits equal credits', () => {
    const t = calculateTrialBalanceTotals(rows);
    expect(t.closingDebit).toBe(t.closingCredit);
    expect(t.closingDifference).toBe(0);
  });
  it('group subtotals sum the posting rows only (no double count)', () => {
    const groups = groupTrialBalanceRows(rows);
    const assets = groups.find((g) => g.id === 'assets')!;
    // Assets posting rows: bank 20,940 + ar 14,800 (+ ins 0) = 35,740 Dr
    expect(assets.subtotals.closingDebit).toBe(35740);
    const sumOfRows = assets.rows.reduce((s, r) => s + r.closingDebit, 0);
    expect(assets.subtotals.closingDebit).toBe(sumOfRows);
  });
  it('export totals equal on-screen totals (same function)', () => {
    const a = calculateTrialBalanceTotals(rows);
    const b = calculateTrialBalanceTotals(filterTrialBalanceRows(rows, { search: '', type: 'ALL', includeZero: true, active: 'all' }));
    expect(a.closingDebit).toBe(b.closingDebit);
  });
});

describe('abnormal & exceptions', () => {
  it('detects abnormal balances', () => {
    expect(detectAbnormalBalance({ normalBalance: 'DEBIT' }, -500).abnormal).toBe(true);
    expect(detectAbnormalBalance({ normalBalance: 'DEBIT' }, -500).side).toBe('credit');
    expect(detectAbnormalBalance({ normalBalance: 'CREDIT' }, 500).abnormal).toBe(true);
    expect(detectAbnormalBalance({ normalBalance: 'DEBIT' }, 500).abnormal).toBe(false);
  });
  it('flags a foreign line with a missing exchange rate', () => {
    const ex = buildTrialBalanceExceptions(rows, ENTRIES, ACCOUNTS, 'USD');
    expect(ex.some((e) => e.id.startsWith('fx-'))).toBe(true);
  });
});

describe('seed data reflects posted-only trial balance', () => {
  const seedRows = buildTrialBalanceRows(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, { from: '0000-01-01', to: '9999-12-31' }, 'USD');
  const r = (code: string) => seedRows.find((x) => x.accountCode === code)!;
  it('draft bank charge excluded → bank closing 223,500 Dr', () => {
    expect(r('1252').closingDebit).toBe(223500);
  });
  it('AR 15,000 Dr, AP 0, equipment 30,000 Dr, accum. dep 1,250 Cr, share capital 250,000 Cr', () => {
    expect(r('1221').closingDebit).toBe(15000);
    expect(r('2210').closingDebit).toBe(0);
    expect(r('2210').closingCredit).toBe(0);
    expect(r('1114').closingDebit).toBe(30000);
    expect(r('1119').closingCredit).toBe(1250);
    expect(r('3100').closingCredit).toBe(250000);
  });
  it('closing debits equal closing credits and reconciles', () => {
    const t = calculateTrialBalanceTotals(seedRows);
    expect(t.closingDebit).toBe(t.closingCredit);
    const rec = reconcileTrialBalance(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, { from: '0000-01-01', to: '9999-12-31' }, 'USD');
    expect(rec.ok).toBe(true);
  });
});
