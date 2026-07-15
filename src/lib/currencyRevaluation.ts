import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type { EntityCurrencyConfig, FxAccountClassification } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';
import type { CurrencyRevaluationLine, CurrencyRevaluationRun } from '@/types/currencyRevaluation';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { resolveExchangeRate } from '@/lib/exchangeRateResolution';
import { roundTo } from '@/lib/currencyConversion';

/* ─────────────────────── Monetary classification (§27) ──────────────────── */

const NON_MONETARY_ASSET = /inventor|property|plant|equipment|prepay|intangible|goodwill|right-of-use|investment property/i;
const MONETARY_ASSET = /cash and cash equivalents|trade receivables|receivable|loan|short-term investments/i;

/** Classify whether a foreign-currency balance on an account is revalued (§27). */
export function classifyFxAccount(a: Account): FxAccountClassification {
  switch (a.type) {
    case 'ASSET':
      if (MONETARY_ASSET.test(a.ifrsSubcategory) || MONETARY_ASSET.test(a.ifrsCategory)) return 'monetary';
      if (NON_MONETARY_ASSET.test(a.ifrsSubcategory) || NON_MONETARY_ASSET.test(a.ifrsCategory)) return 'non-monetary';
      return /non-current/i.test(a.ifrsCategory) ? 'non-monetary' : 'monetary';
    case 'LIABILITY':
      return 'monetary';
    case 'EQUITY':
    case 'OCI':
      return 'non-monetary';
    default:
      return 'not-applicable';
  }
}

/* ───────────────────── Foreign balances by account/currency ──────────────── */

export interface ForeignBalance {
  accountId: string;
  currencyCode: string;
  partyId?: string;
  foreignBalance: number; // signed, debit-positive
  carryingBase: number; // signed, debit-positive
}

/**
 * Foreign-currency balances per (account, currency, party) from posted lines up
 * to `asOfDate`, excluding the base currency. `foreignBalance` is the net in the
 * transaction currency; `carryingBase` is the posted base value.
 */
export function selectForeignBalances(entries: JournalEntry[], baseCurrency: string, asOfDate: string, byParty = false): ForeignBalance[] {
  const map = new Map<string, ForeignBalance>();
  for (const { entry, line } of getPostedJournalLines(entries)) {
    if (entry.entryDate > asOfDate) continue;
    if (entry.currency.toUpperCase() === baseCurrency.toUpperCase()) continue;
    const partyId = byParty ? line.entityId || undefined : undefined;
    const key = `${line.accountId}|${entry.currency}|${partyId ?? ''}`;
    const foreignNet = (Number(line.debit) || 0) - (Number(line.credit) || 0);
    const baseNet = convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, baseCurrency) - convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, baseCurrency);
    const existing = map.get(key);
    if (existing) {
      existing.foreignBalance += foreignNet;
      existing.carryingBase += baseNet;
    } else {
      map.set(key, { accountId: line.accountId, currencyCode: entry.currency, partyId, foreignBalance: foreignNet, carryingBase: baseNet });
    }
  }
  return [...map.values()]
    .map((b) => ({ ...b, foreignBalance: roundTo(b.foreignBalance, 6), carryingBase: roundTo(b.carryingBase, 2) }))
    .filter((b) => Math.abs(b.foreignBalance) > 1e-6);
}

/* ───────────────────────────── Build a run ──────────────────────────────── */

export interface RevaluationParams {
  entityId: string;
  baseCurrencyCode: string;
  revaluationDate: string;
  entries: JournalEntry[];
  accounts: Account[];
  rates: ExchangeRate[];
  config: EntityCurrencyConfig;
  /** Restrict to these currencies (default: all foreign). */
  currencyCodes?: string[];
  byParty?: boolean;
  basePrecision?: number;
}

export interface RevaluationBuildResult {
  run: CurrencyRevaluationRun;
  /** Balances whose closing rate could not be resolved (surfaced, not silently 1.0). */
  missingRates: { accountId: string; currencyCode: string }[];
}

/**
 * Build a draft revaluation run: for each foreign monetary balance, resolve the
 * closing rate and compute the unrealized FX (revalued base − carrying base).
 * Non-monetary accounts are excluded (§27, §29).
 */
export function buildCurrencyRevaluation(params: RevaluationParams): RevaluationBuildResult {
  const accountsById = new Map(params.accounts.map((a) => [a.id, a]));
  const p = params.basePrecision ?? 2;
  const balances = selectForeignBalances(params.entries, params.baseCurrencyCode, params.revaluationDate, params.byParty);
  const lines: CurrencyRevaluationLine[] = [];
  const missingRates: { accountId: string; currencyCode: string }[] = [];

  for (const b of balances) {
    if (params.currencyCodes && !params.currencyCodes.includes(b.currencyCode)) continue;
    const account = accountsById.get(b.accountId);
    if (!account || classifyFxAccount(account) !== 'monetary') continue;

    const resolution = resolveExchangeRate({ entityId: params.entityId, fromCurrencyCode: b.currencyCode, toCurrencyCode: params.baseCurrencyCode, transactionDate: params.revaluationDate, rates: params.rates, allowTriangulation: true, baseCurrencyCode: params.baseCurrencyCode });
    if (!resolution.ok || !resolution.rate) { missingRates.push({ accountId: b.accountId, currencyCode: b.currencyCode }); continue; }

    const closingRate = resolution.rate;
    const revaluedBase = roundTo(b.foreignBalance * closingRate, p);
    const unrealized = roundTo(revaluedBase - b.carryingBase, p); // signed, debit-positive
    if (Math.abs(unrealized) < 0.5 / 10 ** p) continue;

    lines.push({
      id: `${b.accountId}-${b.currencyCode}-${b.partyId ?? 'all'}`,
      accountId: b.accountId, accountCode: account.code, accountName: account.name, partyId: b.partyId,
      currencyCode: b.currencyCode, foreignBalance: b.foreignBalance,
      carryingBaseAmount: b.carryingBase, closingRate, revaluedBaseAmount: revaluedBase,
      unrealizedGain: unrealized > 0 ? unrealized : 0,
      unrealizedLoss: unrealized < 0 ? -unrealized : 0,
      fxGainAccountId: params.config.unrealizedFxGainAccountId ?? params.config.realizedFxGainAccountId,
      fxLossAccountId: params.config.unrealizedFxLossAccountId ?? params.config.realizedFxLossAccountId,
    });
  }

  const totalGain = roundTo(lines.reduce((s, l) => s + l.unrealizedGain, 0), p);
  const totalLoss = roundTo(lines.reduce((s, l) => s + l.unrealizedLoss, 0), p);
  const now = new Date().toISOString();
  const run: CurrencyRevaluationRun = {
    id: '', entityId: params.entityId, revaluationDate: params.revaluationDate, baseCurrencyCode: params.baseCurrencyCode,
    currencyCodes: [...new Set(lines.map((l) => l.currencyCode))], status: 'draft',
    totalGain, totalLoss, netFx: roundTo(totalGain - totalLoss, p), lines,
    auditTrail: [{ id: 'a', at: now, action: 'revaluation-built' }], createdAt: now, updatedAt: now,
  };
  return { run, missingRates };
}
