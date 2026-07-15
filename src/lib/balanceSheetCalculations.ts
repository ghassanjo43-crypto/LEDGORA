import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type {
  BalanceSheetAccountLine,
  BalanceSheetGroup,
  BalanceSheetLine,
  BalanceSheetOptions,
  BalanceSheetReport,
  BalanceSheetSection,
  BalanceSheetSide,
  ReportWarning,
} from '@/types/balanceSheet';
import { BALANCE_SHEET_TYPES } from '@/types/balanceSheet';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { buildIncomeStatement } from '@/lib/incomeStatementCalculations';

export const BALANCE_TOLERANCE = 0.01;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Most recent fiscal-year start (from an "MM-DD" setting) on or before `asOf`. */
export function fiscalYearStartDate(asOf: string, fiscalYearStart: string): string {
  const [mm, dd] = fiscalYearStart.split('-').map(Number);
  const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
  const year = new Date(asOfMs).getUTCFullYear();
  let start = Date.UTC(year, (mm || 1) - 1, dd || 1);
  if (start > asOfMs) start = Date.UTC(year - 1, (mm || 1) - 1, dd || 1);
  return new Date(start).toISOString().slice(0, 10);
}

export function isBalanceSheetAccount(a: Account): boolean {
  return BALANCE_SHEET_TYPES.includes(a.type);
}

/**
 * Signed base balance (posted debits − credits) per account, as at `asOfDate`,
 * optionally restricted to journal lines tagged to `entityId`.
 */
export function selectPostedBalancesAsOf(entries: JournalEntry[], asOfDate: string, base: string, entityId?: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (entry.entryDate > asOfDate) continue;
    if (entityId && line.entityId !== entityId) continue;
    const bd = convertToBaseCurrency(line.debit, entry.currency, entry.exchangeRate, base);
    const bc = convertToBaseCurrency(line.credit, entry.currency, entry.exchangeRate, base);
    map.set(line.accountId, (map.get(line.accountId) ?? 0) + bd - bc);
  }
  return map;
}

function sideOf(a: Account, signed: number): BalanceSheetSide | 'unclassified' {
  switch (a.type) {
    case 'ASSET':
      return 'asset';
    case 'LIABILITY':
      return 'liability';
    case 'EQUITY':
    case 'OCI':
      return 'equity';
    case 'CONTROL':
    default:
      return signed >= 0 ? 'asset' : 'liability';
  }
}

interface SectionKey { id: string; title: string; order: number }
function sectionOf(a: Account, side: BalanceSheetSide | 'unclassified'): SectionKey {
  const cat = a.ifrsCategory || '';
  if (side === 'asset') {
    if (/non-current/i.test(cat)) return { id: 'non-current-assets', title: 'Non-current assets', order: 1 };
    if (/current/i.test(cat)) return { id: 'current-assets', title: 'Current assets', order: 2 };
    return { id: 'unclassified-assets', title: 'Unclassified assets', order: 3 };
  }
  if (side === 'liability') {
    if (/non-current/i.test(cat)) return { id: 'non-current-liabilities', title: 'Non-current liabilities', order: 1 };
    if (/current/i.test(cat)) return { id: 'current-liabilities', title: 'Current liabilities', order: 2 };
    return { id: 'unclassified-liabilities', title: 'Unclassified liabilities', order: 3 };
  }
  return { id: 'equity', title: 'Equity', order: 1 };
}

export function detectAbnormal(a: Account, signed: number): { isAbnormal: boolean; side: '' | 'debit' | 'credit' } {
  if (Math.abs(signed) < 0.005) return { isAbnormal: false, side: '' };
  const side: 'debit' | 'credit' = signed > 0 ? 'debit' : 'credit';
  const normalSide = a.normalBalance === 'DEBIT' ? 'debit' : 'credit';
  return { isAbnormal: side !== normalSide, side };
}

/** Reuses the Income Statement engine — profit is never recomputed here. */
export function calculateCurrentPeriodProfit(accounts: Account[], entries: JournalEntry[], asOfDate: string, fiscalYearStart: string, base: string): number {
  const from = fiscalYearStartDate(asOfDate, fiscalYearStart);
  return buildIncomeStatement(accounts, entries, { from, to: asOfDate }, base, { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false }).totals.netProfit;
}

/** Unclosed profit or loss of periods before the current fiscal year. */
function retainedBroughtForward(accounts: Account[], entries: JournalEntry[], asOfDate: string, fiscalYearStart: string, base: string): number {
  const fyStart = fiscalYearStartDate(asOfDate, fiscalYearStart);
  const to = addDays(fyStart, -1);
  if (to < '0001-01-01') return 0;
  return buildIncomeStatement(accounts, entries, { from: '0000-01-01', to }, base, { presentation: 'IAS1', detail: 'summary', comparison: 'none', includeZero: false }).totals.netProfit;
}

function buildAccountLines(accounts: Account[], balances: Map<string, number>, comparative: Map<string, number>, includeZero: boolean): BalanceSheetAccountLine[] {
  const lines: BalanceSheetAccountLine[] = [];
  for (const a of accounts) {
    if (!isBalanceSheetAccount(a) || !a.isPostingAccount) continue;
    const signed = round2(balances.get(a.id) ?? 0);
    const compSigned = round2(comparative.get(a.id) ?? 0);
    if (Math.abs(signed) < 0.005 && Math.abs(compSigned) < 0.005 && !includeZero) continue;
    const side = sideOf(a, signed);
    const bsSide: BalanceSheetSide = side === 'unclassified' ? 'asset' : side;
    const currentAmount = round2(bsSide === 'asset' ? signed : -signed);
    const comparativeAmount = round2(bsSide === 'asset' ? compSigned : -compSigned);
    const ab = detectAbnormal(a, signed);
    lines.push({
      accountId: a.id,
      accountCode: a.code,
      accountName: a.name,
      accountType: a.type,
      normalBalance: a.normalBalance,
      side: bsSide,
      isContra: a.type === 'ASSET' && a.normalBalance === 'CREDIT',
      signed,
      currentAmount,
      comparativeAmount,
      isAbnormal: ab.isAbnormal,
      abnormalSide: ab.side,
    });
  }
  return lines;
}

function groupSection(id: string, title: string, accounts: Account[], accountLines: BalanceSheetAccountLine[]): BalanceSheetSection {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const groups = new Map<string, BalanceSheetAccountLine[]>();
  for (const l of accountLines) {
    const a = byId.get(l.accountId);
    const label = a?.ifrsSubcategory || a?.ifrsCategory || 'Other';
    groups.set(label, [...(groups.get(label) ?? []), l]);
  }
  const groupList: BalanceSheetGroup[] = [...groups.entries()]
    .map(([label, gl]) => {
      const sorted = gl.slice().sort((x, y) => x.accountCode.localeCompare(y.accountCode));
      return {
        id: `${id}-${label}`,
        label,
        accounts: sorted,
        subtotal: round2(sorted.reduce((s, x) => s + x.currentAmount, 0)),
        comparativeSubtotal: round2(sorted.reduce((s, x) => s + x.comparativeAmount, 0)),
      };
    })
    .sort((x, y) => (x.accounts[0]?.accountCode ?? '').localeCompare(y.accounts[0]?.accountCode ?? ''));
  return {
    id,
    title,
    groups: groupList,
    total: round2(groupList.reduce((s, g) => s + g.subtotal, 0)),
    comparativeTotal: round2(groupList.reduce((s, g) => s + g.comparativeSubtotal, 0)),
  };
}

function buildSections(side: 'asset' | 'liability' | 'equity', accounts: Account[], accountLines: BalanceSheetAccountLine[]): BalanceSheetSection[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const buckets = new Map<string, { key: SectionKey; lines: BalanceSheetAccountLine[] }>();
  for (const l of accountLines.filter((x) => x.side === side)) {
    const a = byId.get(l.accountId)!;
    const key = sectionOf(a, side);
    const b = buckets.get(key.id) ?? { key, lines: [] };
    b.lines.push(l);
    buckets.set(key.id, b);
  }
  return [...buckets.values()]
    .sort((x, y) => x.key.order - y.key.order)
    .map((b) => groupSection(b.key.id, b.key.title, accounts, b.lines));
}

/* ────────────────────────────── Flat lines ──────────────────────────────── */

function emitSectionLines(lines: BalanceSheetLine[], sections: BalanceSheetSection[], detail: boolean, hasComp: boolean, accountsById: Map<string, Account>): void {
  for (const section of sections) {
    lines.push({ id: `sec-${section.id}`, label: section.title, level: 0, lineType: 'section', currentAmount: 0 });
    for (const g of section.groups) {
      if (detail) {
        const multi = g.accounts.length > 1;
        if (multi) lines.push({ id: `grp-${g.id}`, label: g.label, level: 1, lineType: 'group', currentAmount: 0 });
        for (const acc of g.accounts) {
          const a = accountsById.get(acc.accountId);
          lines.push(mkLine(`acc-${acc.accountId}`, a?.isPostingAccount && acc.isContra ? `Less: ${acc.accountName}` : acc.accountName, multi ? 2 : 1, 'account', acc.currentAmount, hasComp ? acc.comparativeAmount : undefined, { accountIds: [acc.accountId], isContra: acc.isContra, isAbnormal: acc.isAbnormal, abnormalSide: acc.abnormalSide }));
        }
        if (multi) lines.push(mkLine(`grpsub-${g.id}`, `Total ${g.label.toLowerCase()}`, 1, 'subtotal', g.subtotal, hasComp ? g.comparativeSubtotal : undefined));
      } else {
        lines.push(mkLine(`grp-${g.id}`, g.label, 1, 'group', g.subtotal, hasComp ? g.comparativeSubtotal : undefined, { accountIds: g.accounts.map((x) => x.accountId) }));
      }
    }
    lines.push(mkLine(`secsub-${section.id}`, `Total ${section.title.toLowerCase()}`, 0, 'subtotal', section.total, hasComp ? section.comparativeTotal : undefined, { emphasis: 'normal' }));
  }
}

function mkLine(
  id: string,
  label: string,
  level: number,
  lineType: BalanceSheetLine['lineType'],
  currentAmount: number,
  comparativeAmount: number | undefined,
  extra: Partial<BalanceSheetLine> = {},
): BalanceSheetLine {
  const line: BalanceSheetLine = { id, label, level, lineType, currentAmount, ...extra };
  if (comparativeAmount !== undefined) {
    line.comparativeAmount = comparativeAmount;
    line.variance = round2(currentAmount - comparativeAmount);
    line.variancePercent = Math.abs(comparativeAmount) < 0.005 ? null : line.variance / Math.abs(comparativeAmount);
  }
  return line;
}

/* ────────────────────────────── Assemble ────────────────────────────────── */

export function buildBalanceSheet(accounts: Account[], entries: JournalEntry[], opts: BalanceSheetOptions): BalanceSheetReport {
  const { asOfDate, comparativeDate, entityId, base, fiscalYearStart, detail, includeZero } = opts;
  const hasComparative = !!comparativeDate;
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  const balances = selectPostedBalancesAsOf(entries, asOfDate, base, entityId || undefined);
  const comparative = comparativeDate ? selectPostedBalancesAsOf(entries, comparativeDate, base, entityId || undefined) : new Map<string, number>();

  const accountLines = buildAccountLines(accounts, balances, comparative, includeZero);

  const assets = buildSections('asset', accounts, accountLines);
  const liabilities = buildSections('liability', accounts, accountLines);
  const equity = buildSections('equity', accounts, accountLines);

  const totalAssets = round2(assets.reduce((s, x) => s + x.total, 0));
  const totalLiabilities = round2(liabilities.reduce((s, x) => s + x.total, 0));
  const realEquity = round2(equity.reduce((s, x) => s + x.total, 0));

  const currentPeriodProfit = round2(calculateCurrentPeriodProfit(accounts, entries, asOfDate, fiscalYearStart, base));
  const retainedEarningsBroughtForward = round2(retainedBroughtForward(accounts, entries, asOfDate, fiscalYearStart, base));
  const totalEquity = round2(realEquity + currentPeriodProfit + retainedEarningsBroughtForward);
  const totalEquityAndLiabilities = round2(totalEquity + totalLiabilities);
  const difference = round2(totalAssets - totalEquityAndLiabilities);
  const isBalanced = Math.abs(difference) < BALANCE_TOLERANCE;

  // Comparative counterparts
  const compProfit = comparativeDate ? round2(calculateCurrentPeriodProfit(accounts, entries, comparativeDate, fiscalYearStart, base)) : 0;
  const compRetained = comparativeDate ? round2(retainedBroughtForward(accounts, entries, comparativeDate, fiscalYearStart, base)) : 0;
  const compRealEquity = round2(equity.reduce((s, x) => s + x.comparativeTotal, 0));
  const compAssets = round2(assets.reduce((s, x) => s + x.comparativeTotal, 0));
  const compLiab = round2(liabilities.reduce((s, x) => s + x.comparativeTotal, 0));
  const compEquity = round2(compRealEquity + compProfit + compRetained);

  /* Flat lines */
  const lines: BalanceSheetLine[] = [];
  lines.push({ id: 'hdr-assets', label: 'Assets', level: 0, lineType: 'total', currentAmount: 0, emphasis: 'strong' });
  emitSectionLines(lines, assets, detail, hasComparative, accountsById);
  lines.push(mkLine('total-assets', 'Total assets', 0, 'total', totalAssets, hasComparative ? compAssets : undefined, { emphasis: 'strong' }));
  lines.push({ id: 'spacer-1', label: '', level: 0, lineType: 'spacer', currentAmount: 0 });
  lines.push({ id: 'hdr-eql', label: 'Equity and liabilities', level: 0, lineType: 'total', currentAmount: 0, emphasis: 'strong' });

  // Equity — real accounts + synthetic retained/current-period lines
  lines.push({ id: 'sec-equity', label: 'Equity', level: 0, lineType: 'section', currentAmount: 0 });
  for (const section of equity) {
    for (const g of section.groups) {
      if (detail) {
        for (const acc of g.accounts) lines.push(mkLine(`acc-${acc.accountId}`, acc.accountName, 1, 'account', acc.currentAmount, hasComparative ? acc.comparativeAmount : undefined, { accountIds: [acc.accountId], isAbnormal: acc.isAbnormal, abnormalSide: acc.abnormalSide }));
      } else {
        lines.push(mkLine(`grp-${g.id}`, g.label, 1, 'group', g.subtotal, hasComparative ? g.comparativeSubtotal : undefined, { accountIds: g.accounts.map((x) => x.accountId) }));
      }
    }
  }
  lines.push(mkLine('eq-retained-bf', 'Retained earnings brought forward', 1, 'account', retainedEarningsBroughtForward, hasComparative ? compRetained : undefined, { isSynthetic: true }));
  lines.push(mkLine('eq-current-profit', currentPeriodProfit < 0 ? 'Current-period loss' : 'Current-period profit', 1, 'account', currentPeriodProfit, hasComparative ? compProfit : undefined, { isSynthetic: true }));
  lines.push(mkLine('total-equity', 'Total equity', 0, 'subtotal', totalEquity, hasComparative ? compEquity : undefined, { emphasis: 'normal' }));

  emitSectionLines(lines, liabilities, detail, hasComparative, accountsById);
  lines.push(mkLine('total-liabilities', 'Total liabilities', 0, 'subtotal', totalLiabilities, hasComparative ? compLiab : undefined, { emphasis: 'normal' }));
  lines.push(mkLine('total-eql', 'Total equity and liabilities', 0, 'grand-total', totalEquityAndLiabilities, hasComparative ? round2(compEquity + compLiab) : undefined, { emphasis: 'final' }));

  const report: BalanceSheetReport = {
    entityId,
    asOfDate,
    comparativeDate,
    currency: base,
    assets,
    equity,
    liabilities,
    totalAssets,
    totalEquity,
    totalLiabilities,
    totalEquityAndLiabilities,
    difference,
    isBalanced,
    currentPeriodProfit,
    retainedEarningsBroughtForward,
    hasComparative,
    warnings: [],
    lines,
  };
  if (hasComparative) {
    report.comparativeTotals = {
      totalAssets: compAssets,
      totalEquity: compEquity,
      totalLiabilities: compLiab,
      totalEquityAndLiabilities: round2(compEquity + compLiab),
      difference: round2(compAssets - (compEquity + compLiab)),
      currentPeriodProfit: compProfit,
      retainedEarningsBroughtForward: compRetained,
    };
  }
  report.warnings = validateBalanceSheet(report, accountLines, accounts);
  return report;
}

export function calculateBalanceSheetTotals(report: BalanceSheetReport) {
  return {
    totalAssets: report.totalAssets,
    totalEquity: report.totalEquity,
    totalLiabilities: report.totalLiabilities,
    totalEquityAndLiabilities: report.totalEquityAndLiabilities,
    difference: report.difference,
    isBalanced: report.isBalanced,
  };
}

export function validateBalanceSheet(report: BalanceSheetReport, accountLines: BalanceSheetAccountLine[], accounts: Account[]): ReportWarning[] {
  const warnings: ReportWarning[] = [];
  if (!report.isBalanced) {
    warnings.push({ id: 'out-of-balance', severity: 'error', message: `Balance sheet is out of balance by ${Math.abs(report.difference).toFixed(2)}.` });
  }
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const l of accountLines) {
    if (l.isAbnormal) {
      warnings.push({ id: `abn-${l.accountId}`, severity: 'warning', message: `${l.accountCode} — ${l.accountName} has an abnormal ${l.abnormalSide} balance.`, accountCode: l.accountCode });
    }
    const a = byId.get(l.accountId);
    if (a && !a.ifrsCategory) {
      warnings.push({ id: `unclassified-${l.accountId}`, severity: 'warning', message: `${l.accountCode} — ${l.accountName} lacks an IFRS classification and needs review.`, accountCode: l.accountCode });
    }
  }
  return warnings;
}
