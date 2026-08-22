import { describe, expect, it } from 'vitest';
import type { Account } from '@/types';
import { eligiblePostingAccounts, postingAccountEligibility } from './accountEligibility';

const account = (over: Partial<Account> = {}): Account => ({
  id: 'leaf', code: '1111', name: 'Cash', type: 'ASSET', parentId: null, level: 1,
  normalBalance: 'DEBIT', ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: 'Current assets',
  ifrsSubcategory: 'Cash and cash equivalents', cashFlowCategory: 'OPERATING', isPostingAccount: true,
  isActive: true, description: '', industryTag: '', sortOrder: 0, createdAt: '', updatedAt: '', ...over,
});

describe('posting account eligibility', () => {
  it('offers active posting leaves but excludes declared and actual parents', () => {
    const parent = account({ id: 'parent', code: '1000', name: 'Assets', isPostingAccount: false });
    const leaf = account({ parentId: parent.id });
    const malformedParent = account({ id: 'bad-parent', code: '1200' });
    const child = account({ id: 'child', parentId: malformedParent.id });
    expect(eligiblePostingAccounts({ accounts: [parent, leaf, malformedParent, child] }).map((a) => a.id)).toEqual(['leaf', 'child']);
  });

  it.each([
    ['inactive', account({ isActive: false })],
    ['blocked', account({ isBlocked: true })],
    ['archived', account({ isArchived: true })],
    ['another entity', account({ entityId: 'other' })],
  ])('excludes %s accounts', (_label, candidate) => {
    expect(postingAccountEligibility(candidate, { accounts: [candidate], activeEntityId: 'active' }).eligible).toBe(false);
  });

  it('enforces supported contextual classification', () => {
    const revenue = account({ id: 'revenue', type: 'INCOME', name: 'Sales', normalBalance: 'CREDIT', ifrsStatement: 'PROFIT_OR_LOSS' });
    expect(postingAccountEligibility(revenue, { accounts: [revenue], purpose: 'revenue' }).eligible).toBe(true);
    expect(postingAccountEligibility(revenue, { accounts: [revenue], purpose: 'inventory-asset' }).message).toBe('Select a valid inventory asset account.');
  });
});
