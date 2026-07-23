/**
 * Fixed Assets — pure accounting calculations and voucher builders.
 *
 * Everything here is deterministic and store-free so it can be unit-tested and
 * shared between the posting actions and the journal-preview UI. Builders
 * return plain balanced line sets; the store posts them atomically through
 * `journalStore.insertPostedEntry` and refuses to record anything when the
 * journal fails.
 *
 * Account IDs always come from the category / settings mapping (chart of
 * accounts) — never hard-coded numbers.
 */
import type {
  AssetCategory,
  AssetCategoryAccounts,
  FixedAsset,
} from '@/types/fixedAssets';

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/* ── Register arithmetic ──────────────────────────────────────────────────── */

/** Carrying amount right now. */
export function netBookValue(a: Pick<FixedAsset, 'originalCost' | 'accumulatedDepreciation' | 'impairmentBalance'>): number {
  return round2(a.originalCost - a.accumulatedDepreciation - a.impairmentBalance);
}

/** Total amount that may EVER be depreciated (spec §5). */
export function depreciableAmount(a: Pick<FixedAsset, 'originalCost' | 'residualValue' | 'impairmentBalance'>): number {
  return Math.max(0, round2(a.originalCost - a.residualValue - a.impairmentBalance));
}

/** Amount still available to depreciate. */
export function remainingDepreciable(a: Pick<FixedAsset, 'originalCost' | 'residualValue' | 'impairmentBalance' | 'accumulatedDepreciation'>): number {
  return Math.max(0, round2(depreciableAmount(a) - a.accumulatedDepreciation));
}

/** Whole calendar months covered by [from, to] inclusive (both ISO dates). */
export function monthsInclusive(from: string, to: string): number {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

/* ── Depreciation ─────────────────────────────────────────────────────────── */

export interface DepreciationInput {
  asset: FixedAsset;
  periodFrom: string;
  periodTo: string;
  /** Units consumed in the period (units-of-production only). */
  unitsUsed?: number;
}

/**
 * Depreciation charge for one asset over one period, clamped so accumulated
 * depreciation can never exceed cost − residual − impairment.
 */
export function computeDepreciation({ asset, periodFrom, periodTo, unitsUsed = 0 }: DepreciationInput): number {
  if (asset.method === 'none') return 0;
  if (asset.status !== 'active' && asset.status !== 'impaired') return 0;
  const remaining = remainingDepreciable(asset);
  if (remaining <= 0) return 0;

  // Depreciation never starts before the configured start date.
  const startFloor = asset.depreciationStartDate || asset.capitalizationDate || asset.acquisitionDate;
  const from = startFloor > periodFrom ? startFloor : periodFrom;
  if (from > periodTo) return 0;
  // Never charge the same months twice: begin after `depreciatedThrough`.
  const effectiveFrom = asset.depreciatedThrough && asset.depreciatedThrough >= from ? nextMonthStart(asset.depreciatedThrough) : from;
  if (effectiveFrom > periodTo) return 0;
  const months = monthsInclusive(effectiveFrom, periodTo);
  if (months <= 0) return 0;

  let charge = 0;
  switch (asset.method) {
    case 'straight_line': {
      if (asset.usefulLifeMonths <= 0) return 0;
      const monthly = (asset.originalCost - asset.residualValue) / asset.usefulLifeMonths;
      charge = monthly * months;
      break;
    }
    case 'reducing_balance': {
      const opening = netBookValue(asset);
      charge = opening * (asset.reducingBalanceRatePercent / 100) * (months / 12);
      break;
    }
    case 'units_of_production': {
      if (asset.unitsTotal <= 0 || unitsUsed <= 0) return 0;
      charge = ((asset.originalCost - asset.residualValue) * unitsUsed) / asset.unitsTotal;
      break;
    }
  }
  return round2(Math.min(Math.max(0, charge), remaining));
}

function nextMonthStart(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/* ── Disposal ─────────────────────────────────────────────────────────────── */

/** How much of the asset is being disposed of. */
export type DisposalPortion =
  | { kind: 'full' }
  | { kind: 'percentage'; value: number }
  | { kind: 'cost'; value: number }
  | { kind: 'units'; value: number };

/** Fraction of the asset (0..1] represented by a disposal portion. */
export function portionFraction(asset: FixedAsset, portion: DisposalPortion): { ok: boolean; fraction: number; error?: string } {
  switch (portion.kind) {
    case 'full':
      return { ok: true, fraction: 1 };
    case 'percentage':
      if (portion.value <= 0 || portion.value > 100) return { ok: false, fraction: 0, error: 'Disposal percentage must be between 0 and 100.' };
      return { ok: true, fraction: portion.value / 100 };
    case 'cost':
      if (portion.value <= 0 || portion.value > asset.originalCost) return { ok: false, fraction: 0, error: 'Disposed cost portion must be positive and not exceed the asset cost.' };
      return { ok: true, fraction: portion.value / asset.originalCost };
    case 'units':
      if (asset.quantity <= 1) return { ok: false, fraction: 0, error: 'This asset does not represent multiple units.' };
      if (portion.value <= 0 || portion.value > asset.quantity) return { ok: false, fraction: 0, error: `Units must be between 1 and ${asset.quantity}.` };
      return { ok: true, fraction: portion.value / asset.quantity };
  }
}

export interface DisposalComputation {
  fraction: number;
  costPortion: number;
  accumDepPortion: number;
  impairmentPortion: number;
  nbvPortion: number;
  netProceeds: number;
  gainLoss: number;
}

/**
 * Prorate cost / accumulated depreciation / impairment for the disposed
 * portion and compute gain or loss = net proceeds − disposal costs − NBV.
 */
export function computeDisposal(
  asset: FixedAsset,
  fraction: number,
  proceeds: number,
  disposalCosts: number,
): DisposalComputation {
  const costPortion = round2(asset.originalCost * fraction);
  const accumDepPortion = round2(asset.accumulatedDepreciation * fraction);
  const impairmentPortion = round2(asset.impairmentBalance * fraction);
  const nbvPortion = round2(costPortion - accumDepPortion - impairmentPortion);
  const netProceeds = round2(proceeds - disposalCosts);
  return {
    fraction,
    costPortion,
    accumDepPortion,
    impairmentPortion,
    nbvPortion,
    netProceeds,
    gainLoss: round2(netProceeds - nbvPortion),
  };
}

/* ── Voucher builders ─────────────────────────────────────────────────────── */

export interface VoucherLine {
  accountId: string;
  debit: number;
  credit: number;
  description: string;
  costCenter?: string;
  project?: string;
  taxCode?: string;
  taxAmount?: number;
}

export interface VoucherPlan {
  ok: boolean;
  error?: string;
  lines: VoucherLine[];
}

const fail = (error: string): VoucherPlan => ({ ok: false, error, lines: [] });

/** Human labels for mapping-validation errors. */
const ACCOUNT_LABELS: Record<keyof AssetCategoryAccounts, string> = {
  costAccountId: 'fixed asset cost account',
  accumulatedDepreciationAccountId: 'accumulated depreciation account',
  depreciationExpenseAccountId: 'depreciation expense account',
  impairmentLossAccountId: 'impairment loss account',
  accumulatedImpairmentAccountId: 'accumulated impairment account',
  disposalGainAccountId: 'disposal gain account',
  disposalLossAccountId: 'disposal loss account',
  aucAccountId: 'asset-under-construction account',
  recoverableTaxAccountId: 'recoverable input tax account',
  revaluationSurplusAccountId: 'revaluation surplus account',
  revaluationLossAccountId: 'revaluation loss account',
};

/** Verify the category maps every account the voucher needs. */
export function requireMappings(
  category: AssetCategory,
  needed: Array<keyof AssetCategoryAccounts>,
): string | null {
  const missing = needed.filter((k) => !category.accounts[k]);
  if (missing.length === 0) return null;
  return `Category "${category.name}" is missing accounting mappings: ${missing.map((k) => ACCOUNT_LABELS[k]).join(', ')}. Configure the category before posting.`;
}

/** Are all lines balanced to the cent? */
export function isBalanced(lines: VoucherLine[]): boolean {
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  return Math.abs(round2(d) - round2(c)) < 0.005;
}

interface Dims {
  costCenter?: string;
  project?: string;
}

/**
 * Acquisition voucher:
 *   Dr Fixed Asset at Cost (or AUC)   [+ Dr Recoverable Input Tax]
 *       Cr AP / Bank / Cash / source account
 * `creditAccountId` is the funding account chosen on the transaction (Trade
 * payables for credit purchases, a bank/cash account otherwise).
 */
export function buildAcquisitionVoucher(input: {
  category: AssetCategory;
  assetName: string;
  cost: number;
  recoverableTax: number;
  creditAccountId: string;
  toAuc: boolean;
  dims: Dims;
  taxCode?: string;
}): VoucherPlan {
  const { category, cost, recoverableTax } = input;
  if (cost <= 0) return fail('Capitalized cost must be greater than zero.');
  if (!input.creditAccountId) return fail('Select the funding account (payable, bank or cash).');
  const needed: Array<keyof AssetCategoryAccounts> = [input.toAuc ? 'aucAccountId' : 'costAccountId'];
  if (recoverableTax > 0) needed.push('recoverableTaxAccountId');
  const missing = requireMappings(category, needed);
  if (missing) return fail(missing);

  const debitAccount = input.toAuc ? category.accounts.aucAccountId : category.accounts.costAccountId;
  const lines: VoucherLine[] = [
    { accountId: debitAccount, debit: round2(cost), credit: 0, description: `${input.toAuc ? 'Asset under construction' : 'Asset acquisition'} — ${input.assetName}`, ...input.dims },
  ];
  if (recoverableTax > 0) {
    lines.push({ accountId: category.accounts.recoverableTaxAccountId, debit: round2(recoverableTax), credit: 0, description: `Recoverable input tax — ${input.assetName}`, taxCode: input.taxCode, taxAmount: round2(recoverableTax), ...input.dims });
  }
  lines.push({ accountId: input.creditAccountId, debit: 0, credit: round2(cost + recoverableTax), description: `Acquisition funding — ${input.assetName}`, ...input.dims });
  return { ok: true, lines };
}

/** Capitalization from AUC: Dr Cost, Cr AUC. */
export function buildCapitalizationVoucher(input: {
  category: AssetCategory;
  assetName: string;
  amount: number;
  dims: Dims;
}): VoucherPlan {
  if (input.amount <= 0) return fail('Capitalization amount must be greater than zero.');
  const missing = requireMappings(input.category, ['costAccountId', 'aucAccountId']);
  if (missing) return fail(missing);
  return {
    ok: true,
    lines: [
      { accountId: input.category.accounts.costAccountId, debit: round2(input.amount), credit: 0, description: `Capitalization — ${input.assetName}`, ...input.dims },
      { accountId: input.category.accounts.aucAccountId, debit: 0, credit: round2(input.amount), description: `Transfer from asset under construction — ${input.assetName}`, ...input.dims },
    ],
  };
}

/** Depreciation: Dr Expense, Cr Accumulated Depreciation (one pair per asset line). */
export function buildDepreciationVoucher(
  lines: Array<{ category: AssetCategory; assetName: string; amount: number; dims: Dims }>,
): VoucherPlan {
  const out: VoucherLine[] = [];
  for (const l of lines) {
    if (l.amount <= 0) continue;
    const missing = requireMappings(l.category, ['depreciationExpenseAccountId', 'accumulatedDepreciationAccountId']);
    if (missing) return fail(missing);
    out.push({ accountId: l.category.accounts.depreciationExpenseAccountId, debit: l.amount, credit: 0, description: `Depreciation — ${l.assetName}`, ...l.dims });
    out.push({ accountId: l.category.accounts.accumulatedDepreciationAccountId, debit: 0, credit: l.amount, description: `Accumulated depreciation — ${l.assetName}`, ...l.dims });
  }
  if (out.length === 0) return fail('Nothing to depreciate for the selected scope and period.');
  return { ok: true, lines: out };
}

/**
 * Disposal voucher (full or partial portion):
 *   Dr Bank / Receivable (net settlement)   Dr Accum Dep   Dr Accum Impairment
 *   [Dr Loss]    Cr Cost    [Cr Output Tax]    [Cr Gain]
 */
export function buildDisposalVoucher(input: {
  category: AssetCategory;
  assetName: string;
  computation: DisposalComputation;
  proceeds: number;
  disposalCosts: number;
  outputTax: number;
  outputTaxAccountId: string;
  receiptAccountId: string;
  dims: Dims;
  taxCode?: string;
}): VoucherPlan {
  const { category, computation: c } = input;
  const needed: Array<keyof AssetCategoryAccounts> = ['costAccountId'];
  if (c.accumDepPortion > 0) needed.push('accumulatedDepreciationAccountId');
  if (c.impairmentPortion > 0) needed.push('accumulatedImpairmentAccountId');
  if (c.gainLoss > 0) needed.push('disposalGainAccountId');
  if (c.gainLoss < 0) needed.push('disposalLossAccountId');
  const missing = requireMappings(category, needed);
  if (missing) return fail(missing);
  if (input.outputTax > 0 && !input.outputTaxAccountId) return fail('Select the output tax account for the taxable disposal.');
  const settlement = round2(input.proceeds + input.outputTax - input.disposalCosts);
  if (settlement < 0) return fail('Disposal costs cannot exceed proceeds plus tax in a single settlement.');
  if (settlement > 0 && !input.receiptAccountId) return fail('Select the bank / receivable account for the disposal proceeds.');

  const lines: VoucherLine[] = [];
  if (settlement > 0) lines.push({ accountId: input.receiptAccountId, debit: settlement, credit: 0, description: `Disposal proceeds — ${input.assetName}`, ...input.dims });
  if (c.accumDepPortion > 0) lines.push({ accountId: category.accounts.accumulatedDepreciationAccountId, debit: c.accumDepPortion, credit: 0, description: `Derecognize accumulated depreciation — ${input.assetName}`, ...input.dims });
  if (c.impairmentPortion > 0) lines.push({ accountId: category.accounts.accumulatedImpairmentAccountId, debit: c.impairmentPortion, credit: 0, description: `Derecognize accumulated impairment — ${input.assetName}`, ...input.dims });
  if (c.gainLoss < 0) lines.push({ accountId: category.accounts.disposalLossAccountId, debit: round2(-c.gainLoss), credit: 0, description: `Loss on disposal — ${input.assetName}`, ...input.dims });
  lines.push({ accountId: category.accounts.costAccountId, debit: 0, credit: c.costPortion, description: `Derecognize asset cost — ${input.assetName}`, ...input.dims });
  if (input.outputTax > 0) lines.push({ accountId: input.outputTaxAccountId, debit: 0, credit: round2(input.outputTax), description: `Output tax on disposal — ${input.assetName}`, taxCode: input.taxCode, taxAmount: round2(input.outputTax), ...input.dims });
  if (c.gainLoss > 0) lines.push({ accountId: category.accounts.disposalGainAccountId, debit: 0, credit: c.gainLoss, description: `Gain on disposal — ${input.assetName}`, ...input.dims });
  return { ok: true, lines };
}

/** Impairment: Dr Impairment Loss, Cr Accumulated Impairment. */
export function buildImpairmentVoucher(input: {
  category: AssetCategory;
  assetName: string;
  amount: number;
  dims: Dims;
}): VoucherPlan {
  if (input.amount <= 0) return fail('Impairment amount must be greater than zero.');
  const missing = requireMappings(input.category, ['impairmentLossAccountId', 'accumulatedImpairmentAccountId']);
  if (missing) return fail(missing);
  return {
    ok: true,
    lines: [
      { accountId: input.category.accounts.impairmentLossAccountId, debit: round2(input.amount), credit: 0, description: `Impairment loss — ${input.assetName}`, ...input.dims },
      { accountId: input.category.accounts.accumulatedImpairmentAccountId, debit: 0, credit: round2(input.amount), description: `Accumulated impairment — ${input.assetName}`, ...input.dims },
    ],
  };
}

/** Impairment reversal (limited to the impairment balance): mirror entry. */
export function buildImpairmentReversalVoucher(input: {
  category: AssetCategory;
  assetName: string;
  amount: number;
  dims: Dims;
}): VoucherPlan {
  if (input.amount <= 0) return fail('Reversal amount must be greater than zero.');
  const missing = requireMappings(input.category, ['impairmentLossAccountId', 'accumulatedImpairmentAccountId']);
  if (missing) return fail(missing);
  return {
    ok: true,
    lines: [
      { accountId: input.category.accounts.accumulatedImpairmentAccountId, debit: round2(input.amount), credit: 0, description: `Impairment reversal — ${input.assetName}`, ...input.dims },
      { accountId: input.category.accounts.impairmentLossAccountId, debit: 0, credit: round2(input.amount), description: `Reversal of impairment loss — ${input.assetName}`, ...input.dims },
    ],
  };
}

/**
 * Revaluation (elimination approach): accumulated depreciation/impairment is
 * netted against cost, then the carrying amount is stepped to the revalued
 * amount — surplus to equity, deficit to the revaluation loss account.
 */
export function buildRevaluationVoucher(input: {
  category: AssetCategory;
  assetName: string;
  asset: Pick<FixedAsset, 'originalCost' | 'accumulatedDepreciation' | 'impairmentBalance'>;
  revaluedAmount: number;
  dims: Dims;
}): VoucherPlan {
  const { category, asset } = input;
  if (!category.revaluationEnabled) return fail(`Revaluation is not enabled for category "${category.name}".`);
  if (input.revaluedAmount <= 0) return fail('Revalued amount must be greater than zero.');
  const nbv = netBookValue(asset);
  const delta = round2(input.revaluedAmount - nbv);
  const needed: Array<keyof AssetCategoryAccounts> = ['costAccountId'];
  if (asset.accumulatedDepreciation > 0) needed.push('accumulatedDepreciationAccountId');
  if (asset.impairmentBalance > 0) needed.push('accumulatedImpairmentAccountId');
  if (delta > 0) needed.push('revaluationSurplusAccountId');
  if (delta < 0) needed.push('revaluationLossAccountId');
  const missing = requireMappings(category, needed);
  if (missing) return fail(missing);
  if (delta === 0 && asset.accumulatedDepreciation === 0 && asset.impairmentBalance === 0) {
    return fail('The revalued amount equals the carrying amount — nothing to post.');
  }

  const lines: VoucherLine[] = [];
  if (asset.accumulatedDepreciation > 0) lines.push({ accountId: category.accounts.accumulatedDepreciationAccountId, debit: round2(asset.accumulatedDepreciation), credit: 0, description: `Eliminate accumulated depreciation — ${input.assetName}`, ...input.dims });
  if (asset.impairmentBalance > 0) lines.push({ accountId: category.accounts.accumulatedImpairmentAccountId, debit: round2(asset.impairmentBalance), credit: 0, description: `Eliminate accumulated impairment — ${input.assetName}`, ...input.dims });
  // Cost moves from originalCost to revaluedAmount: net line keeps balance.
  const costDelta = round2(input.revaluedAmount - asset.originalCost);
  if (costDelta > 0) lines.push({ accountId: category.accounts.costAccountId, debit: costDelta, credit: 0, description: `Revaluation uplift — ${input.assetName}`, ...input.dims });
  else if (costDelta < 0) lines.push({ accountId: category.accounts.costAccountId, debit: 0, credit: round2(-costDelta), description: `Revaluation adjustment — ${input.assetName}`, ...input.dims });
  if (delta > 0) lines.push({ accountId: category.accounts.revaluationSurplusAccountId, debit: 0, credit: delta, description: `Revaluation surplus — ${input.assetName}`, ...input.dims });
  else if (delta < 0) lines.push({ accountId: category.accounts.revaluationLossAccountId, debit: round2(-delta), credit: 0, description: `Revaluation loss — ${input.assetName}`, ...input.dims });
  if (!isBalanced(lines)) return fail('Revaluation voucher failed to balance — check the register balances.');
  return { ok: true, lines };
}

/**
 * Intercompany transfer OUT at carrying amount (no gain/loss):
 *   Dr Due-from (NBV)   Dr Accum Dep   Dr Accum Impairment   Cr Cost
 */
export function buildIntercompanyTransferVoucher(input: {
  category: AssetCategory;
  assetName: string;
  asset: Pick<FixedAsset, 'originalCost' | 'accumulatedDepreciation' | 'impairmentBalance'>;
  dueFromAccountId: string;
  dims: Dims;
}): VoucherPlan {
  const { category, asset } = input;
  if (!input.dueFromAccountId) return fail('Intercompany transfers require a mapped due-from account.');
  const needed: Array<keyof AssetCategoryAccounts> = ['costAccountId'];
  if (asset.accumulatedDepreciation > 0) needed.push('accumulatedDepreciationAccountId');
  if (asset.impairmentBalance > 0) needed.push('accumulatedImpairmentAccountId');
  const missing = requireMappings(category, needed);
  if (missing) return fail(missing);
  const nbv = netBookValue(asset);
  if (nbv < 0) return fail('Asset carrying amount is negative — correct the register first.');

  const lines: VoucherLine[] = [];
  if (nbv > 0) lines.push({ accountId: input.dueFromAccountId, debit: nbv, credit: 0, description: `Intercompany transfer at carrying amount — ${input.assetName}`, ...input.dims });
  if (asset.accumulatedDepreciation > 0) lines.push({ accountId: category.accounts.accumulatedDepreciationAccountId, debit: round2(asset.accumulatedDepreciation), credit: 0, description: `Derecognize accumulated depreciation — ${input.assetName}`, ...input.dims });
  if (asset.impairmentBalance > 0) lines.push({ accountId: category.accounts.accumulatedImpairmentAccountId, debit: round2(asset.impairmentBalance), credit: 0, description: `Derecognize accumulated impairment — ${input.assetName}`, ...input.dims });
  lines.push({ accountId: category.accounts.costAccountId, debit: 0, credit: round2(asset.originalCost), description: `Derecognize asset cost — ${input.assetName}`, ...input.dims });
  if (!isBalanced(lines)) return fail('Intercompany transfer voucher failed to balance.');
  return { ok: true, lines };
}
