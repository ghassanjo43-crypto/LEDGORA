import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useCreditNoteStore } from './creditNoteStore';
import { useBillStore } from './billStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useCostCenterStore } from './costCenterStore';
import { computeTotals } from '@/lib/journalValidation';
import { buildCostCenterIncomeStatement } from '@/lib/costCenterReporting';
import { dryRunCostCenterImport } from '@/lib/costCenterImport';
import type { InvoiceLine } from '@/types/invoice';
import type { BillLine } from '@/types/bill';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const je = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const firstSupplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
// FIN/HR/SALES/PROD are posting leaves; ADMIN is a summary (non-posting) parent.
const CC = { FIN: 'cc_CC-FIN', HR: 'cc_CC-HR', SALES: 'cc_CC-SALES-DOM', PROD: 'cc_CC-PROD', ADMIN: 'cc_CC-ADMIN' };

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  useCostCenterStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

/* ───────────────────── Invoice integration ───────────────────── */

function issuedInvoice(lines: Partial<InvoiceLine>[]): string {
  const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
  const base = useInvoiceStore.getState().getInvoice(id!)!.lines[0]!;
  const built = lines.map((l, i) => ({ ...base, accountId: acc('4120'), description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 0, id: `il${i}`, ...l }));
  useInvoiceStore.getState().updateDraft(id!, { lines: built });
  const res = useInvoiceStore.getState().issueInvoice(id!);
  expect(res.ok).toBe(true);
  return id!;
}

describe('invoice cost-center integration', () => {
  it('propagates a single line cost center to the revenue journal line; AR & tax stay untagged', () => {
    const id = issuedInvoice([{ unitPrice: 1000, taxRate: 16, costCenterId: CC.SALES }]);
    const inv = useInvoiceStore.getState().getInvoice(id)!;
    const entry = je(inv.journalEntryId!);
    const revenue = entry.lines.find((l) => l.accountCode === '4120')!;
    expect(revenue.costCenter).toBe(CC.SALES);
    expect(revenue.costCenterSnapshot?.code).toBe('CC-SALES-DOM'); // frozen snapshot
    // Receivable + tax control lines carry no cost center.
    expect(entry.lines.find((l) => l.accountCode === '1221')!.costCenter).toBe('');
    expect(entry.lines.find((l) => l.accountCode === '2270')!.costCenter).toBe('');
  });

  it('splits one revenue line across cost centers, preserving the total', () => {
    const id = issuedInvoice([{ unitPrice: 1000, taxRate: 0, costCenterAssignments: [{ costCenterId: CC.SALES, percentage: 60 }, { costCenterId: CC.HR, percentage: 40 }] }]);
    const entry = je(useInvoiceStore.getState().getInvoice(id)!.journalEntryId!);
    const revenueLines = entry.lines.filter((l) => l.accountCode === '4120');
    expect(revenueLines).toHaveLength(2);
    expect(revenueLines.find((l) => l.costCenter === CC.SALES)!.credit).toBe(600);
    expect(revenueLines.find((l) => l.costCenter === CC.HR)!.credit).toBe(400);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });

  it('a required cost-center rule blocks issuing an invoice without one', () => {
    useCostCenterStore.getState().upsertRequirementRule({ id: 'req-rev', entityId: 'primary', accountIds: [acc('4120')], requirement: 'required', effectiveFrom: '2026-01-01', status: 'active' });
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const base = useInvoiceStore.getState().getInvoice(id!)!.lines[0]!;
    useInvoiceStore.getState().updateDraft(id!, { lines: [{ ...base, accountId: acc('4120'), quantity: 1, unitPrice: 1000, taxRate: 0 }] });
    const blocked = useInvoiceStore.getState().issueInvoice(id!);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/cost center is required/i);
    // Adding a cost center lets it post.
    useInvoiceStore.getState().updateDraft(id!, { lines: [{ ...base, accountId: acc('4120'), quantity: 1, unitPrice: 1000, taxRate: 0, costCenterId: CC.SALES }] });
    expect(useInvoiceStore.getState().issueInvoice(id!).ok).toBe(true);
  });
});

/* ───────────────────── Credit-note inheritance ───────────────────── */

describe('credit-note inheritance', () => {
  it('inherits the original invoice line cost center and propagates it to the reversal journal', () => {
    const id = issuedInvoice([{ unitPrice: 1000, taxRate: 0, costCenterId: CC.SALES }]);
    const created = useCreditNoteStore.getState().createCreditNoteFromInvoice(id, { creditType: 'full' });
    const cn = useCreditNoteStore.getState().getCreditNoteById(created.id!)!;
    expect(cn.lines[0]!.costCenterId).toBe(CC.SALES); // inherited, not a current default
    useCreditNoteStore.getState().issueCreditNote(created.id!);
    const entry = je(useCreditNoteStore.getState().getCreditNoteById(created.id!)!.journalEntryId!);
    const reversal = entry.lines.find((l) => l.debit > 0 && l.costCenter);
    expect(reversal!.costCenter).toBe(CC.SALES);
  });

  it('partial credit preserves the original cost-center relationship', () => {
    const id = issuedInvoice([{ unitPrice: 1000, quantity: 4, taxRate: 0, costCenterId: CC.PROD }]);
    const created = useCreditNoteStore.getState().createCreditNoteFromInvoice(id, { creditType: 'selected-lines' });
    const cn = useCreditNoteStore.getState().getCreditNoteById(created.id!)!;
    expect(cn.lines[0]!.costCenterId).toBe(CC.PROD);
  });
});

/* ───────────────────── Bill integration ───────────────────── */

function postedBill(lines: Partial<BillLine>[], invoiceNumber = 'CC-1'): string {
  const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-03-01', dueDate: '2026-04-01', currency: 'USD' });
  const base = useBillStore.getState().getBill(id!)!.lines[0]!;
  const built = lines.map((l, i) => ({ ...base, accountId: acc('6300'), description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 0, id: `bl${i}`, billId: id!, ...l }));
  useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: invoiceNumber, lines: built });
  const res = useBillStore.getState().postBill(id!);
  expect(res.ok).toBe(true);
  return id!;
}

describe('bill cost-center integration', () => {
  it('propagates a bill expense cost center to the expense journal line; AP stays untagged', () => {
    const id = postedBill([{ unitPrice: 1000, taxRate: 16, costCenterId: CC.PROD }]);
    const entry = je(useBillStore.getState().getBill(id)!.journalEntryId!);
    const expense = entry.lines.find((l) => l.accountCode === '6300')!;
    expect(expense.costCenter).toBe(CC.PROD);
    expect(expense.costCenterSnapshot?.code).toBe('CC-PROD');
    expect(entry.lines.find((l) => l.accountCode === '2210')!.costCenter).toBe(''); // AP untagged
    expect(entry.lines.find((l) => l.accountCode === '2270')!.costCenter).toBe(''); // recoverable input tax untagged
  });

  it('splits a bill expense across cost centers (scenario 2 shape)', () => {
    const id = postedBill([{ unitPrice: 10000, taxRate: 0, costCenterAssignments: [{ costCenterId: CC.HR, percentage: 40 }, { costCenterId: CC.SALES, percentage: 35 }, { costCenterId: CC.PROD, percentage: 25 }] }]);
    const entry = je(useBillStore.getState().getBill(id)!.journalEntryId!);
    const expenses = entry.lines.filter((l) => l.accountCode === '6300');
    expect(expenses.map((l) => l.debit).sort((a, b) => a - b)).toEqual([2500, 3500, 4000]);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });

  it('a required rule blocks posting a bill without a cost center', () => {
    useCostCenterStore.getState().upsertRequirementRule({ id: 'req-exp', entityId: 'primary', accountIds: [acc('6300')], requirement: 'required', effectiveFrom: '2026-01-01', status: 'active' });
    const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-03-01', dueDate: '2026-04-01', currency: 'USD' });
    const base = useBillStore.getState().getBill(id!)!.lines[0]!;
    useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: 'REQ-1', lines: [{ ...base, accountId: acc('6300'), quantity: 1, unitPrice: 1000, taxRate: 0, billId: id! }] });
    expect(useBillStore.getState().postBill(id!).ok).toBe(false);
  });

  it('supplier credit inherits the original bill line cost center', () => {
    const id = postedBill([{ unitPrice: 1000, taxRate: 0, costCenterId: CC.FIN }], 'SC-1');
    const res = useBillStore.getState().createSupplierCredit(id, { netAmount: 500, taxAmount: 0, creditAccountId: acc('6300'), reason: 'Return' });
    expect(res.ok).toBe(true);
    const credit = useBillStore.getState().getBill(id)!.supplierCredits[0]!;
    const entry = je(credit.journalEntryId!);
    const reversal = entry.lines.find((l) => l.accountCode === '6300')!;
    expect(reversal.costCenter).toBe(CC.FIN);
  });
});

/* ───────────────────── Historical snapshot & reports ───────────────────── */

describe('historical snapshot & hierarchy reports', () => {
  it('the posted snapshot survives a rename and a hierarchy move; current vs historical reports differ', () => {
    postedBill([{ unitPrice: 1000, taxRate: 0, costCenterId: CC.FIN }], 'HS-1');
    // Rename Finance and move it under Sales — historical presentation must not change.
    useCostCenterStore.getState().updateCostCenter(CC.FIN, { name: 'Finance & Treasury' });
    useCostCenterStore.getState().moveCostCenter(CC.FIN, 'cc_CC-SALES');

    const entries = useJournalStore.getState().entries;
    const accounts = useStore.getState().accounts;
    const centers = useCostCenterStore.getState().costCenters;

    // Snapshot on the posted line keeps the ORIGINAL code/name/path.
    const posted = entries.flatMap((e) => e.lines).find((l) => l.costCenter === CC.FIN && l.costCenterSnapshot)!;
    expect(posted.costCenterSnapshot!.name).toBe('Finance'); // frozen — not "Finance & Treasury"

    // Under the CURRENT tree Finance now rolls up under Sales; historically it rolled up under Admin.
    const currentUnderSales = buildCostCenterIncomeStatement(entries, accounts, centers, 'cc_CC-SALES', { from: '2026-01-01', to: '2026-12-31', base: 'USD', includeDescendants: true, basis: 'current' });
    const historicalUnderAdmin = buildCostCenterIncomeStatement(entries, accounts, centers, CC.ADMIN, { from: '2026-01-01', to: '2026-12-31', base: 'USD', includeDescendants: true, basis: 'historical' });
    expect(currentUnderSales.operatingExpenses).toBe(1000); // current: Finance is under Sales now
    expect(historicalUnderAdmin.operatingExpenses).toBe(1000); // historical: it was posted under Admin
  });
});

/* ───────────────────── Import dry-run ───────────────────── */

describe('cost-center import dry-run', () => {
  it('catches duplicate codes, unknown parents, and invalid dates before commit', () => {
    const centers = useCostCenterStore.getState().costCenters;
    const csv = [
      'entity,code,name,type,parentCode,postingAllowed,effectiveFrom,status',
      'primary,CC-FIN,Finance,administrative,CC-ADMIN,true,2026-01-01,active', // duplicate existing code
      'primary,CC-NEW,New Center,support,CC-MISSING,true,2026-01-01,active', // unknown parent
      'primary,CC-BADDATE,Bad Date,support,CC-CORP,true,not-a-date,active', // invalid date
      'primary,CC-OK,Good Center,support,CC-CORP,true,2026-01-01,active', // accepted
    ].join('\n');
    const dry = dryRunCostCenterImport(csv, centers, 'primary');
    expect(dry.acceptedCount).toBe(1);
    expect(dry.rejectedCount).toBe(3);
    expect(dry.rows.find((r) => r.raw.code === 'CC-FIN')!.errors.join(' ')).toMatch(/already exists/i);
    expect(dry.rows.find((r) => r.raw.code === 'CC-NEW')!.errors.join(' ')).toMatch(/unknown parent/i);
    expect(dry.rows.find((r) => r.raw.code === 'CC-BADDATE')!.errors.join(' ')).toMatch(/invalid effectivefrom/i);
    expect(dry.rows.find((r) => r.raw.code === 'CC-OK')!.accepted).toBe(true);
  });
});
