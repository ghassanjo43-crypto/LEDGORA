/**
 * Company accounting settings — the authoritative record.
 *
 * ══ What these are ═══════════════════════════════════════════════════════════
 *
 * The facts that decide what a set of books MEANS: when its year starts, when
 * it opens, which framework it reports under, whether it is registered for tax.
 * They belonged to `useStore.settings` in localStorage, where a fiscal year was
 * editable from devtools and clearing site data silently reset the basis on
 * which every statement was prepared.
 *
 * ══ Read is not the same as write ════════════════════════════════════════════
 *
 * Reading settings is always permitted to a member who may see the
 * organization: a screen cannot render a date without knowing the year start,
 * and a lapsed subscriber must still be able to look at their own books.
 *
 * WRITING requires an active subscription, checked by the route against the
 * server's own row. Free Preview may explore every feature and keep none of it,
 * and a fiscal year is exactly the sort of permanent record that rule exists
 * for.
 *
 * ══ Why the row always exists ════════════════════════════════════════════════
 *
 * Migration 027 creates one per company, and both company-creation paths create
 * one alongside the company. So `readSettings` never invents defaults on the
 * fly: a missing row is a genuine fault, not a state to paper over with
 * plausible values that would differ between two readers.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { writeAuditLog } from '../lib/audit.js';

type Executor = Kysely<Database> | Transaction<Database>;

export type ReportingFramework = 'IFRS' | 'IFRS_FOR_SMES' | 'US_GAAP' | 'OTHER';

const FRAMEWORKS: readonly ReportingFramework[] = ['IFRS', 'IFRS_FOR_SMES', 'US_GAAP', 'OTHER'];

export interface CompanySettingsView {
  organizationId: string;
  companyId: string;
  fiscalYearStart: string;
  booksStartDate: string | null;
  /** Always 'accrual'. See migration 027 for why there is no second value. */
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
  /** Optimistic concurrency token; every update requires and increments it. */
  version: number;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toView(row: any): CompanySettingsView {
  const date = (value: unknown): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  };
  return {
    organizationId: row.organization_id,
    companyId: row.company_id,
    fiscalYearStart: row.fiscal_year_start,
    booksStartDate: date(row.books_start_date),
    accountingBasis: 'accrual',
    reportingFramework: row.reporting_framework,
    taxRegistered: row.tax_registered,
    taxRegistrationNumber: row.tax_registration_number,
    defaultTaxRate: String(row.default_tax_rate),
    organizationType: row.organization_type,
    industryType: row.industry_type,
    logoUrl: row.logo_url,
    email: row.email,
    phone: row.phone,
    website: row.website,
    country: row.country,
    stateProvince: row.state_province,
    city: row.city,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    postalCode: row.postal_code,
    version: row.version,
  };
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

export async function readSettings(
  executor: Executor,
  organizationId: string,
  companyId: string,
): Promise<CompanySettingsView> {
  const row = await executor
    .selectFrom('company_settings')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    .executeTakeFirst();

  /*
   * Another company's settings are unreachable by construction — the query is
   * keyed on both ids — so a miss means this company genuinely has no row.
   */
  if (!row) throw errors.notFound('Company settings');
  return toView(row);
}

/**
 * The settings a NEW company starts with.
 *
 * Inherited from the organization's onboarding defaults, which is the only
 * place a sensible starting value exists. Called inside the same transaction
 * that creates the company, so a set of books never exists without them.
 */
export async function createDefaultSettings(
  trx: Transaction<Database>,
  organizationId: string,
  companyId: string,
): Promise<void> {
  const organization = await trx
    .selectFrom('organizations')
    .select(['fiscal_year_start', 'books_start_date', 'tax_number', 'industry', 'country'])
    .where('id', '=', organizationId)
    .executeTakeFirst();

  const taxNumber = organization?.tax_number ?? '';

  await trx
    .insertInto('company_settings')
    .values({
      organization_id: organizationId,
      company_id: companyId,
      fiscal_year_start: organization?.fiscal_year_start || '01-01',
      books_start_date: organization?.books_start_date ?? null,
      tax_registration_number: taxNumber,
      /* A number implies registration; the CHECK refuses the reverse. */
      tax_registered: taxNumber !== '',
      industry_type: organization?.industry ?? '',
      country: organization?.country ?? '',
    })
    .onConflict((oc) => oc.columns(['organization_id', 'company_id']).doNothing())
    .execute();
}

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

export interface UpdateSettingsInput {
  organizationId: string;
  companyId: string;
  /**
   * The version the caller read. Required, and deliberately not defaulted: a
   * caller that has not read the settings cannot be allowed to overwrite them,
   * and filling this in here would turn every update into last-write-wins.
   */
  expectedVersion: number;
  /**
   * Whether this organization may make a permanent change — resolved by the
   * route from `subscriptions.status`, never from anything a client asserts.
   */
  mayPersist: boolean;
  actorUserId: string;
  requestId?: string | null;
  patch: Partial<{
    fiscalYearStart: string;
    booksStartDate: string | null;
    reportingFramework: ReportingFramework;
    taxRegistered: boolean;
    taxRegistrationNumber: string;
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
  }>;
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function updateSettings(
  db: Kysely<Database>,
  input: UpdateSettingsInput,
): Promise<CompanySettingsView> {
  /*
   * Free Preview may not make this permanent. Checked before the transaction
   * opens, so an unentitled caller reads nothing and writes nothing.
   */
  if (!input.mayPersist) throw errors.persistenceRequiresSubscription();

  const { patch } = input;

  /* Validated here as well as by the database: a constraint violation is a
   * correct refusal with an unreadable message. */
  if (patch.fiscalYearStart !== undefined && !MONTH_DAY.test(patch.fiscalYearStart)) {
    throw errors.validation('The financial year must start on a valid month and day, such as 01-01.');
  }
  if (patch.booksStartDate != null && !ISO_DATE.test(patch.booksStartDate)) {
    throw errors.validation('The books start date must be a calendar date.');
  }
  if (patch.reportingFramework !== undefined && !FRAMEWORKS.includes(patch.reportingFramework)) {
    throw errors.validation('That reporting framework is not supported.');
  }
  if (patch.defaultTaxRate !== undefined) {
    const rate = Number(patch.defaultTaxRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw errors.validation('The default tax rate must be between 0 and 100.');
    }
  }

  const updated = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('company_settings')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('company_id', '=', input.companyId)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Company settings');
    if (current.version !== input.expectedVersion) {
      throw errors.conflict(
        'These settings were changed by someone else. Reload and apply your change again.',
      );
    }

    /*
     * A tax number cannot survive deregistration. Resolved against the MERGED
     * state rather than the patch, so clearing `taxRegistered` alone does not
     * leave a number behind and trip the CHECK with an unreadable error.
     */
    const taxRegistered = patch.taxRegistered ?? current.tax_registered;
    const taxNumber = patch.taxRegistrationNumber ?? current.tax_registration_number;
    if (!taxRegistered && taxNumber !== '') {
      throw errors.validation(
        'Remove the tax registration number, or keep the company registered for tax.',
      );
    }

    const row = await trx
      .updateTable('company_settings')
      .set({
        ...(patch.fiscalYearStart !== undefined ? { fiscal_year_start: patch.fiscalYearStart } : {}),
        ...(patch.booksStartDate !== undefined ? { books_start_date: patch.booksStartDate } : {}),
        ...(patch.reportingFramework !== undefined
          ? { reporting_framework: patch.reportingFramework } : {}),
        ...(patch.taxRegistered !== undefined ? { tax_registered: patch.taxRegistered } : {}),
        ...(patch.taxRegistrationNumber !== undefined
          ? { tax_registration_number: patch.taxRegistrationNumber } : {}),
        ...(patch.defaultTaxRate !== undefined ? { default_tax_rate: patch.defaultTaxRate } : {}),
        ...(patch.organizationType !== undefined
          ? { organization_type: patch.organizationType } : {}),
        ...(patch.industryType !== undefined ? { industry_type: patch.industryType } : {}),
        ...(patch.logoUrl !== undefined ? { logo_url: patch.logoUrl } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.website !== undefined ? { website: patch.website } : {}),
        ...(patch.country !== undefined ? { country: patch.country } : {}),
        ...(patch.stateProvince !== undefined ? { state_province: patch.stateProvince } : {}),
        ...(patch.city !== undefined ? { city: patch.city } : {}),
        ...(patch.addressLine1 !== undefined ? { address_line1: patch.addressLine1 } : {}),
        ...(patch.addressLine2 !== undefined ? { address_line2: patch.addressLine2 } : {}),
        ...(patch.postalCode !== undefined ? { postal_code: patch.postalCode } : {}),
        version: current.version + 1,
        updated_at: sql`now()`,
      })
      .where('organization_id', '=', input.organizationId)
      .where('company_id', '=', input.companyId)
      /* The guard that makes the version token real rather than advisory. */
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw errors.conflict(
        'These settings were changed by someone else. Reload and apply your change again.',
      );
    }
    return toView(row);
  });

  /*
   * Audited with the FIELDS that changed, never their values: a logo data URL
   * or a tax number does not belong in an audit trail that is read casually.
   * Which settings moved, and when, is what the trail is for.
   */
  await writeAuditLog(db, {
    action: 'company_settings.updated',
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    targetType: 'company',
    targetId: input.companyId,
    requestId: input.requestId ?? null,
    metadata: {
      fields: Object.keys(patch).sort(),
      previousVersion: input.expectedVersion,
      resultingVersion: updated.version,
    },
  });

  return updated;
}
