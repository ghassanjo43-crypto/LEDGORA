import type { BusinessEntity } from '@/types';

export type EntityScope = 'all' | 'customer' | 'supplier';
export type EntityTypeFilter = 'ALL' | 'customer' | 'supplier' | 'both';
export type EntityStatusFilter = 'all' | 'active' | 'inactive';

export interface EntityFilters {
  type: EntityTypeFilter;
  country: string; // '' = all
  currency: string; // '' = all
  status: EntityStatusFilter;
}

export const DEFAULT_ENTITY_FILTERS: EntityFilters = {
  type: 'ALL',
  country: '',
  currency: '',
  status: 'all',
};

export interface EntityStats {
  totalCustomers: number;
  totalSuppliers: number;
  both: number;
  inactive: number;
  total: number;
}

export function isCustomer(e: BusinessEntity): boolean {
  return e.entityType === 'customer' || e.entityType === 'both';
}

export function isSupplier(e: BusinessEntity): boolean {
  return e.entityType === 'supplier' || e.entityType === 'both';
}

export function computeEntityStats(entities: BusinessEntity[]): EntityStats {
  let totalCustomers = 0;
  let totalSuppliers = 0;
  let both = 0;
  let inactive = 0;
  for (const e of entities) {
    if (isCustomer(e)) totalCustomers += 1;
    if (isSupplier(e)) totalSuppliers += 1;
    if (e.entityType === 'both') both += 1;
    if (!e.isActive) inactive += 1;
  }
  return { totalCustomers, totalSuppliers, both, inactive, total: entities.length };
}

/** Restrict a list to a page scope (all / customers / suppliers). */
export function scopeEntities(
  entities: BusinessEntity[],
  scope: EntityScope,
): BusinessEntity[] {
  if (scope === 'customer') return entities.filter(isCustomer);
  if (scope === 'supplier') return entities.filter(isSupplier);
  return entities;
}

function matchesEntitySearch(e: BusinessEntity, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  return (
    e.entityCode.toLowerCase().includes(q) ||
    e.legalName.toLowerCase().includes(q) ||
    e.tradingName.toLowerCase().includes(q) ||
    e.contactPerson.toLowerCase().includes(q) ||
    e.email.toLowerCase().includes(q) ||
    e.city.toLowerCase().includes(q) ||
    e.country.toLowerCase().includes(q)
  );
}

function matchesEntityFilters(e: BusinessEntity, f: EntityFilters): boolean {
  if (f.type !== 'ALL' && e.entityType !== f.type) return false;
  if (f.country && e.country !== f.country) return false;
  if (f.currency && e.defaultCurrency !== f.currency) return false;
  if (f.status === 'active' && !e.isActive) return false;
  if (f.status === 'inactive' && e.isActive) return false;
  return true;
}

export function filterEntities(
  entities: BusinessEntity[],
  query: string,
  filters: EntityFilters,
): BusinessEntity[] {
  return entities.filter(
    (e) => matchesEntitySearch(e, query) && matchesEntityFilters(e, filters),
  );
}

/** Distinct sorted values of a field, for populating filter dropdowns. */
export function distinctValues(
  entities: BusinessEntity[],
  field: 'country' | 'defaultCurrency',
): string[] {
  const set = new Set<string>();
  for (const e of entities) {
    const v = e[field];
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
