import { useMemo, useState } from 'react';
import { ListTree, SearchX } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { buildTree } from '@/lib/accountTree';
import { filterAccounts, withAncestors } from '@/lib/selectors';
import { AccountNode, type TreeCallbacks, type TreeViewState } from './AccountNode';
import { EmptyState } from '@/components/ui/EmptyState';

export function AccountTree({ callbacks }: { callbacks: TreeCallbacks }) {
  const accounts = useStore((s) => s.accounts);
  const search = useStore((s) => s.search);
  const filters = useStore((s) => s.filters);
  const collapsedIds = useStore((s) => s.collapsedIds);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);

  const [dragId, setDragId] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(accounts), [accounts]);

  const { visibleIds, matchedIds } = useMemo(() => {
    const isFiltered =
      !!search ||
      filters.type !== 'ALL' ||
      filters.statement !== 'ALL' ||
      filters.status !== 'all' ||
      filters.kind !== 'all';
    if (!isFiltered) return { visibleIds: null, matchedIds: null };
    const matched = filterAccounts(accounts, search, filters);
    const matchedSet = new Set(matched.map((a) => a.id));
    const visible = withAncestors(accounts, matchedSet);
    return { visibleIds: visible, matchedIds: matchedSet };
  }, [accounts, search, filters]);

  const view: TreeViewState = {
    callbacks,
    collapsedIds,
    onToggleCollapse: toggleCollapsed,
    visibleIds,
    matchedIds,
    dragId,
    setDragId,
  };

  const roots = tree.filter((n) => !visibleIds || visibleIds.has(n.account.id));

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={ListTree}
        title="No accounts yet."
        description="Add your first account or reset to the default IFRS-aligned chart."
      />
    );
  }

  if (roots.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No accounts match your search or filters."
        description="Try clearing the filters or broadening your search."
        compact
      />
    );
  }

  return (
    <div className="divide-y divide-transparent">
      {roots.map((node) => (
        <AccountNode key={node.account.id} node={node} view={view} />
      ))}
    </div>
  );
}
