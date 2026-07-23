/** Fixed Assets — pure calculation & voucher-builder tests. */
import { describe, it, expect } from 'vitest';
import type { AssetCategory, FixedAsset } from '@/types/fixedAssets';
import {
  buildAcquisitionVoucher, buildCapitalizationVoucher, buildDepreciationVoucher,
  buildDisposalVoucher, buildImpairmentVoucher, buildIntercompanyTransferVoucher,
  buildRevaluationVoucher, computeDepreciation, computeDisposal, depreciableAmount,
  isBalanced, monthsInclusive, netBookValue, portionFraction, remainingDepreciable,
} from './fixedAssetCalculations';

const category = (over: Partial<AssetCategory['accounts']> = {}): AssetCategory => ({
  id: 'cat1', code: 'MACH', name: 'Machinery', description: '',
  accounts: {
    costAccountId: 'acc-cost', accumulatedDepreciationAccountId: 'acc-accum',
    depreciationExpenseAccountId: 'acc-dep-exp', impairmentLossAccountId: 'acc-imp-loss',
    accumulatedImpairmentAccountId: 'acc-accum-imp', disposalGainAccountId: 'acc-gain',
    disposalLossAccountId: 'acc-loss', aucAccountId: 'acc-auc', recoverableTaxAccountId: 'acc-vat-in',
    revaluationSurplusAccountId: 'acc-rev-surplus', revaluationLossAccountId: 'acc-rev-loss',
    ...over,
  },
  defaultMethod: 'straight_line', defaultUsefulLifeMonths: 60, defaultResidualRatePercent: 0,
  revaluationEnabled: true, isActive: true, createdAt: '', updatedAt: '',
});

const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: 'a1', assetCode: 'AST-0001', name: 'CNC machine', description: '', categoryId: 'cat1',
  companyId: '', branch: '', department: '', costCenterId: '', projectId: '', location: '', custodian: '',
  supplierId: '', supplierName: '', purchaseInvoiceRef: '',
  acquisitionDate: '2026-01-01', capitalizationDate: '2026-01-01',
  originalCost: 12000, aucBalance: 0, recoverableTax: 0, nonRecoverableTax: 0, residualValue: 0,
  usefulLifeMonths: 12, method: 'straight_line', reducingBalanceRatePercent: 25,
  unitsTotal: 0, unitsDepreciated: 0, depreciationStartDate: '2026-01-01', depreciatedThrough: '',
  accumulatedDepreciation: 0, impairmentBalance: 0, revaluationSurplusBalance: 0,
  quantity: 1, status: 'active', disposalDate: '', disposalProceeds: 0, disposalGainLoss: 0,
  attachments: [], notes: '', createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
  ...over,
});

describe('register arithmetic', () => {
  it('computes NBV, depreciable and remaining amounts', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 2500, impairmentBalance: 500, residualValue: 1000 });
    expect(netBookValue(a)).toBe(7000);
    expect(depreciableAmount(a)).toBe(8500); // cost − residual − impairment
    expect(remainingDepreciable(a)).toBe(6000);
  });

  it('counts inclusive calendar months', () => {
    expect(monthsInclusive('2026-01-01', '2026-01-31')).toBe(1);
    expect(monthsInclusive('2026-01-01', '2026-12-31')).toBe(12);
    expect(monthsInclusive('2026-03-15', '2026-04-02')).toBe(2);
  });
});

describe('depreciation methods', () => {
  it('straight line: cost−residual over useful life', () => {
    const a = asset({ originalCost: 12000, residualValue: 0, usefulLifeMonths: 12 });
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2026-01-31' })).toBe(1000);
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2026-03-31' })).toBe(3000);
  });

  it('never depreciates land / method none', () => {
    expect(computeDepreciation({ asset: asset({ method: 'none' }), periodFrom: '2026-01-01', periodTo: '2026-12-31' })).toBe(0);
  });

  it('reducing balance: rate applied to opening NBV, time-apportioned', () => {
    const a = asset({ method: 'reducing_balance', originalCost: 10000, reducingBalanceRatePercent: 24, usefulLifeMonths: 0 });
    // 10 000 × 24% × 6/12 = 1 200
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2026-06-30' })).toBe(1200);
  });

  it('units of production: proportional to units used', () => {
    const a = asset({ method: 'units_of_production', originalCost: 10000, residualValue: 1000, unitsTotal: 900 });
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2026-01-31', unitsUsed: 90 })).toBe(900);
  });

  it('clamps at the depreciable amount (cost − residual − impairment)', () => {
    const a = asset({ originalCost: 12000, residualValue: 2000, impairmentBalance: 1000, usefulLifeMonths: 12, accumulatedDepreciation: 8000 });
    // depreciable 9 000, already 8 000 → only 1 000 left even over many months
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2027-12-31' })).toBe(1000);
  });

  it('never charges the same months twice (depreciatedThrough)', () => {
    const a = asset({ depreciatedThrough: '2026-06-30', usefulLifeMonths: 12, originalCost: 12000 });
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2026-06-30' })).toBe(0);
    expect(computeDepreciation({ asset: a, periodFrom: '2026-01-01', periodTo: '2026-07-31' })).toBe(1000);
  });
});

describe('disposal computation', () => {
  it('full disposal gain = net proceeds − NBV', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 6000 });
    const c = computeDisposal(a, 1, 5500, 300);
    expect(c.nbvPortion).toBe(4000);
    expect(c.netProceeds).toBe(5200);
    expect(c.gainLoss).toBe(1200);
  });

  it('prorates cost, depreciation and impairment for a partial disposal', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 4000, impairmentBalance: 1000 });
    const c = computeDisposal(a, 0.25, 2000, 0);
    expect(c.costPortion).toBe(2500);
    expect(c.accumDepPortion).toBe(1000);
    expect(c.impairmentPortion).toBe(250);
    expect(c.nbvPortion).toBe(1250);
    expect(c.gainLoss).toBe(750);
  });

  it('portion fractions: percentage, cost and units', () => {
    const a = asset({ originalCost: 10000, quantity: 4 });
    expect(portionFraction(a, { kind: 'percentage', value: 25 }).fraction).toBe(0.25);
    expect(portionFraction(a, { kind: 'cost', value: 2500 }).fraction).toBe(0.25);
    expect(portionFraction(a, { kind: 'units', value: 1 }).fraction).toBe(0.25);
    expect(portionFraction(asset({ quantity: 1 }), { kind: 'units', value: 1 }).ok).toBe(false);
    expect(portionFraction(a, { kind: 'percentage', value: 120 }).ok).toBe(false);
  });
});

describe('voucher builders', () => {
  it('credit acquisition: Dr cost + Dr recoverable tax, Cr AP — balanced', () => {
    const plan = buildAcquisitionVoucher({ category: category(), assetName: 'CNC', cost: 10000, recoverableTax: 500, creditAccountId: 'acc-ap', toAuc: false, dims: {} });
    expect(plan.ok).toBe(true);
    expect(isBalanced(plan.lines)).toBe(true);
    expect(plan.lines.find((l) => l.accountId === 'acc-cost')?.debit).toBe(10000);
    expect(plan.lines.find((l) => l.accountId === 'acc-vat-in')?.debit).toBe(500);
    expect(plan.lines.find((l) => l.accountId === 'acc-ap')?.credit).toBe(10500);
  });

  it('AUC acquisition debits the AUC account; capitalization moves AUC → cost', () => {
    const auc = buildAcquisitionVoucher({ category: category(), assetName: 'Plant', cost: 8000, recoverableTax: 0, creditAccountId: 'acc-bank', toAuc: true, dims: {} });
    expect(auc.lines.find((l) => l.accountId === 'acc-auc')?.debit).toBe(8000);
    const cap = buildCapitalizationVoucher({ category: category(), assetName: 'Plant', amount: 8000, dims: {} });
    expect(cap.lines.find((l) => l.accountId === 'acc-cost')?.debit).toBe(8000);
    expect(cap.lines.find((l) => l.accountId === 'acc-auc')?.credit).toBe(8000);
  });

  it('rejects with a clear error when a required mapping is missing', () => {
    const plan = buildAcquisitionVoucher({ category: category({ costAccountId: '' }), assetName: 'x', cost: 100, recoverableTax: 0, creditAccountId: 'acc-ap', toAuc: false, dims: {} });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('missing accounting mappings');
    expect(plan.error).toContain('fixed asset cost account');
  });

  it('depreciation voucher pairs expense and accumulated depreciation', () => {
    const plan = buildDepreciationVoucher([{ category: category(), assetName: 'CNC', amount: 1000, dims: { costCenter: 'cc1' } }]);
    expect(plan.ok).toBe(true);
    expect(isBalanced(plan.lines)).toBe(true);
    expect(plan.lines[0]).toMatchObject({ accountId: 'acc-dep-exp', debit: 1000, costCenter: 'cc1' });
    expect(plan.lines[1]).toMatchObject({ accountId: 'acc-accum', credit: 1000 });
  });

  it('disposal with gain, output tax and impairment derecognition — balanced', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 5000, impairmentBalance: 1000 });
    const c = computeDisposal(a, 1, 6000, 0);
    expect(c.gainLoss).toBe(2000);
    const plan = buildDisposalVoucher({ category: category(), assetName: 'CNC', computation: c, proceeds: 6000, disposalCosts: 0, outputTax: 300, outputTaxAccountId: 'acc-vat-out', receiptAccountId: 'acc-bank', dims: {} });
    expect(plan.ok).toBe(true);
    expect(isBalanced(plan.lines)).toBe(true);
    expect(plan.lines.find((l) => l.accountId === 'acc-bank')?.debit).toBe(6300);
    expect(plan.lines.find((l) => l.accountId === 'acc-accum')?.debit).toBe(5000);
    expect(plan.lines.find((l) => l.accountId === 'acc-accum-imp')?.debit).toBe(1000);
    expect(plan.lines.find((l) => l.accountId === 'acc-cost')?.credit).toBe(10000);
    expect(plan.lines.find((l) => l.accountId === 'acc-vat-out')?.credit).toBe(300);
    expect(plan.lines.find((l) => l.accountId === 'acc-gain')?.credit).toBe(2000);
  });

  it('disposal with loss debits the loss account; at-NBV has neither gain nor loss', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 4000 });
    const loss = buildDisposalVoucher({ category: category(), assetName: 'x', computation: computeDisposal(a, 1, 5000, 0), proceeds: 5000, disposalCosts: 0, outputTax: 0, outputTaxAccountId: '', receiptAccountId: 'acc-bank', dims: {} });
    expect(loss.lines.find((l) => l.accountId === 'acc-loss')?.debit).toBe(1000);
    const atNbv = buildDisposalVoucher({ category: category(), assetName: 'x', computation: computeDisposal(a, 1, 6000, 0), proceeds: 6000, disposalCosts: 0, outputTax: 0, outputTaxAccountId: '', receiptAccountId: 'acc-bank', dims: {} });
    expect(atNbv.lines.some((l) => l.accountId === 'acc-gain' || l.accountId === 'acc-loss')).toBe(false);
    expect(isBalanced(atNbv.lines)).toBe(true);
  });

  it('impairment voucher: Dr loss, Cr accumulated impairment', () => {
    const plan = buildImpairmentVoucher({ category: category(), assetName: 'x', amount: 750, dims: {} });
    expect(plan.lines[0]).toMatchObject({ accountId: 'acc-imp-loss', debit: 750 });
    expect(plan.lines[1]).toMatchObject({ accountId: 'acc-accum-imp', credit: 750 });
  });

  it('revaluation eliminates accumulated depreciation and books the surplus', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 4000 });
    const plan = buildRevaluationVoucher({ category: category(), assetName: 'x', asset: a, revaluedAmount: 9000, dims: {} });
    expect(plan.ok).toBe(true);
    expect(isBalanced(plan.lines)).toBe(true);
    expect(plan.lines.find((l) => l.accountId === 'acc-accum')?.debit).toBe(4000);
    expect(plan.lines.find((l) => l.accountId === 'acc-rev-surplus')?.credit).toBe(3000);
  });

  it('revaluation is refused when the category policy disables it', () => {
    const cat = { ...category(), revaluationEnabled: false };
    const plan = buildRevaluationVoucher({ category: cat, assetName: 'x', asset: asset(), revaluedAmount: 9000, dims: {} });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('not enabled');
  });

  it('intercompany transfer derecognizes at carrying amount with no gain/loss', () => {
    const a = asset({ originalCost: 10000, accumulatedDepreciation: 4000 });
    const plan = buildIntercompanyTransferVoucher({ category: category(), assetName: 'x', asset: a, dueFromAccountId: 'acc-due-from', dims: {} });
    expect(plan.ok).toBe(true);
    expect(isBalanced(plan.lines)).toBe(true);
    expect(plan.lines.find((l) => l.accountId === 'acc-due-from')?.debit).toBe(6000);
    expect(plan.lines.some((l) => l.accountId === 'acc-gain' || l.accountId === 'acc-loss')).toBe(false);
  });
});
