/**
 * Universal Journal Voucher — default voucher-type catalogue.
 *
 * Seeded once per workspace; administrators can edit these and add their own
 * (custom types behave as 'general'). No account numbers are hard-coded —
 * default accounts stay unmapped until an administrator picks them from the
 * live chart.
 */
import type { VoucherTypeConfig, VoucherTypeKind } from '@/types/journalVoucher';
import { generateId } from '@/lib/utils';

interface Spec {
  code: string;
  name: string;
  kind?: VoucherTypeKind;
  prefix: string;
  description?: string;
  requiredDimensions?: Array<'costCenter' | 'project'>;
  approval?: boolean;
  autoReversal?: boolean;
  recurring?: boolean;
  tax?: boolean;
  bank?: boolean;
  asset?: boolean;
  intercompany?: boolean;
  warnFormal?: boolean;
}

const SPECS: Spec[] = [
  { code: 'GEN', name: 'General Adjustment', prefix: 'JV', description: 'Manual accounting adjustment' },
  { code: 'BTR', name: 'Internal Bank Transfer', kind: 'bank_transfer', prefix: 'BTR', bank: true, description: 'Transfer between bank accounts' },
  { code: 'CTR', name: 'Cash Transfer', kind: 'bank_transfer', prefix: 'CTR', bank: true, description: 'Cash ↔ bank transfer' },
  { code: 'AAQ', name: 'Asset Acquisition', kind: 'asset_acquisition', prefix: 'AAQ', asset: true, tax: true, bank: true, approval: true, description: 'Fixed-asset purchase without a supplier bill', warnFormal: true },
  { code: 'ASL', name: 'Asset Sale', kind: 'asset_disposal', prefix: 'ASL', asset: true, tax: true, bank: true, approval: true, description: 'Fixed-asset sale without a customer invoice', warnFormal: true },
  { code: 'ADS', name: 'Asset Disposal', kind: 'asset_disposal', prefix: 'ADS', asset: true, approval: true, description: 'Scrapping / write-off of a fixed asset' },
  { code: 'DEP', name: 'Depreciation', kind: 'asset_depreciation', prefix: 'DEP', asset: true, recurring: true, description: 'Depreciation charge' },
  { code: 'AMR', name: 'Amortization', kind: 'asset_depreciation', prefix: 'AMR', asset: true, recurring: true, description: 'Amortization of intangibles' },
  { code: 'ACC', name: 'Accrual', kind: 'accrual', prefix: 'ACC', autoReversal: true, recurring: true, description: 'Expense/revenue accrual' },
  { code: 'ACR', name: 'Accrual Reversal', kind: 'accrual', prefix: 'ACR', description: 'Reversal of a prior accrual' },
  { code: 'PRE', name: 'Prepayment', kind: 'prepayment', prefix: 'PRE', bank: true, description: 'Prepaid expense recognition' },
  { code: 'PRL', name: 'Prepayment Release', kind: 'prepayment', prefix: 'PRL', recurring: true, description: 'Periodic release of a prepaid expense' },
  { code: 'PRV', name: 'Provision', prefix: 'PRV', approval: true, description: 'Provision recognition / remeasurement' },
  { code: 'PVR', name: 'Provision Reversal', prefix: 'PVR', approval: true, description: 'Provision release / reversal' },
  { code: 'RCL', name: 'Reclassification', prefix: 'RCL', description: 'Move balances between accounts or dimensions' },
  { code: 'OBL', name: 'Opening Balance', kind: 'opening_balance', prefix: 'OBL', approval: true, description: 'Opening balances at migration' },
  { code: 'CLS', name: 'Closing Entry', prefix: 'CLS', approval: true, description: 'Period/annual closing entry' },
  { code: 'FXA', name: 'Foreign Exchange Adjustment', prefix: 'FXA', description: 'Realized / revaluation FX adjustment' },
  { code: 'INV', name: 'Inventory Adjustment', prefix: 'INV', description: 'Inventory value adjustment', warnFormal: true },
  { code: 'PAY', name: 'Payroll Adjustment', prefix: 'PAY', description: 'Payroll accrual / correction' },
  { code: 'ICJ', name: 'Intercompany Journal', kind: 'intercompany', prefix: 'ICJ', intercompany: true, approval: true, description: 'Balanced pair across legal entities' },
  { code: 'TAXJ', name: 'Tax Adjustment', kind: 'tax_adjustment', prefix: 'TAX', tax: true, approval: true, description: 'Manual tax adjustment', warnFormal: true },
  { code: 'WOF', name: 'Write-off', prefix: 'WOF', approval: true, description: 'Balance write-off' },
  { code: 'SUS', name: 'Suspense Clearing', prefix: 'SUS', description: 'Clear suspense-account balances' },
  { code: 'COR', name: 'Correction', prefix: 'COR', description: 'Correcting entry referencing the original' },
  { code: 'OTH', name: 'Other', prefix: 'JV', description: 'Other balanced non-document transaction' },
];

export function makeSeedVoucherTypes(): VoucherTypeConfig[] {
  return SPECS.map((s) => ({
    id: generateId('jvt'),
    code: s.code,
    name: s.name,
    kind: s.kind ?? 'general',
    prefix: s.prefix,
    defaultDescription: s.description ?? s.name,
    defaultDebitAccountId: '',
    defaultCreditAccountId: '',
    requiredDimensions: s.requiredDimensions ?? [],
    approvalRequired: s.approval ?? false,
    allowAutoReversal: s.autoReversal ?? false,
    allowRecurring: s.recurring ?? false,
    allowTaxCodes: s.tax ?? false,
    allowBankAccounts: s.bank ?? false,
    allowAssetRefs: s.asset ?? false,
    requireIntercompany: s.intercompany ?? false,
    warnFormalDocument: s.warnFormal ?? false,
    isSystem: true,
    isActive: true,
  }));
}
