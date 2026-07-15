import type { Account, IFRSStatement } from '@/types';
import type { AccountFilters } from '@/store/useStore';
import { IFRS_STATEMENT_META } from '@/data/ifrsOptions';

export interface ChartStats {
  total: number;
  active: number;
  inactive: number;
  posting: number;
  header: number;
  byStatement: { statement: IFRSStatement; label: string; count: number }[];
}

export function computeStats(accounts: Account[]): ChartStats {
  const byStatement = new Map<IFRSStatement, number>();
  let active = 0;
  let posting = 0;
  for (const a of accounts) {
    if (a.isActive) active += 1;
    if (a.isPostingAccount) posting += 1;
    byStatement.set(a.ifrsStatement, (byStatement.get(a.ifrsStatement) ?? 0) + 1);
  }
  const statements = (Object.keys(IFRS_STATEMENT_META) as IFRSStatement[])
    .map((s) => ({ statement: s, label: IFRS_STATEMENT_META[s].short, count: byStatement.get(s) ?? 0 }))
    .filter((s) => s.count > 0);

  return {
    total: accounts.length,
    active,
    inactive: accounts.length - active,
    posting,
    header: accounts.length - posting,
    byStatement: statements,
  };
}

/** Whether a single account matches the free-text search. */
export function matchesSearch(account: Account, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  return (
    account.code.toLowerCase().includes(q) ||
    account.name.toLowerCase().includes(q) ||
    account.ifrsCategory.toLowerCase().includes(q) ||
    account.ifrsSubcategory.toLowerCase().includes(q) ||
    account.description.toLowerCase().includes(q)
  );
}

/** Whether a single account matches the structured filters. */
export function matchesFilters(account: Account, filters: AccountFilters): boolean {
  if (filters.type !== 'ALL' && account.type !== filters.type) return false;
  if (filters.statement !== 'ALL' && account.ifrsStatement !== filters.statement) return false;
  if (filters.status === 'active' && !account.isActive) return false;
  if (filters.status === 'inactive' && account.isActive) return false;
  if (filters.kind === 'posting' && !account.isPostingAccount) return false;
  if (filters.kind === 'header' && account.isPostingAccount) return false;
  return true;
}

export function filterAccounts(
  accounts: Account[],
  query: string,
  filters: AccountFilters,
): Account[] {
  return accounts.filter(
    (a) => matchesSearch(a, query) && matchesFilters(a, filters),
  );
}

/**
 * Given a set of accounts that match a filter, expand to include all ancestors
 * so the tree stays navigable (ancestors are shown but visually de-emphasised).
 */
export function withAncestors(
  accounts: Account[],
  matchedIds: Set<string>,
): Set<string> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const result = new Set(matchedIds);
  for (const id of matchedIds) {
    let current = byId.get(id);
    let guard = 0;
    while (current?.parentId && guard < 64) {
      result.add(current.parentId);
      current = byId.get(current.parentId);
      guard += 1;
    }
  }
  return result;
}
