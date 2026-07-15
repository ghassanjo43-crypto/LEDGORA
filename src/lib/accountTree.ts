import type { Account } from '@/types';

export interface AccountTreeNode {
  account: Account;
  children: AccountTreeNode[];
  depth: number;
}

/** Build a nested tree from a flat account list, respecting sortOrder then code. */
export function buildTree(accounts: Account[]): AccountTreeNode[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, Account[]>();

  for (const acc of accounts) {
    // Orphaned accounts (missing parent) are treated as roots so they stay visible.
    const parentKey = acc.parentId && byId.has(acc.parentId) ? acc.parentId : null;
    const list = childrenOf.get(parentKey) ?? [];
    list.push(acc);
    childrenOf.set(parentKey, list);
  }

  const sortSiblings = (list: Account[]): Account[] =>
    [...list].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.code.localeCompare(b.code);
    });

  const build = (parentKey: string | null, depth: number): AccountTreeNode[] =>
    sortSiblings(childrenOf.get(parentKey) ?? []).map((account) => ({
      account,
      depth,
      children: build(account.id, depth + 1),
    }));

  return build(null, 0);
}

/** Flatten a tree back into a list following display order. */
export function flattenTree(nodes: AccountTreeNode[]): Account[] {
  const out: Account[] = [];
  const walk = (list: AccountTreeNode[]): void => {
    for (const node of list) {
      out.push(node.account);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** All descendant ids of an account (excludes the account itself). */
export function getDescendantIds(accounts: Account[], accountId: string): string[] {
  const childrenOf = new Map<string, Account[]>();
  for (const acc of accounts) {
    if (!acc.parentId) continue;
    const list = childrenOf.get(acc.parentId) ?? [];
    list.push(acc);
    childrenOf.set(acc.parentId, list);
  }
  const result: string[] = [];
  const stack = [...(childrenOf.get(accountId) ?? [])];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    result.push(current.id);
    stack.push(...(childrenOf.get(current.id) ?? []));
  }
  return result;
}

/** Direct children of an account. */
export function getChildren(accounts: Account[], accountId: string): Account[] {
  return accounts.filter((a) => a.parentId === accountId);
}

/**
 * Would setting `candidateParentId` as the parent of `accountId` create a cycle?
 * True if the candidate is the account itself or one of its descendants.
 */
export function wouldCreateCycle(
  accounts: Account[],
  accountId: string,
  candidateParentId: string | null,
): boolean {
  if (!candidateParentId) return false;
  if (candidateParentId === accountId) return true;
  return getDescendantIds(accounts, accountId).includes(candidateParentId);
}

/** Recompute the `level` of every account from its parent chain. */
export function recomputeLevels(accounts: Account[]): Account[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const levelCache = new Map<string, number>();

  const levelOf = (acc: Account, guard = 0): number => {
    if (guard > 64) return 0; // safety against malformed cycles
    if (levelCache.has(acc.id)) return levelCache.get(acc.id) as number;
    if (!acc.parentId || !byId.has(acc.parentId)) {
      levelCache.set(acc.id, 0);
      return 0;
    }
    const parent = byId.get(acc.parentId) as Account;
    const lvl = levelOf(parent, guard + 1) + 1;
    levelCache.set(acc.id, lvl);
    return lvl;
  };

  return accounts.map((a) => ({ ...a, level: levelOf(a) }));
}

/** Human-readable path, e.g. "Assets › Current assets › Trade receivables". */
export function getAccountPath(accounts: Account[], accountId: string): string {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const parts: string[] = [];
  let current = byId.get(accountId);
  let guard = 0;
  while (current && guard < 64) {
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return parts.join(' › ');
}
