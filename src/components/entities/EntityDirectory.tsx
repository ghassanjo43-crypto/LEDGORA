import { useMemo, useRef, useState } from 'react';
import { useEntityStore } from '@/store/useEntityStore';
import {
  computeEntityStats,
  distinctValues,
  filterEntities,
  scopeEntities,
  type EntityFilters,
  type EntityScope,
  DEFAULT_ENTITY_FILTERS,
} from '@/lib/entitySelectors';
import {
  exportEntitiesToCsv,
  exportEntitiesToJson,
  importEntitiesFromCsv,
  importEntitiesFromJson,
} from '@/lib/entityImportExport';
import { downloadFile } from '@/lib/utils';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { EntityDashboardCards } from './EntityDashboardCards';
import { EntitySearchFilterBar } from './EntitySearchFilterBar';
import { EntityTable } from './EntityTable';
import { EntityFormDrawer, type EntityFormMode } from './EntityFormDrawer';

interface EntityDirectoryProps {
  scope: EntityScope;
  title: string;
  description: string;
}

const SCOPE_DEFAULT_TYPE = {
  all: 'customer',
  customer: 'customer',
  supplier: 'supplier',
} as const;

export function EntityDirectory({ scope, title, description }: EntityDirectoryProps) {
  const entities = useEntityStore((s) => s.entities);
  const deleteEntity = useEntityStore((s) => s.deleteEntity);
  const replaceAll = useEntityStore((s) => s.replaceAll);
  const { notify } = useToast();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<EntityFilters>(DEFAULT_ENTITY_FILTERS);
  const [formMode, setFormMode] = useState<EntityFormMode | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scoped = useMemo(() => scopeEntities(entities, scope), [entities, scope]);
  const stats = useMemo(() => computeEntityStats(entities), [entities]);
  const countries = useMemo(() => distinctValues(entities, 'country'), [entities]);
  const currencies = useMemo(() => distinctValues(entities, 'defaultCurrency'), [entities]);

  const visible = useMemo(
    () => filterEntities(scoped, search, filters),
    [scoped, search, filters],
  );

  const searchActive =
    !!search ||
    filters.type !== DEFAULT_ENTITY_FILTERS.type ||
    filters.country !== '' ||
    filters.currency !== '' ||
    filters.status !== 'all';

  const pendingDelete = pendingDeleteId
    ? entities.find((e) => e.id === pendingDeleteId)
    : undefined;

  const confirmDelete = (): void => {
    if (!pendingDeleteId) return;
    const result = deleteEntity(pendingDeleteId);
    notify(result.ok ? 'Entity deleted.' : result.error ?? 'Could not delete.', result.ok ? 'success' : 'error');
    setPendingDeleteId(null);
  };

  const slug = scope === 'all' ? 'business-entities' : scope === 'customer' ? 'customers' : 'suppliers';
  const stamp = new Date().toISOString().slice(0, 10);

  const handleExport = (format: 'csv' | 'json'): void => {
    const data = scoped;
    if (format === 'json') {
      downloadFile(`${slug}-${stamp}.json`, exportEntitiesToJson(data), 'application/json');
    } else {
      downloadFile(`${slug}-${stamp}.csv`, exportEntitiesToCsv(data), 'text/csv');
    }
    notify(`Exported ${data.length} entities as ${format.toUpperCase()}.`, 'success');
  };

  const handleImportFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith('.json');
    const result = isJson ? importEntitiesFromJson(text) : importEntitiesFromCsv(text);

    if (result.entities.length === 0) {
      const first = result.issues[0]?.message ?? 'Could not parse the file.';
      notify(`Import failed: ${first}`, 'error');
      return;
    }
    if (!result.ok) {
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      notify(`Import blocked — ${errors} validation error(s). Fix the file and retry.`, 'error');
      return;
    }
    replaceAll(result.entities);
    notify(`Imported ${result.entities.length} entities.`, 'success');
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) void handleImportFile(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-5">
      <EntityDashboardCards stats={stats} />

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        onChange={onInputChange}
        className="hidden"
      />

      <Card>
        <CardHeader
          title={title}
          description={description}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleExport('csv')} title="Export scope to CSV">
                <Icon.Download className="h-4 w-4" /> CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleExport('json')} title="Export scope to JSON">
                <Icon.Download className="h-4 w-4" /> JSON
              </Button>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Icon.Upload className="h-4 w-4" /> Import
              </Button>
              <Button
                size="sm"
                onClick={() => setFormMode({ kind: 'create', type: SCOPE_DEFAULT_TYPE[scope] })}
              >
                <Icon.Plus className="h-4 w-4" /> New entity
              </Button>
            </div>
          }
        />
        <CardBody className="space-y-4">
          <EntitySearchFilterBar
            scope={scope}
            search={search}
            onSearch={setSearch}
            filters={filters}
            onFilters={(patch) => setFilters((f) => ({ ...f, ...patch }))}
            onReset={() => {
              setSearch('');
              setFilters(DEFAULT_ENTITY_FILTERS);
            }}
            countries={countries}
            currencies={currencies}
          />
          <p className="text-xs text-slate-400">
            Showing {visible.length} of {scoped.length} {scope === 'all' ? 'entities' : `${scope}s`}.
          </p>
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <EntityTable
              entities={visible}
              onEdit={(id) => setFormMode({ kind: 'edit', entityId: id })}
              onRequestDelete={setPendingDeleteId}
              onAdd={() => setFormMode({ kind: 'create', type: SCOPE_DEFAULT_TYPE[scope] })}
              searchActive={searchActive}
            />
          </div>
        </CardBody>
      </Card>

      <EntityFormDrawer open={formMode !== null} mode={formMode} onClose={() => setFormMode(null)} />

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete entity?"
        message={
          <>
            Delete <strong>{pendingDelete?.legalName}</strong> ({pendingDelete?.entityCode})?
            This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
