import { describe, it, expect } from 'vitest';
import type { Account, AccountType, NormalBalance } from '@/types';
import {
  isBlankJournalLine,
  isPostingAccount,
  balanceStatus,
  computeTotals,
  activeLines,
  validateJournalDraft,
  validateJournalForPosting,
  type FormLikeLine,
  type FormLikeValues,
} from './journalValidation';

function account(id: string, type: AccountType, nb: NormalBalance, opts: { posting?: boolean; active?: boolean } = {}): Account {
  return {
    id, code: id, name: `Acct ${id}`, type, parentId: null, level: 1, normalBalance: nb,
    ifrsStatement: 'PROFIT_OR_LOSS', ifrsCategory: '', ifrsSubcategory: '', cashFlowCategory: 'NOT_APPLICABLE',
    isPostingAccount: opts.posting ?? true, isActive: opts.active ?? true, description: '', industryTag: 'general',
    sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}

// A posting/leaf account (like 1252 Bank) and a non-posting header/parent.
const BANK = account('1252', 'ASSET', 'DEBIT', { posting: true });
const CAPITAL = account('3100', 'EQUITY', 'CREDIT', { posting: true });
const HEADER = account('1000', 'ASSET', 'DEBIT', { posting: false });
const accountsById = new Map<string, Account>([BANK, CAPITAL, HEADER].map((a) => [a.id, a]));

const blankLine = (): FormLikeLine => ({ accountId: '', debit: 0, credit: 0, memo: '', entityId: '', costCenter: '', project: '', taxCode: '', taxAmount: 0 });
function line(over: Partial<FormLikeLine>): FormLikeLine { return { ...blankLine(), ...over }; }

describe('isBlankJournalLine', () => {
  it('treats a fully empty placeholder row as blank', () => {
    expect(isBlankJournalLine(blankLine())).toBe(true);
  });
  it('is not blank once any field is filled', () => {
    expect(isBlankJournalLine(line({ accountId: '1252' }))).toBe(false);
    expect(isBlankJournalLine(line({ debit: 100 }))).toBe(false);
    expect(isBlankJournalLine(line({ memo: 'x' }))).toBe(false);
    expect(isBlankJournalLine(line({ debit: '0', credit: '50' }))).toBe(false); // string amounts
  });
});

describe('isPostingAccount', () => {
  it('accepts a genuine posting/leaf account (1252)', () => {
    expect(isPostingAccount(BANK)).toBe(true);
  });
  it('rejects a non-posting header/parent account', () => {
    expect(isPostingAccount(HEADER)).toBe(false);
  });
  it('rejects undefined', () => {
    expect(isPostingAccount(undefined)).toBe(false);
  });
});

describe('balanceStatus', () => {
  it('zero/zero totals are "not started", never "unbalanced"', () => {
    expect(balanceStatus(computeTotals([{ debit: 0, credit: 0 }, { debit: 0, credit: 0 }]))).toBe('not-started');
  });
  it('non-zero disagreeing totals are "unbalanced"', () => {
    expect(balanceStatus(computeTotals([{ debit: 100, credit: 0 }, { debit: 0, credit: 40 }]))).toBe('unbalanced');
  });
  it('non-zero agreeing totals are "balanced"', () => {
    expect(balanceStatus(computeTotals([{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }]))).toBe('balanced');
  });
});

describe('activeLines', () => {
  it('ignores blank placeholder rows and keeps original row numbers', () => {
    const lines = [line({ accountId: '1252', debit: 100 }), blankLine(), line({ accountId: '3100', credit: 100 })];
    const active = activeLines(lines);
    expect(active).toHaveLength(2);
    expect(active.map((l) => l.lineNumber)).toEqual([1, 3]);
  });
});

describe('validateJournalDraft (lenient)', () => {
  it('allows an incomplete draft (missing accounts / amounts / unbalanced / one line)', () => {
    const values: FormLikeValues = { description: '', entryDate: '2026-07-11', lines: [line({ debit: 50 }), blankLine()] };
    expect(validateJournalDraft(values)).toEqual([]);
  });
  it('still blocks a line with both a debit and a credit', () => {
    const values: FormLikeValues = { lines: [line({ accountId: '1252', debit: 50, credit: 50 })] };
    expect(validateJournalDraft(values).some((i) => i.rule === 'debit-and-credit')).toBe(true);
  });
});

describe('validateJournalForPosting (strict)', () => {
  const empty: FormLikeValues = { description: '', entryDate: '2026-07-11', lines: [blankLine(), blankLine()] };

  it('an empty new entry reports the required posting errors (revealed only after a post attempt in the UI)', () => {
    const issues = validateJournalForPosting(empty, accountsById);
    expect(issues.some((i) => i.rule === 'min-lines')).toBe(true);
    expect(issues.some((i) => i.rule === 'description-required')).toBe(true);
    // blank rows are ignored, so there is NO "select a posting account" per blank line
    expect(issues.some((i) => i.rule === 'account-required')).toBe(false);
  });

  it('accepts a balanced two-line entry that uses posting account 1252', () => {
    const values: FormLikeValues = {
      description: 'Owner capital',
      entryDate: '2026-07-11',
      lines: [line({ accountId: '1252', debit: 1000 }), line({ accountId: '3100', credit: 1000 })],
    };
    expect(validateJournalForPosting(values, accountsById)).toEqual([]);
  });

  it('resolves the selected account by its string ID', () => {
    const values: FormLikeValues = { description: 'x', entryDate: '2026-07-11', lines: [line({ accountId: '1252', debit: 10 }), line({ accountId: '3100', credit: 10 })] };
    // 1252 resolves to a posting account → no header/account errors
    const issues = validateJournalForPosting(values, accountsById);
    expect(issues.some((i) => i.rule === 'header-account' || i.rule === 'account-required')).toBe(false);
  });

  it('rejects a non-posting header account consistently with the picker', () => {
    const values: FormLikeValues = { description: 'x', entryDate: '2026-07-11', lines: [line({ accountId: '1000', debit: 10 }), line({ accountId: '3100', credit: 10 })] };
    const issues = validateJournalForPosting(values, accountsById);
    expect(issues.some((i) => i.rule === 'header-account')).toBe(true);
    expect(isPostingAccount(HEADER)).toBe(false); // the picker filters on the same helper
  });

  it('requires at least two active lines', () => {
    const values: FormLikeValues = { description: 'x', entryDate: '2026-07-11', lines: [line({ accountId: '1252', debit: 10 }), blankLine()] };
    expect(validateJournalForPosting(values, accountsById).some((i) => i.rule === 'min-lines')).toBe(true);
  });

  it('requires non-zero balanced totals', () => {
    const unbalanced: FormLikeValues = { description: 'x', entryDate: '2026-07-11', lines: [line({ accountId: '1252', debit: 100 }), line({ accountId: '3100', credit: 60 })] };
    expect(validateJournalForPosting(unbalanced, accountsById).some((i) => i.rule === 'unbalanced')).toBe(true);
  });
});
