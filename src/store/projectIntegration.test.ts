import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useBillStore } from './billStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useProjectStore } from './projectStore';
import { validateProjectForActivation, isProjectActiveOnDate, checkDuplicateProjectCode } from '@/lib/projectValidation';
import { resolveDefaultProject } from '@/lib/projectResolution';
import { createProjectSnapshot } from '@/lib/projectSnapshots';
import { buildProjectIncomeStatement, buildProjectLedger, buildProjectSummary } from '@/lib/projectReporting';
import { SEED_PROJECTS } from '@/data/projectSeed';
import type { InvoiceLine } from '@/types/invoice';
import type { BillLine } from '@/types/bill';
import type { Project } from '@/types/project';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const je = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const firstSupplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
const PRJ = { SOLAR: 'prj_PRJ-SOLAR', ERP: 'prj_PRJ-ERP' };

function project(over: Partial<Project>): Project {
  return { id: 'x', entityId: 'primary', code: 'P', name: 'P', status: 'active', startDate: '2026-01-01', auditTrail: [], createdAt: '', updatedAt: '', ...over };
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  useProjectStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

/* ───────────────────── Master & validation ───────────────────── */

describe('project master & validation', () => {
  it('enforces unique code per entity and valid dates', () => {
    expect(checkDuplicateProjectCode(SEED_PROJECTS, 'prj-solar', 'primary')).toBe(true);
    expect(validateProjectForActivation(project({ id: 'n', code: 'PRJ-SOLAR' }), { existing: SEED_PROJECTS }).some((i) => i.rule === 'code-unique')).toBe(true);
    expect(validateProjectForActivation(project({ id: 'n', code: 'NEW', startDate: '2026-06-01', endDate: '2026-01-01' }), { existing: [] }).some((i) => i.rule === 'date-range')).toBe(true);
  });
  it('closed/expired projects are not active on a date', () => {
    expect(isProjectActiveOnDate(project({ status: 'completed' }), '2026-06-01')).toBe(false);
    expect(isProjectActiveOnDate(project({ endDate: '2026-03-01' }), '2026-06-01')).toBe(false);
    expect(isProjectActiveOnDate(project({}), '2026-06-01')).toBe(true);
  });
  it('default resolution honours explicit → customer → none', () => {
    expect(resolveDefaultProject({ explicitProjectId: 'A', customerDefaultProjectId: 'B' })).toEqual({ projectId: 'A', source: 'explicit' });
    expect(resolveDefaultProject({ customerDefaultProjectId: 'B' }).source).toBe('customer');
    expect(resolveDefaultProject({}).source).toBe('none');
  });
});

/* ───────────────────── Document propagation ───────────────────── */

function issuedInvoice(lines: Partial<InvoiceLine>[]): string {
  const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
  const base = useInvoiceStore.getState().getInvoice(id!)!.lines[0]!;
  const built = lines.map((l, i) => ({ ...base, accountId: acc('4120'), description: 'Work', quantity: 1, unitPrice: 1000, taxRate: 0, id: `il${i}`, ...l }));
  useInvoiceStore.getState().updateDraft(id!, { lines: built });
  expect(useInvoiceStore.getState().issueInvoice(id!).ok).toBe(true);
  return id!;
}
function postedBill(lines: Partial<BillLine>[]): string {
  const { id } = useBillStore.getState().createDraft({ supplierId: firstSupplierId(), billDate: '2026-03-01', dueDate: '2026-04-01', currency: 'USD' });
  const base = useBillStore.getState().getBill(id!)!.lines[0]!;
  const built = lines.map((l, i) => ({ ...base, accountId: acc('6300'), description: 'Work', quantity: 1, unitPrice: 1000, taxRate: 0, id: `bl${i}`, billId: id!, ...l }));
  useBillStore.getState().updateDraft(id!, { supplierInvoiceNumber: 'PRJ-1', lines: built });
  expect(useBillStore.getState().postBill(id!).ok).toBe(true);
  return id!;
}

describe('project document integration', () => {
  it('propagates an invoice revenue-line project to the journal, with a frozen snapshot', () => {
    const id = issuedInvoice([{ unitPrice: 5000, taxRate: 16, projectId: PRJ.SOLAR }]);
    const entry = je(useInvoiceStore.getState().getInvoice(id)!.journalEntryId!);
    const revenue = entry.lines.find((l) => l.accountCode === '4120')!;
    expect(revenue.project).toBe(PRJ.SOLAR);
    expect(revenue.projectSnapshot?.code).toBe('PRJ-SOLAR');
    // Receivable/tax lines carry no project.
    expect(entry.lines.find((l) => l.accountCode === '1221')!.project).toBe('');
  });

  it('propagates a bill expense-line project to the journal', () => {
    const id = postedBill([{ unitPrice: 3000, taxRate: 0, projectId: PRJ.ERP }]);
    const entry = je(useBillStore.getState().getBill(id)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '6300')!.project).toBe(PRJ.ERP);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.project).toBe(''); // AP untagged
  });

  it('supports a project and a cost center together on one line', () => {
    const id = postedBill([{ unitPrice: 3000, taxRate: 0, projectId: PRJ.SOLAR, costCenterId: 'cc_CC-PROD' }]);
    const expense = je(useBillStore.getState().getBill(id)!.journalEntryId!).lines.find((l) => l.accountCode === '6300')!;
    expect(expense.project).toBe(PRJ.SOLAR);
    expect(expense.costCenter).toBe('cc_CC-PROD'); // dimensions stay distinct
  });
});

/* ───────────────────── Reporting ───────────────────── */

describe('project reporting', () => {
  it('income statement and margin derive from posted journal lines', () => {
    issuedInvoice([{ unitPrice: 10000, taxRate: 0, projectId: PRJ.SOLAR }]); // revenue 10,000
    postedBill([{ unitPrice: 4000, taxRate: 0, projectId: PRJ.SOLAR }]); // expense 4,000
    const entries = useJournalStore.getState().entries;
    const accounts = useStore.getState().accounts;
    const is = buildProjectIncomeStatement(entries, accounts, PRJ.SOLAR, { from: '2026-01-01', to: '2026-12-31', base: 'USD' });
    expect(is.revenue).toBe(10000);
    expect(is.operatingExpenses).toBe(4000);
    expect(is.netResult).toBe(6000);

    const ledger = buildProjectLedger(entries, accounts, PRJ.SOLAR, { base: 'USD' });
    expect(ledger.length).toBeGreaterThanOrEqual(2);

    const summary = buildProjectSummary(entries, accounts, useProjectStore.getState().projects, { base: 'USD' });
    const solar = summary.find((r) => r.projectId === PRJ.SOLAR)!;
    expect(solar.revenue).toBe(10000);
    expect(solar.cost).toBe(4000);
    expect(solar.margin).toBe(6000);
  });

  it('snapshot survives a later project rename', () => {
    const prj = SEED_PROJECTS.find((p) => p.id === PRJ.SOLAR)!;
    const snap = createProjectSnapshot(prj, 'now');
    expect(snap.code).toBe('PRJ-SOLAR');
    expect(snap.name).toBe('Solar Plant Installation');
  });

  it('replaceAll rehydrates projects', () => {
    const snapshot = JSON.parse(JSON.stringify(useProjectStore.getState().projects));
    useProjectStore.getState().replaceAll({ projects: snapshot });
    expect(useProjectStore.getState().getProject(PRJ.SOLAR)).toBeTruthy();
  });
});
