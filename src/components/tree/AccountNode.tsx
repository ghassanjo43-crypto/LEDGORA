import { useState } from 'react';
import type { AccountType } from '@/types';
import type { AccountTreeNode } from '@/lib/accountTree';
import { ACCOUNT_TYPE_OPTIONS } from '@/data/ifrsOptions';
import { useStore } from '@/store/useStore';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Icon } from '@/components/ui/icons';
import {
  BalanceBadge,
  KindBadge,
  StatementBadge,
  StatusBadge,
  TypeBadge,
} from '@/components/shared/AccountBadges';
import { AccountDot } from '@/components/shared/AccountChip';
import { cn } from '@/lib/utils';

export interface TreeCallbacks {
  onEdit: (accountId: string) => void;
  onAddChild: (parentId: string) => void;
  onRequestDelete: (accountId: string) => void;
}

export interface TreeViewState {
  callbacks: TreeCallbacks;
  collapsedIds: Record<string, true>;
  onToggleCollapse: (id: string) => void;
  /** Ids that should be rendered (matches + their ancestors). Null = show all. */
  visibleIds: Set<string> | null;
  /** Ids that directly match the search/filter (rendered at full opacity). */
  matchedIds: Set<string> | null;
  dragId: string | null;
  setDragId: (id: string | null) => void;
}

export function AccountNode({
  node,
  view,
}: {
  node: AccountTreeNode;
  view: TreeViewState;
}) {
  const { account, depth, children } = node;
  const { callbacks, collapsedIds, onToggleCollapse, visibleIds, matchedIds } = view;

  const quickUpdate = useStore((s) => s.quickUpdate);
  const duplicateAccount = useStore((s) => s.duplicateAccount);
  const setActive = useStore((s) => s.setActive);
  const moveAccount = useStore((s) => s.moveAccount);
  const reorderSibling = useStore((s) => s.reorderSibling);
  const { notify } = useToast();

  const [editing, setEditing] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const [draft, setDraft] = useState({
    code: account.code,
    name: account.name,
    type: account.type,
  });

  const collapsed = !!collapsedIds[account.id];
  const matched = matchedIds ? matchedIds.has(account.id) : true;
  const visibleChildren = children.filter(
    (c) => !visibleIds || visibleIds.has(c.account.id),
  );
  const hasChildren = visibleChildren.length > 0;

  const startEdit = (): void => {
    setDraft({ code: account.code, name: account.name, type: account.type });
    setEditing(true);
  };

  const saveInline = (): void => {
    const result = quickUpdate(account.id, {
      code: draft.code.trim(),
      name: draft.name.trim(),
      type: draft.type,
    });
    if (result.ok) {
      setEditing(false);
      notify('Account updated.', 'success');
    } else {
      notify(result.error ?? 'Update failed.', 'error');
    }
  };

  const handleDuplicate = (): void => {
    const result = duplicateAccount(account.id);
    notify(
      result.ok ? 'Account duplicated.' : result.error ?? 'Could not duplicate.',
      result.ok ? 'success' : 'error',
    );
  };

  const indent = 12 + depth * 20;

  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={(e) => {
          view.setDragId(account.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          view.setDragId(null);
          setDropTarget(false);
        }}
        onDragOver={(e) => {
          if (view.dragId && view.dragId !== account.id) {
            e.preventDefault();
            setDropTarget(true);
          }
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(false);
          if (view.dragId && view.dragId !== account.id) {
            const result = reorderSibling(view.dragId, account.id);
            if (!result.ok) notify(result.error ?? 'Could not reorder.', 'warning');
          }
          view.setDragId(null);
        }}
        className={cn(
          'group flex items-center gap-2 border-b border-slate-100 py-2.5 pr-2 transition-colors dark:border-slate-800/60',
          !matched && 'opacity-55',
          dropTarget && 'bg-brand-50 ring-1 ring-inset ring-brand-300 dark:bg-brand-500/10',
          !account.isActive && 'bg-slate-50/60 dark:bg-slate-900/40',
        )}
        style={{ paddingLeft: indent }}
      >
        <button
          type="button"
          onClick={() => hasChildren && onToggleCollapse(account.id)}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 transition-colors',
            hasChildren ? 'hover:bg-slate-200 dark:hover:bg-slate-700' : 'invisible',
          )}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          <Icon.Chevron className={cn('h-4 w-4 transition-transform', !collapsed && 'rotate-90')} />
        </button>

        <span
          className="hidden shrink-0 cursor-grab text-slate-300 group-hover:text-slate-400 dark:text-slate-600 sm:block"
          title="Drag to reorder among siblings"
        >
          <Icon.Grip className="h-4 w-4" />
        </span>

        {editing ? (
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <Input
              value={draft.code}
              onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
              className="h-8 w-24"
              aria-label="Code"
            />
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="h-8 min-w-[10rem] flex-1"
              aria-label="Name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveInline();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <Select
              value={draft.type}
              options={ACCOUNT_TYPE_OPTIONS}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as AccountType }))}
              className="h-8 w-48"
              aria-label="Type"
            />
            <Button size="sm" onClick={saveInline}>
              <Icon.Check className="h-4 w-4" /> Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onDoubleClick={startEdit}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              title="Double-click to edit inline"
            >
              <AccountDot type={account.type} />
              <span className="shrink-0 font-mono text-xs font-semibold text-slate-500 dark:text-slate-400">
                {account.code}
              </span>
              <span
                className={cn(
                  'truncate text-sm',
                  account.isPostingAccount
                    ? 'text-slate-700 dark:text-slate-200'
                    : 'font-semibold text-slate-900 dark:text-slate-100',
                  !account.isActive && 'line-through decoration-slate-300',
                )}
              >
                {account.name}
              </span>
            </button>

            <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
              <TypeBadge type={account.type} />
              <StatementBadge statement={account.ifrsStatement} />
              <KindBadge isPosting={account.isPostingAccount} />
              <BalanceBadge normalBalance={account.normalBalance} />
              {!account.isActive && <StatusBadge isActive={false} />}
            </div>

            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <IconAction label="Move up" onClick={() => moveAccount(account.id, 'up')}>
                <Icon.ArrowUp className="h-4 w-4" />
              </IconAction>
              <IconAction label="Move down" onClick={() => moveAccount(account.id, 'down')}>
                <Icon.ArrowDown className="h-4 w-4" />
              </IconAction>
              {!account.isPostingAccount && (
                <IconAction label="Add child account" onClick={() => callbacks.onAddChild(account.id)}>
                  <Icon.Plus className="h-4 w-4" />
                </IconAction>
              )}
              <IconAction label="Edit account" onClick={() => callbacks.onEdit(account.id)}>
                <Icon.Edit className="h-4 w-4" />
              </IconAction>
              <IconAction label="Duplicate account" onClick={handleDuplicate}>
                <Icon.Copy className="h-4 w-4" />
              </IconAction>
              <IconAction
                label={account.isActive ? 'Deactivate' : 'Activate'}
                onClick={() => setActive(account.id, !account.isActive)}
              >
                {account.isActive ? <Icon.Moon className="h-4 w-4" /> : <Icon.Sun className="h-4 w-4" />}
              </IconAction>
              <IconAction label="Delete account" danger onClick={() => callbacks.onRequestDelete(account.id)}>
                <Icon.Trash className="h-4 w-4" />
              </IconAction>
            </div>
          </>
        )}
      </div>

      {hasChildren && !collapsed && (
        <div>
          {visibleChildren.map((child) => (
            <AccountNode key={child.account.id} node={child} view={view} />
          ))}
        </div>
      )}
    </div>
  );
}

function IconAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'focus-ring flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors',
        danger
          ? 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10'
          : 'hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}
