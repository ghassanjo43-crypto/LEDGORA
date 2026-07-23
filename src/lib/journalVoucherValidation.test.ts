/** Universal Journal Voucher — pure validation, totals & allocation tests. */
import { describe, it, expect } from 'vitest';
import type { Account } from '@/types';
import type { JournalVoucher, JournalVoucherLine, JournalVoucherSettings, VoucherTypeConfig } from '@/types/journalVoucher';
import {
  allocateAmount, computeVoucherTotals, expandLineAllocation, validateVoucherForPosting,
  withCredit, withDebit, type VoucherValidationContext,
} from './journalVoucherValidation';

let seq = 0;
const id = (): string => `id_${++seq}`;

const account = (over: Partial<Account>): Account => ({
  id: id(), code: '1000', name: 'Account', type: 'ASSET', parentId: null, level: 0,
  normalBalance: 'DEBIT', ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: '', ifrsSubcategory: '',
  cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: true, isActive: true, description: '',
  industryTag: '', sortOrder: 0, createdAt: '', updatedAt: '', ...over,
});

const line = (over: Partial<JournalVoucherLine>): JournalVoucherLine => ({
  id: id(), lineNumber: 1, accountId: '', accountCode: '', accountName: '', debit: 0, credit: 0,
  description: '', entityId: '', bankAccountId: '', assetId: '', inventoryItemId: '', employee: '',
  relatedCompany: '', branch: '', department: '', costCenterId: '', projectId: '', profitCenter: '',
  location: '', taxCode: '', taxAmount: 0, dueDate: '', reference: '', attachments: [], ...over,
});

const SETTINGS: JournalVoucherSettings = {
  postingLockDate: '', roundingAccountId: '', roundingTolerance: 0.1,
  fxGainAccountId: '', fxLossAccountId: '', openingBalancesLocked: false,
  segregationOfDuties: true, materialAmountThreshold: 10000,
};

const TYPE: VoucherTypeConfig = {
  id: 'type1', code: 'GEN', name: 'General Adjustment', kind: 'general', prefix: 'JV',
  defaultDescription: '', defaultDebitAccountId: '', defaultCreditAccountId: '',
  requiredDimensions: [], approvalRequired: false, allowAutoReversal: false, allowRecurring: false,
  allowTaxCodes: false, allowBankAccounts: false, allowAssetRefs: false, requireIntercompany: false,
  warnFormalDocument: false, isSystem: true, isActive: true,
};

function voucher(lines: JournalVoucherLine[], over: Partial<JournalVoucher> = {}): JournalVoucher {
  return {
    id: id(), number: 'JV-0001', typeId: 'type1', status: 'draft', organizationId: 'org1', companyId: 'co1',
    branch: '', transactionDate: '2026-07-01', postingDate: '2026-07-01', period: '2026-07',
    documentDate: '2026-07-01', currency: 'USD', exchangeRate: 1,
    externalReference: '', internalReference: '', sourceModule: '', sourceTransactionId: '',
    description: 'test', narration: '', autoReverseDate: '', templateId: '', lines,
    journalEntryId: '', journalEntryNumber: '', assetTransactionId: '',
    reversalOfVoucherId: '', reversedByVoucherId: '', replacementVoucherId: '', reversalReason: '',
    intercompanyRef: '', preparedBy: 'A', reviewedBy: '', approvedBy: '', postedBy: '', rejectionComment: '',
    createdAt: '', updatedAt: '', approvedAt: '', postedAt: '', attachments: [], history: [], ...over,
  };
}

function ctx(accounts: Account[], over: Partial<VoucherValidationContext> = {}): VoucherValidationContext {
  return {
    accounts, baseCurrency: 'USD', costCenterIds: new Set(), projectIds: new Set(),
    postingLockDate: '', postedSourceKeys: new Set(), settings: SETTINGS, type: TYPE, ...over,
  };
}

describe('line grid rules', () => {
  it('entering one side clears the other (never both on one line)', () => {
    let l = line({ debit: 100 });
    l = withCredit(l, 40);
    expect(l.debit).toBe(0);
    expect(l.credit).toBe(40);
    l = withDebit(l, 25);
    expect(l.credit).toBe(0);
    expect(l.debit).toBe(25);
  });

  it('computes transaction and base totals with per-line base rounding', () => {
    const totals = computeVoucherTotals(
      [line({ debit: 33.33 }), line({ debit: 66.67 }), line({ credit: 100 })],
      1.005,
    );
    expect(totals.debit).toBe(100);
    expect(totals.credit).toBe(100);
    expect(totals.difference).toBe(0);
    // 33.33×1.005→33.50 · 66.67×1.005→67.00 vs 100×1.005→100.50
    expect(totals.baseDebit).toBe(100.5);
    expect(totals.baseCredit).toBe(100.5);
  });
});

describe('validateVoucherForPosting', () => {
  const cash = account({ code: '1010', name: 'Cash' });
  const bank = account({ code: '1020', name: 'Bank' });

  it('accepts a balanced two-line voucher', () => {
    const v = voucher([line({ accountId: cash.id, debit: 100 }), line({ accountId: bank.id, credit: 100 })]);
    expect(validateVoucherForPosting(v, ctx([cash, bank]))).toHaveLength(0);
  });

  it('rejects unbalanced, too-few-lines and both-sides lines', () => {
    const unbalanced = voucher([line({ accountId: cash.id, debit: 100 }), line({ accountId: bank.id, credit: 90 })]);
    expect(validateVoucherForPosting(unbalanced, ctx([cash, bank])).some((i) => i.code === 'unbalanced')).toBe(true);

    const single = voucher([line({ accountId: cash.id, debit: 100 })]);
    expect(validateVoucherForPosting(single, ctx([cash, bank])).some((i) => i.code === 'too-few-lines')).toBe(true);

    const both = voucher([line({ accountId: cash.id, debit: 100, credit: 100 }), line({ accountId: bank.id, credit: 0, debit: 0 })]);
    expect(validateVoucherForPosting(both, ctx([cash, bank])).some((i) => i.code === 'both-sides')).toBe(true);
  });

  it('rejects inactive accounts, closed periods and foreign dimensions', () => {
    const inactive = account({ code: '1030', name: 'Old account', isActive: false });
    const v1 = voucher([line({ accountId: inactive.id, debit: 50 }), line({ accountId: bank.id, credit: 50 })]);
    expect(validateVoucherForPosting(v1, ctx([inactive, bank])).some((i) => i.code === 'account-inactive')).toBe(true);

    const v2 = voucher([line({ accountId: cash.id, debit: 50 }), line({ accountId: bank.id, credit: 50 })]);
    expect(validateVoucherForPosting(v2, ctx([cash, bank], { postingLockDate: '2026-07-31' })).some((i) => i.code === 'closed-period')).toBe(true);

    const v3 = voucher([line({ accountId: cash.id, debit: 50, costCenterId: 'cc-foreign' }), line({ accountId: bank.id, credit: 50 })]);
    expect(validateVoucherForPosting(v3, ctx([cash, bank])).some((i) => i.code === 'dimension-foreign')).toBe(true);
  });

  it('requires an exchange rate for foreign-currency vouchers', () => {
    const v = voucher([line({ accountId: cash.id, debit: 50 }), line({ accountId: bank.id, credit: 50 })], { currency: 'EUR', exchangeRate: 0 });
    expect(validateVoucherForPosting(v, ctx([cash, bank])).some((i) => i.code === 'rate-missing')).toBe(true);
  });

  it('rejects an unexplained base-currency imbalance; accepts explained rounding within tolerance', () => {
    // 33.33 + 33.33 + 33.34 = 100 vs 100 → base drift of 0.01 at rate 1.005
    const lines = [line({ accountId: cash.id, debit: 33.33 }), line({ accountId: cash.id, debit: 33.33 }), line({ accountId: cash.id, debit: 33.34 }), line({ accountId: bank.id, credit: 100 })];
    const v = voucher(lines, { currency: 'EUR', exchangeRate: 1.005 });
    // No rounding account configured → unexplained → rejected.
    expect(validateVoucherForPosting(v, ctx([cash, bank])).some((i) => i.code === 'base-imbalance')).toBe(true);
    // Configured rounding account + tolerance → explained → accepted.
    const okCtx = ctx([cash, bank], { settings: { ...SETTINGS, roundingAccountId: 'acc-rounding' } });
    expect(validateVoucherForPosting(v, okCtx)).toHaveLength(0);
  });

  it('rejects duplicate source transactions and tax on non-tax types', () => {
    const v = voucher([line({ accountId: cash.id, debit: 50 }), line({ accountId: bank.id, credit: 50 })], { sourceModule: 'payroll', sourceTransactionId: 'RUN-9' });
    expect(validateVoucherForPosting(v, ctx([cash, bank], { postedSourceKeys: new Set(['payroll:RUN-9']) })).some((i) => i.code === 'duplicate-source')).toBe(true);

    const taxed = voucher([line({ accountId: cash.id, debit: 50, taxCode: 'VAT5' }), line({ accountId: bank.id, credit: 50 })]);
    expect(validateVoucherForPosting(taxed, ctx([cash, bank])).some((i) => i.code === 'tax-not-allowed')).toBe(true);
  });

  it('bank transfers must credit exactly one source ≠ destination', () => {
    const transferType: VoucherTypeConfig = { ...TYPE, kind: 'bank_transfer', name: 'Internal Bank Transfer' };
    const same = voucher([line({ accountId: bank.id, debit: 50 }), line({ accountId: bank.id, credit: 50 })]);
    expect(validateVoucherForPosting(same, ctx([cash, bank], { type: transferType })).some((i) => i.code === 'transfer-same-account')).toBe(true);
    const okv = voucher([line({ accountId: cash.id, debit: 50 }), line({ accountId: bank.id, credit: 50 })]);
    expect(validateVoucherForPosting(okv, ctx([cash, bank], { type: transferType }))).toHaveLength(0);
  });
});

describe('allocation', () => {
  it('allocates by percentage totalling exactly 100%, absorbing rounding drift', () => {
    const res = allocateAmount(100, [{ patch: {}, percent: 33.33 }, { patch: {}, percent: 33.33 }, { patch: {}, percent: 33.34 }]);
    expect(res.ok).toBe(true);
    expect(res.amounts.reduce((s, a) => s + a, 0)).toBe(100);
  });

  it('rejects allocations not totalling 100% (or mismatched fixed amounts)', () => {
    expect(allocateAmount(100, [{ patch: {}, percent: 60 }, { patch: {}, percent: 30 }]).ok).toBe(false);
    expect(allocateAmount(100, [{ patch: {}, amount: 70 }, { patch: {}, amount: 20 }]).ok).toBe(false);
    expect(allocateAmount(100, [{ patch: {}, amount: 70 }, { patch: {}, amount: 30 }]).ok).toBe(true);
  });

  it('expands one line into allocated dimension copies', () => {
    const src = line({ accountId: 'acc-exp', debit: 900, description: 'Rent' });
    const res = expandLineAllocation(src, [
      { patch: { costCenterId: 'cc-a' }, percent: 50 },
      { patch: { costCenterId: 'cc-b' }, percent: 50 },
    ], id);
    expect(res.ok).toBe(true);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toMatchObject({ costCenterId: 'cc-a', debit: 450, credit: 0 });
    expect(res.lines[1]).toMatchObject({ costCenterId: 'cc-b', debit: 450 });
  });
});
