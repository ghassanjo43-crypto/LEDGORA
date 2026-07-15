import { describe, it, expect } from 'vitest';
import type { Account, AccountType, NormalBalance, ProfitOrLossCategory } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import {
  buildIncomeStatement,
  buildAccountAmounts,
  calculateComparativeVariance,
  calculateMargins,
  detectMissingMappings,
  reconcileIncomeStatement,
  convertToBaseCurrency2,
} from './incomeStatementCalculations';
import { SEED_JOURNAL_ENTRIES } from '@/data/journalSeed';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';
import { buildTrialBalanceRows } from './trialBalanceCalculations';

interface AccOpts { plCat?: ProfitOrLossCategory; ifrsCat?: string; posting?: boolean }
function acc(id: string, type: AccountType, normalBalance: NormalBalance, o: AccOpts = {}): Account {
  return {
    id, code: id, name: `Acct ${id}`, type, parentId: null, level: 1, normalBalance,
    ifrsStatement: type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY' ? 'STATEMENT_OF_FINANCIAL_POSITION' : type === 'OCI' ? 'OCI' : 'PROFIT_OR_LOSS',
    ifrsCategory: o.ifrsCat ?? 'General', ifrsSubcategory: '', cashFlowCategory: 'NOT_APPLICABLE',
    profitOrLossCategory: o.plCat, isPostingAccount: o.posting ?? true, isActive: true, description: '',
    industryTag: 'general', sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}

const REV = acc('rev', 'INCOME', 'CREDIT', { plCat: 'OPERATING', ifrsCat: 'Revenue' });
const RET = acc('ret', 'INCOME', 'DEBIT', { plCat: 'OPERATING', ifrsCat: 'Revenue' }); // contra-revenue
const COS = acc('cos', 'COST_OF_SALES', 'DEBIT', { plCat: 'OPERATING', ifrsCat: 'Cost of sales' });
const OPEX1 = acc('opex1', 'OPERATING_EXPENSE', 'DEBIT', { plCat: 'OPERATING', ifrsCat: 'Administrative expenses' });
const OPEX2 = acc('opex2', 'OPERATING_EXPENSE', 'DEBIT', { plCat: 'OPERATING', ifrsCat: 'Administrative expenses' });
const OINC = acc('oinc', 'OTHER_INCOME_EXPENSE', 'CREDIT', { plCat: 'INVESTING', ifrsCat: 'Other income' });
const FINC = acc('finc', 'FINANCE', 'CREDIT', { plCat: 'FINANCING', ifrsCat: 'Finance income' });
const FCOST = acc('fcost', 'FINANCE', 'DEBIT', { plCat: 'FINANCING', ifrsCat: 'Finance costs' });
const TAX = acc('tax', 'TAX', 'DEBIT', { plCat: 'INCOME_TAXES', ifrsCat: 'Taxation' });
const NOCAT = acc('nocat', 'OPERATING_EXPENSE', 'DEBIT', { plCat: 'OPERATING', ifrsCat: '' });
const BANK = acc('bank', 'ASSET', 'DEBIT', { ifrsCat: 'Cash' });
const OCI = acc('oci', 'OCI', 'CREDIT', { ifrsCat: 'Revaluation' });
const ACCOUNTS = [REV, RET, COS, OPEX1, OPEX2, OINC, FINC, FCOST, TAX, NOCAT, BANK, OCI];

let seq = 0;
function ln(accountId: string, debit: number, credit: number): JournalLine {
  seq += 1;
  return { id: `l${seq}`, journalEntryId: '', lineNumber: 0, accountId, accountCode: accountId, accountName: accountId, description: '', debit, credit, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' };
}
function entry(id: string, date: string, status: JournalStatus, lines: JournalLine[], o: { currency?: string; rate?: number } = {}): JournalEntry {
  lines.forEach((l, i) => { l.lineNumber = i + 1; });
  const td = lines.reduce((s, l) => s + l.debit, 0);
  const tc = lines.reduce((s, l) => s + l.credit, 0);
  return {
    id, entryNumber: id, entryDate: date, reference: id, description: id, status, transactionType: '',
    currency: o.currency ?? 'USD', exchangeRate: o.rate ?? 1, totalDebit: td, totalCredit: tc, difference: td - tc,
    notes: '', reversalReference: '', lines,
    createdAt: `${date}T00:00:00Z`, createdBy: 'T', updatedAt: `${date}T00:00:00Z`, updatedBy: 'T',
    postedAt: status === 'posted' ? `${date}T10:00:00Z` : '', postedBy: '', approvedBy: '', voidedAt: '', voidedBy: '', originalEntryId: '', reversalEntryId: '',
  };
}

const ENTRIES: JournalEntry[] = [
  entry('REV1', '2026-03-01', 'posted', [ln('bank', 100000, 0), ln('rev', 0, 100000)]),
  entry('RET1', '2026-03-05', 'posted', [ln('ret', 5000, 0), ln('bank', 0, 5000)]),
  entry('COS1', '2026-03-10', 'posted', [ln('cos', 40000, 0), ln('bank', 0, 40000)]),
  entry('SAL1', '2026-03-15', 'posted', [ln('opex1', 20000, 0), ln('bank', 0, 20000)]),
  entry('RNT1', '2026-03-20', 'posted', [ln('opex2', 10000, 0), ln('bank', 0, 10000)]),
  entry('OIN1', '2026-04-01', 'posted', [ln('bank', 3000, 0), ln('oinc', 0, 3000)]),
  entry('FIN1', '2026-04-05', 'posted', [ln('bank', 1000, 0), ln('finc', 0, 1000)]),
  entry('FCO1', '2026-04-10', 'posted', [ln('fcost', 2000, 0), ln('bank', 0, 2000)]),
  entry('TAX1', '2026-04-15', 'posted', [ln('tax', 4000, 0), ln('bank', 0, 4000)]),
  entry('NOC1', '2026-04-20', 'posted', [ln('nocat', 500, 0), ln('bank', 0, 500)]),
  entry('OCI1', '2026-04-25', 'posted', [ln('bank', 9000, 0), ln('oci', 0, 9000)]), // excluded
  entry('DRAFT', '2026-03-02', 'draft', [ln('bank', 50000, 0), ln('rev', 0, 50000)]), // excluded
  entry('VOID', '2026-03-03', 'void', [ln('opex1', 8000, 0), ln('bank', 0, 8000)]), // excluded
  entry('PY_REV', '2025-03-01', 'posted', [ln('bank', 80000, 0), ln('rev', 0, 80000)]), // comparative
];
const P = { from: '2026-01-01', to: '2026-12-31' };
const base = 'USD';
const opts = { presentation: 'IAS1' as const, detail: 'standard' as const, comparison: 'none' as const, includeZero: false };
const result = buildIncomeStatement(ACCOUNTS, ENTRIES, P, base, opts);
const t = result.totals;

describe('source: posted-only, correct account universe', () => {
  it('includes posted revenue (net of contra-revenue returns)', () => {
    expect(t.revenue).toBe(95000); // 100,000 − 5,000 returns
  });
  it('excludes draft revenue', () => {
    expect(t.revenue).not.toBe(145000);
  });
  it('excludes void expense', () => {
    expect(t.operatingExpenses).toBe(30500); // 20,000 + 10,000 + 500 (nocat), not +8,000 void
  });
  it('includes posted expenses', () => {
    expect(t.costOfSales).toBe(40000);
  });
  it('excludes balance-sheet accounts', () => {
    expect(result.amounts.some((a) => a.accountCode === 'bank')).toBe(false);
  });
  it('excludes OCI from the primary statement', () => {
    expect(result.amounts.some((a) => a.accountCode === 'oci')).toBe(false);
  });
});

describe('signs', () => {
  it('revenue shows positive for a normal credit balance', () => {
    const rev = result.amounts.find((a) => a.accountCode === 'rev')!;
    expect(rev.currentAmount).toBe(100000);
  });
  it('a contra-revenue account reduces revenue (negative line)', () => {
    const ret = result.amounts.find((a) => a.accountCode === 'ret')!;
    expect(ret.currentAmount).toBe(-5000);
  });
  it('expense shows positive for a normal debit balance', () => {
    const cos = result.amounts.find((a) => a.accountCode === 'cos')!;
    expect(cos.currentAmount).toBe(40000);
  });
});

describe('subtotals', () => {
  it('gross profit', () => { expect(t.grossProfit).toBe(55000); }); // 95,000 − 40,000
  it('operating profit', () => { expect(t.operatingProfit).toBe(24500); }); // 55,000 − 30,500
  it('profit before tax', () => { expect(t.profitBeforeTax).toBe(26500); }); // 24,500 + 3,000 + 1,000 − 2,000
  it('net profit', () => { expect(t.netProfit).toBe(22500); }); // 26,500 − 4,000
});

describe('comparatives, variance & margins', () => {
  it('variance is current − comparative', () => {
    expect(calculateComparativeVariance(95000, 80000).variance).toBe(15000);
    expect(calculateComparativeVariance(95000, 80000).variancePercent).toBeCloseTo(0.1875);
  });
  it('variance % handles a zero prior safely', () => {
    expect(calculateComparativeVariance(100, 0).variancePercent).toBeNull();
  });
  it('margins are ratios of revenue', () => {
    const m = calculateMargins(t);
    expect(m.grossMargin).toBeCloseTo(55000 / 95000);
    expect(m.netMargin).toBeCloseTo(22500 / 95000);
  });
  it('previous-year comparative pulls prior revenue', () => {
    const r = buildIncomeStatement(ACCOUNTS, ENTRIES, P, base, { ...opts, comparison: 'previous-year' });
    expect(r.hasComparative).toBe(true);
    expect(r.comparativeTotals.revenue).toBe(80000);
  });
});

describe('currency', () => {
  it('re-exports the base-currency converter', () => {
    expect(convertToBaseCurrency2(1000, 'EUR', 1.5, 'USD')).toBeCloseTo(1500);
  });
  it('sums foreign revenue at the entry rate', () => {
    const fx = [...ENTRIES, entry('FX', '2026-05-01', 'posted', [ln('bank', 1000, 0), ln('rev', 0, 1000)], { currency: 'EUR', rate: 1.5 })];
    const r = buildIncomeStatement(ACCOUNTS, fx, P, base, opts);
    expect(r.totals.revenue).toBe(96500); // 95,000 + 1,500
  });
});

describe('exceptions & reconciliation', () => {
  it('flags an account with activity but no IFRS category', () => {
    const ex = detectMissingMappings(ACCOUNTS, ENTRIES, P, base, false);
    expect(ex.some((e) => e.accountCode === 'nocat')).toBe(true);
  });
  it('net profit reconciles to Σ(credits − debits) over posted P&L lines', () => {
    const rec = reconcileIncomeStatement(ACCOUNTS, ENTRIES, P, base);
    expect(rec.ok).toBe(true);
    expect(rec.difference).toBe(0);
    expect(rec.netProfit).toBe(22500);
  });
  it('net profit reconciles to the Trial Balance P&L movement', () => {
    const rows = buildTrialBalanceRows(ACCOUNTS, ENTRIES, P, base);
    const plTypes = new Set(['INCOME', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME_EXPENSE', 'FINANCE', 'TAX', 'DISCONTINUED_OPERATIONS']);
    const tbNet = rows.filter((r) => plTypes.has(r.accountType)).reduce((s, r) => s + (r.periodCredits - r.periodDebits), 0);
    expect(Math.round(tbNet)).toBe(t.netProfit);
  });
});

describe('line reconciliation & detail levels', () => {
  it('category totals reconcile to the section subtotal (standard)', () => {
    const catLine = result.lines.find((l) => l.id === 'cat-operatingExpenses-Administrative expenses')!;
    const totalLine = result.lines.find((l) => l.id === 'total-operatingExpenses')!;
    // Admin expenses category = opex1 + opex2 = 30,000; section total also includes nocat (own category)
    expect(catLine.currentAmount).toBe(30000);
    expect(totalLine.currentAmount).toBe(30500);
  });
  it('detailed account lines reconcile to the section subtotal', () => {
    const detailed = buildIncomeStatement(ACCOUNTS, ENTRIES, P, base, { ...opts, detail: 'detailed' });
    const accLines = detailed.lines.filter((l) => l.lineType === 'account' && ['acc-opex1', 'acc-opex2', 'acc-nocat'].includes(l.id));
    const sum = accLines.reduce((s, l) => s + l.currentAmount, 0);
    const totalLine = detailed.lines.find((l) => l.id === 'total-operatingExpenses')!;
    expect(sum).toBe(totalLine.currentAmount);
  });
  it('account lines carry accountIds for drill-down', () => {
    const detailed = buildIncomeStatement(ACCOUNTS, ENTRIES, P, base, { ...opts, detail: 'detailed' });
    expect(detailed.lines.find((l) => l.id === 'acc-cos')!.accountIds).toEqual(['cos']);
  });
});

describe('IFRS 18 presentation', () => {
  const r18 = buildIncomeStatement(ACCOUNTS, ENTRIES, P, base, { ...opts, presentation: 'IFRS18' });
  it('groups by profit-or-loss category and reconciles to the same net profit', () => {
    const net = r18.lines.find((l) => l.id === 'ifrs18-net')!;
    expect(net.currentAmount).toBe(22500);
    const operating = r18.lines.find((l) => l.id === 'ifrs18-total-OPERATING')!;
    // 100,000 − 5,000 − 40,000 − 30,500 = 24,500
    expect(operating.currentAmount).toBe(24500);
  });
});

describe('seed data', () => {
  const WIDE = { from: '0000-01-01', to: '9999-12-31' };
  const seed = buildIncomeStatement(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, WIDE, 'USD', { presentation: 'IAS1', detail: 'standard', comparison: 'none', includeZero: false });
  it('reflects posted service revenue and a net loss (draft bank charge excluded)', () => {
    expect(seed.totals.revenue).toBe(35000);
    expect(seed.totals.financeCosts).toBe(0); // draft 7200 excluded
    expect(seed.totals.netProfit).toBe(-27750); // 35,000 − 62,750 operating expenses
  });
  it('reconciles', () => {
    expect(reconcileIncomeStatement(SEED_ACCOUNTS, SEED_JOURNAL_ENTRIES, WIDE, 'USD').ok).toBe(true);
  });
});

// keep buildAccountAmounts referenced (public API used by the page)
describe('api surface', () => {
  it('buildAccountAmounts returns only P&L accounts', () => {
    const a = buildAccountAmounts(ACCOUNTS, ENTRIES, P, null, base);
    expect(a.every((x) => x.accountCode !== 'bank' && x.accountCode !== 'oci')).toBe(true);
  });
});
