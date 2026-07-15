import type { Account } from '@/types';
import type { TaxCode, TaxRateVersion } from '@/types/taxCode';
import { isPostingAccount } from '@/lib/journalValidation';
import { hasOverlappingRateVersion } from '@/lib/taxResolution';

export interface TaxIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

const TAXABLE_CATEGORIES: TaxCode['category'][] = ['standard', 'reduced', 'reverse-charge', 'import', 'self-assessed', 'custom'];
export function isTaxableCategory(c: TaxCode['category']): boolean {
  return TAXABLE_CATEGORIES.includes(c);
}

/** Drafts may be incomplete — only flag corrupt data. */
export function validateTaxCodeDraft(code: Pick<TaxCode, 'rate' | 'rateType' | 'precision'>): TaxIssue[] {
  const issues: TaxIssue[] = [];
  if (Number(code.rate) < 0) issues.push({ severity: 'error', rule: 'negative-rate', message: 'Tax rate cannot be negative.' });
  if (code.rateType === 'percentage' && Number(code.rate) > 100) issues.push({ severity: 'error', rule: 'rate-range', message: 'A percentage rate cannot exceed 100%.' });
  if (Number(code.precision) < 0 || Number(code.precision) > 6) issues.push({ severity: 'error', rule: 'precision', message: 'Precision must be between 0 and 6.' });
  return issues;
}

export interface TaxCodeActivationContext {
  accountsById: Map<string, Account>;
  existingCodes: TaxCode[];
  versions: TaxRateVersion[];
}

/**
 * Full activation validation (§28). A tax code may only be activated when it is
 * uniquely coded, correctly rated, has the account mappings its category needs,
 * and has no overlapping rate versions.
 */
export function validateTaxCodeForActivation(code: TaxCode, ctx: TaxCodeActivationContext): TaxIssue[] {
  const issues: TaxIssue[] = [...validateTaxCodeDraft(code)];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });
  const posting = (id: string | undefined): boolean => !!id && isPostingAccount(ctx.accountsById.get(id));

  if (!code.code.trim()) err('code', 'A tax code is required.');
  else {
    const dupe = ctx.existingCodes.some((c) => c.id !== code.id && c.code.trim().toLowerCase() === code.code.trim().toLowerCase() && (c.entityId ?? '') === (code.entityId ?? '') && (c.jurisdictionId ?? '') === (code.jurisdictionId ?? ''));
    if (dupe) err('code-unique', `Tax code "${code.code}" already exists in this entity/jurisdiction.`);
  }
  if (!code.name.trim()) err('name', 'A tax name is required.');
  if (!code.category) err('category', 'A tax category is required.');
  if (!code.direction) err('direction', 'A tax direction is required.');
  if (!code.calculationMethod) err('method', 'A calculation method is required.');
  if (!code.effectiveFrom) err('effective-from', 'An effective-from date is required.');
  if (code.effectiveTo && code.effectiveTo < code.effectiveFrom) err('effective-range', 'Effective-to cannot precede effective-from.');

  const taxable = isTaxableCategory(code.category);
  const sales = code.direction === 'sales' || code.direction === 'both';
  const purchase = code.direction === 'purchase' || code.direction === 'both';

  if (taxable && code.category !== 'reverse-charge') {
    if (sales && !posting(code.outputTaxAccountId)) err('output-account', 'A taxable sales code needs a posting output-tax account.');
    if (purchase && !posting(code.inputTaxAccountId)) err('input-account', 'A taxable purchase code needs a posting input-tax account.');
  }
  if (code.category === 'reverse-charge') {
    if (!posting(code.reverseChargeOutputAccountId)) err('rc-output', 'Reverse charge needs a posting reverse-charge output account.');
    if (!posting(code.reverseChargeInputAccountId)) err('rc-input', 'Reverse charge needs a posting reverse-charge input account.');
  }
  if (code.category === 'withholding' || code.direction === 'withholding-payable' || code.direction === 'withholding-receivable') {
    if (!posting(code.withholdingAccountId)) err('wht-account', 'A withholding code needs a posting withholding account.');
  }
  if ((code.recoverabilityPercent ?? 100) < 100 && code.nonRecoverableAccountId && !posting(code.nonRecoverableAccountId)) {
    err('non-recoverable-account', 'The non-recoverable account must be a posting account.');
  }
  if (taxable && code.reportingBoxIds.length === 0) issues.push({ severity: 'warning', rule: 'reporting-box', message: 'No reporting box is mapped — this code will not appear on the tax return.' });

  // Overlapping rate versions.
  const codeVersions = ctx.versions.filter((v) => v.taxCodeId === code.id).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (const v of codeVersions) {
    if (hasOverlappingRateVersion(codeVersions, code.id, v.effectiveFrom, v.effectiveTo, v.id)) {
      err('overlap', 'Rate versions have overlapping effective periods.');
      break;
    }
  }

  // Duplicate active defaults.
  const dupDefault = (flag: keyof TaxCode, label: string) => {
    if (code[flag] && code.status === 'active') {
      const other = ctx.existingCodes.find((c) => c.id !== code.id && c.status === 'active' && c[flag] && (c.entityId ?? '') === (code.entityId ?? ''));
      if (other) err('duplicate-default', `Another active code (${other.code}) is already the ${label} default.`);
    }
  };
  dupDefault('isDefaultSales', 'sales');
  dupDefault('isDefaultPurchase', 'purchase');
  dupDefault('isDefaultExport', 'export');
  dupDefault('isDefaultImport', 'import');

  return issues;
}

/** Validate a code is usable on a transaction dated `date`. */
export function validateTaxCodeForTransaction(code: TaxCode | undefined, date: string): TaxIssue[] {
  const issues: TaxIssue[] = [];
  if (!code) return [{ severity: 'error', rule: 'missing', message: 'The selected tax code no longer exists.' }];
  if (code.status !== 'active') issues.push({ severity: 'error', rule: 'inactive', message: `Tax code ${code.code} is ${code.status} and cannot be used on new transactions.` });
  if (code.effectiveFrom > date) issues.push({ severity: 'error', rule: 'not-yet-effective', message: `Tax code ${code.code} is not effective until ${code.effectiveFrom}.` });
  if (code.effectiveTo && code.effectiveTo < date) issues.push({ severity: 'error', rule: 'expired', message: `Tax code ${code.code} expired on ${code.effectiveTo}.` });
  return issues;
}

export function canActivateTaxCode(code: TaxCode, ctx: TaxCodeActivationContext): boolean {
  return validateTaxCodeForActivation(code, ctx).every((i) => i.severity !== 'error');
}
