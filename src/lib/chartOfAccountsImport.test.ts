/**
 * Copying the browser's balance-sheet chart to the accounting service.
 *
 * The bug behind this: `listEligibleAccounts` reads the SERVER's `accounts`
 * table, nothing in the frontend had ever written to it, and so the opening
 * balance page showed "0 accounts" for every subscriber — while a complete
 * chart sat in the browser two menu items away.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Account } from '@/types';
import { balanceSheetAccounts, toServerAccount, importBalanceSheetChart } from './chartOfAccountsImport';
import { accountingApi } from '@/services/api/accountingApi';

const account = (over: Partial<Account> & Pick<Account, 'id' | 'code' | 'name' | 'type'>): Account => ({
  parentId: null, level: 0, normalBalance: 'DEBIT', ifrsStatement: 'SFP', ifrsCategory: '',
  ifrsSubcategory: '', cashFlowCategory: 'OPERATING', isPostingAccount: true, isActive: true,
  description: '', industryTag: '', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as Account);

const CHART: Account[] = [
  account({ id: 'a', code: '1000', name: 'Assets', type: 'ASSET', level: 0, isPostingAccount: false }),
  account({ id: 'a1', code: '1100', name: 'Cash', type: 'ASSET', level: 1, parentId: 'a' }),
  account({ id: 'l', code: '2000', name: 'Loans', type: 'LIABILITY', level: 0, normalBalance: 'CREDIT' }),
  account({ id: 'e', code: '3000', name: 'Capital', type: 'EQUITY', level: 0, normalBalance: 'CREDIT' }),
  account({ id: 'i', code: '4000', name: 'Sales', type: 'INCOME', level: 0, normalBalance: 'CREDIT' }),
  account({ id: 'x', code: '5000', name: 'Rent', type: 'OPERATING_EXPENSE', level: 0 }),
];

beforeEach(() => { vi.restoreAllMocks(); });

describe('selecting what to import', () => {
  it('takes only the types that map to the server without invention', () => {
    /*
     * The browser splits the income statement five ways where the server has
     * `income` and `expense`. Rather than guess that mapping, the import copies
     * the balance-sheet types — which are one-to-one, and are the only ones
     * opening balances can use anyway.
     */
    expect(balanceSheetAccounts(CHART).map((a) => a.code)).toEqual(['1000', '1100', '2000', '3000']);
  });
});

describe('translating one account', () => {
  it('carries posting state, normal balance and parentage across the vocabularies', () => {
    expect(toServerAccount(CHART[1]!, 'server-parent')).toMatchObject({
      accountCode: '1100', accountName: 'Cash', accountType: 'asset',
      normalBalance: 'debit', parentAccountId: 'server-parent', isPostable: true, active: true,
    });
    expect(toServerAccount(CHART[2]!, null)).toMatchObject({ accountType: 'liability', normalBalance: 'credit' });
  });

  it('marks a header account non-postable, so the server refuses postings to it', () => {
    expect(toServerAccount(CHART[0]!, null).isPostable).toBe(false);
  });
});

describe('running the import', () => {
  it('creates parents before children and links them by server id', async () => {
    const created: Array<{ code: string; parent: string | null }> = [];
    vi.spyOn(accountingApi, 'create').mockImplementation(async (input) => {
      created.push({ code: input.accountCode, parent: input.parentAccountId ?? null });
      return { id: `srv-${input.accountCode}`, accountCode: input.accountCode, accountName: input.accountName,
        accountType: input.accountType, parentAccountId: input.parentAccountId ?? null, isPostable: true };
    });

    const outcome = await importBalanceSheetChart(CHART, new Set());

    expect(outcome).toMatchObject({ created: 4, skipped: 0, failures: [] });
    // The parent is created first, and the child points at the id it returned —
    // not at the browser's own id, which the server has never seen.
    expect(created.map((c) => c.code)).toEqual(['1000', '2000', '3000', '1100']);
    expect(created.find((c) => c.code === '1100')!.parent).toBe('srv-1000');
  });

  it('skips codes the server already holds, so a re-run is safe', async () => {
    const create = vi.spyOn(accountingApi, 'create').mockResolvedValue({
      id: 'srv-1', accountCode: '3000', accountName: 'Capital', accountType: 'equity',
      parentAccountId: null, isPostable: true,
    });

    const outcome = await importBalanceSheetChart(CHART, new Set(['1000', '1100', '2000']));

    expect(outcome).toMatchObject({ created: 1, skipped: 3 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports a refused account instead of failing the whole import', async () => {
    vi.spyOn(accountingApi, 'create').mockImplementation(async (input) => {
      if (input.accountCode === '2000') throw new Error('Account code already in use.');
      return { id: `srv-${input.accountCode}`, accountCode: input.accountCode, accountName: input.accountName,
        accountType: input.accountType, parentAccountId: null, isPostable: true };
    });

    const outcome = await importBalanceSheetChart(CHART, new Set());

    expect(outcome.created).toBe(3);
    expect(outcome.failures).toEqual([
      { code: '2000', name: 'Loans', reason: 'Account code already in use.' },
    ]);
  });
});
