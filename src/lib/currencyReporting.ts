import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { EntityCurrencyConfig } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { selectForeignBalances } from '@/lib/currencyRevaluation';
import { resolveExchangeRate } from '@/lib/exchangeRateResolution';
import { roundTo } from '@/lib/currencyConversion';

/* ─────────────────────────── FX gain/loss report ─────────────────────────── */

export interface FxRow {
  id: string;
  date: string;
  kind: 'realized' | 'unrealized';
  currency: string;
  documentNumber: string;
  gain: number;
  loss: number;
  net: number;
  journalEntryId: string;
}

export interface FxByCurrency {
  currency: string;
  realizedGain: number;
  realizedLoss: number;
  unrealizedGain: number;
  unrealizedLoss: number;
  net: number;
}

export interface FxGainLossReport {
  realizedGain: number;
  realizedLoss: number;
  unrealizedGain: number;
  unrealizedLoss: number;
  netFx: number;
  byCurrency: FxByCurrency[];
  rows: FxRow[];
}

export interface FxReportParams {
  entries: JournalEntry[];
  config: EntityCurrencyConfig;
  baseCurrency: string;
  from?: string;
  to?: string;
}

/** The set of FX account ids from the entity config. */
export function fxAccountIds(config: EntityCurrencyConfig): Set<string> {
  return new Set([config.realizedFxGainAccountId, config.realizedFxLossAccountId, config.unrealizedFxGainAccountId, config.unrealizedFxLossAccountId].filter(Boolean) as string[]);
}

/**
 * Build the FX gain/loss report from posted journal lines hitting the FX
 * accounts. A credit to an FX account is a gain, a debit is a loss; entries of
 * type "FX Revaluation" are unrealized, all others realized (§35).
 */
export function buildFxGainLossReport(params: FxReportParams): FxGainLossReport {
  const ids = fxAccountIds(params.config);
  const rows: FxRow[] = [];
  for (const { entry, line } of getPostedJournalLines(params.entries)) {
    if (!ids.has(line.accountId)) continue;
    if (params.from && entry.entryDate < params.from) continue;
    if (params.to && entry.entryDate > params.to) continue;
    const debit = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, params.baseCurrency);
    const credit = convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, params.baseCurrency);
    const gain = roundTo(credit, 2);
    const loss = roundTo(debit, 2);
    if (gain === 0 && loss === 0) continue;
    const kind = entry.transactionType === 'FX Revaluation' ? 'unrealized' : 'realized';
    rows.push({ id: line.id, date: entry.entryDate, kind, currency: entry.currency, documentNumber: entry.entryNumber, gain, loss, net: roundTo(gain - loss, 2), journalEntryId: entry.id });
  }

  const byCurrencyMap = new Map<string, FxByCurrency>();
  for (const r of rows) {
    let c = byCurrencyMap.get(r.currency);
    if (!c) { c = { currency: r.currency, realizedGain: 0, realizedLoss: 0, unrealizedGain: 0, unrealizedLoss: 0, net: 0 }; byCurrencyMap.set(r.currency, c); }
    if (r.kind === 'realized') { c.realizedGain = roundTo(c.realizedGain + r.gain, 2); c.realizedLoss = roundTo(c.realizedLoss + r.loss, 2); }
    else { c.unrealizedGain = roundTo(c.unrealizedGain + r.gain, 2); c.unrealizedLoss = roundTo(c.unrealizedLoss + r.loss, 2); }
    c.net = roundTo(c.net + r.net, 2);
  }

  const sum = (k: 'realized' | 'unrealized', g: 'gain' | 'loss') => roundTo(rows.filter((r) => r.kind === k).reduce((s, r) => s + r[g], 0), 2);
  const realizedGain = sum('realized', 'gain');
  const realizedLoss = sum('realized', 'loss');
  const unrealizedGain = sum('unrealized', 'gain');
  const unrealizedLoss = sum('unrealized', 'loss');
  return {
    realizedGain, realizedLoss, unrealizedGain, unrealizedLoss,
    netFx: roundTo(realizedGain - realizedLoss + unrealizedGain - unrealizedLoss, 2),
    byCurrency: [...byCurrencyMap.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/* ───────────────────────── Currency exposure report ─────────────────────── */

export interface ExposureRow {
  currency: string;
  receivables: number;
  payables: number;
  bank: number;
  netForeign: number;
  currentRate: number;
  baseEquivalent: number;
  /** Analytical only — impact of a ±1% rate move on the base equivalent. */
  sensitivity1pct: number;
}

export interface ExposureParams {
  entries: JournalEntry[];
  accounts: Account[];
  rates: ExchangeRate[];
  config: EntityCurrencyConfig;
  baseCurrency: string;
  asOfDate: string;
}

/** Analytical currency exposure by currency (foreign monetary positions). NOT booked accounting. */
export function buildCurrencyExposureReport(params: ExposureParams): ExposureRow[] {
  const accountsById = new Map(params.accounts.map((a) => [a.id, a]));
  const balances = selectForeignBalances(params.entries, params.baseCurrency, params.asOfDate, false);
  const byCurrency = new Map<string, ExposureRow>();

  for (const b of balances) {
    const account = accountsById.get(b.accountId);
    if (!account) continue;
    let row = byCurrency.get(b.currencyCode);
    if (!row) { row = { currency: b.currencyCode, receivables: 0, payables: 0, bank: 0, netForeign: 0, currentRate: 0, baseEquivalent: 0, sensitivity1pct: 0 }; byCurrency.set(b.currencyCode, row); }
    const sub = `${account.ifrsSubcategory} ${account.ifrsCategory}`;
    if (/cash and cash equivalents/i.test(sub)) row.bank = roundTo(row.bank + b.foreignBalance, 2);
    else if (/receivable/i.test(sub)) row.receivables = roundTo(row.receivables + b.foreignBalance, 2);
    else if (account.type === 'LIABILITY') row.payables = roundTo(row.payables + b.foreignBalance, 2);
    row.netForeign = roundTo(row.netForeign + b.foreignBalance, 2);
  }

  for (const row of byCurrency.values()) {
    const res = resolveExchangeRate({ entityId: params.config.entityId, fromCurrencyCode: row.currency, toCurrencyCode: params.baseCurrency, transactionDate: params.asOfDate, rates: params.rates, allowTriangulation: true, baseCurrencyCode: params.baseCurrency });
    row.currentRate = res.rate ?? 0;
    row.baseEquivalent = roundTo(row.netForeign * row.currentRate, 2);
    row.sensitivity1pct = roundTo(row.baseEquivalent * 0.01, 2);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
