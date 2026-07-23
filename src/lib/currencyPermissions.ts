/**
 * Currency Master & Exchange Rates — role-based permissions, following the
 * existing organization role model (`types/roles.OrganizationRole`).
 *
 * A platform administrator inspecting a subscriber workspace in full-access
 * operator mode may manage currencies for support, but remains scoped to the
 * selected organization, is identified as the REAL administrator by the audit
 * layer (`store/platformFullAccess.resolveAuditActor`), never impersonates the
 * subscriber, and never alters subscription entitlement or pricing from here.
 */
import type { OrganizationRole } from '@/types/roles';

export type CurrencyPermission =
  | 'currency.view'
  | 'currency.create'
  | 'currency.edit'
  | 'currency.activate'
  | 'currency.deactivate'
  | 'currency.configurePrecision'
  | 'currency.setBaseCurrency'
  | 'currency.manageReportingCurrencies'
  | 'exchangeRate.view'
  | 'exchangeRate.create'
  | 'exchangeRate.edit'
  | 'exchangeRate.approve'
  | 'exchangeRate.import'
  | 'exchangeRate.deleteDraft';

const ALL: CurrencyPermission[] = [
  'currency.view', 'currency.create', 'currency.edit', 'currency.activate',
  'currency.deactivate', 'currency.configurePrecision', 'currency.setBaseCurrency',
  'currency.manageReportingCurrencies',
  'exchangeRate.view', 'exchangeRate.create', 'exchangeRate.edit',
  'exchangeRate.approve', 'exchangeRate.import', 'exchangeRate.deleteDraft',
];

/** Role → permission grants. Owners/admins hold everything, including precision
 *  and base-currency configuration. Accountants operate rates day-to-day. */
const ROLE_GRANTS: Record<OrganizationRole, CurrencyPermission[]> = {
  owner: ALL,
  admin: ALL,
  accountant: [
    'currency.view', 'currency.activate',
    'exchangeRate.view', 'exchangeRate.create', 'exchangeRate.edit',
    'exchangeRate.import', 'exchangeRate.deleteDraft',
  ],
  member: ['currency.view', 'exchangeRate.view'],
  viewer: ['currency.view', 'exchangeRate.view'],
};

export function roleHasCurrencyPermission(role: OrganizationRole, permission: CurrencyPermission): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface CurrencyPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertCurrencyPermission(role: OrganizationRole, permission: CurrencyPermission): CurrencyPermissionResult {
  return roleHasCurrencyPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}
