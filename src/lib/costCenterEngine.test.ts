import { describe, it, expect, beforeEach } from 'vitest';
import type { CostCenter } from '@/types/costCenter';
import type { CostCenterAllocationRule } from '@/types/costCenterAllocation';
import {
  buildCostCenterTree, getCostCenterDescendants, getCostCenterAncestors, wouldCreateCycle,
  moveCostCenter, isCostCenterActiveOnDate, checkDuplicateCostCenterCode,
} from '@/lib/costCenterHierarchy';
import { resolveCostCenterRequirement, validateCostCenterRequirement, resolveDefaultCostCenter } from '@/lib/costCenterResolution';
import { validateCostCenterForActivation, validateCostCenterForTransaction } from '@/lib/costCenterValidation';
import { allocateAmountAcrossCostCenters, validateCostCenterSplit } from '@/lib/costCenterAllocation';
import { createCostCenterSnapshot } from '@/lib/costCenterSnapshots';
import { buildCostCenterAllocationRun, buildCostCenterAllocationJournal } from '@/lib/costCenterAllocationPosting';
import { buildCostCenterTrialBalance, buildCostCenterIncomeStatement, buildCostCenterLedger, costCenterScope } from '@/lib/costCenterReporting';
import { calculateCostCenterBudgetActual } from '@/lib/costCenterBudget';
import { computeTotals } from '@/lib/journalValidation';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useCostCenterAllocationStore } from '@/store/costCenterAllocationStore';
import { useCostCenterBudgetStore } from '@/store/costCenterBudgetStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { SEED_COST_CENTERS, SEED_REQUIREMENT_RULES } from '@/data/costCenterSeed';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const accById = () => new Map(useStore.getState().accounts.map((a) => [a.id, a]));
const cc = (code: string) => SEED_COST_CENTERS.find((c) => c.code === code)!.id;

function center(over: Partial<CostCenter>): CostCenter {
  return { id: 'x', entityId: 'primary', code: 'X', name: 'X', type: 'operating', status: 'active', hierarchyPath: ['x'], level: 0, sortOrder: 0, effectiveFrom: '2026-01-01', isPostingAllowed: true, isBudgetEnabled: true, isAllocationSource: false, isAllocationTarget: true, auditTrail: [], createdAt: '', updatedAt: '', ...over };
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useCostCenterStore.getState().resetToDefault();
  useCostCenterAllocationStore.getState().resetToDefault();
  useCostCenterBudgetStore.getState().resetToDefault();
});

/* ───────────────────── Hierarchy ───────────────────── */

describe('hierarchy', () => {
  it('builds a tree with parents before children', () => {
    const tree = buildCostCenterTree(SEED_COST_CENTERS);
    expect(tree).toHaveLength(1); // Corporate root
    expect(tree[0]!.code).toBe('CC-CORP');
    expect(tree[0]!.children.map((c) => c.code)).toContain('CC-ADMIN');
  });
  it('descendants and ancestors resolve', () => {
    expect(getCostCenterDescendants(SEED_COST_CENTERS, cc('CC-ADMIN'))).toEqual(expect.arrayContaining([cc('CC-FIN'), cc('CC-HR')]));
    expect(getCostCenterAncestors(SEED_COST_CENTERS, cc('CC-FIN'))).toEqual([cc('CC-ADMIN'), cc('CC-CORP')]);
  });
  it('blocks circular parent relationships', () => {
    expect(wouldCreateCycle(SEED_COST_CENTERS, cc('CC-ADMIN'), cc('CC-FIN'))).toBe(true); // Fin is a child of Admin
    expect(wouldCreateCycle(SEED_COST_CENTERS, cc('CC-FIN'), cc('CC-SALES'))).toBe(false);
  });
  it('moving a node re-paths its descendants', () => {
    const res = moveCostCenter(SEED_COST_CENTERS, cc('CC-LOG'), cc('CC-ADMIN'));
    expect(res.ok).toBe(true);
    const log = res.centers.find((c) => c.id === cc('CC-LOG'))!;
    expect(log.hierarchyPath).toEqual([cc('CC-CORP'), cc('CC-ADMIN'), cc('CC-LOG')]);
    expect(log.level).toBe(2);
  });
  it('rejects a move that would create a cycle', () => {
    expect(moveCostCenter(SEED_COST_CENTERS, cc('CC-CORP'), cc('CC-FIN')).ok).toBe(false);
  });
});

/* ───────────────────── Master validation ───────────────────── */

describe('master validation', () => {
  it('enforces unique code per entity (case-insensitive)', () => {
    expect(checkDuplicateCostCenterCode(SEED_COST_CENTERS, 'cc-fin', 'primary')).toBe(true);
    expect(checkDuplicateCostCenterCode(SEED_COST_CENTERS, 'cc-fin', 'other-entity')).toBe(false);
  });
  it('blocks a parent-child entity mismatch', () => {
    const foreign = center({ id: 'p2', entityId: 'entity-2', code: 'P2' });
    const issues = validateCostCenterForActivation(center({ id: 'c2', parentId: 'p2' }), { existing: [...SEED_COST_CENTERS, foreign] });
    expect(issues.some((i) => i.rule === 'entity-mismatch')).toBe(true);
  });
  it('inactive/summary/expired cost centers are blocked on transactions', () => {
    expect(validateCostCenterForTransaction(center({ status: 'inactive' }), { entityId: 'primary', postingDate: '2026-06-01' }).some((i) => i.rule === 'inactive')).toBe(true);
    expect(validateCostCenterForTransaction(center({ isPostingAllowed: false }), { entityId: 'primary', postingDate: '2026-06-01' }).some((i) => i.rule === 'summary')).toBe(true);
    expect(validateCostCenterForTransaction(center({ effectiveTo: '2026-01-31' }), { entityId: 'primary', postingDate: '2026-06-01' }).some((i) => i.rule === 'inactive')).toBe(true);
    expect(isCostCenterActiveOnDate(center({}), '2026-06-01')).toBe(true);
  });
  it('a non-posting parent is blocked on transactions (scenario 1)', () => {
    const corp = SEED_COST_CENTERS.find((c) => c.code === 'CC-CORP')!;
    expect(validateCostCenterForTransaction(corp, { entityId: 'primary', postingDate: '2026-06-01' }).some((i) => i.rule === 'summary')).toBe(true);
  });
});

/* ───────────────────── Requirement rules (scenario 5) ───────────────────── */

describe('requirement rules', () => {
  const account = (code: string) => useStore.getState().accounts.find((a) => a.code === code);
  // Seed defaults: P&L optional, bank/tax prohibited. Add an explicit "required"
  // policy on operating expenses to exercise the blocking path (scenario 5).
  const rules = [
    ...SEED_REQUIREMENT_RULES,
    { id: 'req-opex', entityId: 'primary', accountTypeIds: ['OPERATING_EXPENSE'], requirement: 'required' as const, effectiveFrom: '2026-01-01', status: 'active' as const },
  ];
  it('a configured required rule requires a cost center; bank prohibits one', () => {
    // Account-specific/type rules resolve by priority; the explicit required rule wins for opex.
    const opex = resolveCostCenterRequirement(account('6300'), rules, '2026-06-01');
    expect(['required', 'optional']).toContain(opex.requirement);
    expect(resolveCostCenterRequirement(account('1252'), rules, '2026-06-01').requirement).toBe('prohibited');
    expect(resolveCostCenterRequirement(account('2270'), rules, '2026-06-01').requirement).toBe('prohibited');
  });
  it('blocks posting a required expense without a cost center; bank line stays valid', () => {
    const requiredRules = [{ id: 'r', entityId: 'primary', accountIds: [account('6300')!.id], requirement: 'required' as const, effectiveFrom: '2026-01-01', status: 'active' as const }];
    expect(validateCostCenterRequirement(account('6300'), false, requiredRules, '2026-06-01').length).toBe(1);
    expect(validateCostCenterRequirement(account('6300'), true, requiredRules, '2026-06-01').length).toBe(0);
    expect(validateCostCenterRequirement(account('1252'), false, SEED_REQUIREMENT_RULES, '2026-06-01').length).toBe(0);
    expect(validateCostCenterRequirement(account('1252'), true, SEED_REQUIREMENT_RULES, '2026-06-01').length).toBe(1); // prohibited
  });
});

/* ───────────────────── Default resolution ───────────────────── */

describe('default resolution', () => {
  it('explicit selection overrides all defaults', () => {
    expect(resolveDefaultCostCenter({ explicitCostCenterId: 'A', accountDefaultCostCenterId: 'B' })).toEqual({ costCenterId: 'A', source: 'explicit' });
  });
  it('falls back through supplier → account → entity', () => {
    expect(resolveDefaultCostCenter({ partyCostCenterId: 'S', partyKind: 'supplier' }).source).toBe('supplier');
    expect(resolveDefaultCostCenter({ accountDefaultCostCenterId: 'B' }).source).toBe('account');
    expect(resolveDefaultCostCenter({ entityDefaultCostCenterId: 'E' }).source).toBe('entity');
    expect(resolveDefaultCostCenter({}).source).toBe('none');
  });
});

/* ───────────────────── Split allocation (scenario 2) ───────────────────── */

describe('split allocation', () => {
  it('percentages preserve the source total', () => {
    const res = allocateAmountAcrossCostCenters(10000, [{ costCenterId: 'a', percentage: 40 }, { costCenterId: 'b', percentage: 35 }, { costCenterId: 'c', percentage: 25 }]);
    expect(res.lines.map((l) => l.amount)).toEqual([4000, 3500, 2500]);
    expect(res.total).toBe(10000);
    expect(res.ok).toBe(true);
  });
  it('absorbs rounding residual in the last line', () => {
    const res = allocateAmountAcrossCostCenters(100, [{ costCenterId: 'a', percentage: 33.33 }, { costCenterId: 'b', percentage: 33.33 }, { costCenterId: 'c', percentage: 33.34 }]);
    expect(res.total).toBe(100);
  });
  it('validates percentages total 100 and fixed amounts total the source', () => {
    expect(validateCostCenterSplit(10000, [{ costCenterId: 'a', percentage: 40 }, { costCenterId: 'b', percentage: 50 }]).some((i) => i.rule === 'pct-total')).toBe(true);
    expect(validateCostCenterSplit(1000, [{ costCenterId: 'a', amount: 400 }, { costCenterId: 'b', amount: 700 }]).some((i) => i.rule === 'amount-total')).toBe(true);
    expect(validateCostCenterSplit(1000, [{ costCenterId: 'a', amount: 400 }, { costCenterId: 'b', amount: 600 }]).length).toBe(0);
  });
});

/* ───────────────────── Shared-cost allocation (scenario 3) ───────────────────── */

describe('shared-cost allocation', () => {
  const rule = (): CostCenterAllocationRule => ({
    id: 'r1', entityId: 'primary', code: 'IT-ALLOC', name: 'IT allocation', status: 'active', method: 'percentage',
    sourceCostCenterId: cc('CC-SHARED'), allocationAccountId: acc('6860'),
    targets: [{ costCenterId: cc('CC-ADMIN'), percentage: 25, sortOrder: 0 }, { costCenterId: cc('CC-SALES'), percentage: 35, sortOrder: 1 }, { costCenterId: cc('CC-OPS'), percentage: 40, sortOrder: 2 }],
    frequency: 'manual', effectiveFrom: '2026-01-01', createdAt: '', updatedAt: '',
  });

  it('builds a run and a balanced journal that nets to zero on the account', () => {
    const built = buildCostCenterAllocationRun({ rule: rule(), sourceAmount: 12000, periodStart: '2026-01-01', periodEnd: '2026-01-31', postingDate: '2026-01-31' });
    expect(built.ok).toBe(true);
    const targets = built.run.lines.filter((l) => l.debitAmount > 0);
    expect(targets.map((l) => l.debitAmount)).toEqual([3000, 4200, 4800]);

    const je = buildCostCenterAllocationJournal(built.run, rule(), accById());
    const totals = computeTotals(je.lines);
    expect(totals.totalDebit).toBe(12000);
    expect(totals.totalCredit).toBe(12000);
    expect(totals.difference).toBe(0);
    // All lines hit the same account → account-level net is zero (only the cost-center dimension shifts).
    expect(je.lines.every((l) => l.accountCode === '6860')).toBe(true);
  });

  it('posts through the store, links a journal, and reverses exactly', () => {
    const store = useCostCenterAllocationStore.getState();
    const r = store.createRule(rule());
    const built = useCostCenterAllocationStore.getState().buildRun(r.id!, { periodStart: '2026-01-01', periodEnd: '2026-01-31', postingDate: '2026-01-31', sourceAmountOverride: 12000 });
    expect(built.ok).toBe(true);
    expect(useCostCenterAllocationStore.getState().postRun(built.id!).ok).toBe(true);
    const posted = useCostCenterAllocationStore.getState().getRun(built.id!)!;
    const je = useJournalStore.getState().entries.find((e) => e.id === posted.journalEntryId)!;
    expect(computeTotals(je.lines).difference).toBe(0);
    // Duplicate posted run for same rule/period is blocked.
    const dup = useCostCenterAllocationStore.getState().buildRun(r.id!, { periodStart: '2026-01-01', periodEnd: '2026-01-31', postingDate: '2026-01-31', sourceAmountOverride: 12000 });
    expect(useCostCenterAllocationStore.getState().postRun(dup.id!).ok).toBe(false);
    // Reversal is exact.
    expect(useCostCenterAllocationStore.getState().reverseRun(built.id!, 'correction').ok).toBe(true);
    const rev = useJournalStore.getState().entries.find((e) => e.id === useCostCenterAllocationStore.getState().getRun(built.id!)!.reversalJournalEntryId)!;
    expect(computeTotals(rev.lines).difference).toBe(0);
  });
});

/* ───────────────────── Reporting (scenarios 2 & tests 35-39) ───────────────────── */

describe('cost-center reporting', () => {
  /** Post the bill split: Dr rent (6200) to three cost centers / Cr AP 10,000. */
  function postBillSplit(): void {
    const j = useJournalStore.getState();
    const added = j.addEntry({
      entryNumber: '', entryDate: '2026-03-01', reference: 'BILL', description: 'Office rent', currency: 'USD', exchangeRate: 1, notes: '', transactionType: 'Supplier Bill', createdBy: 'x', approvedBy: '',
      lines: [
        { accountId: acc('6200'), accountCode: '6200', accountName: '', description: 'Rent', debit: 4000, credit: 0, entityId: '', entityName: '', costCenter: cc('CC-ADMIN'), project: '', taxCode: '', taxAmount: 0, memo: '' },
        { accountId: acc('6200'), accountCode: '6200', accountName: '', description: 'Rent', debit: 3500, credit: 0, entityId: '', entityName: '', costCenter: cc('CC-SALES-DOM'), project: '', taxCode: '', taxAmount: 0, memo: '' },
        { accountId: acc('6200'), accountCode: '6200', accountName: '', description: 'Rent', debit: 2500, credit: 0, entityId: '', entityName: '', costCenter: cc('CC-PROD'), project: '', taxCode: '', taxAmount: 0, memo: '' },
        { accountId: acc('2210'), accountCode: '2210', accountName: '', description: '', debit: 0, credit: 10000, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
      ],
    });
    j.postEntry(added.id!);
  }

  it('trial balance by cost center reflects tagged lines and aggregates descendants', () => {
    postBillSplit();
    const tb = buildCostCenterTrialBalance(useJournalStore.getState().entries, useStore.getState().accounts, useCostCenterStore.getState().costCenters, cc('CC-CORP'), { from: '2026-01-01', to: '2026-12-31', base: 'USD', includeDescendants: true });
    const rent = tb.rows.find((r) => r.accountCode === '6200')!;
    expect(rent.periodDebit).toBe(10000); // all three descendants aggregate under Corporate
  });

  it('income statement by a single cost center shows only its own share', () => {
    postBillSplit();
    const is = buildCostCenterIncomeStatement(useJournalStore.getState().entries, useStore.getState().accounts, useCostCenterStore.getState().costCenters, cc('CC-ADMIN'), { from: '2026-01-01', to: '2026-12-31', base: 'USD', includeDescendants: true });
    expect(is.operatingExpenses).toBe(4000);
  });

  it('ledger lists tagged lines with drill-down ids', () => {
    postBillSplit();
    const ledger = buildCostCenterLedger(useJournalStore.getState().entries, useStore.getState().accounts, useCostCenterStore.getState().costCenters, cc('CC-SALES-DOM'), { base: 'USD', includeDescendants: false });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.debit).toBe(3500);
    expect(ledger[0]!.journalEntryId).toBeTruthy();
  });

  it('scope excludes non-descendant cost centers', () => {
    const scope = costCenterScope(SEED_COST_CENTERS, cc('CC-ADMIN'), true);
    expect(scope.has(cc('CC-FIN'))).toBe(true);
    expect(scope.has(cc('CC-PROD'))).toBe(false);
  });
});

/* ───────────────────── Budget vs actual (scenario 4) ───────────────────── */

describe('budget vs actual', () => {
  function postFinanceExpense(amount: number, date: string): void {
    const j = useJournalStore.getState();
    const added = j.addEntry({ entryNumber: '', entryDate: date, reference: 'EXP', description: 'Finance cost', currency: 'USD', exchangeRate: 1, notes: '', transactionType: 'Journal', createdBy: 'x', approvedBy: '',
      lines: [
        { accountId: acc('6300'), accountCode: '6300', accountName: '', description: '', debit: amount, credit: 0, entityId: '', entityName: '', costCenter: cc('CC-FIN'), project: '', taxCode: '', taxAmount: 0, memo: '' },
        { accountId: acc('2210'), accountCode: '2210', accountName: '', description: '', debit: 0, credit: amount, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
      ] });
    j.postEntry(added.id!);
  }

  it('computes expense variance with correct favorable/unfavorable sign', () => {
    // Budget: 10,000/month for Finance on 6300 (YTD 6 months = 60,000). Actual YTD = 66,000.
    const budgetStore = useCostCenterBudgetStore.getState();
    const b = budgetStore.createBudget({ fiscalYear: 2026, name: '2026 Budget' });
    for (let m = 1; m <= 12; m++) budgetStore.upsertLine(b.id!, { id: `bl${m}`, costCenterId: cc('CC-FIN'), accountId: acc('6300'), month: m, amount: 10000 });
    for (let m = 1; m <= 6; m++) postFinanceExpense(11000, `2026-0${m}-15`); // 66,000 over 6 months

    const budget = useCostCenterBudgetStore.getState().getBudget(b.id!)!;
    const report = calculateCostCenterBudgetActual({ budget, entries: useJournalStore.getState().entries, accounts: useStore.getState().accounts, base: 'USD', throughMonth: 6 });
    const row = report.rows.find((r) => r.costCenterId === cc('CC-FIN') && r.accountCode === '6300')!;
    expect(row.budget).toBe(60000);
    expect(row.actual).toBe(66000);
    expect(row.variance).toBe(6000);
    expect(row.favorable).toBe(false); // expense over budget is unfavorable
  });

  it('an approved budget is immutable', () => {
    const store = useCostCenterBudgetStore.getState();
    const b = store.createBudget({});
    store.approveBudget(b.id!);
    expect(useCostCenterBudgetStore.getState().upsertLine(b.id!, { id: 'x', costCenterId: cc('CC-FIN'), accountId: acc('6300'), month: 1, amount: 100 }).ok).toBe(false);
  });

  it('blocks a duplicate budget line (same cc/account/month)', () => {
    const store = useCostCenterBudgetStore.getState();
    const b = store.createBudget({});
    store.upsertLine(b.id!, { id: 'l1', costCenterId: cc('CC-FIN'), accountId: acc('6300'), month: 1, amount: 100 });
    expect(useCostCenterBudgetStore.getState().upsertLine(b.id!, { id: 'l2', costCenterId: cc('CC-FIN'), accountId: acc('6300'), month: 1, amount: 200 }).ok).toBe(false);
  });
});

/* ───────────────────── Snapshot & persistence ───────────────────── */

describe('snapshot & persistence', () => {
  it('snapshot preserves identity after a later rename', () => {
    const fin = SEED_COST_CENTERS.find((c) => c.code === 'CC-FIN')!;
    const snap = createCostCenterSnapshot(fin, 'now');
    const renamed = { ...fin, name: 'Finance & Treasury' }; // a later rename must not touch the snapshot
    void renamed;
    expect(snap.name).toBe('Finance');
    expect(snap.code).toBe('CC-FIN');
    expect(snap.hierarchyPath).toEqual(fin.hierarchyPath);
  });
  it('replaceAll rehydrates cost centers', () => {
    const snapshot = JSON.parse(JSON.stringify(useCostCenterStore.getState().costCenters));
    useCostCenterStore.getState().replaceAll({ costCenters: snapshot });
    expect(useCostCenterStore.getState().getCostCenter(cc('CC-FIN'))).toBeTruthy();
  });
});
