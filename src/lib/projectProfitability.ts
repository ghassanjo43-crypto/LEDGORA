import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { Invoice } from '@/types/invoice';
import type { Bill } from '@/types/bill';
import type { CreditNote } from '@/types/creditNote';
import type { Receipt } from '@/types/receipt';
import type { Payment } from '@/types/payment';
import type { Project } from '@/types/project';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { calculateBillLine } from '@/lib/billCalculations';
import { calculateCreditNoteLine } from '@/lib/creditNoteCalculations';
import { buildContractValueSummary } from '@/lib/projectContract';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Project profitability & cash flow — all derived from POSTED records (§3–4, §13).
 * Billed revenue, recognised revenue and cash collected are computed independently
 * and never equated. Cash comes only from receipt/payment allocations to project
 * invoices/bills (an invoice or bill is not a cash movement).
 */

/* ─────────────────── Per-document project share ──────────────────────────── */

/** Fraction of an invoice's net attributable to a project (by revenue line). */
export function invoiceProjectShare(invoice: Invoice, projectId: string): number {
  let total = 0;
  let project = 0;
  for (const line of invoice.lines) {
    const net = calculateInvoiceLine(line).taxableAmount;
    total += net;
    if (line.projectId === projectId) project += net;
  }
  return total <= 0 ? 0 : project / total;
}

/** Fraction of a bill's net attributable to a project (by expense line). */
export function billProjectShare(bill: Bill, projectId: string): number {
  let total = 0;
  let project = 0;
  for (const line of bill.lines) {
    const net = calculateBillLine(line).taxableAmount;
    total += net;
    if (line.projectId === projectId) project += net;
  }
  return total <= 0 ? 0 : project / total;
}

const POSTED_RECEIPT = (r: Receipt): boolean => r.status === 'posted' || r.status === 'partially-allocated' || r.status === 'fully-allocated';
const POSTED_PAYMENT = (p: Payment): boolean => p.status === 'posted' || p.status === 'partially-allocated' || p.status === 'fully-allocated';

/**
 * Cash collected for a project = each posted receipt allocation to a project
 * invoice × that invoice's project share. Handles one receipt across several
 * projects, partial allocations and reversed allocations.
 */
export function projectCashInflow(projectId: string, invoices: Invoice[], receipts: Receipt[]): number {
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  let cash = 0;
  for (const r of receipts) {
    if (!POSTED_RECEIPT(r)) continue;
    for (const a of r.allocations) {
      if (a.reversed || !a.invoiceId) continue;
      const inv = invoiceById.get(a.invoiceId);
      if (!inv) continue;
      cash += (Number(a.amount) || 0) * invoiceProjectShare(inv, projectId);
    }
  }
  return roundMoney(cash);
}

/** Cash paid out for a project = payment allocations to project bills × bill project share. */
export function projectCashOutflow(projectId: string, bills: Bill[], payments: Payment[]): number {
  const billById = new Map(bills.map((b) => [b.id, b]));
  let cash = 0;
  for (const p of payments) {
    if (!POSTED_PAYMENT(p)) continue;
    for (const a of p.allocations) {
      if (a.reversed || !a.billId) continue;
      const bill = billById.get(a.billId);
      if (!bill) continue;
      cash += (Number(a.amount) || 0) * billProjectShare(bill, projectId);
    }
  }
  return roundMoney(cash);
}

/* ─────────────────── GL-derived revenue & cost ────────────────────────────── */

function glRevenueAndCost(entries: JournalEntry[], accountsById: Map<string, Account>, projectId: string, base: string): { revenue: number; cost: number } {
  let revenue = 0;
  let cost = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.project !== projectId) continue;
    const acc = accountsById.get(line.accountId);
    if (!acc) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, base);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, base);
    if (acc.type === 'INCOME') revenue += credit - debit;
    else if (acc.type === 'COST_OF_SALES' || acc.type === 'OPERATING_EXPENSE') cost += debit - credit;
  }
  return { revenue: roundMoney(revenue), cost: roundMoney(cost) };
}

/* ─────────────────── Billed revenue (documents) ──────────────────────────── */

function billedRevenue(projectId: string, invoices: Invoice[], creditNotes: CreditNote[]): number {
  let billed = 0;
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void') continue;
    for (const line of inv.lines) if (line.projectId === projectId) billed += calculateInvoiceLine(line).taxableAmount;
  }
  for (const cn of creditNotes) {
    if (cn.status === 'draft' || cn.status === 'void') continue;
    for (const line of cn.lines) if (line.projectId === projectId) billed -= calculateCreditNoteLine(line).taxableAmount;
  }
  return roundMoney(billed);
}

function outstandingBalances(projectId: string, invoices: Invoice[], bills: Bill[]): { receivable: number; payable: number } {
  let receivable = 0;
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void') continue;
    const share = invoiceProjectShare(inv, projectId);
    if (share > 0) receivable += (Number(inv.balanceDue) || 0) * share;
  }
  let payable = 0;
  for (const bill of bills) {
    if (bill.status === 'draft' || bill.status === 'void' || bill.status === 'reversed') continue;
    const share = billProjectShare(bill, projectId);
    if (share > 0) payable += (Number(bill.balanceDue) || 0) * share;
  }
  return { receivable: roundMoney(receivable), payable: roundMoney(payable) };
}

/* ─────────────────────────── Profitability ───────────────────────────────── */

export interface ProjectProfitability {
  projectId: string;
  code: string;
  name: string;

  originalContractValue: number;
  approvedChangeOrders: number;
  revisedContractValue: number;

  billedRevenue: number;
  recognizedRevenue: number;
  cashCollected: number;

  actualCost: number;
  committedCost: number;
  forecastCostToComplete: number;
  estimatedTotalCost: number;

  grossProfit: number;
  grossMarginPercent: number | null;
  forecastProfit: number;
  forecastMarginPercent: number | null;

  receivableBalance: number;
  payableBalance: number;
}

export interface ProfitabilityInput {
  project: Project;
  entries: JournalEntry[];
  accounts: Account[];
  invoices: Invoice[];
  bills: Bill[];
  creditNotes: CreditNote[];
  receipts: Receipt[];
  payments: Payment[];
  base: string;
  /** Open commitment amount from POs/subcontracts (management data, not in the GL). */
  committedCost?: number;
}

/** Build the full project profitability picture from posted records (§3). */
export function buildProjectProfitability(input: ProfitabilityInput): ProjectProfitability {
  const { project } = input;
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  const contract = buildContractValueSummary(project);
  const gl = glRevenueAndCost(input.entries, accountsById, project.id, input.base);
  const billed = billedRevenue(project.id, input.invoices, input.creditNotes);
  const cash = projectCashInflow(project.id, input.invoices, input.receipts);
  const actualCost = gl.cost;
  const committedCost = roundMoney(input.committedCost ?? 0);
  const estimatedTotalCost = roundMoney(project.estimatedTotalCost ?? Math.max(actualCost, 0));
  const { receivable, payable } = outstandingBalances(project.id, input.invoices, input.bills);

  const grossProfit = roundMoney(gl.revenue - actualCost);
  const forecastProfit = roundMoney(contract.revisedContractValue - estimatedTotalCost);
  return {
    projectId: project.id, code: project.code, name: project.name,
    originalContractValue: contract.originalContractValue,
    approvedChangeOrders: contract.approvedRevenueChange,
    revisedContractValue: contract.revisedContractValue,
    billedRevenue: billed,
    recognizedRevenue: gl.revenue,
    cashCollected: cash,
    actualCost,
    committedCost,
    forecastCostToComplete: roundMoney(Math.max(0, estimatedTotalCost - actualCost)),
    estimatedTotalCost,
    grossProfit,
    grossMarginPercent: gl.revenue === 0 ? null : roundMoney((grossProfit / gl.revenue) * 100),
    forecastProfit,
    forecastMarginPercent: contract.revisedContractValue === 0 ? null : roundMoney((forecastProfit / contract.revisedContractValue) * 100),
    receivableBalance: receivable,
    payableBalance: payable,
  };
}

/* ─────────────────────────── Project cash flow ────────────────────────────── */

export interface ProjectCashFlow {
  projectId: string;
  cashInflow: number;
  cashOutflow: number;
  netCash: number;
}

/** Project cash flow (§13): inflow from receipts to project invoices, outflow from payments to project bills. */
export function buildProjectCashFlow(projectId: string, input: Pick<ProfitabilityInput, 'invoices' | 'bills' | 'receipts' | 'payments'>): ProjectCashFlow {
  const cashInflow = projectCashInflow(projectId, input.invoices, input.receipts);
  const cashOutflow = projectCashOutflow(projectId, input.bills, input.payments);
  return { projectId, cashInflow, cashOutflow, netCash: roundMoney(cashInflow - cashOutflow) };
}
