/**
 * Fixed Assets — default category seed.
 *
 * Categories are seeded ONCE per workspace, with their accounting mappings
 * resolved from the organization's LIVE chart of accounts by name (never a
 * hard-coded account number). Anything that cannot be resolved is left
 * unmapped — posting then rejects with a clear "missing mapping" error until
 * an administrator completes the category configuration.
 */
import type { Account } from '@/types';
import type { AssetCategory, AssetCategoryAccounts, DepreciationMethod } from '@/types/fixedAssets';
import { generateId, nowIso } from '@/lib/utils';

/** First active posting account whose name contains any of the fragments. */
function resolve(accounts: Account[], fragments: string[]): string {
  for (const fragment of fragments) {
    const hit = accounts.find(
      (a) => a.isPostingAccount && a.isActive && a.name.toLowerCase().includes(fragment.toLowerCase()),
    );
    if (hit) return hit.id;
  }
  return '';
}

interface CategorySpec {
  code: string;
  name: string;
  description: string;
  method: DepreciationMethod;
  lifeMonths: number;
  residualRate: number;
  costAliases: string[];
  accumDepAliases?: string[];
  revaluationEnabled?: boolean;
}

const SPECS: CategorySpec[] = [
  { code: 'LAND', name: 'Land', description: 'Freehold land — not depreciated.', method: 'none', lifeMonths: 0, residualRate: 100, costAliases: ['Land and buildings'], revaluationEnabled: true },
  { code: 'BLDG', name: 'Buildings', description: 'Buildings and structural improvements.', method: 'straight_line', lifeMonths: 480, residualRate: 5, costAliases: ['Land and buildings'], revaluationEnabled: true },
  { code: 'MACH', name: 'Machinery', description: 'Plant and machinery.', method: 'straight_line', lifeMonths: 120, residualRate: 5, costAliases: ['Plant and machinery'] },
  { code: 'VEH', name: 'Vehicles', description: 'Motor vehicles.', method: 'reducing_balance', lifeMonths: 60, residualRate: 10, costAliases: ['Motor vehicles'] },
  { code: 'FURN', name: 'Furniture and fixtures', description: 'Furniture, fixtures and office fit-out.', method: 'straight_line', lifeMonths: 84, residualRate: 0, costAliases: ['Furniture, fixtures'] },
  { code: 'COMP', name: 'Computer equipment', description: 'Computers and IT hardware.', method: 'straight_line', lifeMonths: 36, residualRate: 0, costAliases: ['Furniture, fixtures', 'equipment'] },
  { code: 'LHI', name: 'Leasehold improvements', description: 'Improvements to leased premises.', method: 'straight_line', lifeMonths: 60, residualRate: 0, costAliases: ['Furniture, fixtures', 'Leasehold'] },
  { code: 'ROU', name: 'Right-of-use assets', description: 'IFRS 16 lease right-of-use assets.', method: 'straight_line', lifeMonths: 60, residualRate: 0, costAliases: ['Right-of-use'] },
  { code: 'INTG', name: 'Intangible assets', description: 'Software, licences, patents and trademarks.', method: 'straight_line', lifeMonths: 60, residualRate: 0, costAliases: ['Software and licences', 'Intangible'], accumDepAliases: ['Accumulated amortisation'] },
];

export function makeSeedCategories(accounts: Account[]): AssetCategory[] {
  const shared = {
    accumulatedDepreciationAccountId: resolve(accounts, ['Accumulated depreciation']),
    depreciationExpenseAccountId: resolve(accounts, ['Depreciation expense', 'Depreciation and amortisation', 'Depreciation']),
    impairmentLossAccountId: resolve(accounts, ['Impairment loss', 'Impairment']),
    accumulatedImpairmentAccountId: resolve(accounts, ['Accumulated impairment']),
    disposalGainAccountId: resolve(accounts, ['Gain / loss on disposal', 'Gain on disposal', 'disposal of assets']),
    disposalLossAccountId: resolve(accounts, ['Gain / loss on disposal', 'Loss on disposal', 'disposal of assets']),
    aucAccountId: resolve(accounts, ['under construction', 'Capital work in progress']),
    recoverableTaxAccountId: resolve(accounts, ['VAT / sales tax recoverable', 'recoverable', 'Input tax', 'Input VAT']),
    revaluationSurplusAccountId: resolve(accounts, ['Revaluation surplus', 'Revaluation reserve']),
    revaluationLossAccountId: resolve(accounts, ['Revaluation loss', 'Gain / loss on disposal']),
  };
  const now = nowIso();
  return SPECS.map((spec) => {
    const accountsFor: AssetCategoryAccounts = {
      ...shared,
      costAccountId: resolve(accounts, spec.costAliases),
      accumulatedDepreciationAccountId: spec.accumDepAliases
        ? resolve(accounts, spec.accumDepAliases) || shared.accumulatedDepreciationAccountId
        : shared.accumulatedDepreciationAccountId,
    };
    return {
      id: generateId('facat'),
      code: spec.code,
      name: spec.name,
      description: spec.description,
      accounts: accountsFor,
      defaultMethod: spec.method,
      defaultUsefulLifeMonths: spec.lifeMonths,
      defaultResidualRatePercent: spec.residualRate,
      revaluationEnabled: spec.revaluationEnabled ?? false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    } satisfies AssetCategory;
  });
}
