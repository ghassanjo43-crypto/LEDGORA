import { createDefaultSettings } from './companySettingsService.js';
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

    /*
     * The organization's first set of books.
     *
     * A subscriber always keeps books for at least one company, and accounting
     * records are scoped to a company (migration 025), so an organization with
     * none could not post anything at all. Creating it here — in the same
     * transaction, at the moment the tenant comes into existence — means the
     * state "a customer exists but has nowhere to write" is never reachable.
     *
     * This is NOT the same act the migration's backfill refuses. That one would
     * guess which of several existing companies some historical journal belonged
     * to. This creates the first company for an organization that has no books
     * yet, so there is nothing to attribute and nothing to get wrong.
     *
     * The name is the organization's own legal name because at this moment they
     * are the same thing; a customer who later keeps several companies renames
     * this one and adds the others. The client reference is the server id — the
     * browser has not minted one, and reusing the uuid keeps the column's
     * meaning ("whatever the client calls these books") honest rather than
     * leaving it empty.
     */
    const company = await trx
      .insertInto('companies')
      .values({
        /*
         * A company id of its own, deliberately NOT reused from the
         * organization. Making them equal would be convenient and would mean
         * that passing an organization id where a company id belongs — the
         * exact confusion company scoping exists to prevent — worked perfectly
         * for every single-company tenant and failed only once a customer added
         * a second company.
         */
        organization_id: organization.id,
      /*
       * PROVISIONAL — see migration 026.
       *
       * This is the organization's one set of books, created here so a
       * subscriber never exists with nowhere to post. It is not yet claimed by
       * a client, so `adopted_at` stays NULL and the first browser registration
       * ADOPTS this very row: same server id, new client reference. That is what
       * keeps "one real set of books, exactly one company row" true, and what
       * stops journals posted before the browser syncs from ending up in a
       * different ledger than journals posted after.
       *
       * The reference is prefixed rather than left empty because the column is
       * NOT NULL and unique per organization. `adopted_at` — not the shape of
       * this string — is what makes the row provisional.
       */
        client_reference: `provisional:${organization.id}`,
        legal_name: input.legalName.trim(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    /*
     * ...and the settings that say what these books mean, inheriting the
     * organization's onboarding defaults. Same transaction, so a set of books
     * never exists without a fiscal year or a reporting framework — a report
     * has no sensible behaviour when they are absent.
     */
    await createDefaultSettings(trx, organization.id, company.id);

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
