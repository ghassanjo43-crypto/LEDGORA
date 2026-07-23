// @vitest-environment happy-dom
/**
 * Fixed Assets — end-to-end workflow contract.
 *
 * Every posted asset transaction must generate exactly one balanced, immutable
 * General Journal Voucher linked to the source transaction, flow to the
 * General Ledger / Trial Balance / Balance Sheet / Income Statement, respect
 * permissions, approvals, closed periods and mappings, and remain reversible
 * with a mirrored voucher and an exact register restore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Account } from '@/types';
import type { RegisteredUser } from '@/types/onboarding';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useAuthStore } from '@/store/authStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { resetBusinessWorkspace } from '@/store/businessWorkspace';
import { netBookValue } from '@/lib/fixedAssetCalculations';
import { buildReconciliation, glBalance } from '@/lib/fixedAssetReports';
import { calculateAccountClosingNet, calculateAccountPeriodMovement } from '@/lib/trialBalanceCalculations';
import { selectPostedBalancesAsOf } from '@/lib/balanceSheetCalculations';
import { classifyIncomeStatementSection, getProfitOrLossDisplayAmount } from '@/lib/incomeStatementCalculations';
import type { AssetCategory } from '@/types/fixedAssets';
import { generateId, nowIso } from '@/lib/utils';

/* ── Workbench ────────────────────────────────────────────────────────────── */

const fa = () => useFixedAssetStore.getState();
const journal = () => useJournalStore.getState();
const accounts = () => useStore.getState().accounts;

function findAccount(nameFragment: string): Account {
  const hit = accounts().find((a) => a.isPostingAccount && a.name.toLowerCase().includes(nameFragment.toLowerCase()));
  if (!hit) throw new Error(`workbench: account "${nameFragment}" not found`);
  return hit;
}

function addAccount(code: string, name: string, type: Account['type'], normalBalance: 'DEBIT' | 'CREDIT'): Account {
  const acc: Account = {
    id: generateId('acc'), code, name, type, parentId: null, level: 0, normalBalance,
    ifrsStatement: type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY' ? 'STATEMENT_OF_FINANCIAL_POSITION' : 'PROFIT_OR_LOSS',
    ifrsCategory: 'Test', ifrsSubcategory: 'Test', cashFlowCategory: 'NOT_APPLICABLE',
    isPostingAccount: true, isActive: true, description: '', industryTag: '', sortOrder: 9000,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  useStore.setState({ accounts: [...accounts(), acc] });
  return acc;
}

interface Bench {
  ap: Account; bank: Account; cost: Account; accumDep: Account; depExp: Account;
  vatOut: Account; gainLoss: Account; vatIn: Account; impLoss: Account; accumImp: Account;
  auc: Account; revSurplus: Account; dueFrom: Account;
  category: AssetCategory;
}

function seedBench(): Bench {
  useStore.getState().resetToDefault();
  journal().replaceAll([]);
  fa().resetToDefault();
  useAuthStore.setState({ users: [], currentUserId: null }); // no member record → owner
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useOperatorViewStore.getState().exit();

  const ap = findAccount('Trade payables');
  const bank = findAccount('Bank current accounts');
  const cost = findAccount('Plant and machinery');
  const accumDep = findAccount('Accumulated depreciation');
  const depExp = findAccount('Depreciation expense');
  const vatOut = findAccount('VAT / sales tax payable');
  const gainLoss = findAccount('disposal of assets');
  const vatIn = addAccount('1315', 'VAT recoverable — input tax', 'ASSET', 'DEBIT');
  const impLoss = addAccount('7500', 'Impairment loss', 'OTHER_INCOME_EXPENSE', 'DEBIT');
  const accumImp = addAccount('1118', 'Accumulated impairment — PP&E', 'ASSET', 'CREDIT');
  const auc = addAccount('1117', 'Assets under construction', 'ASSET', 'DEBIT');
  const revSurplus = addAccount('3400', 'Revaluation surplus', 'EQUITY', 'CREDIT');
  const dueFrom = addAccount('1610', 'Due from related parties', 'ASSET', 'DEBIT');

  const category: AssetCategory = {
    id: 'cat-mach', code: 'MACH', name: 'Machinery', description: '',
    accounts: {
      costAccountId: cost.id, accumulatedDepreciationAccountId: accumDep.id,
      depreciationExpenseAccountId: depExp.id, impairmentLossAccountId: impLoss.id,
      accumulatedImpairmentAccountId: accumImp.id, disposalGainAccountId: gainLoss.id,
      disposalLossAccountId: gainLoss.id, aucAccountId: auc.id, recoverableTaxAccountId: vatIn.id,
      revaluationSurplusAccountId: revSurplus.id, revaluationLossAccountId: gainLoss.id,
    },
    defaultMethod: 'straight_line', defaultUsefulLifeMonths: 12, defaultResidualRatePercent: 0,
    revaluationEnabled: true, isActive: true, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const saved = fa().saveCategory(category);
  if (!saved.ok) throw new Error(saved.error);
  return { ap, bank, cost, accumDep, depExp, vatOut, gainLoss, vatIn, impLoss, accumImp, auc, revSurplus, dueFrom, category };
}

/** Create a draft asset in the bench category. */
function draftAsset(over: Partial<Parameters<ReturnType<typeof fa>['createAsset']>[0]> = {}): string {
  const res = fa().createAsset({ name: 'CNC machine', categoryId: 'cat-mach', acquisitionDate: '2026-01-01', method: 'straight_line', usefulLifeMonths: 12, ...over });
  if (!res.ok || !res.id) throw new Error(res.error);
  return res.id;
}

/** Draft + posted cash acquisition (non-depreciating unless specified). */
function activeAsset(bench: Bench, cost = 10000, over: Parameters<typeof draftAsset>[0] = {}): string {
  const id = draftAsset({ method: 'none', ...over });
  const res = fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: cost, funding: 'cash', creditAccountId: bench.bank.id });
  if (!res.ok) throw new Error(res.error);
  return id;
}

const faEntries = () => journal().entries.filter((e) => e.transactionType === 'Fixed Assets');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  useOperatorViewStore.getState().exit();
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
});

/* ── Acquisition ──────────────────────────────────────────────────────────── */

describe('acquisition postings', () => {
  it('cash purchase: Dr cost / Cr bank, one balanced immutable voucher, linked both ways', () => {
    const bench = seedBench();
    const id = draftAsset();
    const res = fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: 10000, funding: 'cash', creditAccountId: bench.bank.id });
    expect(res.ok).toBe(true);

    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.status).toBe('active');
    expect(asset.originalCost).toBe(10000);
    expect(asset.capitalizationDate).toBe('2026-01-05');

    const entries = faEntries();
    expect(entries).toHaveLength(1); // no duplicates
    const entry = entries[0]!;
    expect(entry.status).toBe('posted');
    expect(entry.totalDebit).toBe(entry.totalCredit);
    expect(entry.lines.find((l) => l.accountId === bench.cost.id)?.debit).toBe(10000);
    expect(entry.lines.find((l) => l.accountId === bench.bank.id)?.credit).toBe(10000);

    // Traceability: transaction ↔ voucher, and the voucher names its source.
    const txn = fa().transactions.find((t) => t.assetId === id)!;
    expect(txn.journalEntryId).toBe(entry.id);
    expect(entry.reference).toBe(`FA:${txn.number}`);
    expect(entry.notes).toContain('Fixed Assets');

    // Posted vouchers are immutable in the journal.
    expect(journal().updateEntry(entry.id, {} as never).ok).toBe(false);
  });

  it('credit purchase with recoverable tax: Dr cost + Dr input tax / Cr AP', () => {
    const bench = seedBench();
    const id = draftAsset();
    const res = fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: 20000, recoverableTax: 1000, funding: 'credit', creditAccountId: bench.ap.id, supplierName: 'Prime Equipment', invoiceRef: 'INV-77' });
    expect(res.ok).toBe(true);
    const entry = faEntries()[0]!;
    expect(entry.lines.find((l) => l.accountId === bench.vatIn.id)?.debit).toBe(1000);
    expect(entry.lines.find((l) => l.accountId === bench.ap.id)?.credit).toBe(21000);
    expect(fa().assets.find((a) => a.id === id)!.originalCost).toBe(20000); // recoverable tax NOT in cost
  });

  it('non-recoverable tax and attributable costs are capitalized into cost', () => {
    const bench = seedBench();
    const id = draftAsset();
    fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: 10000, nonRecoverableTax: 500, otherCapitalizedCosts: 700, funding: 'bank', creditAccountId: bench.bank.id });
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.originalCost).toBe(11200);
    expect(faEntries()[0]!.lines.find((l) => l.accountId === bench.cost.id)?.debit).toBe(11200);
  });

  it('asset under construction accumulates, then capitalizes Dr cost / Cr AUC', () => {
    const bench = seedBench();
    const id = draftAsset();
    fa().postAcquisition({ assetId: id, date: '2026-01-10', baseCost: 6000, funding: 'auc', creditAccountId: bench.ap.id });
    fa().postAcquisition({ assetId: id, date: '2026-02-10', baseCost: 4000, funding: 'auc', creditAccountId: bench.bank.id });
    let asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.aucBalance).toBe(10000);
    expect(asset.status).toBe('draft'); // not yet in service
    expect(glBalance(journal().entries, bench.auc.id)).toBe(10000);

    const cap = fa().capitalizeAsset({ assetId: id, date: '2026-03-01' });
    expect(cap.ok).toBe(true);
    asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.status).toBe('active');
    expect(asset.originalCost).toBe(10000);
    expect(asset.aucBalance).toBe(0);
    expect(glBalance(journal().entries, bench.auc.id)).toBe(0);
    expect(glBalance(journal().entries, bench.cost.id)).toBe(10000);
  });

  it('rejects posting when the category lacks accounting mappings', () => {
    const bench = seedBench();
    fa().saveCategory({ ...bench.category, id: 'cat-bare', code: 'BARE', name: 'Unmapped', accounts: { ...bench.category.accounts, costAccountId: '' } });
    const id = draftAsset({ categoryId: 'cat-bare' });
    const res = fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: 100, funding: 'cash', creditAccountId: bench.bank.id });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('missing accounting mappings');
    expect(faEntries()).toHaveLength(0); // nothing posted, nothing recorded
    expect(fa().transactions).toHaveLength(0);
  });

  it('rejects posting into a closed accounting period', () => {
    const bench = seedBench();
    fa().updateSettings({ postingLockDate: '2026-06-30' });
    const id = draftAsset();
    const res = fa().postAcquisition({ assetId: id, date: '2026-05-15', baseCost: 100, funding: 'cash', creditAccountId: bench.bank.id });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('closed');
    expect(faEntries()).toHaveLength(0);
  });
});

/* ── Depreciation ─────────────────────────────────────────────────────────── */

describe('depreciation runs', () => {
  it('straight line: preview → post updates the register and the ledger', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12 });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2026-01-31' });
    expect(prev.ok).toBe(true);
    const run = fa().runs.find((r) => r.id === prev.id)!;
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]!.amount).toBe(1000);

    const post = fa().postDepreciationRun(run.id);
    expect(post.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.accumulatedDepreciation).toBe(1000);
    expect(asset.depreciatedThrough).toBe('2026-01-31');
    expect(glBalance(journal().entries, bench.depExp.id)).toBe(1000);
    expect(glBalance(journal().entries, bench.accumDep.id)).toBe(-1000);
  });

  it('posting is idempotent — a run can post exactly once', () => {
    const bench = seedBench();
    activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12 });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2026-01-31' });
    fa().postDepreciationRun(prev.id!);
    const before = faEntries().length;
    const again = fa().postDepreciationRun(prev.id!);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already posted');
    expect(faEntries()).toHaveLength(before);
  });

  it('reducing balance charges the rate on opening NBV', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000, { method: 'reducing_balance', reducingBalanceRatePercent: 24, usefulLifeMonths: 0 });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2026-06-30', scope: { assetIds: [id] } });
    const run = fa().runs.find((r) => r.id === prev.id)!;
    expect(run.lines[0]!.amount).toBe(1200); // 10 000 × 24% × 6/12
  });

  it('never depreciates beyond cost − residual − impairment', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12, residualValue: 2000 });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2028-12-31' }); // 36 months over a 12-month life
    const run = fa().runs.find((r) => r.id === prev.id)!;
    expect(run.lines[0]!.amount).toBe(10000); // clamped to depreciable amount
    fa().postDepreciationRun(run.id);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.accumulatedDepreciation).toBe(10000);
    expect(asset.status).toBe('fully_depreciated');
    // A later run finds nothing left.
    const prev2 = fa().previewDepreciationRun({ periodFrom: '2029-01-01', periodTo: '2029-12-31' });
    expect(fa().runs.find((r) => r.id === prev2.id)!.lines).toHaveLength(0);
  });

  it('requires approval when configured, and reverses with a mirrored voucher', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12 });
    fa().updateSettings({ approvalRequired: { ...fa().settings.approvalRequired, depreciation: true } });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2026-01-31' });
    expect(fa().postDepreciationRun(prev.id!).ok).toBe(false); // approval required
    fa().approveDepreciationRun(prev.id!, 'CFO');
    expect(fa().postDepreciationRun(prev.id!).ok).toBe(true);

    const rev = fa().reverseDepreciationRun(prev.id!, 'wrong period');
    expect(rev.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.accumulatedDepreciation).toBe(0);
    expect(asset.depreciatedThrough).toBe('');
    expect(glBalance(journal().entries, bench.depExp.id)).toBe(0); // mirrored out
    expect(fa().runs.find((r) => r.id === prev.id)!.status).toBe('reversed');
  });
});

/* ── Disposal ─────────────────────────────────────────────────────────────── */

describe('disposal', () => {
  it('with gain: derecognizes cost and credits the gain', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const res = fa().disposeAsset({ assetId: id, date: '2026-06-30', proceeds: 12000, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    expect(res.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.status).toBe('disposed');
    expect(asset.disposalGainLoss).toBe(2000);
    expect(glBalance(journal().entries, bench.cost.id)).toBe(0);
    const entry = journal().entries.find((e) => e.id === res.journalEntryId)!;
    expect(entry.lines.find((l) => l.accountId === bench.gainLoss.id)?.credit).toBe(2000);
    expect(entry.totalDebit).toBe(entry.totalCredit);
  });

  it('with loss and at NBV', () => {
    const bench = seedBench();
    const loss = fa().disposeAsset({ assetId: activeAsset(bench, 10000), date: '2026-06-30', proceeds: 8000, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    const lossEntry = journal().entries.find((e) => e.id === loss.journalEntryId)!;
    expect(lossEntry.lines.find((l) => l.accountId === bench.gainLoss.id)?.debit).toBe(2000);

    const atNbv = fa().disposeAsset({ assetId: activeAsset(bench, 5000), date: '2026-06-30', proceeds: 5000, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    const nbvEntry = journal().entries.find((e) => e.id === atNbv.journalEntryId)!;
    expect(nbvEntry.lines.some((l) => l.accountId === bench.gainLoss.id)).toBe(false);
  });

  it('with output tax credits the tax payable account', () => {
    const bench = seedBench();
    const res = fa().disposeAsset({ assetId: activeAsset(bench, 10000), date: '2026-06-30', proceeds: 11000, outputTax: 550, outputTaxAccountId: bench.vatOut.id, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    const entry = journal().entries.find((e) => e.id === res.journalEntryId)!;
    expect(entry.lines.find((l) => l.accountId === bench.vatOut.id)?.credit).toBe(550);
    expect(entry.lines.find((l) => l.accountId === bench.bank.id)?.debit).toBe(11550);
  });

  it('partial disposal prorates the register and posts only the disposed portion', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const res = fa().disposeAsset({ assetId: id, date: '2026-06-30', portion: { kind: 'percentage', value: 40 }, proceeds: 5000, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    expect(res.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.status).not.toBe('disposed');
    expect(asset.originalCost).toBe(6000);
    expect(asset.disposalGainLoss).toBe(1000); // 5 000 − 4 000 NBV portion
    const entry = journal().entries.find((e) => e.id === res.journalEntryId)!;
    expect(entry.lines.find((l) => l.accountId === bench.cost.id)?.credit).toBe(4000);
  });

  it('refuses disposal before the acquisition date', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const res = fa().disposeAsset({ assetId: id, date: '2025-12-31', proceeds: 1, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('precede');
  });

  it('demands catch-up depreciation (or a documented override) before disposal', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12, depreciationStartDate: '2026-01-01' });
    const blocked = fa().disposeAsset({ assetId: id, date: '2026-03-31', proceeds: 9000, receiptAccountId: bench.bank.id, approvedBy: 'CFO' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('Depreciation');

    const withCatchUp = fa().disposeAsset({ assetId: id, date: '2026-03-31', proceeds: 9000, receiptAccountId: bench.bank.id, approvedBy: 'CFO', catchUpDepreciation: true });
    expect(withCatchUp.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    // 3 months × 1 000 caught up, then disposed: gain/loss vs NBV 9 000 → 0.
    expect(asset.disposalGainLoss).toBe(0);
    const catchUpTxn = fa().transactions.find((t) => t.type === 'depreciation' && t.assetId === id);
    expect(catchUpTxn).toBeTruthy();
  });
});

/* ── Impairment, revaluation & transfers ──────────────────────────────────── */

describe('impairment and revaluation', () => {
  it('impairs to the recoverable amount and reverses within the limit', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const imp = fa().impairAsset({ assetId: id, date: '2026-06-30', recoverableAmount: 7500, reason: 'damage assessment', approvedBy: 'CFO' });
    expect(imp.ok).toBe(true);
    let asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.impairmentBalance).toBe(2500);
    expect(asset.status).toBe('impaired');
    expect(netBookValue(asset)).toBe(7500);
    expect(glBalance(journal().entries, bench.impLoss.id)).toBe(2500);
    const txn = fa().transactions.find((t) => t.type === 'impairment')!;
    expect(txn.details.carryingAmountBefore).toBe(10000);
    expect(txn.details.recoverableAmount).toBe(7500);

    // Reversal is clamped to the impairment balance.
    const rev = fa().reverseImpairment({ assetId: id, date: '2026-09-30', amount: 99999, reason: 'value recovered', approvedBy: 'CFO' });
    expect(rev.ok).toBe(true);
    asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.impairmentBalance).toBe(0);
    expect(asset.status).toBe('active');
    expect(glBalance(journal().entries, bench.impLoss.id)).toBe(0);
  });

  it('revalues only categories that permit it, booking the surplus to equity', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const res = fa().revalueAsset({ assetId: id, date: '2026-06-30', revaluedAmount: 12500, reason: 'external valuation', approvedBy: 'CFO' });
    expect(res.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.originalCost).toBe(12500);
    expect(asset.revaluationSurplusBalance).toBe(2500);
    expect(glBalance(journal().entries, bench.revSurplus.id)).toBe(-2500); // credit balance

    fa().saveCategory({ ...bench.category, revaluationEnabled: false });
    const denied = fa().revalueAsset({ assetId: id, date: '2026-07-31', revaluedAmount: 13000, reason: 'x', approvedBy: 'CFO' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('not enabled');
  });
});

describe('transfers', () => {
  it('same-entity transfer moves dimensions with no voucher and no gain/loss', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const before = faEntries().length;
    const res = fa().transferAsset({ assetId: id, date: '2026-05-01', changes: { location: 'Warehouse B', custodian: 'Sam Chen' }, reason: 'relocation' });
    expect(res.ok).toBe(true);
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.location).toBe('Warehouse B');
    expect(asset.disposalGainLoss).toBe(0);
    expect(faEntries()).toHaveLength(before); // dimension-only: no voucher
    expect(fa().transactions.find((t) => t.type === 'transfer')!.journalEntryId).toBe('');
  });

  it('intercompany transfers are refused unless enabled with due-from mapping', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    const refused = fa().intercompanyTransfer({ assetId: id, date: '2026-05-01', targetCompany: 'Acme FZE', reason: 'group restructure' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('Intercompany transfers are not enabled');

    fa().updateSettings({ allowIntercompanyTransfers: true, intercompanyDueFromAccountId: bench.dueFrom.id });
    const res = fa().intercompanyTransfer({ assetId: id, date: '2026-05-01', targetCompany: 'Acme FZE', reason: 'group restructure', approvedBy: 'CFO' });
    expect(res.ok).toBe(true);
    expect(fa().assets.find((a) => a.id === id)!.status).toBe('disposed');
    expect(glBalance(journal().entries, bench.dueFrom.id)).toBe(10000); // carrying amount, no gain/loss
    expect(glBalance(journal().entries, bench.cost.id)).toBe(0);
  });
});

/* ── Reversal & correction ────────────────────────────────────────────────── */

describe('reversal vouchers', () => {
  it('reverses the debits/credits, preserves the original and restores the register', () => {
    const bench = seedBench();
    const id = draftAsset();
    const post = fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: 10000, funding: 'cash', creditAccountId: bench.bank.id });
    const txn = fa().transactions.find((t) => t.id === post.transactionId)!;

    const rev = fa().reverseTransaction(txn.id, 'posted against the wrong asset', 'CFO');
    expect(rev.ok).toBe(true);

    // Register restored to the pre-posting snapshot.
    const asset = fa().assets.find((a) => a.id === id)!;
    expect(asset.status).toBe('draft');
    expect(asset.originalCost).toBe(0);

    // Original voucher preserved; the mirrored voucher nets it to zero.
    const original = journal().entries.find((e) => e.id === txn.journalEntryId)!;
    expect(original.status).toBe('posted');
    expect(glBalance(journal().entries, bench.cost.id)).toBe(0);
    expect(glBalance(journal().entries, bench.bank.id)).toBe(0);

    // Linkage both ways, and a reversal cannot repeat.
    const updated = fa().transactions.find((t) => t.id === txn.id)!;
    expect(updated.status).toBe('reversed');
    const reversal = fa().transactions.find((t) => t.id === updated.reversedByTransactionId)!;
    expect(reversal.reversalOfTransactionId).toBe(txn.id);
    expect(reversal.reason).toContain('wrong asset');
    expect(fa().reverseTransaction(txn.id, 'again', 'CFO').ok).toBe(false);
  });

  it('requires a documented reason', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 1000);
    const txn = fa().transactions.find((t) => t.assetId === id)!;
    expect(fa().reverseTransaction(txn.id, '   ', 'CFO').ok).toBe(false);
  });
});

/* ── Financial statement integration ──────────────────────────────────────── */

describe('ledger and statement integration', () => {
  it('flows to GL, Trial Balance, Balance Sheet and Income Statement', () => {
    const bench = seedBench();
    activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12 });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2026-01-31' });
    fa().postDepreciationRun(prev.id!);
    const entries = journal().entries;

    // General Ledger
    expect(glBalance(entries, bench.cost.id)).toBe(12000);
    expect(glBalance(entries, bench.accumDep.id)).toBe(-1000);

    // Trial Balance
    const period = { from: '2026-01-01', to: '2026-12-31' };
    const mv = calculateAccountPeriodMovement(bench.cost.id, entries, period, 'USD');
    expect(calculateAccountClosingNet(0, mv.periodDebits, mv.periodCredits)).toBe(12000);

    // Balance Sheet
    const balances = selectPostedBalancesAsOf(entries, '2026-12-31', 'USD');
    expect(balances.get(bench.cost.id)).toBe(12000);
    expect(balances.get(bench.accumDep.id)).toBe(-1000);

    // Income Statement: depreciation expense presented as an operating expense.
    const section = classifyIncomeStatementSection(bench.depExp);
    expect(['operatingExpenses', 'otherIncomeExpenses']).toContain(section);
    const depMv = calculateAccountPeriodMovement(bench.depExp.id, entries, period, 'USD');
    expect(getProfitOrLossDisplayAmount(depMv.periodDebits - depMv.periodCredits, bench.depExp.normalBalance)).toBe(1000);
  });

  it('reconciles the register to the General Ledger with zero difference', () => {
    const bench = seedBench();
    activeAsset(bench, 12000, { method: 'straight_line', usefulLifeMonths: 12 });
    const prev = fa().previewDepreciationRun({ periodFrom: '2026-01-01', periodTo: '2026-01-31' });
    fa().postDepreciationRun(prev.id!);

    const rows = buildReconciliation(fa().categories, fa().assets, accounts(), journal().entries);
    const costRow = rows.find((r) => r.accountId === bench.cost.id && r.role === 'cost')!;
    expect(costRow.registerBalance).toBe(12000);
    expect(costRow.difference).toBe(0);
    const accumRow = rows.find((r) => r.accountId === bench.accumDep.id)!;
    expect(accumRow.registerBalance).toBe(-1000);
    expect(accumRow.difference).toBe(0);
  });
});

/* ── Permissions, audit & tenancy ─────────────────────────────────────────── */

function signInAs(role: RegisteredUser['role']): void {
  const user = {
    id: 'usr_t', fullName: 'Test Member', email: 't@t.com', mobile: '', country: 'AE',
    passwordHash: 'x', emailVerified: true, verificationToken: '', organizationId: 'org_t',
    role, status: 'active', createdAt: nowIso(),
  } as RegisteredUser;
  useAuthStore.setState({ users: [user], currentUserId: user.id });
}

describe('permissions and audit', () => {
  it('viewers cannot create or dispose; accountants cannot configure', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 1000);
    signInAs('viewer');
    expect(fa().createAsset({ name: 'x', categoryId: 'cat-mach' }).ok).toBe(false);
    expect(fa().disposeAsset({ assetId: id, date: '2026-06-30', proceeds: 1, receiptAccountId: bench.bank.id, approvedBy: 'CFO' }).ok).toBe(false);
    signInAs('accountant');
    expect(fa().updateSettings({ postingLockDate: '2026-01-01' }).ok).toBe(false);
    expect(fa().createAsset({ name: 'ok', categoryId: 'cat-mach' }).ok).toBe(true);
  });

  it('approval-gated postings demand an approver', () => {
    const bench = seedBench();
    const id = activeAsset(bench, 10000);
    // disposal approval is required by default
    const res = fa().disposeAsset({ assetId: id, date: '2026-06-30', proceeds: 5000, receiptAccountId: bench.bank.id });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requires approval');
  });

  it('a platform administrator in operator mode is audited as the administrator', () => {
    const bench = seedBench();
    const id = draftAsset();
    useBackendSessionStore.setState({
      status: 'ready',
      user: { id: 'usr_admin', email: 'admin@ledgora.com', fullName: 'Platform Admin', status: 'active', emailVerified: true, mustChangePassword: false, platformRoles: ['super_admin'], lastLoginAt: null, createdAt: nowIso() },
      platformRoles: ['super_admin'],
      error: null,
    });
    useOperatorViewStore.getState().enter({ orgName: 'Acme Holdings Ltd.' });

    const res = fa().postAcquisition({ assetId: id, date: '2026-01-05', baseCost: 5000, funding: 'cash', creditAccountId: bench.bank.id });
    expect(res.ok).toBe(true);
    const txn = fa().transactions.find((t) => t.assetId === id)!;
    expect(txn.postedBy).toContain('Platform administrator');
    expect(txn.postedBy).toContain('admin@ledgora.com');
    const audit = fa().auditTrail.at(-1)!;
    expect(audit.actor).toContain('Platform administrator');
    expect(audit.operator?.operatorUserId).toBe('usr_admin');
    // The voucher itself is attributed to the administrator too.
    const entry = journal().entries.find((e) => e.id === res.journalEntryId)!;
    expect(entry.postedBy).toContain('Platform administrator');
  });

  it('assets are scoped to the workspace: leaving it clears the register', () => {
    const bench = seedBench();
    activeAsset(bench, 9000);
    expect(fa().assets.length).toBeGreaterThan(0);
    resetBusinessWorkspace(); // sign-out / tenant switch resets business stores
    expect(fa().assets).toHaveLength(0);
    expect(fa().transactions).toHaveLength(0);
  });
});
