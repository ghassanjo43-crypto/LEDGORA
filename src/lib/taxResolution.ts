import type { PartyTaxProfile, ProductTaxCategory, TaxCode, TaxDirection, TaxRateVersion, TaxSnapshot } from '@/types/taxCode';

/**
 * Tax resolution: pick the rate version effective on a date, resolve the default
 * tax code by priority, and map a code/snapshot to its posting accounts. All pure
 * — no store access — so callers pass the current configuration in.
 */

export interface ResolvedRateVersion {
  rate: number;
  effectiveFrom: string;
  effectiveTo?: string;
  outputTaxAccountId?: string;
  inputTaxAccountId?: string;
  taxPayableAccountId?: string;
  taxReceivableAccountId?: string;
  /** True when a distinct historical version matched (vs. falling back to the code). */
  fromVersion: boolean;
}

function withinPeriod(date: string, from: string, to?: string): boolean {
  return date >= from && (!to || date <= to);
}

/**
 * Resolve the rate version applicable on `transactionDate`. Historical documents
 * therefore keep their original rate; new documents use the current version.
 * Falls back to the tax code's own rate/accounts when no version matches.
 */
export function resolveTaxRateVersion(code: TaxCode, versions: TaxRateVersion[], transactionDate: string): ResolvedRateVersion {
  const applicable = versions
    .filter((v) => v.taxCodeId === code.id && withinPeriod(transactionDate, v.effectiveFrom, v.effectiveTo))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (applicable) {
    return {
      rate: applicable.rate,
      effectiveFrom: applicable.effectiveFrom,
      effectiveTo: applicable.effectiveTo,
      outputTaxAccountId: applicable.outputTaxAccountId ?? code.outputTaxAccountId,
      inputTaxAccountId: applicable.inputTaxAccountId ?? code.inputTaxAccountId,
      taxPayableAccountId: applicable.taxPayableAccountId ?? code.taxPayableAccountId,
      taxReceivableAccountId: applicable.taxReceivableAccountId ?? code.taxReceivableAccountId,
      fromVersion: true,
    };
  }
  return {
    rate: code.rate,
    effectiveFrom: code.effectiveFrom,
    effectiveTo: code.effectiveTo,
    outputTaxAccountId: code.outputTaxAccountId,
    inputTaxAccountId: code.inputTaxAccountId,
    taxPayableAccountId: code.taxPayableAccountId,
    taxReceivableAccountId: code.taxReceivableAccountId,
    fromVersion: false,
  };
}

/** Detect whether a new [from,to] version overlaps any existing version for a code. */
export function hasOverlappingRateVersion(versions: TaxRateVersion[], taxCodeId: string, from: string, to: string | undefined, ignoreId?: string): boolean {
  return versions.some((v) => {
    if (v.taxCodeId !== taxCodeId || v.id === ignoreId) return false;
    const vTo = v.effectiveTo ?? '9999-12-31';
    const nTo = to ?? '9999-12-31';
    return from <= vTo && v.effectiveFrom <= nTo;
  });
}

/* ─────────────────────────── Default code resolution ────────────────────── */

export type TaxDefaultSource = 'explicit' | 'product' | 'party' | 'transaction-type' | 'entity-default' | 'none';

export interface DefaultTaxResolution {
  taxCodeId?: string;
  source: TaxDefaultSource;
}

export interface ResolveDefaultTaxParams {
  direction: 'sales' | 'purchase';
  explicitTaxCodeId?: string;
  productCategory?: ProductTaxCategory;
  party?: PartyTaxProfile;
  transactionTypeDefaultId?: string;
  taxCodes: TaxCode[];
}

/**
 * Resolve the default tax code by priority (§29):
 *   explicit → product category → party profile → transaction type → entity
 *   default → none. Never silently overrides an explicit selection.
 */
export function resolveDefaultTaxCode(params: ResolveDefaultTaxParams): DefaultTaxResolution {
  const sales = params.direction === 'sales';
  if (params.explicitTaxCodeId) return { taxCodeId: params.explicitTaxCodeId, source: 'explicit' };

  const fromProduct = sales ? params.productCategory?.defaultSalesTaxCodeId : params.productCategory?.defaultPurchaseTaxCodeId;
  if (fromProduct) return { taxCodeId: fromProduct, source: 'product' };

  const fromParty = sales ? params.party?.defaultSalesTaxCodeId : params.party?.defaultPurchaseTaxCodeId;
  if (fromParty) return { taxCodeId: fromParty, source: 'party' };

  if (params.transactionTypeDefaultId) return { taxCodeId: params.transactionTypeDefaultId, source: 'transaction-type' };

  const entityDefault = params.taxCodes.find(
    (c) => c.status === 'active' && (sales ? c.isDefaultSales : c.isDefaultPurchase) && isDirectionAllowed(c.direction, params.direction),
  );
  if (entityDefault) return { taxCodeId: entityDefault.id, source: 'entity-default' };

  return { source: 'none' };
}

/** A code participates in a sales/purchase selector when its direction matches. */
export function isDirectionAllowed(codeDirection: TaxDirection, want: 'sales' | 'purchase'): boolean {
  if (codeDirection === 'both') return true;
  if (want === 'sales') return codeDirection === 'sales' || codeDirection === 'withholding-receivable';
  return codeDirection === 'purchase' || codeDirection === 'withholding-payable';
}

/** Codes selectable on a given transaction direction, active and effective on the date. */
export function selectableTaxCodes(taxCodes: TaxCode[], want: 'sales' | 'purchase', date?: string): TaxCode[] {
  return taxCodes.filter((c) => {
    if (c.status !== 'active') return false;
    if (!isDirectionAllowed(c.direction, want)) return false;
    if (date) {
      if (c.effectiveFrom > date) return false;
      if (c.effectiveTo && c.effectiveTo < date) return false;
    }
    return true;
  });
}

/* ─────────────────────────────── Account mapping ────────────────────────── */

export interface ResolvedTaxAccounts {
  taxAccountId?: string;
  recoverableAccountId?: string;
  nonRecoverableAccountId?: string;
  reverseChargeOutputAccountId?: string;
  reverseChargeInputAccountId?: string;
  withholdingAccountId?: string;
}

type AccountSource = Pick<TaxCode,
  'outputTaxAccountId' | 'inputTaxAccountId' | 'taxReceivableAccountId' | 'taxPayableAccountId' |
  'nonRecoverableAccountId' | 'reverseChargeOutputAccountId' | 'reverseChargeInputAccountId' | 'withholdingAccountId' | 'category'>;

/**
 * Map a tax code (or frozen snapshot) to the accounts a posting needs, by
 * direction. Snapshots carry the same account fields, so reversals/credits reuse
 * the original mapping rather than today's.
 */
export function resolveTaxAccounts(source: AccountSource | TaxSnapshot, direction: 'sales' | 'purchase'): ResolvedTaxAccounts {
  const s = source as AccountSource & Partial<TaxSnapshot>;
  return {
    taxAccountId: direction === 'sales'
      ? s.outputTaxAccountId ?? s.taxPayableAccountId
      : s.inputTaxAccountId ?? s.taxReceivableAccountId,
    recoverableAccountId: s.inputTaxAccountId,
    nonRecoverableAccountId: s.nonRecoverableAccountId,
    reverseChargeOutputAccountId: s.reverseChargeOutputAccountId,
    reverseChargeInputAccountId: s.reverseChargeInputAccountId,
    withholdingAccountId: s.withholdingAccountId,
  };
}
