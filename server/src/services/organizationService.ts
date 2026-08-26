/**
 * Organizations and membership.
 *
 * The organization record moves here from browser localStorage: a platform
 * administrator must be able to see every subscriber, which is impossible when
 * the record only exists in one customer's browser.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, OrganizationRole } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { advanceApplicationForUser, ensureApplication } from './applicantService.js';

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

/**
 * The organization as the client adopts it.
 *
 * Complete on purpose: the browser mirrors this record verbatim (keeping THIS
 * id), so any field omitted here is a field the client has to invent a default
 * for — which is how a hydrated organization silently loses the industry and
 * financial-year settings its owner typed in.
 */
export interface OrganizationSummary {
  id: string;
  legalName: string;
  tradingName: string | null;
  country: string;
  registrationNumber: string | null;
  taxNumber: string | null;
  industry: string | null;
  baseCurrency: string;
  fiscalYearStart: string;
  booksStartDate: string | null;
  status: string;
  createdAt: string;
  /** The organization's owner — not necessarily the caller. */
  ownerUserId: string | null;
  /** The CALLER's role in this organization. */
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
        subscriber_owner_user_id: userId,
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

    // Attach the tenant to the applicant record. `ensureApplication` first, so a
    // pre-backfill account still gets one rather than silently losing the link.
    await ensureApplication(trx, userId, { source: 'organization_created' });
    await advanceApplicationForUser(trx, userId, { organizationId: organization.id });

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

/**
 * The workspace this user signs in to.
 *
 * A subscriber owns exactly one workspace and resolves to THAT one, even when
 * they also hold a guest membership somewhere else — being invited into a
 * colleague's books must never displace your own. Everyone else resolves
 * through their active membership. The ordering is what makes this
 * deterministic: without it the query returned whichever row the planner
 * happened to hand back first, which is how a subscriber with a second
 * membership ended up looking like they had no workspace and was sent to
 * onboarding to create a duplicate.
 */
export async function findMembershipForUser(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
): Promise<{ organizationId: string; role: OrganizationRole } | null> {
  const row = await db
    .selectFrom('organization_memberships as m')
    .innerJoin('organizations as o', 'o.id', 'm.organization_id')
    .select(['m.organization_id', 'm.role'])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'active')
    // Owned workspace first, then oldest membership — a stable tiebreak.
    .orderBy(sql`case when o.subscriber_owner_user_id = m.user_id then 0 else 1 end`, 'asc')
    .orderBy('m.created_at', 'asc')
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
    registrationNumber: organization.registration_number,
    taxNumber: organization.tax_number,
    industry: organization.industry,
    baseCurrency: organization.base_currency,
    fiscalYearStart: organization.fiscal_year_start,
    booksStartDate: organization.books_start_date,
    status: organization.status,
    createdAt: new Date(organization.created_at).toISOString(),
    ownerUserId: organization.subscriber_owner_user_id,
    role: membership.role,
  };
}

/** Resolve the caller's organization or fail — used by subscription routes. */
export async function requireOrganizationFor(db: Kysely<Database>, userId: string): Promise<string> {
  const membership = await findMembershipForUser(db, userId);
  if (!membership) throw errors.validation('Create your company workspace before choosing a package.');
  return membership.organizationId;
}
