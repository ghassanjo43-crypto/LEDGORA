/**
 * Organizations and membership.
 *
 * The organization record moves here from browser localStorage: a platform
 * administrator must be able to see every subscriber, which is impossible when
 * the record only exists in one customer's browser.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, OrganizationRole } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

export interface CreateOrganizationInput {
  legalName: string;
  tradingName?: string;
  country: string;
  registrationNumber?: string;
  taxNumber?: string;
  industry?: string;
  baseCurrency?: string;
  fiscalYearStart?: string;
  booksStartDate?: string;
}

export interface OrganizationSummary {
  id: string;
  legalName: string;
  tradingName: string | null;
  country: string;
  baseCurrency: string;
  status: string;
  role: OrganizationRole;
}

/**
 * Create an organization and make the caller its owner, atomically — an
 * organization without an owner would be unreachable.
 */
export async function createOrganization(
  db: Kysely<Database>,
  userId: string,
  input: CreateOrganizationInput,
  context: AuditContext = {},
): Promise<{ id: string }> {
  const existing = await findMembershipForUser(db, userId);
  if (existing) throw errors.conflict('You already belong to an organization.');

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .insertInto('organizations')
      .values({
        legal_name: input.legalName.trim(),
        trading_name: input.tradingName?.trim() || null,
        country: input.country,
        registration_number: input.registrationNumber?.trim() || null,
        tax_number: input.taxNumber?.trim() || null,
        industry: input.industry?.trim() || null,
        base_currency: input.baseCurrency ?? 'USD',
        fiscal_year_start: input.fiscalYearStart ?? '01-01',
        books_start_date: input.booksStartDate ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('organization_memberships')
      .values({ organization_id: organization.id, user_id: userId, role: 'owner', status: 'active' })
      .execute();

    await writeAuditLog(trx, {
      ...context,
      actorUserId: userId,
      organizationId: organization.id,
      action: 'organization.created',
      targetType: 'organization',
      targetId: organization.id,
      metadata: { legalName: input.legalName.trim(), country: input.country },
    });

    return { id: organization.id };
  });
}

export async function findMembershipForUser(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
): Promise<{ organizationId: string; role: OrganizationRole } | null> {
  const row = await db
    .selectFrom('organization_memberships')
    .select(['organization_id', 'role'])
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return row ? { organizationId: row.organization_id, role: row.role } : null;
}

/** The caller's organization, or null. */
export async function getCurrentOrganization(
  db: Kysely<Database>,
  userId: string,
): Promise<OrganizationSummary | null> {
  const membership = await findMembershipForUser(db, userId);
  if (!membership) return null;

  const organization = await db
    .selectFrom('organizations')
    .selectAll()
    .where('id', '=', membership.organizationId)
    .executeTakeFirst();
  if (!organization) return null;

  return {
    id: organization.id,
    legalName: organization.legal_name,
    tradingName: organization.trading_name,
    country: organization.country,
    baseCurrency: organization.base_currency,
    status: organization.status,
    role: membership.role,
  };
}

/** Resolve the caller's organization or fail — used by subscription routes. */
export async function requireOrganizationFor(db: Kysely<Database>, userId: string): Promise<string> {
  const membership = await findMembershipForUser(db, userId);
  if (!membership) throw errors.validation('Create your organization before choosing a package.');
  return membership.organizationId;
}
