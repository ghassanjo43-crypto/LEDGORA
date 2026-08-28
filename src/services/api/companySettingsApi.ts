/**
 * Company accounting settings, from the server.
 *
 * These decide what a set of books MEANS — fiscal year, books start, reporting
 * framework, tax registration. They used to live in `useStore.settings` in
 * localStorage, where a fiscal year was editable from devtools and clearing
 * site data silently reset the basis every statement was prepared on.
 *
 * The server is now authoritative; `useStore.settings` is a cache of what this
 * returned. Which company is answered by the selector header, so there is no
 * company identifier in the path or the body.
 */
import { api } from './client';

export type ReportingFramework = 'IFRS' | 'IFRS_FOR_SMES' | 'US_GAAP' | 'OTHER';

export interface ServerCompanySettings {
  organizationId: string;
  companyId: string;
  fiscalYearStart: string;
  booksStartDate: string | null;
  /** Always 'accrual'. A database CHECK permits no other value. */
  accountingBasis: 'accrual';
  reportingFramework: ReportingFramework;
  taxRegistered: boolean;
  taxRegistrationNumber: string;
  /** A decimal string, never a float — it multiplies money. */
  defaultTaxRate: string;
  organizationType: string;
  industryType: string;
  logoUrl: string;
  email: string;
  phone: string;
  website: string;
  country: string;
  stateProvince: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  /** Required on every update; the server refuses a stale or absent token. */
  version: number;
}

/**
 * The fields a client may change.
 *
 * `accountingBasis` is absent deliberately: it is accrual and the database
 * permits nothing else, so offering it would imply a choice that does not
 * exist. `baseCurrency` is absent because it belongs to the organization.
 */
export type CompanySettingsPatch = Partial<Omit<
  ServerCompanySettings,
  'organizationId' | 'companyId' | 'accountingBasis' | 'version'
>>;

export const companySettingsApi = {
  get: async (): Promise<ServerCompanySettings> =>
    (await api.get<{ settings: ServerCompanySettings }>(
      '/api/organizations/current/company-settings',
    )).settings,

  /**
   * Apply a partial change.
   *
   * `expectedVersion` is required rather than defaulted: a caller that has not
   * read the settings cannot be allowed to overwrite them, and filling it in
   * here would turn every update into last-write-wins.
   */
  update: async (
    patch: CompanySettingsPatch,
    expectedVersion: number,
  ): Promise<ServerCompanySettings> =>
    (await api.patch<{ settings: ServerCompanySettings }>(
      '/api/organizations/current/company-settings',
      { ...patch, expectedVersion },
    )).settings,
};
