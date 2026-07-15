import type { Account, NormalBalance } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type {
  ComparisonMode,
  DetailLevel,
  IncomeStatementAccountAmount,
  IncomeStatementException,
  IncomeStatementLine,
  IncomeStatementMargins,
  IncomeStatementResult,
  IncomeStatementSection,
  IncomeStatementTotals,
  PresentationMode,
  StatementPeriod,
} from '@/types/incomeStatement';
import { PROFIT_OR_LOSS_TYPES } from '@/types/incomeStatement';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';

export const FINANCIAL_STATEMENT_TOLERANCE = 0.01;
export const convertToBaseCurrency2 = convertToBaseCurrency;
export { getPostedJournalLines };

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** True when an account participates in the primary statement of profit or loss. */
export function isProfitOrLossAccount(a: Account): boolean {
  return PROFIT_OR_LOSS_TYPES.includes(a.type);
}

/* ───────────────────── Section classification (IAS 1) ───────────────────── */

const INCOME_SIDE_SECTIONS = new Set<IncomeStatementSection>(['revenue', 'otherIncome', 'financeIncome', 'discontinued']);

export function classifyIncomeStatementSection(a: Account): IncomeStatementSection {
  switch (a.type) {
    case 'INCOME':
      return 'revenue';
    case 'COST_OF_SALES':
      return 'costOfSales';
    case 'OPERATING_EXPENSE':
      return 'operatingExpenses';
    case 'OTHER_INCOME_EXPENSE':
      return a.normalBalance === 'CREDIT' ? 'otherIncome' : 'otherExpenses';
    case 'FINANCE':
      return a.normalBalance === 'CREDIT' ? 'financeIncome' : 'financeCosts';
    case 'TAX':
      return 'incomeTax';
    case 'DISCONTINUED_OPERATIONS':
      return 'discontinued';
    default:
      return 'operatingExpenses';
  }
}

/** Report display amount: income-side sections use credits−debits, expense-side debits−credits. */
export function normalizeIncomeStatementAmount(net: number, section: IncomeStatementSection): number {
  return INCOME_SIDE_SECTIONS.has(section) ? -net : net;
}

/**
 * Convenience matching the spec signature: convert a net (debits−credits) to a
 * presentation amount using the account's normal balance.
 */
export function getProfitOrLossDisplayAmount(netDebitMinusCredit: number, normalBalance: NormalBalance): number {
  return normalBalance === 'CREDIT' ? -netDebitMinusCredit : netDebitMinusCredit;
}

/* ─────────────────────────── Period activity ────────────────────────────── */

export function getPostedProfitOrLossLines(entries: JournalEntry[], accounts: Account[]) {
  const plIds = new Set(accounts.filter(isProfitOrLossAccount).map((a) => a.id));
  return getPostedJournalLines(entries).filter(({ line }) => plIds.has(line.accountId));
}

/** period debits/credits/net (base) for one account, posted only, within [from,to]. */
export function calculateAccountPeriodAmount(accountId: string, entries: JournalEntry[], period: StatementPeriod, base: string): { periodDebit: number; periodCredit: number; net: number } {
  let periodDebit = 0;
  let periodCredit = 0;
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (line.accountId !== accountId) continue;
    if (entry.entryDate < period.from || entry.entryDate > period.to) continue;
    periodDebit += convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    periodCredit += convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
  }
  periodDebit = round2(periodDebit);
  periodCredit = round2(periodCredit);
  return { periodDebit, periodCredit, net: round2(periodDebit - periodCredit) };
}

/** Net (debits−credits) per P&L account across a period, in one pass. */
function netByAccount(entries: JournalEntry[], plIds: Set<string>, period: StatementPeriod, base: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (!plIds.has(line.accountId)) continue;
    if (entry.entryDate < period.from || entry.entryDate > period.to) continue;
    const bd = convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    const bc = convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
    map.set(line.accountId, (map.get(line.accountId) ?? 0) + bd - bc);
  }
  return map;
}

/** Build per-account amounts for current + comparative periods. */
export function buildAccountAmounts(accounts: Account[], entries: JournalEntry[], period: StatementPeriod, comparative: StatementPeriod | null, base: string): IncomeStatementAccountAmount[] {
  const plAccounts = accounts.filter(isProfitOrLossAccount);
  const plIds = new Set(plAccounts.map((a) => a.id));
  const cur = netByAccount(entries, plIds, period, base);
  const cmp = comparative ? netByAccount(entries, plIds, comparative, base) : new Map<string, number>();

  return plAccounts.map((a) => {
    const section = classifyIncomeStatementSection(a);
    const net = round2(cur.get(a.id) ?? 0);
    const compNet = round2(cmp.get(a.id) ?? 0);
    return {
      accountId: a.id,
      accountCode: a.code,
      accountName: a.name,
      ifrsCategory: a.ifrsCategory || 'Uncategorised',
      ifrsSubcategory: a.ifrsSubcategory || '',
      profitOrLossCategory: a.profitOrLossCategory ?? 'NOT_APPLICABLE',
      section,
      net,
      contribution: round2(-net),
      currentAmount: round2(normalizeIncomeStatementAmount(net, section)),
      comparativeAmount: round2(normalizeIncomeStatementAmount(compNet, section)),
    } satisfies IncomeStatementAccountAmount;
  });
}

/* ───────────────────────── Section & profit totals ──────────────────────── */

const sumBy = (amts: IncomeStatementAccountAmount[], section: IncomeStatementSection, key: 'currentAmount' | 'comparativeAmount'): number =>
  round2(amts.filter((a) => a.section === section).reduce((s, a) => s + a[key], 0));

function totalsFor(amts: IncomeStatementAccountAmount[], key: 'currentAmount' | 'comparativeAmount'): IncomeStatementTotals {
  const revenue = sumBy(amts, 'revenue', key);
  const costOfSales = sumBy(amts, 'costOfSales', key);
  const grossProfit = round2(revenue - costOfSales);
  const operatingExpenses = sumBy(amts, 'operatingExpenses', key);
  const operatingProfit = round2(grossProfit - operatingExpenses);
  const otherIncome = sumBy(amts, 'otherIncome', key);
  const otherExpenses = sumBy(amts, 'otherExpenses', key);
  const financeIncome = sumBy(amts, 'financeIncome', key);
  const financeCosts = sumBy(amts, 'financeCosts', key);
  const profitBeforeTax = round2(operatingProfit + otherIncome - otherExpenses + financeIncome - financeCosts);
  const incomeTax = sumBy(amts, 'incomeTax', key);
  const profitFromContinuing = round2(profitBeforeTax - incomeTax);
  const discontinued = sumBy(amts, 'discontinued', key);
  const netProfit = round2(profitFromContinuing + discontinued);
  return { revenue, costOfSales, grossProfit, operatingExpenses, operatingProfit, otherIncome, otherExpenses, financeIncome, financeCosts, profitBeforeTax, incomeTax, profitFromContinuing, discontinued, netProfit };
}

export const calculateRevenue = (a: IncomeStatementAccountAmount[]) => sumBy(a, 'revenue', 'currentAmount');
export const calculateCostOfSales = (a: IncomeStatementAccountAmount[]) => sumBy(a, 'costOfSales', 'currentAmount');
export const calculateGrossProfit = (a: IncomeStatementAccountAmount[]) => round2(calculateRevenue(a) - calculateCostOfSales(a));
export const calculateOperatingExpenses = (a: IncomeStatementAccountAmount[]) => sumBy(a, 'operatingExpenses', 'currentAmount');
export const calculateOperatingProfit = (a: IncomeStatementAccountAmount[]) => round2(calculateGrossProfit(a) - calculateOperatingExpenses(a));
export const calculateFinanceIncome = (a: IncomeStatementAccountAmount[]) => sumBy(a, 'financeIncome', 'currentAmount');
export const calculateFinanceCosts = (a: IncomeStatementAccountAmount[]) => sumBy(a, 'financeCosts', 'currentAmount');
export const calculateIncomeTaxExpense = (a: IncomeStatementAccountAmount[]) => sumBy(a, 'incomeTax', 'currentAmount');
export const calculateProfitBeforeTax = (a: IncomeStatementAccountAmount[]) => totalsFor(a, 'currentAmount').profitBeforeTax;
export const calculateNetProfit = (a: IncomeStatementAccountAmount[]) => totalsFor(a, 'currentAmount').netProfit;

export function calculateMargins(t: IncomeStatementTotals): IncomeStatementMargins {
  const m = (n: number): number | null => (Math.abs(t.revenue) < 0.005 ? null : n / t.revenue);
  return { grossMargin: m(t.grossProfit), operatingMargin: m(t.operatingProfit), netMargin: m(t.netProfit) };
}

export function calculateComparativeVariance(current: number, comparative: number): { variance: number; variancePercent: number | null } {
  const variance = round2(current - comparative);
  const variancePercent = Math.abs(comparative) < 0.005 ? null : variance / Math.abs(comparative);
  return { variance, variancePercent };
}

/* ──────────────────────────── Grouping helpers ──────────────────────────── */

export function groupAccountsByIFRSCategory(amts: IncomeStatementAccountAmount[]): { category: string; accounts: IncomeStatementAccountAmount[] }[] {
  const map = new Map<string, IncomeStatementAccountAmount[]>();
  for (const a of amts) map.set(a.ifrsCategory, [...(map.get(a.ifrsCategory) ?? []), a]);
  return [...map.entries()]
    .map(([category, accounts]) => ({ category, accounts: accounts.slice().sort((x, y) => x.accountCode.localeCompare(y.accountCode)) }))
    .sort((x, y) => (x.accounts[0]?.accountCode ?? '').localeCompare(y.accounts[0]?.accountCode ?? ''));
}

/* ─────────────────────────── Statement builder ──────────────────────────── */

interface SectionMeta {
  section: IncomeStatementSection;
  label: string;
  totalLabel: string;
}
const SECTION_META: Record<IncomeStatementSection, SectionMeta> = {
  revenue: { section: 'revenue', label: 'Revenue', totalLabel: 'Total revenue' },
  costOfSales: { section: 'costOfSales', label: 'Cost of sales', totalLabel: 'Total cost of sales' },
  operatingExpenses: { section: 'operatingExpenses', label: 'Operating expenses', totalLabel: 'Total operating expenses' },
  otherIncome: { section: 'otherIncome', label: 'Other income', totalLabel: 'Total other income' },
  otherExpenses: { section: 'otherExpenses', label: 'Other expenses', totalLabel: 'Total other expenses' },
  financeIncome: { section: 'financeIncome', label: 'Finance income', totalLabel: 'Total finance income' },
  financeCosts: { section: 'financeCosts', label: 'Finance costs', totalLabel: 'Total finance costs' },
  incomeTax: { section: 'incomeTax', label: 'Income tax expense', totalLabel: 'Total income tax expense' },
  discontinued: { section: 'discontinued', label: 'Discontinued operations', totalLabel: 'Total discontinued operations' },
};

function pctOfRevenue(amount: number, revenue: number): number | null {
  return Math.abs(revenue) < 0.005 ? null : amount / revenue;
}

function makeLine(partial: Omit<IncomeStatementLine, 'variance' | 'variancePercent'> & { comparativeAmount?: number }): IncomeStatementLine {
  const line: IncomeStatementLine = { ...partial };
  if (partial.comparativeAmount !== undefined) {
    const { variance, variancePercent } = calculateComparativeVariance(partial.currentAmount, partial.comparativeAmount);
    line.variance = variance;
    line.variancePercent = variancePercent;
  }
  return line;
}

function subtotalLine(id: string, label: string, current: number, comparative: number | undefined, revenue: number, emphasis: IncomeStatementLine['emphasis']): IncomeStatementLine {
  return makeLine({ id, label, level: 0, lineType: 'subtotal', currentAmount: current, comparativeAmount: comparative, percentageOfRevenue: pctOfRevenue(current, revenue), emphasis });
}

/** IAS 1 statement of profit or loss (default presentation). */
function buildIas1Lines(amts: IncomeStatementAccountAmount[], totals: IncomeStatementTotals, comp: IncomeStatementTotals | null, detail: DetailLevel, includeZero: boolean): IncomeStatementLine[] {
  const lines: IncomeStatementLine[] = [];
  const revenue = totals.revenue;
  const hasComp = comp !== null;
  const sectionTotal = (s: IncomeStatementSection, key: 'currentAmount' | 'comparativeAmount') => sumBy(amts, s, key);

  const pushSection = (meta: SectionMeta): void => {
    const secAccounts = amts.filter((a) => a.section === meta.section);
    const total = sectionTotal(meta.section, 'currentAmount');
    const compTotal = sectionTotal(meta.section, 'comparativeAmount');
    const empty = Math.abs(total) < 0.005 && Math.abs(compTotal) < 0.005;
    if (empty && !includeZero) return;
    if (secAccounts.length === 0 && !includeZero) return;

    lines.push({ id: `sec-${meta.section}`, label: meta.label, level: 0, lineType: 'section', currentAmount: 0 });

    if (detail !== 'summary') {
      const groups = groupAccountsByIFRSCategory(secAccounts);
      for (const g of groups) {
        const catCur = round2(g.accounts.reduce((s, a) => s + a.currentAmount, 0));
        const catCmp = round2(g.accounts.reduce((s, a) => s + a.comparativeAmount, 0));
        if (Math.abs(catCur) < 0.005 && Math.abs(catCmp) < 0.005 && !includeZero) continue;
        if (detail === 'detailed') {
          lines.push({ id: `cat-${meta.section}-${g.category}`, label: g.category, level: 1, lineType: 'category', currentAmount: 0 });
          for (const a of g.accounts) {
            if (Math.abs(a.currentAmount) < 0.005 && Math.abs(a.comparativeAmount) < 0.005 && !includeZero) continue;
            lines.push(makeLine({
              id: `acc-${a.accountId}`,
              label: `${a.accountCode} · ${a.accountName}`,
              level: 2,
              lineType: 'account',
              currentAmount: a.currentAmount,
              comparativeAmount: hasComp ? a.comparativeAmount : undefined,
              percentageOfRevenue: pctOfRevenue(a.currentAmount, revenue),
              accountIds: [a.accountId],
            }));
          }
        } else {
          // standard: one line per category
          lines.push(makeLine({
            id: `cat-${meta.section}-${g.category}`,
            label: g.category,
            level: 1,
            lineType: 'category',
            currentAmount: catCur,
            comparativeAmount: hasComp ? catCmp : undefined,
            percentageOfRevenue: pctOfRevenue(catCur, revenue),
            accountIds: g.accounts.map((a) => a.accountId),
          }));
        }
      }
    }

    lines.push(makeLine({
      id: `total-${meta.section}`,
      label: meta.totalLabel,
      level: 0,
      lineType: 'subtotal',
      currentAmount: total,
      comparativeAmount: hasComp ? compTotal : undefined,
      percentageOfRevenue: pctOfRevenue(total, revenue),
      emphasis: 'normal',
    }));
  };

  const compT = (k: keyof IncomeStatementTotals) => (comp ? comp[k] : undefined);

  pushSection(SECTION_META.revenue);
  pushSection(SECTION_META.costOfSales);
  lines.push(subtotalLine('gross-profit', 'Gross profit', totals.grossProfit, compT('grossProfit'), revenue, 'strong'));
  pushSection(SECTION_META.operatingExpenses);
  lines.push(subtotalLine('operating-profit', 'Operating profit', totals.operatingProfit, compT('operatingProfit'), revenue, 'strong'));
  pushSection(SECTION_META.otherIncome);
  pushSection(SECTION_META.otherExpenses);
  pushSection(SECTION_META.financeIncome);
  pushSection(SECTION_META.financeCosts);
  lines.push(subtotalLine('profit-before-tax', 'Profit before tax', totals.profitBeforeTax, compT('profitBeforeTax'), revenue, 'strong'));
  pushSection(SECTION_META.incomeTax);
  lines.push(subtotalLine('profit-continuing', 'Profit from continuing operations', totals.profitFromContinuing, compT('profitFromContinuing'), revenue, 'normal'));
  const hasDiscontinued = amts.some((a) => a.section === 'discontinued');
  if (hasDiscontinued || includeZero) pushSection(SECTION_META.discontinued);
  lines.push(subtotalLine('net-profit', totals.netProfit < 0 ? 'Net loss for the period' : 'Net profit for the period', totals.netProfit, compT('netProfit'), revenue, 'final'));

  return lines;
}

/* ─────────────────────────── IFRS 18 grouping ───────────────────────────── */

const IFRS18_GROUPS: { key: IncomeStatementAccountAmount['profitOrLossCategory']; label: string }[] = [
  { key: 'OPERATING', label: 'Operating' },
  { key: 'INVESTING', label: 'Investing' },
  { key: 'FINANCING', label: 'Financing' },
  { key: 'INCOME_TAXES', label: 'Income taxes' },
  { key: 'DISCONTINUED_OPERATIONS', label: 'Discontinued operations' },
];

/** IFRS 18 ready presentation grouped by profitOrLossCategory (uses contributions). */
function buildIfrs18Lines(amts: IncomeStatementAccountAmount[], detail: DetailLevel, includeZero: boolean, revenue: number, hasComp: boolean): IncomeStatementLine[] {
  const lines: IncomeStatementLine[] = [];
  // comparativeAmount is stored as section magnitude; recover the profit
  // contribution (credits − debits) via the section's natural side.
  const contributionComparative = (a: IncomeStatementAccountAmount): number =>
    INCOME_SIDE_SECTIONS.has(a.section) ? a.comparativeAmount : -a.comparativeAmount;
  const curContribution = (cat: IncomeStatementAccountAmount['profitOrLossCategory']) => round2(amts.filter((a) => a.profitOrLossCategory === cat).reduce((s, a) => s + a.contribution, 0));
  const cmpContribution = (cat: IncomeStatementAccountAmount['profitOrLossCategory']) => round2(amts.filter((a) => a.profitOrLossCategory === cat).reduce((s, a) => s + contributionComparative(a), 0));

  let runningCur = 0;
  let runningCmp = 0;
  const emit = (id: string, label: string, cur: number, cmp: number, level: number, type: IncomeStatementLine['lineType'], emphasis?: IncomeStatementLine['emphasis'], accountIds?: string[]) => {
    lines.push(makeLine({ id, label, level, lineType: type, currentAmount: cur, comparativeAmount: hasComp ? cmp : undefined, percentageOfRevenue: pctOfRevenue(cur, revenue), emphasis, accountIds }));
  };

  for (const grp of IFRS18_GROUPS) {
    const groupAccounts = amts.filter((a) => a.profitOrLossCategory === grp.key);
    const cur = curContribution(grp.key);
    const cmp = cmpContribution(grp.key);
    if (groupAccounts.length === 0 && Math.abs(cur) < 0.005 && !includeZero) continue;
    lines.push({ id: `ifrs18-sec-${grp.key}`, label: grp.label, level: 0, lineType: 'section', currentAmount: 0 });
    if (detail !== 'summary') {
      const groups = groupAccountsByIFRSCategory(groupAccounts);
      for (const g of groups) {
        if (detail === 'detailed') {
          for (const a of g.accounts) {
            if (Math.abs(a.contribution) < 0.005 && !includeZero) continue;
            emit(`ifrs18-acc-${a.accountId}`, `${a.accountCode} · ${a.accountName}`, a.contribution, contributionComparative(a), 1, 'account', undefined, [a.accountId]);
          }
        } else {
          const catCur = round2(g.accounts.reduce((s, a) => s + a.contribution, 0));
          const catCmp = round2(g.accounts.reduce((s, a) => s + contributionComparative(a), 0));
          if (Math.abs(catCur) < 0.005 && !includeZero) continue;
          emit(`ifrs18-cat-${grp.key}-${g.category}`, g.category, catCur, catCmp, 1, 'category', undefined, g.accounts.map((a) => a.accountId));
        }
      }
    }
    emit(`ifrs18-total-${grp.key}`, `${grp.label} result`, cur, cmp, 0, 'subtotal', 'normal');

    runningCur = round2(runningCur + cur);
    runningCmp = round2(runningCmp + cmp);
    if (grp.key === 'INVESTING') emit('ifrs18-pbfit', 'Profit before financing and income taxes', runningCur, runningCmp, 0, 'subtotal', 'strong');
    if (grp.key === 'FINANCING') emit('ifrs18-pbt', 'Profit before tax', runningCur, runningCmp, 0, 'subtotal', 'strong');
    if (grp.key === 'INCOME_TAXES') emit('ifrs18-continuing', 'Profit from continuing operations', runningCur, runningCmp, 0, 'subtotal', 'normal');
  }
  emit('ifrs18-net', runningCur < 0 ? 'Net loss for the period' : 'Net profit for the period', runningCur, runningCmp, 0, 'subtotal', 'final');
  return lines;
}

/* ────────────────────────────── Exceptions ──────────────────────────────── */

export function detectMissingMappings(accounts: Account[], entries: JournalEntry[], period: StatementPeriod, base: string, ifrs18: boolean): IncomeStatementException[] {
  const issues: IncomeStatementException[] = [];
  const plIds = new Set(accounts.filter(isProfitOrLossAccount).map((a) => a.id));
  const nets = netByAccount(entries, plIds, period, base);
  for (const a of accounts) {
    if (!isProfitOrLossAccount(a)) continue;
    const net = round2(nets.get(a.id) ?? 0);
    if (Math.abs(net) < 0.005) continue; // only material, active accounts
    const push = (missing: string, severity: IncomeStatementException['severity'] = 'warning') =>
      issues.push({ id: `${missing}-${a.id}`, severity, message: `${a.code} — ${a.name} has period activity but is missing ${missing}.`, accountCode: a.code, accountName: a.name, amount: round2(-net), missing });
    if (!a.ifrsCategory) push('an IFRS category');
    if (a.normalBalance !== 'DEBIT' && a.normalBalance !== 'CREDIT') push('a normal balance', 'error');
    if (ifrs18 && (!a.profitOrLossCategory || a.profitOrLossCategory === 'NOT_APPLICABLE')) push('an IFRS 18 category');
  }
  return issues;
}

/* ──────────────────────── Comparative period resolver ────────────────────── */

function shiftYears(date: string, years: number): string {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}
function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayDiff(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

export function resolveComparativePeriod(period: StatementPeriod, mode: ComparisonMode): StatementPeriod | null {
  if (mode === 'none') return null;
  switch (mode) {
    case 'previous-year':
    case 'previous-ytd':
      return { from: shiftYears(period.from, 1), to: shiftYears(period.to, 1) };
    case 'previous-month':
      return { from: (() => { const d = new Date(period.from); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); })(), to: addDays(period.from, -1) };
    case 'previous-quarter':
      return { from: (() => { const d = new Date(period.from); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); })(), to: addDays(period.from, -1) };
    case 'previous-period':
    default: {
      const len = dayDiff(period.from, period.to);
      const to = addDays(period.from, -1);
      return { from: addDays(to, -len), to };
    }
  }
}

/* ─────────────────────────────── Assemble ───────────────────────────────── */

export function buildIncomeStatement(
  accounts: Account[],
  entries: JournalEntry[],
  period: StatementPeriod,
  base: string,
  opts: { presentation: PresentationMode; detail: DetailLevel; comparison: ComparisonMode; includeZero: boolean },
): IncomeStatementResult {
  const comparative = resolveComparativePeriod(period, opts.comparison);
  const hasComparative = comparative !== null;
  const amounts = buildAccountAmounts(accounts, entries, period, comparative, base);
  const totals = totalsFor(amounts, 'currentAmount');
  const comparativeTotals = totalsFor(amounts, 'comparativeAmount');
  const margins = calculateMargins(totals);
  const comparativeMargins = calculateMargins(comparativeTotals);
  const exceptions = detectMissingMappings(accounts, entries, period, base, opts.presentation === 'IFRS18');

  const lines = opts.presentation === 'IFRS18'
    ? buildIfrs18Lines(amounts, opts.detail, opts.includeZero, totals.revenue, hasComparative)
    : buildIas1Lines(amounts, totals, hasComparative ? comparativeTotals : null, opts.detail, opts.includeZero);

  return { lines, totals, comparativeTotals, margins, comparativeMargins, amounts, exceptions, hasComparative };
}

export function filterIncomeStatementAccounts(amts: IncomeStatementAccountAmount[], includeZero: boolean): IncomeStatementAccountAmount[] {
  return includeZero ? amts : amts.filter((a) => Math.abs(a.currentAmount) >= 0.005 || Math.abs(a.comparativeAmount) >= 0.005);
}

/* ────────────────────────── Dev reconciliation ──────────────────────────── */

/** Net profit must equal Σ(credits − debits) over all posted P&L period lines. */
export function reconcileIncomeStatement(accounts: Account[], entries: JournalEntry[], period: StatementPeriod, base: string, tolerance = FINANCIAL_STATEMENT_TOLERANCE): { ok: boolean; netProfit: number; ledgerNet: number; difference: number } {
  const amounts = buildAccountAmounts(accounts, entries, period, null, base);
  const netProfit = totalsFor(amounts, 'currentAmount').netProfit;
  const plIds = new Set(accounts.filter(isProfitOrLossAccount).map((a) => a.id));
  const nets = netByAccount(entries, plIds, period, base);
  let ledgerNet = 0;
  for (const v of nets.values()) ledgerNet += -v; // credits − debits
  ledgerNet = round2(ledgerNet);
  const difference = round2(netProfit - ledgerNet);
  return { ok: Math.abs(difference) < tolerance, netProfit, ledgerNet, difference };
}
