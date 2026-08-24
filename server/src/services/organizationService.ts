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
  /**
   * Chosen at onboarding, then locked. See migration 021 for why document and
   * interface language are separate facts.
   */
  interfaceLanguage?: SupportedLanguage;
  documentLanguage?: SupportedLanguage;
  fiscalYearStart?: string;
  booksStartDate?: string;
}

/** The languages the application actually ships translations for. */
export const SUPPORTED_LANGUAGES = ['en', 'ar'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
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
  interfaceLanguage: string;
  documentLanguage: string;
  interfaceLanguageLocked: boolean;
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
        /*
         * Defaulted rather than required: an organization created by an older
         * client, or by an operator provisioning on someone's behalf, must not
         * fail for want of a language. English is the safe default because it
         * is the language every screen is guaranteed to have.
         */
        interface_language: input.interfaceLanguage ?? 'en',
        document_language: input.documentLanguage ?? input.interfaceLanguage ?? 'en',
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
    interfaceLanguage: organization.interface_language,
    documentLanguage: organization.document_language,
    interfaceLanguageLocked: organization.interface_language_locked,
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

/* ══ Language ═════════════════════════════════════════════════════════════ */

export interface LanguageChangeInput {
  field: 'interface_language' | 'document_language';
  value: SupportedLanguage;
  reason: string;
}

/**
 * Change an organization's language.
 *
 * ── Why this is not a settings toggle ────────────────────────────────────────
 * `document_language` decides what language a customer's invoice and a
 * submitted UBL document are in. Changing it does NOT retranslate documents
 * already issued — those keep the language they were cleared in, which is the
 * point. What it changes is everything issued afterwards, so the books end up
 * with a language boundary partway through a tax year. That is a legitimate
 * thing to do and a terrible thing to do by accident, which is why it takes an
 * owner or admin and a written reason.
 *
 * The reason is recorded in its own table rather than the audit log, because
 * "which language were documents issued in during 2026" is a question that
 * outlives log retention.
 */
export async function changeOrganizationLanguage(
  db: Kysely<Database>,
  organizationId: string,
  actorUserId: string,
  input: LanguageChangeInput,
): Promise<OrganizationSummary> {
  if (!isSupportedLanguage(input.value)) {
    throw errors.validation(`${input.value} is not a language this application ships.`);
  }
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is kept with the organization.', {
      fieldErrors: { reason: 'Explain why the language is changing.' },
    });
  }

  return db.transaction().execute(async (trx) => {
    const membership = await trx
      .selectFrom('organization_memberships')
      .select(['role'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', actorUserId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    /*
     * Authority comes from the caller's own membership, never from the request.
     * A member may not change what language their colleagues' documents are
     * issued in.
     */
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw errors.forbidden('Only an owner or an administrator can change the organization language.');
    }

    const current = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw errors.notFound('Organization');

    const previous = input.field === 'interface_language'
      ? current.interface_language
      : current.document_language;

    // A no-op change still costs an audit row and a reason; refuse it instead.
    if (previous === input.value) {
      throw errors.conflict(`The organization language is already ${input.value}.`);
    }

    await trx
      .updateTable('organizations')
      .set(input.field === 'interface_language'
        ? { interface_language: input.value }
        : { document_language: input.value })
      .where('id', '=', organizationId)
      .execute();

    await trx.insertInto('organization_language_changes').values({
      organization_id: organizationId,
      field: input.field,
      previous_value: previous,
      new_value: input.value,
      reason,
      changed_by: actorUserId,
    }).execute();

    const updated = await trx
      .selectFrom('organizations').selectAll()
      .where('id', '=', organizationId).executeTakeFirstOrThrow();

    return {
      id: updated.id,
      legalName: updated.legal_name,
      tradingName: updated.trading_name,
      country: updated.country,
      registrationNumber: updated.registration_number,
      taxNumber: updated.tax_number,
      industry: updated.industry,
      baseCurrency: updated.base_currency,
      interfaceLanguage: updated.interface_language,
      documentLanguage: updated.document_language,
      interfaceLanguageLocked: updated.interface_language_locked,
      fiscalYearStart: updated.fiscal_year_start,
      booksStartDate: updated.books_start_date,
      status: updated.status,
      createdAt: new Date(updated.created_at as unknown as string).toISOString(),
      ownerUserId: updated.subscriber_owner_user_id,
      role: membership.role,
    };
  });
}

/** The recorded history of language changes, for an auditor. */
export async function languageHistory(
  db: Kysely<Database>,
  organizationId: string,
): Promise<Array<{ field: string; from: string; to: string; reason: string; at: string }>> {
  const rows = await db
    .selectFrom('organization_language_changes')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('changed_at', 'desc')
    .execute();

  return rows.map((row) => ({
    field: row.field,
    from: row.previous_value,
    to: row.new_value,
    reason: row.reason,
    at: new Date(row.changed_at as unknown as string).toISOString(),
  }));
}
