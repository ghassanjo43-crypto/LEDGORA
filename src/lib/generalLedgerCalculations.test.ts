import { describe, it, expect } from 'vitest';
import type { Account, AccountType, NormalBalance } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import {
  getPostedJournalLines,
  calculateOpeningBalance,
  buildAccountLedger,
  groupLedgerLinesByAccount,
  filterLedgerLines,
  getBalanceSide,
  convertToBaseCurrency,
  reconcileLedger,
} from './generalLedgerCalculations';

function acc(id: string, type: AccountType, normalBalance: NormalBalance): Account {
  return {
    id, code: id, name: `Acct ${id}`, type, parentId: null, level: 1, normalBalance,
    ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: '', ifrsSubcategory: '',
    cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: true, isActive: true, description: '',
    industryTag: 'general', sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}
const BANK = acc('bank', 'ASSET', 'DEBIT');
const REV = acc('rev', 'INCOME', 'CREDIT');
const RENT = acc('rent', 'OPERATING_EXPENSE', 'DEBIT');
const ACCOUNTS = [BANK, REV, RENT];

let seq = 0;
function ln(accountId: string, debit: number, credit: number, entityId = ''): JournalLine {
  seq += 1;
  return { id: `l${seq}`, journalEntryId: '', lineNumber: 0, accountId, accountCode: accountId, accountName: accountId, description: '', debit, credit, entityId, entityName: entityId, costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' };
}
function entry(id: string, date: string, status: JournalStatus, lines: JournalLine[], o: { currency?: string; rate?: number; reversalReference?: string; originalEntryId?: string } = {}): JournalEntry {
  lines.forEach((l, i) => { l.lineNumber = i + 1; });
  const td = lines.reduce((s, l) => s + l.debit, 0);
  const tc = lines.reduce((s, l) => s + l.credit, 0);
  return {
    id, entryNumber: id, entryDate: date, reference: `REF-${id}`, description: id, status,
    transactionType: '', currency: o.currency ?? 'USD', exchangeRate: o.rate ?? 1, totalDebit: td, totalCredit: tc, difference: td - tc,
    notes: '', reversalReference: o.reversalReference ?? '', lines,
    createdAt: `${date}T00:00:00Z`, createdBy: 'Dave', updatedAt: `${date}T00:00:00Z`, updatedBy: 'Dave',
    postedAt: status === 'posted' ? `${date}T10:00:00Z` : '', postedBy: status === 'posted' ? 'Mgr' : '', approvedBy: '',
    voidedAt: '', voidedBy: '', originalEntryId: o.originalEntryId ?? '', reversalEntryId: '',
  };
}

const ENTRIES: JournalEntry[] = [
  entry('BEFORE', '2025-12-31', 'posted', [ln('bank', 2000, 0), ln('rev', 0, 2000)]),
  entry('E1', '2026-01-05', 'posted', [ln('bank', 1000, 0), ln('rev', 0, 1000)]),
  entry('E2', '2026-01-10', 'posted', [ln('rent', 300, 0), ln('bank', 0, 300)]),
  entry('E3', '2026-02-01', 'posted', [ln('bank', 500, 0, 'c1'), ln('rev', 0, 500)]),
  entry('REV1', '2026-02-05', 'posted', [ln('rev', 200, 0), ln('bank', 0, 200)], { reversalReference: 'REV-E1', originalEntryId: 'E1' }),
  entry('FX', '2026-02-10', 'posted', [ln('rent', 100, 0), ln('bank', 0, 100)], { currency: 'EUR', rate: 1.1 }),
  entry('DRAFT', '2026-01-20', 'draft', [ln('bank', 9999, 0), ln('rev', 0, 9999)]),
  entry('VOID', '2026-01-21', 'void', [ln('bank', 8888, 0), ln('rev', 0, 8888)]),
];
const YEAR = { from: '2026-01-01', to: '2026-12-31' };

describe('source of truth', () => {
  it('includes only posted lines (drafts & voids excluded)', () => {
    const posted = getPostedJournalLines(ENTRIES);
    expect(posted.some((p) => p.entry.id === 'DRAFT')).toBe(false);
    expect(posted.some((p) => p.entry.id === 'VOID')).toBe(false);
    expect(posted.some((p) => p.entry.id === 'E1')).toBe(true);
  });
  it('reversal entries appear as posted, flagged Reversal', () => {
    const led = buildAccountLedger(BANK, ENTRIES, YEAR, 'USD');
    const rev = led.lines.find((l) => l.journalNumber === 'REV1');
    expect(rev?.transactionType).toBe('Reversal');
  });
});

describe('currency', () => {
  it('converts foreign amounts by the entry rate', () => {
    expect(convertToBaseCurrency(100, 'EUR', 1.1, 'USD')).toBeCloseTo(110);
    expect(convertToBaseCurrency(100, 'USD', 1, 'USD')).toBe(100);
  });
});

describe('opening balance', () => {
  it('includes posted transactions before the start date', () => {
    expect(calculateOpeningBalance(BANK, ENTRIES, '2026-01-01', 'USD')).toBe(2000); // BEFORE only
  });
  it('rolls forward as the start date advances', () => {
    // before 2026-02-01: BEFORE 2000 + E1 1000 − E2 300 = 2700
    expect(calculateOpeningBalance(BANK, ENTRIES, '2026-02-01', 'USD')).toBe(2700);
  });
});

describe('running balance & closing (debit-normal: bank)', () => {
  const led = buildAccountLedger(BANK, ENTRIES, YEAR, 'USD');
  it('opening 2000 Dr, closing 2890 Dr', () => {
    expect(led.openingBalance).toBe(2000);
    expect(led.closingBalance).toBe(2890);
  });
  it('running balance is opening + cumulative signed', () => {
    expect(led.lines.map((l) => l.runningBalance)).toEqual([3000, 2700, 3200, 3000, 2890]);
  });
  it('closing equals opening + net movement', () => {
    expect(led.closingBalance).toBe(led.openingBalance + led.netMovement);
    expect(led.periodDebits).toBe(1500);
    expect(led.periodCredits).toBe(610);
    expect(led.netMovement).toBe(890);
  });
});

describe('running balance (credit-normal: revenue)', () => {
  const led = buildAccountLedger(REV, ENTRIES, YEAR, 'USD');
  it('credit-normal balance stays positive Cr', () => {
    expect(led.openingBalance).toBe(2000);
    expect(led.closingBalance).toBe(3300);
    expect(led.lines.map((l) => l.runningBalance)).toEqual([3000, 3500, 3300]);
  });
});

describe('foreign currency in balances (rent)', () => {
  it('includes base-converted FX line', () => {
    const led = buildAccountLedger(RENT, ENTRIES, YEAR, 'USD');
    // rent: E2 300 + FX 110 = 410 Dr
    expect(led.closingBalance).toBe(410);
    expect(led.lines.find((l) => l.journalNumber === 'FX')?.baseDebit).toBeCloseTo(110);
  });
});

describe('balance side & abnormal', () => {
  it('labels sides by normal balance', () => {
    expect(getBalanceSide(500, 'DEBIT')).toBe('debit');
    expect(getBalanceSide(-500, 'DEBIT')).toBe('credit'); // asset with net credit = abnormal
    expect(getBalanceSide(500, 'CREDIT')).toBe('credit');
    expect(getBalanceSide(0, 'DEBIT')).toBe('zero');
  });
  it('flags abnormal running balances', () => {
    const contra = acc('contra', 'ASSET', 'DEBIT');
    const e = [entry('X', '2026-03-01', 'posted', [ln('contra', 0, 700), ln('rev', 700, 0)])];
    const led = buildAccountLedger(contra, e, YEAR, 'USD');
    expect(led.lines[0]!.abnormal).toBe(true);
    expect(led.lines[0]!.balanceSide).toBe('credit');
  });
});

describe('date & entity filtering', () => {
  it('period lines exclude out-of-range dates but opening still includes them', () => {
    const feb = buildAccountLedger(BANK, ENTRIES, { from: '2026-02-01', to: '2026-02-28' }, 'USD');
    expect(feb.openingBalance).toBe(2700); // Jan rolled into opening
    expect(feb.lines.every((l) => l.entryDate >= '2026-02-01')).toBe(true);
    expect(feb.closingBalance).toBe(2890);
  });
  it('filters lines by entity', () => {
    const led = buildAccountLedger(BANK, ENTRIES, YEAR, 'USD');
    const only = filterLedgerLines(led.lines, { entityId: 'c1', reference: '', journalNumber: '', project: '', costCenter: '', search: '' });
    expect(only.map((l) => l.journalNumber)).toEqual(['E3']);
  });
});

describe('multi-account grouping', () => {
  it('produces a ledger per active posting account, sorted by code', () => {
    const groups = groupLedgerLinesByAccount(ACCOUNTS, ENTRIES, YEAR, 'USD');
    expect(groups.map((g) => g.account.id).sort()).toEqual(['bank', 'rent', 'rev']);
    groups.forEach((g) => expect(g.closingBalance).toBe(g.openingBalance + g.netMovement));
  });
});

describe('reconciliation', () => {
  it('global base debits equal credits and per-account balances reconcile', () => {
    const r = reconcileLedger(ENTRIES, ACCOUNTS, 'USD');
    expect(r.balanced).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.totalDebits).toBe(r.totalCredits);
  });
});
