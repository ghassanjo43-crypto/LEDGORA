import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type {
  CashFlowLine,
  CashFlowPeriod,
  CashFlowPolicy,
  CashFlowStatement,
  CashFlowWarning,
} from '@/types/cashFlow';
import { DEFAULT_CASH_FLOW_POLICY } from '@/types/cashFlow';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { selectPostedBalancesAsOf } from '@/lib/balanceSheetCalculations';
import { buildIncomeStatement } from '@/lib/incomeStatementCalculations';

export const CASH_TOLERANCE = 0.01;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ──────────────────────────── Cash accounts ─────────────────────────────── */

/** Cash & cash-equivalent accounts, identified by CoA metadata (never by name). */
export function selectCashAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.type === 'ASSET' && /cash and cash equivalents/i.test(a.ifrsSubcategory));
}
export function isCashAccount(a: Account): boolean {
  return a.type === 'ASSET' && /cash and cash equivalents/i.test(a.ifrsSubcategory);
}

function sumCash(balances: Map<string, number>, cashIds: Set<string>): number {
  let total = 0;
  for (const id of cashIds) total += balances.get(id) ?? 0;
  return round2(total);
}

export function calculateOpeningCash(entries: JournalEntry[], cashIds: Set<string>, periodStart: string, base: string, entityId?: string): number {
  return sumCash(selectPostedBalancesAsOf(entries, addDays(periodStart, -1), base, entityId), cashIds);
}
export function calculateClosingCash(entries: JournalEntry[], cashIds: Set<string>, periodEnd: string, base: string, entityId?: string): number {
  return sumCash(selectPostedBalancesAsOf(entries, periodEnd, base, entityId), cashIds);
}

/* ───────────────────────── Counterpart classification ───────────────────── */

export type CounterpartActivity = 'operating' | 'investing' | 'financing' | 'unclassified';

/** Classify a non-cash counterpart account into a cash-flow activity. */
export function accountActivity(a: Account, policy: CashFlowPolicy): CounterpartActivity {
  if (!a.ifrsCategory) return 'unclassified';
  switch (a.type) {
    case 'EQUITY':
      // dividends / drawings may follow policy; capital is financing
      if (/dividend|drawing/i.test(a.ifrsSubcategory) || /dividend|drawing/i.test(a.name)) return policy.dividendsPaid;
      return 'financing';
    case 'LIABILITY':
      if (/borrowings|lease/i.test(a.ifrsSubcategory)) return 'financing';
      return 'operating';
    case 'ASSET':
      if (/non-current/i.test(a.ifrsCategory)) return 'investing';
      if (/short-term investments/i.test(a.ifrsSubcategory)) return 'investing';
      return 'operating';
    case 'FINANCE':
      return a.normalBalance === 'CREDIT' ? policy.interestReceived : policy.interestPaid;
    default:
      return 'operating';
  }
}

/* ───────────────── Investing & financing (cash-journal analysis) ─────────── */

interface CashClassifiedLine { accountId: string; amount: number; journalEntryId: string; activity: CounterpartActivity }

/**
 * For each posted, in-period entry that touches cash, attribute the cash effect
 * of every non-cash counterpart line (credit − debit) to that account's activity.
 * Pure cash-to-cash transfers are skipped. Avoids double counting.
 */
function classifyCashJournalLines(entries: JournalEntry[], cashIds: Set<string>, accountsById: Map<string, Account>, period: CashFlowPeriod, base: string, entityId: string | undefined, policy: CashFlowPolicy): CashClassifiedLine[] {
  const out: CashClassifiedLine[] = [];
  const posted = getPostedJournalLines(entries);
  // Group posted lines back into their entries.
  const byEntry = new Map<string, { entry: JournalEntry; lines: typeof posted }>();
  for (const item of posted) {
    if (item.entry.entryDate < period.start || item.entry.entryDate > period.end) continue;
    const g = byEntry.get(item.entry.id) ?? { entry: item.entry, lines: [] };
    g.lines.push(item);
    byEntry.set(item.entry.id, g);
  }
  for (const { entry, lines } of byEntry.values()) {
    const cashLines = lines.filter((l) => cashIds.has(l.line.accountId) && (!entityId || l.line.entityId === entityId));
    if (cashLines.length === 0) continue;
    const nonCash = lines.filter((l) => !cashIds.has(l.line.accountId) && (!entityId || l.line.entityId === entityId));
    if (nonCash.length === 0) {
      // Only cash lines → composition change between cash accounts = internal transfer.
      continue;
    }
    // Attribute each counterpart's cash effect = (credit − debit).
    for (const { line } of nonCash) {
      const a = accountsById.get(line.accountId);
      if (!a) continue;
      const amount = round2(convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base) - convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base));
      if (Math.abs(amount) < 0.005) continue;
      out.push({ accountId: line.accountId, amount, journalEntryId: entry.id, activity: accountActivity(a, policy) });
    }
  }
  return out;
}

function groupActivityLines(classified: CashClassifiedLine[], activity: CounterpartActivity, accountsById: Map<string, Account>, idPrefix: string): CashFlowLine[] {
  const byAccount = new Map<string, { amount: number; entries: Set<string> }>();
  for (const c of classified.filter((x) => x.activity === activity)) {
    const rec = byAccount.get(c.accountId) ?? { amount: 0, entries: new Set<string>() };
    rec.amount = round2(rec.amount + c.amount);
    rec.entries.add(c.journalEntryId);
    byAccount.set(c.accountId, rec);
  }
  return [...byAccount.entries()]
    .filter(([, r]) => Math.abs(r.amount) >= 0.005)
    .map(([accountId, r]) => {
      const a = accountsById.get(accountId);
      return {
        id: `${idPrefix}-${accountId}`,
        label: activityLineLabel(a, activity, r.amount),
        amount: r.amount,
        activity,
        accountIds: [accountId],
        journalEntryIds: [...r.entries],
        source: 'cash-journal-analysis' as const,
      } satisfies CashFlowLine;
    })
    .sort((x, y) => (accountsById.get(x.accountIds[0]!)?.code ?? '').localeCompare(accountsById.get(y.accountIds[0]!)?.code ?? ''));
}

function activityLineLabel(a: Account | undefined, activity: CounterpartActivity, amount: number): string {
  const name = a?.name ?? 'Unclassified';
  if (activity === 'investing') {
    if (/non-current|investment|intangible|property|equipment|goodwill/i.test(`${a?.ifrsCategory} ${a?.ifrsSubcategory} ${a?.name}`)) {
      return amount < 0 ? `Purchase of ${name.toLowerCase()}` : `Proceeds from ${name.toLowerCase()}`;
    }
  }
  if (activity === 'financing') {
    if (a?.type === 'EQUITY') return amount >= 0 ? `Proceeds from ${name.toLowerCase()}` : `${name}`;
    if (/borrowings|lease/i.test(a?.ifrsSubcategory ?? '')) return amount >= 0 ? `Proceeds from ${name.toLowerCase()}` : `Repayment of ${name.toLowerCase()}`;
  }
  return name;
}

/* ─────────────────────── Non-cash adjustments (operating) ────────────────── */

function periodMovement(accountId: string, entries: JournalEntry[], period: CashFlowPeriod, base: string, entityId?: string): number {
  let net = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.accountId !== accountId) continue;
    if (entry.entryDate < period.start || entry.entryDate > period.end) continue;
    if (entityId && line.entityId !== entityId) continue;
    net += convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base) - convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
  }
  return round2(net);
}

/** Add-back of genuine non-cash P&L items (depreciation, amortisation, impairment…). */
export function calculateNonCashAdjustments(accounts: Account[], entries: JournalEntry[], period: CashFlowPeriod, base: string, entityId?: string): CashFlowLine[] {
  const pnlTypes = new Set(['INCOME', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME_EXPENSE', 'FINANCE', 'TAX', 'DISCONTINUED_OPERATIONS']);
  const lines: CashFlowLine[] = [];
  for (const a of accounts) {
    if (!a.isPostingAccount || !pnlTypes.has(a.type)) continue;
    if (a.cashFlowCategory !== 'NON_CASH') continue;
    const net = periodMovement(a.id, entries, period, base, entityId); // expense debit-normal → +net
    if (Math.abs(net) < 0.005) continue;
    lines.push({
      id: `noncash-${a.id}`,
      label: a.name,
      amount: net, // add back (expense) / subtract (non-cash income has negative net)
      activity: 'operating',
      accountIds: [a.id],
      journalEntryIds: [],
      source: 'income-statement',
      isNonCash: true,
    });
  }
  return lines.sort((x, y) => x.label.localeCompare(y.label));
}

/* ─────────────────────── Working-capital changes (operating) ─────────────── */

function isOperatingWorkingCapital(a: Account, policy: CashFlowPolicy): boolean {
  if (!a.isPostingAccount) return false;
  if (a.type === 'ASSET') {
    if (isCashAccount(a)) return false;
    if (/non-current/i.test(a.ifrsCategory)) return false; // "current assets" is a substring of "non-current assets"
    if (!/current assets/i.test(a.ifrsCategory)) return false;
    if (/short-term investments/i.test(a.ifrsSubcategory)) return false; // investing
    return true;
  }
  if (a.type === 'LIABILITY') {
    if (/non-current/i.test(a.ifrsCategory)) return false;
    if (!/current liabilit/i.test(a.ifrsCategory)) return false;
    if (/borrowings|lease/i.test(a.ifrsSubcategory)) return false; // financing
    return true;
  }
  void policy;
  return false;
}

export function calculateWorkingCapitalChanges(accounts: Account[], entries: JournalEntry[], period: CashFlowPeriod, base: string, entityId: string | undefined, policy: CashFlowPolicy): CashFlowLine[] {
  const opening = selectPostedBalancesAsOf(entries, addDays(period.start, -1), base, entityId);
  const closing = selectPostedBalancesAsOf(entries, period.end, base, entityId);
  const lines: CashFlowLine[] = [];
  for (const a of accounts) {
    if (!isOperatingWorkingCapital(a, policy)) continue;
    const open = round2(opening.get(a.id) ?? 0);
    const close = round2(closing.get(a.id) ?? 0);
    const adj = round2(open - close); // universal: opening − closing (signed Dr) = cash effect
    if (Math.abs(adj) < 0.005 && Math.abs(open) < 0.005 && Math.abs(close) < 0.005) continue;
    if (Math.abs(adj) < 0.005) continue;
    const displayOpen = a.type === 'ASSET' ? open : -open;
    const displayClose = a.type === 'ASSET' ? close : -close;
    const increase = displayClose > displayOpen;
    lines.push({
      id: `wc-${a.id}`,
      label: `${increase ? 'Increase' : 'Decrease'} in ${a.name.toLowerCase()}`,
      amount: adj,
      activity: 'operating',
      accountIds: [a.id],
      journalEntryIds: [],
      source: 'balance-movement',
      isWorkingCapital: true,
    });
  }
  return lines.sort((x, y) => x.label.localeCompare(y.label));
}

/* ─────────────────────────────── Assemble ───────────────────────────────── */

const sum = (lines: CashFlowLine[]) => round2(lines.reduce((s, l) => s + l.amount, 0));

interface BuildOpts {
  periodStart: string;
  periodEnd: string;
  comparativePeriod?: CashFlowPeriod;
  entityId?: string;
  base: string;
  policy?: CashFlowPolicy;
}

interface CoreTotals {
  profit: number;
  nonCash: CashFlowLine[];
  wc: CashFlowLine[];
  investing: CashFlowLine[];
  financing: CashFlowLine[];
  netOperating: number;
  netInvesting: number;
  netFinancing: number;
  netChange: number;
  openingCash: number;
  closingCash: number;
  unclassified: CashClassifiedLine[];
}

function computeCore(accounts: Account[], entries: JournalEntry[], period: CashFlowPeriod, base: string, entityId: string | undefined, policy: CashFlowPolicy, cashIds: Set<string>, accountsById: Map<string, Account>): CoreTotals {
  const profit = round2(buildIncomeStatement(accounts, entries, { from: period.start, to: period.end }, base, { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false }).totals.netProfit);
  const nonCash = calculateNonCashAdjustments(accounts, entries, period, base, entityId);
  const wc = calculateWorkingCapitalChanges(accounts, entries, period, base, entityId, policy);
  const classified = classifyCashJournalLines(entries, cashIds, accountsById, period, base, entityId, policy);
  const investing = groupActivityLines(classified, 'investing', accountsById, 'inv');
  const financing = groupActivityLines(classified, 'financing', accountsById, 'fin');
  const unclassified = classified.filter((c) => c.activity === 'unclassified');
  const netOperating = round2(profit + sum(nonCash) + sum(wc));
  const netInvesting = sum(investing);
  const netFinancing = sum(financing);
  const netChange = round2(netOperating + netInvesting + netFinancing);
  const openingCash = calculateOpeningCash(entries, cashIds, period.start, base, entityId);
  const closingCash = calculateClosingCash(entries, cashIds, period.end, base, entityId);
  return { profit, nonCash, wc, investing, financing, netOperating, netInvesting, netFinancing, netChange, openingCash, closingCash, unclassified };
}

export function buildCashFlowStatement(accounts: Account[], entries: JournalEntry[], opts: BuildOpts): CashFlowStatement {
  const policy = opts.policy ?? DEFAULT_CASH_FLOW_POLICY;
  const period: CashFlowPeriod = { start: opts.periodStart, end: opts.periodEnd };
  const cashAccounts = selectCashAccounts(accounts);
  const cashIds = new Set(cashAccounts.map((a) => a.id));
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  const core = computeCore(accounts, entries, period, opts.base, opts.entityId, policy, cashIds, accountsById);

  const calculatedClosingCash = round2(core.openingCash + core.netChange);
  const balanceSheetClosingCash = core.closingCash;
  const reconciliationDifference = round2(calculatedClosingCash - balanceSheetClosingCash);
  const isReconciled = Math.abs(reconciliationDifference) < CASH_TOLERANCE;

  const unclassifiedItems: CashFlowWarning[] = core.unclassified.map((u) => ({
    id: `unclassified-${u.accountId}-${u.journalEntryId}`,
    severity: 'warning',
    message: `Cash movement of ${u.amount.toFixed(2)} could not be classified (${accountsById.get(u.accountId)?.code ?? u.accountId}).`,
    reference: accountsById.get(u.accountId)?.code,
  }));
  const warnings: CashFlowWarning[] = [...unclassifiedItems];
  if (!isReconciled) {
    warnings.unshift({ id: 'reconciliation', severity: 'error', message: `Cash-flow reconciliation difference of ${Math.abs(reconciliationDifference).toFixed(2)}.` });
  }

  const statement: CashFlowStatement = {
    entityId: opts.entityId ?? '',
    periodStart: period.start,
    periodEnd: period.end,
    comparativePeriod: opts.comparativePeriod,
    currency: opts.base,
    profitForPeriod: core.profit,
    nonCashAdjustments: core.nonCash,
    workingCapitalChanges: core.wc,
    cashGeneratedFromOperations: core.netOperating,
    taxesPaid: 0,
    interestPaid: 0,
    netOperatingCashFlow: core.netOperating,
    investingActivities: core.investing,
    netInvestingCashFlow: core.netInvesting,
    financingActivities: core.financing,
    netFinancingCashFlow: core.netFinancing,
    exchangeRateEffect: 0,
    netChangeInCash: core.netChange,
    openingCash: core.openingCash,
    calculatedClosingCash,
    balanceSheetClosingCash,
    reconciliationDifference,
    isReconciled,
    hasComparative: !!opts.comparativePeriod,
    unclassifiedItems,
    warnings,
  };

  if (opts.comparativePeriod) {
    const comp = computeCore(accounts, entries, opts.comparativePeriod, opts.base, opts.entityId, policy, cashIds, accountsById);
    statement.comparativeTotals = {
      profitForPeriod: comp.profit,
      netOperatingCashFlow: comp.netOperating,
      netInvestingCashFlow: comp.netInvesting,
      netFinancingCashFlow: comp.netFinancing,
      netChangeInCash: comp.netChange,
      openingCash: comp.openingCash,
      calculatedClosingCash: round2(comp.openingCash + comp.netChange),
    };
    // Attach comparative amounts to matching lines by id.
    const compById = new Map<string, number>();
    [...comp.nonCash, ...comp.wc, ...comp.investing, ...comp.financing].forEach((l) => compById.set(l.id, l.amount));
    [...statement.nonCashAdjustments, ...statement.workingCapitalChanges, ...statement.investingActivities, ...statement.financingActivities].forEach((l) => {
      l.comparativeAmount = compById.get(l.id) ?? 0;
    });
  }

  return statement;
}

export function validateCashFlowReconciliation(statement: CashFlowStatement, tolerance = CASH_TOLERANCE): boolean {
  return Math.abs(statement.reconciliationDifference) < tolerance;
}
