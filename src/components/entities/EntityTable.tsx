import { Users } from 'lucide-react';
import type { BusinessEntity, EntityType } from '@/types';
import { useEntityStore } from '@/store/useEntityStore';
import { useToast } from '@/components/ui/Toast';
import { Icon } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ENTITY_TYPE_OPTIONS, paymentTermsLabel } from '@/data/entityOptions';
import { EntityStatusBadge, EntityTypeBadge } from './EntityBadges';
import { cn } from '@/lib/utils';

interface EntityTableProps {
  entities: BusinessEntity[];
  onEdit: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onAdd: () => void;
  searchActive: boolean;
}

export function EntityTable({
  entities,
  onEdit,
  onRequestDelete,
  onAdd,
  searchActive,
}: EntityTableProps) {
  const setEntityType = useEntityStore((s) => s.setEntityType);
  const setActive = useEntityStore((s) => s.setActive);
  const duplicateEntity = useEntityStore((s) => s.duplicateEntity);
  const { notify } = useToast();

  if (entities.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={searchActive ? 'No entities match your search or filters.' : 'No entities yet.'}
        description={
          searchActive
            ? 'Try clearing the filters or widening your search.'
            : 'Add your first business entity to get started.'
        }
        action={
          !searchActive ? (
            <Button size="sm" onClick={onAdd}>
              <Icon.Plus className="h-4 w-4" /> New entity
            </Button>
          ) : undefined
        }
      />
    );
  }

  const handleDuplicate = (id: string): void => {
    const result = duplicateEntity(id);
    notify(result.ok ? 'Entity duplicated.' : result.error ?? 'Could not duplicate.', result.ok ? 'success' : 'error');
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="table-head-sticky">
          <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">
            <th className="px-4 py-3">Code</th>
            <th className="px-4 py-3">Entity</th>
            <th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Contact</th>
            <th className="px-4 py-3">Location</th>
            <th className="px-4 py-3">Currency</th>
            <th className="px-4 py-3">Terms</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {entities.map((e) => (
            <tr
              key={e.id}
              className={cn(
                'group transition-colors odd:bg-slate-50/30 hover:bg-brand-50/40 dark:odd:bg-slate-800/20 dark:hover:bg-brand-500/5',
                !e.isActive && 'opacity-70',
              )}
            >
              <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                {e.entityCode}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={e.legalName} size="sm" square />
                  <div className="flex flex-col">
                    <span className={cn('font-medium text-slate-800 dark:text-slate-100', !e.isActive && 'line-through decoration-slate-300')}>
                      {e.legalName}
                    </span>
                    {e.tradingName && (
                      <span className="text-xs text-slate-400">{e.tradingName}</span>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-4 py-3">
                <EntityTypeBadge type={e.entityType} />
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col">
                  <span className="text-slate-700 dark:text-slate-200">{e.contactPerson || '—'}</span>
                  {e.email && (
                    <a href={`mailto:${e.email}`} className="text-xs text-brand-600 hover:underline dark:text-brand-300">
                      {e.email}
                    </a>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                {[e.city, e.country].filter(Boolean).join(', ') || '—'}
              </td>
              <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{e.defaultCurrency}</td>
              <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{paymentTermsLabel(e.paymentTerms)}</td>
              <td className="px-4 py-3">
                <EntityStatusBadge isActive={e.isActive} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Select
                    options={ENTITY_TYPE_OPTIONS}
                    value={e.entityType}
                    onChange={(ev) => setEntityType(e.id, ev.target.value as EntityType)}
                    className="h-8 w-[9.5rem] text-xs opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                    aria-label={`Change role for ${e.legalName}`}
                    title="Convert role (customer / supplier / both)"
                  />
                  <RowAction label="Edit entity" onClick={() => onEdit(e.id)}>
                    <Icon.Edit className="h-4 w-4" />
                  </RowAction>
                  <RowAction label="Duplicate entity" onClick={() => handleDuplicate(e.id)}>
                    <Icon.Copy className="h-4 w-4" />
                  </RowAction>
                  <RowAction
                    label={e.isActive ? 'Deactivate' : 'Activate'}
                    onClick={() => setActive(e.id, !e.isActive)}
                  >
                    {e.isActive ? <Icon.Moon className="h-4 w-4" /> : <Icon.Sun className="h-4 w-4" />}
                  </RowAction>
                  <RowAction label="Delete entity" danger onClick={() => onRequestDelete(e.id)}>
                    <Icon.Trash className="h-4 w-4" />
                  </RowAction>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowAction({
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
        'focus-ring flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors',
        danger
          ? 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10'
          : 'hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}
