import { useStore } from '@/store/useStore';
import { ACCOUNT_TYPE_OPTIONS, IFRS_STATEMENT_OPTIONS } from '@/data/ifrsOptions';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';

const TYPE_OPTIONS = [{ value: 'ALL', label: 'All types' }, ...ACCOUNT_TYPE_OPTIONS];
const STATEMENT_OPTIONS = [
  { value: 'ALL', label: 'All statements' },
  ...IFRS_STATEMENT_OPTIONS,
];
const STATUS_OPTIONS = [
  { value: 'all', label: 'Active & inactive' },
  { value: 'active', label: 'Active only' },
  { value: 'inactive', label: 'Inactive only' },
];
const KIND_OPTIONS = [
  { value: 'all', label: 'Headers & posting' },
  { value: 'posting', label: 'Posting only' },
  { value: 'header', label: 'Headers only' },
];

export function SearchAndFilterBar() {
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const resetFilters = useStore((s) => s.resetFilters);

  const isFiltered =
    !!search ||
    filters.type !== 'ALL' ||
    filters.statement !== 'ALL' ||
    filters.status !== 'all' ||
    filters.kind !== 'all';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Icon.Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by code, name, category…"
          className="pl-9"
          aria-label="Search accounts"
        />
      </div>

      <Select
        className="w-auto"
        options={TYPE_OPTIONS}
        value={filters.type}
        onChange={(e) => setFilters({ type: e.target.value as typeof filters.type })}
        aria-label="Filter by type"
      />
      <Select
        className="w-auto"
        options={STATEMENT_OPTIONS}
        value={filters.statement}
        onChange={(e) => setFilters({ statement: e.target.value as typeof filters.statement })}
        aria-label="Filter by statement"
      />
      <Select
        className="w-auto"
        options={STATUS_OPTIONS}
        value={filters.status}
        onChange={(e) => setFilters({ status: e.target.value as typeof filters.status })}
        aria-label="Filter by status"
      />
      <Select
        className="w-auto"
        options={KIND_OPTIONS}
        value={filters.kind}
        onChange={(e) => setFilters({ kind: e.target.value as typeof filters.kind })}
        aria-label="Filter by kind"
      />

      {isFiltered && (
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          <Icon.Close className="h-4 w-4" /> Clear
        </Button>
      )}
    </div>
  );
}
