// @vitest-environment happy-dom
/**
 * Universal Journal Voucher — end-to-end workflow contract.
 *
 * One flexible voucher for every balanced non-document transaction, posted
 * through the existing General Journal seam, with approval workflow, duplicate
 * protection, immutability, reversal/correction, recurring templates,
 * intercompany pairs, asset delegation, permissions, tenant isolation and
 * operator-mode audit attribution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Account } from '@/types';
import type { RegisteredUser } from '@/types/onboarding';
import type { JournalVoucher, RecurringVoucherTemplate } from '@/types/journalVoucher';
import { useJournalVoucherStore, makeBlankVoucher, makeBlankLine } from '@/store/journalVoucherStore';
import { useJournalStore } from '@/store/journalStore';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { useStore } from '@/store/useStore';
import { useAuthStore } from '@/store/authStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useCompanyStore } from '@/store/companyStore';
import { resetBusinessWorkspace } from '@/store/businessWorkspace';
import { computeVoucherTotals, renumber } from '@/lib/journalVoucherValidation';
import { openingBalanceVouchers, manualTaxAdjustments, reconcileVouchersToJournal } from '@/lib/journalVoucherReports';
import { calculateAccountClosingNet, calculateAccountPeriodMovement } from '@/lib/trialBalanceCalculations';
import { selectPostedBalancesAsOf } from '@/lib/balanceSheetCalculations';
import { classifyIncomeStatementSection, getProfitOrLossDisplayAmount } from '@/lib/incomeStatementCalculations';
import type { AssetCategory } from '@/types/fixedAssets';
import { generateId, nowIso } from '@/lib/utils';

/* ── Workbench ────────────────────────────────────────────────────────────── */

const jv = () => useJournalVoucherStore.getState();
const journal = () => useJournalStore.getState();
const accounts = () => useStore.getState().accounts;

function findAccount(fragment: string): Account {
  const hit = accounts().find((a) => a.isPostingAccount && a.name.toLowerCase().includes(fragment.toLowerCase()));
  if (!hit) throw new Error(`bench: account "${fragment}" not found`);
  return hit;
}

function addAccount(code: string, name: string, type: Account['type'], normalBalance: 'DEBIT' | 'CREDIT', isActive = true): Account {
  const acc: Account = {
    id: generateId('acc'), code, name, type, parentId: null, level: 0, normalBalance,
    ifrsStatement: type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY' ? 'STATEMENT_OF_FINANCIAL_POSITION' : 'PROFIT_OR_LOSS',
    ifrsCategory: 'Test', ifrsSubcategory: 'Test', cashFlowCategory: 'NOT_APPLICABLE',
    isPostingAccount: true, isActive, description: '', industryTag: '', sortOrder: 9000,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  useStore.setState({ accounts: [...accounts(), acc] });
  return acc;
}

interface Bench {
  bank: Account; cash: Account; ap: Account; expense: Account; revenue: Account;
  accrued: Account; prepaid: Account; provision: Account; provisionExp: Account;
  charges: Account; suspense: Account; equity: Account; fxGain: Account; fxLoss: Account;
  dueTo: Account; dueFrom: Account; vatOut: Account; petty: Account; inactive: Account;
}

function seedBench(): Bench {
  useStore.getState().resetToDefault();
  journal().replaceAll([]);
  jv().resetToDefault();
  useFixedAssetStore.getState().resetToDefault();
  useAuthStore.setState({ users: [], currentUserId: null });
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useOperatorViewStore.getState().exit();
  useCompanyStore.getState().ensureInitialized(); // legal-entity scope, as AppLayout does
  jv().ensureSeeded();

  const bench: Bench = {
    bank: findAccount('Bank current accounts'),
    cash: addAccount('1015', 'Petty cash — main safe', 'ASSET', 'DEBIT'),
    ap: findAccount('Trade payables'),
    expense: findAccount('Rent and utilities'),
    revenue: findAccount('Service revenue'),
    accrued: findAccount('Accrued expenses'),
    prepaid: addAccount('1250', 'Prepaid expenses', 'ASSET', 'DEBIT'),
    provision: addAccount('2400', 'Provision for warranty', 'LIABILITY', 'CREDIT'),
    provisionExp: addAccount('6900', 'Provision expense', 'OPERATING_EXPENSE', 'DEBIT'),
    charges: findAccount('Finance costs'),
    suspense: addAccount('1990', 'Suspense account', 'ASSET', 'DEBIT'),
    equity: addAccount('3900', 'Opening balance equity', 'EQUITY', 'CREDIT'),
    fxGain: addAccount('7300', 'FX gain', 'OTHER_INCOME_EXPENSE', 'CREDIT'),
    fxLoss: addAccount('7310', 'FX loss', 'OTHER_INCOME_EXPENSE', 'DEBIT'),
    dueTo: addAccount('2600', 'Due to related parties', 'LIABILITY', 'CREDIT'),
    dueFrom: addAccount('1610', 'Due from related parties', 'ASSET', 'DEBIT'),
    vatOut: findAccount('VAT / sales tax payable'),
    petty: addAccount('1016', 'Petty cash — site', 'ASSET', 'DEBIT'),
    inactive: addAccount('1999', 'Legacy account', 'ASSET', 'DEBIT', false),
  };
  return bench;
}

function typeByCode(code: string) {
  const t = jv().types.find((x) => x.code === code);
  if (!t) throw new Error(`bench: voucher type ${code} not found`);
  return t;
}

/** Build a draft voucher of the given type with debit/credit line pairs. */
function draft(
  code: string,
  pairs: Array<{ accountId: string; debit?: number; credit?: number; costCenterId?: string; taxCode?: string; taxAmount?: number }>,
  over: Partial<JournalVoucher> = {},
): JournalVoucher {
  const v: JournalVoucher = {
    ...makeBlankVoucher(typeByCode(code)),
    description: `${code} test voucher`,
    ...over,
    lines: renumber(pairs.map((p) => ({ ...makeBlankLine(), accountId: p.accountId, debit: p.debit ?? 0, credit: p.credit ?? 0, costCenterId: p.costCenterId ?? '', taxCode: p.taxCode ?? '', taxAmount: p.taxAmount ?? 0 }))),
  };
  const res = jv().saveDraft(v);
  if (!res.ok) throw new Error(res.error);
  return jv().vouchers.find((x) => x.id === res.id!)!;
}

/** Draft + post in one step; returns the refreshed voucher. */
function post(code: string, pairs: Parameters<typeof draft>[1], over: Partial<JournalVoucher> = {}): JournalVoucher {
  const v = draft(code, pairs, over);
  const res = jv().postVoucher(v.id);
  if (!res.ok) throw new Error(res.error);
  return jv().vouchers.find((x) => x.id === v.id)!;
}

const jvEntries = () => journal().entries.filter((e) => e.transactionType === 'Journal Voucher');

function glNet(accountId: string): number {
  let net = 0;
  for (const e of journal().entries) {
    if (e.status !== 'posted') continue;
    for (const l of e.lines) if (l.accountId === accountId) net += l.debit - l.credit;
  }
  return Math.round(net * 100) / 100;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  useOperatorViewStore.getState().exit();
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
});

/* ── Core posting ─────────────────────────────────────────────────────────── */

describe('core voucher posting', () => {
  it('posts a balanced two-line voucher through the General Journal with two-way links', () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 250 }, { accountId: b.bank.id, credit: 250 }]);
    expect(v.status).toBe('posted');
    expect(v.journalEntryNumber).toBeTruthy();

    const entries = jvEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBe(v.journalEntryId);
    expect(entry.reference).toBe(`JV:${v.number}`);
    expect(entry.totalDebit).toBe(entry.totalCredit);
    expect(entry.status).toBe('posted');
    // The General Journal remains the accounting record — no second ledger.
    expect(glNet(b.expense.id)).toBe(250);
    expect(glNet(b.bank.id)).toBe(-250);
  });

  it('posts a multi-line voucher and keeps the Trial Balance level', () => {
    const b = seedBench();
    post('GEN', [
      { accountId: b.expense.id, debit: 300 },
      { accountId: b.charges.id, debit: 200 },
      { accountId: b.suspense.id, debit: 100 },
      { accountId: b.bank.id, credit: 450 },
      { accountId: b.cash.id, credit: 150 },
    ]);
    const all = journal().entries.filter((e) => e.status === 'posted');
    const totalD = all.reduce((s, e) => s + e.totalDebit, 0);
    const totalC = all.reduce((s, e) => s + e.totalCredit, 0);
    expect(Math.abs(totalD - totalC)).toBeLessThan(0.005);
  });

  it('rejects unbalanced vouchers and same-line debit+credit', () => {
    const b = seedBench();
    const bad = draft('GEN', [{ accountId: b.expense.id, debit: 100 }, { accountId: b.bank.id, credit: 90 }]);
    const res = jv().postVoucher(bad.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('debits');
    expect(jvEntries()).toHaveLength(0);

    const both = draft('GEN', [{ accountId: b.expense.id, debit: 100, credit: 100 }, { accountId: b.bank.id, debit: 0, credit: 0 }]);
    // Force both sides onto one line (the grid prevents this; the guard must too).
    useJournalVoucherStore.setState({
      vouchers: jv().vouchers.map((x) => (x.id === both.id ? { ...x, lines: x.lines.map((l, i) => (i === 0 ? { ...l, debit: 100, credit: 100 } : { ...l, debit: 100, credit: 100 })) } : x)),
    });
    expect(jv().postVoucher(both.id).ok).toBe(false);
  });

  it('rejects inactive accounts and closed periods', () => {
    const b = seedBench();
    const v = draft('GEN', [{ accountId: b.inactive.id, debit: 10 }, { accountId: b.bank.id, credit: 10 }]);
    const res = jv().postVoucher(v.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('inactive');

    jv().updateSettings({ postingLockDate: '2099-12-31' });
    const v2 = draft('GEN', [{ accountId: b.expense.id, debit: 10 }, { accountId: b.bank.id, credit: 10 }]);
    const res2 = jv().postVoucher(v2.id);
    expect(res2.ok).toBe(false);
    expect(res2.error).toContain('closed');
  });

  it('prevents double posting and duplicate source documents (reporting the existing journal)', () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 50 }, { accountId: b.bank.id, credit: 50 }], { sourceModule: 'payroll', sourceTransactionId: 'RUN-7' });
    expect(jv().postVoucher(v.id).ok).toBe(false); // idempotent

    const dup = draft('GEN', [{ accountId: b.expense.id, debit: 50 }, { accountId: b.bank.id, credit: 50 }], { sourceModule: 'payroll', sourceTransactionId: 'RUN-7' });
    const res = jv().postVoucher(dup.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('already posted');
    expect(res.existingJournalNumber).toBe(v.journalEntryNumber);
    expect(jvEntries()).toHaveLength(1); // no duplicate accounting
  });

  it('posted vouchers are immutable — only view/attach/reverse/correct/copy', () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 75 }, { accountId: b.bank.id, credit: 75 }]);
    expect(jv().saveDraft({ ...v, description: 'tampered' }).ok).toBe(false);
    expect(jv().cancelDraft(v.id).ok).toBe(false);
    // Attaching further supporting documents remains permitted.
    expect(jv().addAttachment(v.id, { name: 'invoice.pdf', url: '#', note: '' }).ok).toBe(true);
    // The generated journal entry is itself immutable.
    expect(journal().updateEntry(v.journalEntryId, {} as never).ok).toBe(false);
  });
});

/* ── Transfers ────────────────────────────────────────────────────────────── */

describe('internal bank and cash transfers', () => {
  it('bank→cash, cash→bank and transfers with charges post correctly', () => {
    const b = seedBench();
    // Bank → cash
    post('CTR', [{ accountId: b.cash.id, debit: 500 }, { accountId: b.bank.id, credit: 500 }]);
    // Cash → bank
    post('CTR', [{ accountId: b.bank.id, debit: 200 }, { accountId: b.cash.id, credit: 200 }]);
    // Bank → petty cash with charges: total cash moves only by the charge.
    post('BTR', [
      { accountId: b.petty.id, debit: 990 },
      { accountId: b.charges.id, debit: 10 },
      { accountId: b.bank.id, credit: 1000 },
    ]);
    const cashTotal = glNet(b.bank.id) + glNet(b.cash.id) + glNet(b.petty.id);
    expect(cashTotal).toBe(-10); // company cash changed only by charges
    expect(glNet(b.charges.id)).toBe(10);
  });

  it('refuses a transfer whose source equals its destination', () => {
    const b = seedBench();
    const v = draft('BTR', [{ accountId: b.bank.id, debit: 100 }, { accountId: b.bank.id, credit: 100 }]);
    const res = jv().postVoucher(v.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('different');
  });
});

/* ── Accruals, prepayments, provisions, reclass, opening, closing ─────────── */

describe('accruals and prepayments', () => {
  it('posts an accrual and reverses it automatically on the reversal date', () => {
    const b = seedBench();
    const v = post('ACC', [{ accountId: b.expense.id, debit: 1200 }, { accountId: b.accrued.id, credit: 1200 }], { autoReverseDate: '2026-08-01' });
    expect(glNet(b.accrued.id)).toBe(-1200);

    const run = jv().processAutoReversals('2026-08-31');
    expect(run.ok).toBe(true);
    expect(run.reversedCount).toBe(1);
    const original = jv().vouchers.find((x) => x.id === v.id)!;
    expect(original.status).toBe('reversed');
    const reversal = jv().vouchers.find((x) => x.reversalOfVoucherId === v.id)!;
    expect(reversal.status).toBe('posted');
    expect(reversal.reversalReason).toContain('Automatic reversal');
    expect(glNet(b.accrued.id)).toBe(0);
    // Second automatic pass finds nothing.
    expect(jv().processAutoReversals('2026-09-30').reversedCount).toBe(0);
  });

  it('posts a prepayment and releases it periodically from a recurring template', () => {
    const b = seedBench();
    post('PRE', [{ accountId: b.prepaid.id, debit: 1200 }, { accountId: b.bank.id, credit: 1200 }]);

    const template: RecurringVoucherTemplate = {
      id: generateId('rvt'), number: '', name: 'Insurance release', typeId: typeByCode('PRL').id,
      frequency: 'monthly', startDate: '2026-07-31', endDate: '2026-12-31', nextPostingDate: '2026-07-31',
      description: 'Monthly prepaid insurance release', currency: 'USD', exchangeRate: 1,
      lines: renumber([
        { ...makeBlankLine(), accountId: b.expense.id, debit: 100 },
        { ...makeBlankLine(), accountId: b.prepaid.id, credit: 100 },
      ]),
      autoReverse: false, approvalRequired: false, active: true,
      createdAt: nowIso(), createdBy: '', generatedVoucherIds: [],
    };
    const saved = jv().saveTemplate(template);
    expect(saved.ok).toBe(true);

    // Two monthly releases.
    for (let i = 0; i < 2; i++) {
      const gen = jv().generateFromTemplate(saved.id!);
      expect(gen.ok).toBe(true);
      expect(jv().postVoucher(gen.id!).ok).toBe(true);
    }
    const t = jv().templates.find((x) => x.id === saved.id)!;
    expect(t.generatedVoucherIds).toHaveLength(2);
    expect(t.nextPostingDate).toBe('2026-09-30'); // advanced twice
    const generated = jv().vouchers.filter((v) => v.templateId === t.id);
    expect(generated.every((v) => v.status === 'posted')).toBe(true);
    expect(glNet(b.prepaid.id)).toBe(1000); // 1 200 − 2 × 100
  });

  it('provisions require approval, honouring segregation of duties for material amounts', () => {
    const b = seedBench();
    // Material provision (≥ threshold 10 000): preparer cannot approve.
    const big = draft('PRV', [{ accountId: b.provisionExp.id, debit: 15000 }, { accountId: b.provision.id, credit: 15000 }]);
    expect(jv().postVoucher(big.id).ok).toBe(false); // approval missing
    jv().submitVoucher(big.id);
    const selfApprove = jv().approveVoucher(big.id);
    expect(selfApprove.ok).toBe(false);
    expect(selfApprove.error).toContain('Segregation of duties');

    // Below the material threshold the same user may approve.
    const small = draft('PRV', [{ accountId: b.provisionExp.id, debit: 500 }, { accountId: b.provision.id, credit: 500 }]);
    jv().submitVoucher(small.id);
    expect(jv().approveVoucher(small.id).ok).toBe(true);
    expect(jv().postVoucher(small.id).ok).toBe(true);
    expect(glNet(b.provision.id)).toBe(-500);
  });

  it('reclassification, suspense clearing and closing entries post as ordinary balanced vouchers', () => {
    const b = seedBench();
    post('GEN', [{ accountId: b.suspense.id, debit: 300 }, { accountId: b.bank.id, credit: 300 }]);
    post('SUS', [{ accountId: b.expense.id, debit: 300 }, { accountId: b.suspense.id, credit: 300 }]);
    expect(glNet(b.suspense.id)).toBe(0);

    const rcl = post('RCL', [{ accountId: b.charges.id, debit: 120 }, { accountId: b.expense.id, credit: 120 }], { internalReference: 'JE-0001', description: 'Reclass rent to finance costs' });
    expect(rcl.status).toBe('posted');

    const cls = draft('CLS', [{ accountId: b.revenue.id, debit: 1000 }, { accountId: b.equity.id, credit: 1000 }]);
    jv().submitVoucher(cls.id);
    expect(jv().approveVoucher(cls.id).ok).toBe(true); // 1 000 < materiality
    expect(jv().postVoucher(cls.id).ok).toBe(true);
  });

  it('opening balances are gated by the lock and separately reportable', () => {
    const b = seedBench();
    jv().updateSettings({ openingBalancesLocked: true });
    const locked = draft('OBL', [{ accountId: b.bank.id, debit: 5000 }, { accountId: b.equity.id, credit: 5000 }], { externalReference: 'MIGRATION-2026' });
    jv().submitVoucher(locked.id);
    jv().updateSettings({ segregationOfDuties: false });
    jv().approveVoucher(locked.id);
    const refused = jv().postVoucher(locked.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('locked');

    jv().updateSettings({ openingBalancesLocked: false });
    expect(jv().postVoucher(locked.id).ok).toBe(true);
    expect(openingBalanceVouchers(jv().vouchers, jv().types).map((v) => v.id)).toContain(locked.id);
  });
});

/* ── Foreign currency ─────────────────────────────────────────────────────── */

describe('foreign currency', () => {
  it('posts foreign-currency vouchers with a rate; refuses a missing rate', () => {
    const b = seedBench();
    const missing = draft('GEN', [{ accountId: b.bank.id, debit: 100 }, { accountId: b.revenue.id, credit: 100 }], { currency: 'EUR', exchangeRate: 0 });
    const res = jv().postVoucher(missing.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('exchange rate');

    const v = post('GEN', [{ accountId: b.bank.id, debit: 100 }, { accountId: b.revenue.id, credit: 100 }], { currency: 'EUR', exchangeRate: 1.1 });
    const entry = journal().entries.find((e) => e.id === v.journalEntryId)!;
    expect(entry.currency).toBe('EUR');
    expect(entry.exchangeRate).toBe(1.1);
    // Base-currency integration: TB converts via the entry rate.
    const mv = calculateAccountPeriodMovement(b.bank.id, journal().entries, { from: '2026-01-01', to: '2026-12-31' }, 'USD');
    expect(mv.periodDebits).toBeCloseTo(110, 2);
  });

  it('posts realized FX gain and loss to the configured accounts', () => {
    const b = seedBench();
    jv().updateSettings({ fxGainAccountId: b.fxGain.id, fxLossAccountId: b.fxLoss.id });
    post('FXA', [{ accountId: b.bank.id, debit: 40 }, { accountId: jv().settings.fxGainAccountId, credit: 40 }], { description: 'Realized FX gain' });
    post('FXA', [{ accountId: jv().settings.fxLossAccountId, debit: 25 }, { accountId: b.bank.id, credit: 25 }], { description: 'Realized FX loss' });
    expect(glNet(b.fxGain.id)).toBe(-40);
    expect(glNet(b.fxLoss.id)).toBe(25);
  });
});

/* ── Intercompany ─────────────────────────────────────────────────────────── */

describe('intercompany journals', () => {
  it('posts one balanced journal per legal entity, sharing one reference', () => {
    const b = seedBench();
    const res = jv().postIntercompanyPair({
      date: '2026-07-15', amount: 2000, description: 'Management fee',
      intercompanyRef: 'ICR-2026-001',
      paying: { company: 'Acme Trading LLC', chargeAccountId: b.expense.id, dueToAccountId: b.dueTo.id },
      receiving: { company: 'Acme Holdings Ltd', dueFromAccountId: b.dueFrom.id, creditAccountId: b.revenue.id },
    });
    expect(res.ok).toBe(true);
    const pair = jv().vouchers.filter((v) => v.intercompanyRef === 'ICR-2026-001');
    expect(pair).toHaveLength(2);
    expect(new Set(pair.map((v) => v.companyId)).size).toBe(2); // separate company ledgers
    expect(pair.every((v) => v.status === 'posted')).toBe(true);
    expect(pair.every((v) => v.journalEntryId)).toBe(true);
    expect(pair[0]!.journalEntryId).not.toBe(pair[1]!.journalEntryId); // never one journal across two entities
    // Matching amount both legs: due-to mirrors due-from.
    expect(glNet(b.dueTo.id)).toBe(-2000);
    expect(glNet(b.dueFrom.id)).toBe(2000);
  });

  it('rejects incomplete intercompany input', () => {
    const b = seedBench();
    const res = jv().postIntercompanyPair({
      date: '2026-07-15', amount: 2000, description: 'x', intercompanyRef: 'ICR-2',
      paying: { company: 'A', chargeAccountId: b.expense.id, dueToAccountId: '' },
      receiving: { company: 'B', dueFromAccountId: b.dueFrom.id, creditAccountId: b.revenue.id },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('due-to');
    const same = jv().postIntercompanyPair({
      date: '2026-07-15', amount: 100, description: 'x', intercompanyRef: 'ICR-3',
      paying: { company: 'A', chargeAccountId: b.expense.id, dueToAccountId: b.dueTo.id },
      receiving: { company: 'A', dueFromAccountId: b.dueFrom.id, creditAccountId: b.revenue.id },
    });
    expect(same.ok).toBe(false);
    expect(same.error).toContain('DIFFERENT');
  });
});

/* ── Asset delegation ─────────────────────────────────────────────────────── */

function seedAssetCategory(bench: Bench): void {
  const cost = findAccount('Plant and machinery');
  const accumDep = findAccount('Accumulated depreciation');
  const depExp = findAccount('Depreciation expense');
  const gainLoss = findAccount('disposal of assets');
  const impLoss = addAccount('7501', 'Impairment loss expense', 'OTHER_INCOME_EXPENSE', 'DEBIT');
  const accumImp = addAccount('1118', 'Accumulated impairment', 'ASSET', 'CREDIT');
  const category: AssetCategory = {
    id: 'cat-jv', code: 'MACH', name: 'Machinery', description: '',
    accounts: {
      costAccountId: cost.id, accumulatedDepreciationAccountId: accumDep.id,
      depreciationExpenseAccountId: depExp.id, impairmentLossAccountId: impLoss.id,
      accumulatedImpairmentAccountId: accumImp.id, disposalGainAccountId: gainLoss.id,
      disposalLossAccountId: gainLoss.id, aucAccountId: '', recoverableTaxAccountId: bench.suspense.id,
      revaluationSurplusAccountId: bench.equity.id, revaluationLossAccountId: gainLoss.id,
    },
    defaultMethod: 'straight_line', defaultUsefulLifeMonths: 12, defaultResidualRatePercent: 0,
    revaluationEnabled: false, isActive: true, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const res = useFixedAssetStore.getState().saveCategory(category);
  if (!res.ok) throw new Error(res.error);
}

function draftAsset(name: string, method: 'none' | 'straight_line' = 'none'): string {
  const res = useFixedAssetStore.getState().createAsset({ name, categoryId: 'cat-jv', acquisitionDate: '2026-01-01', method, usefulLifeMonths: 12 });
  if (!res.ok) throw new Error(res.error);
  return res.id!;
}

describe('asset vouchers delegate to Fixed Assets (one engine, no duplicates)', () => {
  it('asset purchase posts once, activates the asset and links both ways', () => {
    const b = seedBench();
    seedAssetCategory(b);
    const assetId = draftAsset('CNC machine');
    const v = draft('AAQ', [], { assetInput: { assetId, funding: 'bank', creditAccountId: b.bank.id, baseCost: 9000 } });
    jv().submitVoucher(v.id);
    jv().updateSettings({ segregationOfDuties: false });
    jv().approveVoucher(v.id);
    const res = jv().postVoucher(v.id);
    expect(res.ok).toBe(true);

    const asset = useFixedAssetStore.getState().assets.find((a) => a.id === assetId)!;
    expect(asset.status).toBe('active');
    expect(asset.originalCost).toBe(9000);
    const posted = jv().vouchers.find((x) => x.id === v.id)!;
    expect(posted.assetTransactionId).toBeTruthy();
    expect(posted.journalEntryId).toBeTruthy();
    // Exactly ONE journal entry — the Fixed Assets voucher; no JV duplicate.
    expect(journal().entries.filter((e) => e.status === 'posted')).toHaveLength(1);
    // Duplicate capitalization prevented: a second purchase voucher fails.
    const again = draft('AAQ', [], { assetInput: { assetId, funding: 'bank', creditAccountId: b.bank.id, baseCost: 9000 } });
    jv().submitVoucher(again.id);
    jv().approveVoucher(again.id);
    expect(jv().postVoucher(again.id).ok).toBe(false);
  });

  it('asset sale with gain, with loss, and scrapping at NBV', () => {
    const b = seedBench();
    seedAssetCategory(b);
    jv().updateSettings({ segregationOfDuties: false });
    const sellVoucher = (assetId: string, proceeds: number): JournalVoucher => {
      const v = draft('ASL', [], { assetInput: { assetId, proceeds, receiptAccountId: b.bank.id, catchUpDepreciation: true } });
      jv().submitVoucher(v.id); jv().approveVoucher(v.id);
      const r = jv().postVoucher(v.id);
      if (!r.ok) throw new Error(r.error);
      return jv().vouchers.find((x) => x.id === v.id)!;
    };
    const buy = (name: string, cost: number): string => {
      const assetId = draftAsset(name);
      const v = draft('AAQ', [], { assetInput: { assetId, funding: 'bank', creditAccountId: b.bank.id, baseCost: cost } });
      jv().submitVoucher(v.id); jv().approveVoucher(v.id);
      const r = jv().postVoucher(v.id);
      if (!r.ok) throw new Error(r.error);
      return assetId;
    };

    const gainAsset = buy('Lathe', 5000);
    sellVoucher(gainAsset, 6500);
    expect(useFixedAssetStore.getState().assets.find((a) => a.id === gainAsset)!.disposalGainLoss).toBe(1500);

    const lossAsset = buy('Press', 5000);
    sellVoucher(lossAsset, 4000);
    expect(useFixedAssetStore.getState().assets.find((a) => a.id === lossAsset)!.disposalGainLoss).toBe(-1000);

    const scrapAsset = buy('Rig', 3000);
    const scrapped = sellVoucher(scrapAsset, 0);
    expect(scrapped.status).toBe('posted');
    expect(useFixedAssetStore.getState().assets.find((a) => a.id === scrapAsset)!.status).toBe('disposed');
  });

  it('depreciation, amortization and impairment vouchers update the register with limits', () => {
    const b = seedBench();
    seedAssetCategory(b);
    jv().updateSettings({ segregationOfDuties: false });
    const assetId = draftAsset('Grinder', 'straight_line');
    const acq = draft('AAQ', [], { assetInput: { assetId, funding: 'bank', creditAccountId: b.bank.id, baseCost: 1200 } });
    jv().submitVoucher(acq.id); jv().approveVoucher(acq.id);
    expect(jv().postVoucher(acq.id).ok).toBe(true);

    // Depreciation via voucher (explicit charge).
    const dep = draft('DEP', [], { assetInput: { assetId, amount: 100 } });
    expect(jv().postVoucher(dep.id).ok).toBe(true);
    let asset = useFixedAssetStore.getState().assets.find((a) => a.id === assetId)!;
    expect(asset.accumulatedDepreciation).toBe(100);

    // Amortization uses the same delegated seam.
    const amr = draft('AMR', [], { assetInput: { assetId, amount: 50 } });
    expect(jv().postVoucher(amr.id).ok).toBe(true);

    // Beyond the depreciable amount → refused.
    const over = draft('DEP', [], { assetInput: { assetId, amount: 99999 } });
    const refused = jv().postVoucher(over.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('exceeds');

    // Impairment via voucher. The seeded catalogue has no dedicated impairment
    // type — administrators may add voucher types, so add one (spec §2).
    const saveType = jv().saveType({
      ...typeByCode('DEP'), id: generateId('jvt'), code: 'IMPR', name: 'Asset Impairment', kind: 'asset_impairment', prefix: 'IMP', isSystem: false,
    });
    expect(saveType.ok).toBe(true);
    const impDraft = draft('IMPR', [], { assetInput: { assetId, recoverableAmount: 800 }, description: 'Damage assessment' });
    // The Fixed Assets subledger requires impairment approval — approve first.
    jv().submitVoucher(impDraft.id);
    expect(jv().approveVoucher(impDraft.id).ok).toBe(true);
    expect(jv().postVoucher(impDraft.id).ok).toBe(true);
    asset = useFixedAssetStore.getState().assets.find((a) => a.id === assetId)!;
    expect(asset.impairmentBalance).toBeGreaterThan(0);
  });
});

/* ── Reversal & correction ────────────────────────────────────────────────── */

describe('reversal and correction', () => {
  it('full reversal preserves the original and nets the ledger; second reversal blocked', () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 400 }, { accountId: b.bank.id, credit: 400 }]);
    const res = jv().reverseVoucher(v.id, { reason: 'wrong account' });
    expect(res.ok).toBe(true);

    const original = jv().vouchers.find((x) => x.id === v.id)!;
    expect(original.status).toBe('reversed');
    const reversal = jv().vouchers.find((x) => x.id === original.reversedByVoucherId)!;
    expect(reversal.reversalOfVoucherId).toBe(v.id);
    expect(reversal.reversalReason).toBe('wrong account');
    expect(reversal.postedBy).toBeTruthy();
    expect(glNet(b.expense.id)).toBe(0);
    // Original journal preserved permanently.
    expect(journal().entries.find((e) => e.id === v.journalEntryId)!.status).toBe('posted');
    // A second reversal is refused.
    expect(jv().reverseVoucher(v.id, { reason: 'again' }).ok).toBe(false);
    // Reversal requires a documented reason.
    const v2 = post('GEN', [{ accountId: b.expense.id, debit: 10 }, { accountId: b.bank.id, credit: 10 }]);
    expect(jv().reverseVoucher(v2.id, { reason: '  ' }).ok).toBe(false);
  });

  it('correction reverses the original and links a replacement draft', () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 400 }, { accountId: b.bank.id, credit: 400 }]);
    const res = jv().correctVoucher(v.id, 'amount should be 440');
    expect(res.ok).toBe(true);

    const original = jv().vouchers.find((x) => x.id === v.id)!;
    expect(original.status).toBe('reversed');
    expect(original.replacementVoucherId).toBe(res.id);
    const replacement = jv().vouchers.find((x) => x.id === res.id)!;
    expect(replacement.status).toBe('draft');
    expect(replacement.internalReference).toBe(v.number);
    expect(replacement.lines.filter((l) => l.debit > 0 || l.credit > 0)).toHaveLength(2);
    expect(glNet(b.expense.id)).toBe(0); // reversed, replacement not yet posted
  });
});

/* ── Statement integration & reconciliation ───────────────────────────────── */

describe('financial statement integration', () => {
  it('flows to GL, TB, Balance Sheet and Income Statement', () => {
    const b = seedBench();
    post('ACC', [{ accountId: b.expense.id, debit: 900 }, { accountId: b.accrued.id, credit: 900 }]);
    const entries = journal().entries;
    const period = { from: '2026-01-01', to: '2026-12-31' };

    const mv = calculateAccountPeriodMovement(b.expense.id, entries, period, 'USD');
    expect(calculateAccountClosingNet(0, mv.periodDebits, mv.periodCredits)).toBe(900);

    const balances = selectPostedBalancesAsOf(entries, '2026-12-31', 'USD');
    expect(balances.get(b.accrued.id)).toBe(-900);

    expect(classifyIncomeStatementSection(b.expense)).toBe('operatingExpenses');
    expect(getProfitOrLossDisplayAmount(mv.periodDebits - mv.periodCredits, b.expense.normalBalance)).toBe(900);
  });

  it('the reconciliation report matches every posted voucher to its journal', () => {
    const b = seedBench();
    post('GEN', [{ accountId: b.expense.id, debit: 111 }, { accountId: b.bank.id, credit: 111 }]);
    post('GEN', [{ accountId: b.cash.id, debit: 222 }, { accountId: b.bank.id, credit: 222 }]);
    const rec = reconcileVouchersToJournal(jv().vouchers, journal().entries);
    expect(rec.matched).toBe(2);
    expect(rec.exceptions).toBe(0);
    expect(rec.orphanJournalNumbers).toHaveLength(0);
  });
});

/* ── Tax adjustments, permissions, audit, tenancy ─────────────────────────── */

function signInAs(role: RegisteredUser['role']): void {
  const user = {
    id: 'usr_t', fullName: 'Test Member', email: 't@t.com', mobile: '', country: 'AE',
    passwordHash: 'x', emailVerified: true, verificationToken: '', organizationId: 'org_t',
    role, status: 'active', createdAt: nowIso(),
  } as RegisteredUser;
  useAuthStore.setState({ users: [user], currentUserId: user.id });
}

describe('tax adjustments and permissions', () => {
  it('manual tax adjustments need the dedicated permission and appear in their report', () => {
    const b = seedBench();
    const v = draft('TAXJ', [{ accountId: b.vatOut.id, debit: 80, taxCode: 'VAT5', taxAmount: 80 }, { accountId: b.expense.id, credit: 80 }]);
    jv().submitVoucher(v.id);
    jv().updateSettings({ segregationOfDuties: false });
    jv().approveVoucher(v.id);

    signInAs('member'); // members lack journalVoucher.postTaxAdjustment (and post)
    expect(jv().postVoucher(v.id).ok).toBe(false);
    signInAs('accountant');
    expect(jv().postVoucher(v.id).ok).toBe(true);
    expect(manualTaxAdjustments(jv().vouchers, jv().types).map((x) => x.id)).toContain(v.id);
  });

  it('role permissions: viewers cannot create; members cannot post; accountants cannot approve or configure', () => {
    const b = seedBench();
    const v = draft('GEN', [{ accountId: b.expense.id, debit: 10 }, { accountId: b.bank.id, credit: 10 }]);
    signInAs('viewer');
    expect(jv().saveDraft({ ...makeBlankVoucher(typeByCode('GEN')) }).ok).toBe(false);
    signInAs('member');
    expect(jv().postVoucher(v.id).ok).toBe(false);
    signInAs('accountant');
    expect(jv().updateSettings({ materialAmountThreshold: 1 }).ok).toBe(false);
    const sub = draft('PRV', [{ accountId: b.provisionExp.id, debit: 5 }, { accountId: b.provision.id, credit: 5 }]);
    jv().submitVoucher(sub.id);
    expect(jv().approveVoucher(sub.id).ok).toBe(false);
  });

  it('platform operator support mode: attributed to the administrator, plan untouched, fail-closed', () => {
    const b = seedBench();
    const planBefore = JSON.stringify(useEntitlementStore.getState().subscription);
    useBackendSessionStore.setState({
      status: 'ready',
      user: { id: 'usr_admin', email: 'admin@ledgora.com', fullName: 'Platform Admin', status: 'active', emailVerified: true, mustChangePassword: false, platformRoles: ['super_admin'], lastLoginAt: null, createdAt: nowIso() },
      platformRoles: ['super_admin'], error: null,
    });
    useOperatorViewStore.getState().enter({ orgName: 'Acme Holdings Ltd.' });

    const v = post('GEN', [{ accountId: b.expense.id, debit: 60 }, { accountId: b.bank.id, credit: 60 }]);
    expect(v.postedBy).toContain('Platform administrator');
    expect(v.postedBy).toContain('admin@ledgora.com');
    const audit = jv().auditTrail.at(-1)!;
    expect(audit.actor).toContain('Platform administrator');
    expect(audit.operator?.operatorUserId).toBe('usr_admin');
    expect(audit.operator?.operatorViewMode).toBe('full_access');
    // The subscriber's subscription plan is never modified by support actions.
    expect(JSON.stringify(useEntitlementStore.getState().subscription)).toBe(planBefore);

    // Fail-closed: leaving operator mode ends the elevated attribution.
    useOperatorViewStore.getState().exit();
    const after = post('GEN', [{ accountId: b.expense.id, debit: 5 }, { accountId: b.bank.id, credit: 5 }]);
    expect(after.postedBy).not.toContain('Platform administrator');
  });

  it('tenant isolation: vouchers are workspace-scoped and cleared on sign-out reset', () => {
    const b = seedBench();
    post('GEN', [{ accountId: b.expense.id, debit: 42 }, { accountId: b.bank.id, credit: 42 }]);
    expect(jv().vouchers.length).toBeGreaterThan(0);
    resetBusinessWorkspace();
    expect(jv().vouchers).toHaveLength(0);
    expect(jv().templates).toHaveLength(0);
  });

  it('vouchers survive a refresh (persisted workspace storage rehydrates)', async () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 77 }, { accountId: b.bank.id, credit: 77 }]);
    // The durable workspace snapshot a page reload would rehydrate from
    // already carries the posted voucher (browser storage today — see the
    // backend persistence note in the store).
    const raw = localStorage.getItem('ledgora-journal-vouchers');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!) as { state: { vouchers: JournalVoucher[] } };
    const restored = persisted.state.vouchers.find((x) => x.id === v.id);
    expect(restored).toBeTruthy();
    expect(restored!.status).toBe('posted');
    expect(restored!.journalEntryNumber).toBe(v.journalEntryNumber);
    // And a fresh rehydrate from that snapshot restores it in memory.
    await useJournalVoucherStore.persist.rehydrate();
    expect(jv().vouchers.some((x) => x.id === v.id)).toBe(true);
  });
});

/* ── Register totals sanity ───────────────────────────────────────────────── */

describe('register data', () => {
  it('register rows expose totals, preparer/approver/poster and journal linkage', () => {
    const b = seedBench();
    const v = post('GEN', [{ accountId: b.expense.id, debit: 355 }, { accountId: b.bank.id, credit: 355 }]);
    const totals = computeVoucherTotals(v.lines, 1);
    expect(totals.debit).toBe(355);
    expect(v.preparedBy).toBeTruthy();
    expect(v.postedBy).toBeTruthy();
    expect(v.journalEntryNumber).toMatch(/^JE-/u);
  });
});
