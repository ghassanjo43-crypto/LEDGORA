import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useBillStore } from './billStore';
import { useCreditNoteStore } from './creditNoteStore';
import { useReceiptStore } from './receiptStore';
import { usePaymentStore } from './paymentStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useProjectStore } from './projectStore';
import { useProjectBudgetStore } from './projectBudgetStore';
import { useProjectRecognitionStore } from './projectRecognitionStore';
import { useProjectDeliveryStore } from './projectDeliveryStore';
import { computeTotals } from '@/lib/journalValidation';
import { buildContractValueSummary } from '@/lib/projectContract';
import { calculatePercentageOfCompletion, computeRecognition } from '@/lib/projectRevenueRecognition';
import { calculateCostPlus, calculateFixedPrice, calculateTimeAndMaterials } from '@/lib/projectBilling';
import { buildProjectProfitability, buildProjectCashFlow, projectCashInflow } from '@/lib/projectProfitability';
import { calculateProjectBudgetActual } from '@/lib/projectBudget';
import { validateProjectRequirement } from '@/lib/projectValidation';
import { buildCloseoutChecklist } from '@/lib/projectCloseout';
import type { InvoiceLine } from '@/types/invoice';
import type { BillLine } from '@/types/bill';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const je = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const firstSupplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
const P = { SOLAR: 'prj_PRJ-SOLAR', ERP: 'prj_PRJ-ERP' };

function reportInput() {
  return {
    entries: useJournalStore.getState().entries, accounts: useStore.getState().accounts,
    invoices: useInvoiceStore.getState().invoices, bills: useBillStore.getState().bills,
    creditNotes: useCreditNoteStore.getState().creditNotes, receipts: useReceiptStore.getState().receipts,
    payments: usePaymentStore.getState().payments, base: 'USD',
  };
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  usePaymentStore.getState().resetToDefault();
  useProjectStore.getState().resetToDefault();
  useProjectBudgetStore.getState().resetToDefault();
  useProjectRecognitionStore.getState().resetToDefault();
  useProjectDeliveryStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

/* helpers */
function issuedInvoice(lines: Partial<InvoiceLine>[]): string {
  const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
  const base = useInvoiceStore.getState().getInvoice(id!)!.lines[0]!;
  // Fixed issue date so invoice-based revenue is stable regardless of the clock.
  useInvoiceStore.getState().updateDraft(id!, { issueDate: '2026-03-01', dueDate: '2026-04-01', lines: lines.map((l, i) => ({ ...base, accountId: acc('4120'), description: 'Work', quantity: 1, unitPrice: 1000, taxRate: 0, id: `il${i}`, ...l })) });
  expect(useInvoiceStore.getState().issueInvoice(id!).ok).toBe(true);
  return id!;
}
/** Post a receipt of `amount` against an invoice (fixed method/reference so it posts). */
function postReceipt(invId: string, amount: number): void {
  const r = useReceiptStore.getState().createReceiptForInvoice(invId);
  useReceiptStore.getState().updateDraft(r.id!, { amount, method: 'cash', transactionReference: 'TRX', allocations: [{ id: 'a1', entityId: useInvoiceStore.getState().getInvoice(invId)!.entityId, receiptId: r.id!, invoiceId: invId, invoiceNumber: '', allocationType: 'invoice', amount, baseCurrencyAmount: amount, allocationDate: '2026-05-01', createdAt: '', updatedAt: '' }] });
  expect(useReceiptStore.getState().postReceipt(r.id!).ok).toBe(true);
}
function postedBill(lines: Partial<BillLine>[], inv = 'P2-1'): string {
  const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-03-01', dueDate: '2026-04-01', currency: 'USD' });
  const base = useBillStore.getState().getBill(id!)!.lines[0]!;
  useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: inv, lines: lines.map((l, i) => ({ ...base, accountId: acc('6300'), description: 'Work', quantity: 1, unitPrice: 1000, taxRate: 0, id: `bl${i}`, billId: id!, ...l })) });
  expect(useBillStore.getState().postBill(id!).ok).toBe(true);
  return id!;
}

/* ───────────────────── Requirement rules ───────────────────── */

describe('project requirement rules', () => {
  it('required rule blocks invoice posting; prohibited on bank stays valid', () => {
    const rules = [{ id: 'r', entityId: 'primary', accountIds: [acc('4120')], requirement: 'required' as const, effectiveFrom: '2026-01-01', status: 'active' as const }];
    expect(validateProjectRequirement(useStore.getState().accounts.find((a) => a.code === '4120'), false, rules, '2026-06-01').length).toBe(1);
    expect(validateProjectRequirement(useStore.getState().accounts.find((a) => a.code === '1252'), false, useProjectStore.getState().requirementRules, '2026-06-01').length).toBe(0);
    expect(validateProjectRequirement(useStore.getState().accounts.find((a) => a.code === '1252'), true, useProjectStore.getState().requirementRules, '2026-06-01').length).toBe(1);
  });
  it('a configured required rule blocks issuing an invoice without a project', () => {
    useProjectStore.getState().upsertRequirementRule({ id: 'req-rev', entityId: 'primary', accountIds: [acc('4120')], requirement: 'required', effectiveFrom: '2026-01-01', status: 'active' });
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const base = useInvoiceStore.getState().getInvoice(id!)!.lines[0]!;
    useInvoiceStore.getState().updateDraft(id!, { lines: [{ ...base, accountId: acc('4120'), quantity: 1, unitPrice: 1000, taxRate: 0 }] });
    expect(useInvoiceStore.getState().issueInvoice(id!).ok).toBe(false);
    useInvoiceStore.getState().updateDraft(id!, { lines: [{ ...base, accountId: acc('4120'), quantity: 1, unitPrice: 1000, taxRate: 0, projectId: P.SOLAR }] });
    expect(useInvoiceStore.getState().issueInvoice(id!).ok).toBe(true);
  });
});

/* ───────────────────── Budgets ───────────────────── */

describe('versioned monthly budgets', () => {
  it('spreads annual, blocks duplicate lines, and locks on approval', () => {
    const store = useProjectBudgetStore.getState();
    const b = store.createBudget({ projectId: P.SOLAR, name: 'Original', scenario: 'original', fiscalYear: 2026 });
    store.spreadAnnual(b.id!, 'revenue', 120000);
    expect(useProjectBudgetStore.getState().getBudget(b.id!)!.lines.filter((l) => l.category === 'revenue')).toHaveLength(12);
    // duplicate
    expect(useProjectBudgetStore.getState().upsertLine(b.id!, { id: 'x', category: 'revenue', month: 1, amount: 5 }).ok).toBe(false);
    // approve → immutable
    useProjectBudgetStore.getState().approveBudget(b.id!);
    expect(useProjectBudgetStore.getState().spreadAnnual(b.id!, 'labor', 1000).ok).toBe(false);
  });
  it('budget vs actual compares posted revenue', () => {
    issuedInvoice([{ unitPrice: 10000, taxRate: 0, projectId: P.SOLAR }]);
    const b = useProjectBudgetStore.getState().createBudget({ projectId: P.SOLAR, fiscalYear: 2026 });
    useProjectBudgetStore.getState().spreadAnnual(b.id!, 'revenue', 12000);
    const bva = calculateProjectBudgetActual({ budget: useProjectBudgetStore.getState().getBudget(b.id!)!, entries: useJournalStore.getState().entries, accounts: useStore.getState().accounts, base: 'USD', throughMonth: 12 });
    expect(bva.budgetRevenue).toBe(12000);
    expect(bva.actualRevenue).toBe(10000);
  });
});

/* ───────────────────── Change orders ───────────────────── */

describe('change orders', () => {
  it('approved change orders revise the contract value without rewriting the original', () => {
    useProjectStore.getState().addChangeOrder(P.SOLAR, { number: 'CO-1', revenueChange: 50000, costChange: 30000, status: 'submitted', date: '2026-04-01' });
    const co = useProjectStore.getState().getProject(P.SOLAR)!.changeOrders![0]!;
    // Not approved → no effect yet.
    expect(buildContractValueSummary(useProjectStore.getState().getProject(P.SOLAR)!).revisedContractValue).toBe(300000);
    useProjectStore.getState().approveChangeOrder(P.SOLAR, co.id);
    const summary = buildContractValueSummary(useProjectStore.getState().getProject(P.SOLAR)!);
    expect(summary.originalContractValue).toBe(300000); // preserved
    expect(summary.revisedContractValue).toBe(350000);
  });
});

/* ───────────────────── Profitability & cash flow ───────────────────── */

describe('profitability & cash flow', () => {
  it('does not equate billed, recognised and cash; receipts drive project cash', () => {
    const invId = issuedInvoice([{ unitPrice: 20000, taxRate: 0, projectId: P.SOLAR }]); // billed + recognised 20,000
    postedBill([{ unitPrice: 8000, taxRate: 0, projectId: P.SOLAR }]); // cost 8,000
    // Receipt of 12,000 against the invoice → cash collected 12,000 (partial).
    postReceipt(invId, 12000);

    const p = buildProjectProfitability({ project: useProjectStore.getState().getProject(P.SOLAR)!, ...reportInput() });
    expect(p.billedRevenue).toBe(20000);
    expect(p.recognizedRevenue).toBe(20000);
    expect(p.cashCollected).toBe(12000); // ≠ billed/recognised
    expect(p.actualCost).toBe(8000);
    expect(p.grossProfit).toBe(12000);
    expect(p.receivableBalance).toBe(8000); // 20,000 − 12,000

    const cf = buildProjectCashFlow(P.SOLAR, reportInput());
    expect(cf.cashInflow).toBe(12000);
  });

  it('apportions a receipt across several projects by invoice line share', () => {
    // One invoice, revenue split 60/40 across two projects.
    const invId = issuedInvoice([{ unitPrice: 6000, taxRate: 0, projectId: P.SOLAR }, { unitPrice: 4000, taxRate: 0, projectId: P.ERP, id: 'il1' }]);
    postReceipt(invId, 10000);
    expect(projectCashInflow(P.SOLAR, useInvoiceStore.getState().invoices, useReceiptStore.getState().receipts)).toBe(6000);
    expect(projectCashInflow(P.ERP, useInvoiceStore.getState().invoices, useReceiptStore.getState().receipts)).toBe(4000);
  });
});

/* ───────────────────── Revenue recognition ───────────────────── */

describe('revenue recognition', () => {
  it('percentage-of-completion current-period revenue posts a balanced WIP journal', () => {
    // SOLAR: revised contract 300,000, estimated cost 220,000. Post 110,000 cost → 50% complete → recognise 150,000.
    postedBill([{ unitPrice: 110000, taxRate: 0, projectId: P.SOLAR }], 'POC-1');
    expect(calculatePercentageOfCompletion(110000, 220000)).toBe(0.5);
    const comp = computeRecognition({ project: useProjectStore.getState().getProject(P.SOLAR)!, actualCostToDate: 110000, recognizedToDate: 0 });
    expect(comp.targetCumulative).toBe(150000);
    expect(comp.currentPeriodAmount).toBe(150000);

    const built = useProjectRecognitionStore.getState().buildRun(P.SOLAR, '2026-06-30');
    expect(built.ok).toBe(true);
    expect(useProjectRecognitionStore.getState().postRun(built.id!).ok).toBe(true);
    const run = useProjectRecognitionStore.getState().getRun(built.id!)!;
    const entry = je(run.journalEntryId!);
    expect(computeTotals(entry.lines).difference).toBe(0);
    expect(entry.lines.find((l) => l.accountCode === '1230')!.debit).toBe(150000); // contract asset / unbilled
    expect(entry.lines.find((l) => l.accountCode === '4120')!.credit).toBe(150000); // revenue

    // A second run in the same period recognises nothing further (already up to date).
    expect(useProjectRecognitionStore.getState().buildRun(P.SOLAR, '2026-06-30').ok).toBe(false);
    // Reversal is exact.
    expect(useProjectRecognitionStore.getState().reverseRun(built.id!, 'correction').ok).toBe(true);
    const rev = je(useProjectRecognitionStore.getState().getRun(built.id!)!.reversalJournalEntryId!);
    expect(rev.lines.find((l) => l.accountCode === '1230')!.credit).toBe(150000);
  });

  it('defers revenue when billed exceeds recognised (Cr contract liability)', () => {
    // Invoice 100,000 on a POC project but recognise only 40% → target 120,000... use ERP (invoice basis) manual override.
    issuedInvoice([{ unitPrice: 100000, taxRate: 0, projectId: P.SOLAR }]); // GL revenue 100,000
    // Manually recognise a lower cumulative via manual method.
    useProjectStore.getState().updateProject(P.SOLAR, { revenueRecognitionMethod: 'manual' });
    const built = useProjectRecognitionStore.getState().buildRun(P.SOLAR, '2026-06-30', 70000); // target 70,000 < 100,000 billed
    expect(built.ok).toBe(true);
    useProjectRecognitionStore.getState().postRun(built.id!);
    const entry = je(useProjectRecognitionStore.getState().getRun(built.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2230')!.credit).toBe(30000); // deferred revenue (contract liability)
    expect(entry.lines.find((l) => l.accountCode === '4120')!.debit).toBe(30000);
  });
});

/* ───────────────────── Billing calculators ───────────────────── */

describe('billing calculators', () => {
  it('cost-plus applies markup to unbilled approved cost', () => {
    const d = useProjectDeliveryStore.getState();
    const t = d.addTimeEntry({ projectId: P.SOLAR, employeeName: 'A', date: '2026-05-01', hours: 10, billingRate: 100, costRate: 60 });
    d.approveTime(t.id!);
    const sug = calculateCostPlus({ project: { ...useProjectStore.getState().getProject(P.SOLAR)!, markupPercent: 15 }, timeEntries: useProjectDeliveryStore.getState().timeEntries, expenses: [], alreadyBilled: 0 });
    expect(sug.amount).toBe(690); // 600 cost × 1.15
  });
  it('time-and-materials sums billable time and expenses; fixed price caps at revised contract', () => {
    const d = useProjectDeliveryStore.getState();
    const t = d.addTimeEntry({ projectId: P.ERP, employeeName: 'A', date: '2026-05-01', hours: 10, billingRate: 120, costRate: 60 });
    d.approveTime(t.id!);
    const e = d.addExpense({ projectId: P.ERP, date: '2026-05-01', description: 'Travel', amount: 200, markupPercent: 10 });
    d.approveExpense(e.id!);
    const tm = calculateTimeAndMaterials({ project: useProjectStore.getState().getProject(P.ERP)!, timeEntries: useProjectDeliveryStore.getState().timeEntries, expenses: useProjectDeliveryStore.getState().expenses, alreadyBilled: 0 });
    expect(tm.timeAmount).toBe(1200);
    expect(tm.expenseAmount).toBe(220);
    expect(tm.amount).toBe(1420);
    // Fixed price cap: OFFICE contract 65,000, already billed 60,000 → suggest 5,000.
    const fp = calculateFixedPrice({ project: useProjectStore.getState().getProject('prj_PRJ-OFFICE')!, timeEntries: [], expenses: [], alreadyBilled: 60000 });
    expect(fp.amount).toBe(5000);
  });
  it('prevents duplicate time billing', () => {
    const d = useProjectDeliveryStore.getState();
    const t = d.addTimeEntry({ projectId: P.ERP, employeeName: 'A', date: '2026-05-01', hours: 5, billingRate: 100, costRate: 60 });
    d.approveTime(t.id!);
    expect(useProjectDeliveryStore.getState().billTime([t.id!], 'INV-1').ok).toBe(true);
    expect(useProjectDeliveryStore.getState().billTime([t.id!], 'INV-2').ok).toBe(false); // already billed
  });
});

/* ───────────────────── Billing → draft invoice ───────────────────── */

describe('generate draft invoice from billing', () => {
  it('creates a draft invoice through the invoice module and marks the time billed (no duplicate)', () => {
    // ERP is time-and-materials; link a customer and add approved billable time.
    useProjectStore.getState().updateProject(P.ERP, { customerId: firstCustomerId() });
    const d = useProjectDeliveryStore.getState();
    const t = d.addTimeEntry({ projectId: P.ERP, employeeName: 'A', date: '2026-05-01', hours: 10, billingRate: 120, costRate: 60 });
    d.approveTime(t.id!);
    const project = useProjectStore.getState().getProject(P.ERP)!;
    const suggestion = calculateTimeAndMaterials({ project, timeEntries: useProjectDeliveryStore.getState().timeEntries, expenses: [], alreadyBilled: 0 });
    expect(suggestion.amount).toBe(1200);

    // Compose the billing flow (as the Delivery page does): draft invoice + tagged line + mark billed.
    const created = useInvoiceStore.getState().createDraft({ customerId: project.customerId! });
    const base = useInvoiceStore.getState().getInvoice(created.id!)!.lines[0]!;
    useInvoiceStore.getState().updateDraft(created.id!, { lines: [{ ...base, accountId: acc('4120'), description: 'ERP billing', quantity: 1, unitPrice: suggestion.amount, taxRate: 0, projectId: P.ERP }] });
    expect(useProjectDeliveryStore.getState().billTime([t.id!], created.id!).ok).toBe(true);

    const inv = useInvoiceStore.getState().getInvoice(created.id!)!;
    expect(inv.status).toBe('draft'); // created through the invoice module, not auto-issued
    expect(inv.lines[0]!.projectId).toBe(P.ERP);
    expect(useProjectDeliveryStore.getState().timeEntries.find((x) => x.id === t.id)!.billed).toBe(true);
    // Re-billing the same time is blocked.
    expect(useProjectDeliveryStore.getState().billTime([t.id!], 'INV-2').ok).toBe(false);
  });
});

/* ───────────────────── Commitments & closeout ───────────────────── */

describe('commitments & closeout', () => {
  it('tracks committed/invoiced/remaining without touching the GL', () => {
    const journalCount = useJournalStore.getState().entries.length;
    const d = useProjectDeliveryStore.getState();
    const c = d.addCommitment({ projectId: P.SOLAR, type: 'purchase-order', reference: 'PO-1', committedAmount: 10000, date: '2026-03-01' });
    d.recordCommitmentInvoiced(c.id!, 4000);
    expect(useProjectDeliveryStore.getState().openCommitment(P.SOLAR)).toBe(6000);
    expect(useJournalStore.getState().entries.length).toBe(journalCount); // no GL effect
  });
  it('closeout blocks on unbilled approved time and reopen requires a reason', () => {
    const d = useProjectDeliveryStore.getState();
    const t = d.addTimeEntry({ projectId: P.ERP, employeeName: 'A', date: '2026-05-01', hours: 5, billingRate: 100, costRate: 60 });
    d.approveTime(t.id!);
    const profitability = buildProjectProfitability({ project: useProjectStore.getState().getProject(P.ERP)!, ...reportInput() });
    const checklist = buildCloseoutChecklist({ project: useProjectStore.getState().getProject(P.ERP)!, timeEntries: useProjectDeliveryStore.getState().timeEntries, expenses: [], commitments: [], profitability });
    expect(checklist.canClose).toBe(false); // unbilled approved time blocks
    expect(useProjectStore.getState().closeProject(P.ERP, { canClose: false }).ok).toBe(false);
    // Bill the time, then close.
    useProjectDeliveryStore.getState().billTime([t.id!], 'INV-1');
    expect(useProjectStore.getState().closeProject(P.ERP, { canClose: true }).ok).toBe(true);
    expect(useProjectStore.getState().getProject(P.ERP)!.status).toBe('closed');
    expect(useProjectStore.getState().reopenProject(P.ERP, '').ok).toBe(false);
    expect(useProjectStore.getState().reopenProject(P.ERP, 'more work').ok).toBe(true);
  });
});

/* ───────────────────── Hydration ───────────────────── */

describe('persistence', () => {
  it('replaceAll rehydrates projects + requirement rules', () => {
    const snap = JSON.parse(JSON.stringify(useProjectStore.getState().projects));
    useProjectStore.getState().replaceAll({ projects: snap });
    expect(useProjectStore.getState().getProject(P.SOLAR)).toBeTruthy();
  });
});
