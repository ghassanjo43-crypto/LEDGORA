import type { Account, AccountType } from '@/types';

export type AccountPurpose = 'general-journal' | 'revenue' | 'purchase-expense' | 'inventory-asset' | 'cogs' | 'accounts-receivable' | 'accounts-payable' | 'bank-cash' | 'input-tax' | 'output-tax';
export type AccountIneligibilityReason = 'missing' | 'other-entity' | 'inactive' | 'unavailable' | 'not-posting-enabled' | 'has-children' | 'wrong-purpose';
export interface AccountEligibilityContext { accounts: readonly Account[]; activeEntityId?: string; purpose?: AccountPurpose }
export interface AccountEligibilityResult { eligible: boolean; reason?: AccountIneligibilityReason; message?: string }

const PURPOSE_LABELS: Record<AccountPurpose, string> = { 'general-journal': 'posting', revenue: 'revenue', 'purchase-expense': 'purchase expense', 'inventory-asset': 'inventory asset', cogs: 'COGS or direct-cost', 'accounts-receivable': 'accounts receivable', 'accounts-payable': 'accounts payable', 'bank-cash': 'cash or bank', 'input-tax': 'input tax asset', 'output-tax': 'output tax liability' };
const accountText = (account: Account): string => `${account.ifrsCategory} ${account.ifrsSubcategory} ${account.name}`.toLowerCase();

/** Context classification is intentionally limited to signals already carried by Account. */
export function accountMatchesPurpose(account: Account, purpose: AccountPurpose): boolean {
  const value = accountText(account);
  const typeIn = (...types: AccountType[]) => types.includes(account.type);
  switch (purpose) {
    case 'general-journal': return true;
    case 'revenue': return account.type === 'INCOME';
    case 'purchase-expense': return typeIn('COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME_EXPENSE', 'FINANCE');
    case 'inventory-asset': return account.type === 'ASSET' && /inventor|stock/.test(value);
    case 'cogs': return account.type === 'COST_OF_SALES';
    case 'accounts-receivable': return account.type === 'ASSET' && /receiv|trade debtor/.test(value);
    case 'accounts-payable': return account.type === 'LIABILITY' && /payable|trade creditor/.test(value);
    case 'bank-cash': return account.type === 'ASSET' && /cash|bank/.test(value);
    case 'input-tax': return account.type === 'ASSET' && /tax|vat|gst/.test(value);
    case 'output-tax': return account.type === 'LIABILITY' && /tax|vat|gst/.test(value);
  }
}

/** Single authoritative rule for accounts used by new postings and mappings. */
export function postingAccountEligibility(account: Account | undefined, context: AccountEligibilityContext): AccountEligibilityResult {
  if (!account) return { eligible: false, reason: 'missing', message: 'The selected account does not exist.' };
  if (context.activeEntityId && account.entityId && account.entityId !== context.activeEntityId) return { eligible: false, reason: 'other-entity', message: 'This account belongs to a different entity.' };
  if (!account.isActive) return { eligible: false, reason: 'inactive', message: 'Select an active posting account. This account is inactive.' };
  if (account.isBlocked || account.isArchived) return { eligible: false, reason: 'unavailable', message: 'This account is not available for new postings.' };
  if (!account.isPostingAccount) return { eligible: false, reason: 'not-posting-enabled', message: 'Select a posting account. Parent accounts cannot receive transactions.' };
  if (context.accounts.some((candidate) => candidate.parentId === account.id)) return { eligible: false, reason: 'has-children', message: 'Select a posting account. Parent accounts cannot receive transactions.' };
  if (context.purpose && !accountMatchesPurpose(account, context.purpose)) return { eligible: false, reason: 'wrong-purpose', message: `Select a valid ${PURPOSE_LABELS[context.purpose]} account.` };
  return { eligible: true };
}

export function eligiblePostingAccounts(context: AccountEligibilityContext): Account[] {
  return context.accounts.filter((account) => postingAccountEligibility(account, context).eligible);
}

export function postingAccountOptions(context: AccountEligibilityContext, emptyLabel = 'Select a posting account'): Array<{ value: string; label: string }> {
  return [{ value: '', label: emptyLabel }, ...eligiblePostingAccounts(context).sort((a, b) => a.code.localeCompare(b.code)).map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` }))];
}
