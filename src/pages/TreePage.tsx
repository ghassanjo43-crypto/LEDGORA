import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { getDescendantIds } from '@/lib/accountTree';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';
import { SearchAndFilterBar } from '@/components/shared/SearchAndFilterBar';
import { AccountTree } from '@/components/tree/AccountTree';
import type { TreeCallbacks } from '@/components/tree/AccountNode';
import { AccountFormDrawer, type FormMode } from '@/components/account/AccountFormDrawer';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';

export function TreePage() {
  const accounts = useStore((s) => s.accounts);
  const deleteAccount = useStore((s) => s.deleteAccount);
  const setAllCollapsed = useStore((s) => s.setAllCollapsed);
  const { notify } = useToast();

  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const callbacks: TreeCallbacks = useMemo(
    () => ({
      onEdit: (accountId) => setFormMode({ kind: 'edit', accountId }),
      onAddChild: (parentId) => setFormMode({ kind: 'create', parentId }),
      onRequestDelete: (accountId) => setPendingDeleteId(accountId),
    }),
    [],
  );

  const pendingDelete = pendingDeleteId
    ? accounts.find((a) => a.id === pendingDeleteId)
    : undefined;
  const descendantCount = pendingDeleteId
    ? getDescendantIds(accounts, pendingDeleteId).length
    : 0;

  const confirmDelete = (): void => {
    if (!pendingDeleteId) return;
    const result = deleteAccount(pendingDeleteId, true);
    notify(
      result.ok ? 'Account deleted.' : result.error ?? 'Could not delete account.',
      result.ok ? 'success' : 'error',
    );
    setPendingDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Account hierarchy"
          description={`${accounts.length} accounts. Double-click a row to edit inline, or drag to reorder siblings.`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAllCollapsed(false)}>
                <Icon.ChevronDown className="h-4 w-4" /> Expand all
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAllCollapsed(true)}>
                <Icon.Chevron className="h-4 w-4" /> Collapse all
              </Button>
              <Button size="sm" onClick={() => setFormMode({ kind: 'create', parentId: null })}>
                <Icon.Plus className="h-4 w-4" /> New account
              </Button>
            </div>
          }
        />
        <CardBody className="space-y-4">
          <SearchAndFilterBar />
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <AccountTree callbacks={callbacks} />
          </div>
        </CardBody>
      </Card>

      <AccountFormDrawer
        open={formMode !== null}
        mode={formMode}
        onClose={() => setFormMode(null)}
      />

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete account?"
        message={
          descendantCount > 0 ? (
            <>
              <strong>{pendingDelete?.name}</strong> has{' '}
              <strong>{descendantCount}</strong> descendant account
              {descendantCount === 1 ? '' : 's'}. Deleting it will also delete
              all of them. This cannot be undone.
            </>
          ) : (
            <>
              Delete <strong>{pendingDelete?.name}</strong> ({pendingDelete?.code})?
              This cannot be undone.
            </>
          )
        }
        confirmLabel={descendantCount > 0 ? 'Delete all' : 'Delete'}
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
