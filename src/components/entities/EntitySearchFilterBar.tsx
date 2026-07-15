import type { EntityFilters, EntityScope } from '@/lib/entitySelectors';
import { DEFAULT_ENTITY_FILTERS } from '@/lib/entitySelectors';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';

interface Props {
  scope: EntityScope;
  search: string;
  onSearch: (value: string) => void;
  filters: EntityFilters;
  onFilters: (patch: Partial<EntityFilters>) => void;
  onReset: () => void;
  countries: string[];
  currencies: string[];
}

export function EntitySearchFilterBar({
  scope,
  search,
  onSearch,
  filters,
  onFilters,
  onReset,
  countries,
  currencies,
}: Props) {
  // On the Customers/Suppliers pages the type filter narrows within scope.
  const typeOptions =
    scope === 'customer'
      ? [
          { value: 'ALL', label: 'All customers' },
          { value: 'customer', label: 'Customer only' },
          { value: 'both', label: 'Customer & supplier' },
        ]
      : scope === 'supplier'
        ? [
            { value: 'ALL', label: 'All suppliers' },
            { value: 'supplier', label: 'Supplier only' },
            { value: 'both', label: 'Customer & supplier' },
          ]
        : [
            { value: 'ALL', label: 'All types' },
            { value: 'customer', label: 'Customers' },
            { value: 'supplier', label: 'Suppliers' },
            { value: 'both', label: 'Both' },
          ];

  const isFiltered =
    !!search ||
    filters.type !== DEFAULT_ENTITY_FILTERS.type ||
    filters.country !== '' ||
    filters.currency !== '' ||
    filters.status !== 'all';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Icon.Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name, code, contact, city…"
          className="pl-9"
          aria-label="Search entities"
        />
      </div>

      <Select
        className="w-auto"
        options={typeOptions}
        value={filters.type}
        onChange={(e) => onFilters({ type: e.target.value as EntityFilters['type'] })}
        aria-label="Filter by type"
      />
      <Select
        className="w-auto"
        options={[{ value: '', label: 'All countries' }, ...countries.map((c) => ({ value: c, label: c }))]}
        value={filters.country}
        onChange={(e) => onFilters({ country: e.target.value })}
        aria-label="Filter by country"
      />
      <Select
        className="w-auto"
        options={[{ value: '', label: 'All currencies' }, ...currencies.map((c) => ({ value: c, label: c }))]}
        value={filters.currency}
        onChange={(e) => onFilters({ currency: e.target.value })}
        aria-label="Filter by currency"
      />
      <Select
        className="w-auto"
        options={[
          { value: 'all', label: 'Active & inactive' },
          { value: 'active', label: 'Active only' },
          { value: 'inactive', label: 'Inactive only' },
        ]}
        value={filters.status}
        onChange={(e) => onFilters({ status: e.target.value as EntityFilters['status'] })}
        aria-label="Filter by status"
      />

      {isFiltered && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <Icon.Close className="h-4 w-4" /> Clear
        </Button>
      )}
    </div>
  );
}
