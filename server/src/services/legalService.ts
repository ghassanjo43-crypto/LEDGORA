/**
 * Recording who accepted which legal document, and which country's law governs
 * an organization.
 *
 * ══ What this service refuses to do ══════════════════════════════════════════
 *
 *  · It never trusts a client timestamp. `accepted_at` defaults to `now()` in
 *    the database, and the request cannot supply one. The single fact an
 *    acceptance record must not take from the party it is evidence against is
 *    when it happened.
 *  · It never infers a legal country. The caller states it, from the three
 *    supported codes, and anything else is rejected — not coerced, not guessed
 *    from an address field, and never read from an IP header.
 *  · It never records an acceptance of a document the caller was not shown.
 *    The version AND the content hash both travel with the request and are
 *    stored; a mismatch against what the server believes is current is refused
 *    rather than silently corrected.
 *  · It never lets a platform operator bind a subscriber. Authority to accept
 *    for an organization comes from the organization.
 *
 * ══ Idempotency ══════════════════════════════════════════════════════════════
 *
 * The unique key `(organization, user, scope, document, version, hash)` makes a
 * repeated submission converge on one row. This service leans on that rather
 * than checking first and inserting second, because the check-then-insert race
 * is exactly what two tabs pressing Accept together would lose.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { writeAuditLog } from '../lib/audit.js';
import {
  ADDENDUM_FOR_COUNTRY,
  findPublishedDocument,
  publishedBundleFor,
} from '../config/publishedLegalDocuments.js';

type Executor = Kysely<Database> | Transaction<Database>;

export type LegalCountry = 'AE' | 'JO' | 'SA';
export type AcceptanceScope = 'organization' | 'individual';
export type LegalDocumentId = 'master-terms' | 'addendum-ae' | 'addendum-jo' | 'addendum-sa';

const LEGAL_COUNTRIES: readonly LegalCountry[] = ['AE', 'JO', 'SA'];
const SCOPES: readonly AcceptanceScope[] = ['organization', 'individual'];
const DOCUMENT_IDS: readonly LegalDocumentId[] = [
  'master-terms', 'addendum-ae', 'addendum-jo', 'addendum-sa',
];

const SHA256 = /^[0-9a-f]{64}$/;

export function isLegalCountry(value: unknown): value is LegalCountry {
  return typeof value === 'string' && (LEGAL_COUNTRIES as readonly string[]).includes(value);
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export interface AcceptanceRow {
  scope: AcceptanceScope;
  documentId: LegalDocumentId;
  version: string;
  contentHash: string;
  acceptedAt: string;
  acceptedByUserId: string;
  bindingAuthorityConfirmed: boolean;
}

export interface LegalStatus {
  organizationId: string;
  legalCountry: LegalCountry | null;
  /** Organization-scope acceptances, whoever in the organization gave them. */
  organizationAcceptances: AcceptanceRow[];
  /** Individual acknowledgements belonging to the calling user only. */
  individualAcknowledgments: AcceptanceRow[];
}

function toRow(row: {
  scope: string; document_id: string; version: string; content_hash: string;
  accepted_at: Date; user_id: string; binding_authority_confirmed: boolean;
}): AcceptanceRow {
  return {
    scope: row.scope as AcceptanceScope,
    documentId: row.document_id as LegalDocumentId,
    version: row.version,
    contentHash: row.content_hash,
    acceptedAt: row.accepted_at.toISOString(),
    acceptedByUserId: row.user_id,
    bindingAuthorityConfirmed: row.binding_authority_confirmed,
  };
}

/**
 * What this user and this organization have accepted.
 *
 * Organization acceptances are returned whoever gave them — the company accepts
 * once, not once per employee — while individual acknowledgements are scoped to
 * the caller. That asymmetry is the two-level model, expressed in the query.
 */
export async function readLegalStatus(
  db: Executor,
  userId: string,
  organizationId: string,
): Promise<LegalStatus> {
  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'legal_country'])
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Organization');

  const rows = await db
    .selectFrom('legal_acceptances')
    .select([
      'scope', 'document_id', 'version', 'content_hash',
      'accepted_at', 'user_id', 'binding_authority_confirmed',
    ])
    .where('organization_id', '=', organizationId)
    /*
     * The tenant boundary, in the query rather than in a later filter. A row
     * belonging to another organization is not fetched and then hidden; it is
     * never selected.
     */
    .where((eb) => eb.or([
      eb('scope', '=', 'organization'),
      eb.and([eb('scope', '=', 'individual'), eb('user_id', '=', userId)]),
    ]))
    .orderBy('accepted_at', 'desc')
    .execute();

  const mapped = rows.map(toRow);
  return {
    organizationId,
    legalCountry: (organization.legal_country as LegalCountry | null) ?? null,
    organizationAcceptances: mapped.filter((r) => r.scope === 'organization'),
    individualAcknowledgments: mapped.filter((r) => r.scope === 'individual'),
  };
}

/* ── Recording an acceptance ──────────────────────────────────────────────── */

export interface RecordAcceptanceInput {
  userId: string;
  organizationId: string;
  scope: AcceptanceScope;
  /** The complete applicable bundle, exactly as it was shown to the user. */
  documents: Array<{ documentId: LegalDocumentId; version: string; contentHash: string }>;
  /**
   * The person's assertion that they may bind the organization.
   *
   * Required for an ORGANIZATION acceptance and refused for an individual one:
   * asking a Viewer to claim corporate authority in order to acknowledge terms
   * for themselves would be asking them to assert something false.
   */
  bindingAuthorityConfirmed: boolean;
  actingAsRole: string | null;
  userAgent?: string | null;
  /**
   * `legal_terms:acknowledge` — held by every member, survives a lapsed
   * subscription, binds nobody but the person.
   */
  mayAcknowledgeIndividually: boolean;
  /**
   * `legal_terms:accept_for_organization` — the Primary Owner, or a person
   * explicitly delegated it. A SEPARATE authority, resolved separately, so
   * neither can be mistaken for the other at a call site.
   */
  mayAcceptForOrganization: boolean;
}

export interface RecordAcceptanceResult {
  recorded: AcceptanceRow[];
  /** True when every row already existed — a replay, not a new acceptance. */
  idempotentReplay: boolean;
}

/**
 * Record an acceptance of the COMPLETE applicable bundle, atomically.
 *
 * ══ Validate everything, then write everything ═══════════════════════════════
 *
 * Every check — authority, country, publication, version, hash, completeness —
 * runs before the first INSERT. An organization recorded as having accepted the
 * Master Terms but not its Country Addendum is a half-agreement no screen asked
 * for and no reader could interpret, and the way to make that unreachable is to
 * have nothing written at the point any check can still fail. The inserts then
 * run in one transaction, so a failure at the second undoes the first.
 */
export async function recordAcceptance(
  db: Kysely<Database>,
  input: RecordAcceptanceInput,
): Promise<RecordAcceptanceResult> {
  if (!SCOPES.includes(input.scope)) throw errors.validation('Unknown acceptance scope.');

  /* ── Authority: two separate permissions, checked separately ───────────── */

  if (input.scope === 'organization') {
    if (!input.mayAcceptForOrganization) {
      throw errors.forbidden(
        'You are not authorised to accept these Terms on behalf of this organization. '
        + 'The organization’s Primary Owner, or someone they have explicitly authorised, must accept them.',
      );
    }
    if (!input.bindingAuthorityConfirmed) {
      /*
       * The screen asked "do you have authority to bind this organization".
       * An acceptance stored without that answer is missing the element that
       * makes it binding, so it is refused rather than recorded incomplete.
       */
      throw errors.validation('Confirmation of authority to bind the organization is required.');
    }
  } else {
    if (!input.mayAcknowledgeIndividually) {
      throw errors.forbidden('You are not permitted to acknowledge these Terms.');
    }
    if (input.bindingAuthorityConfirmed) {
      /*
       * Refused, not ignored. An individual acknowledgement that carried a
       * claim of corporate authority would be evidence of something the person
       * was never asked and may not have.
       */
      throw errors.validation(
        'An individual acknowledgement must not claim authority to bind the organization.',
      );
    }
  }

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .select(['id', 'legal_country'])
      .where('id', '=', input.organizationId)
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Organization');

    const country = organization.legal_country as LegalCountry | null;
    if (!isLegalCountry(country)) {
      throw errors.validation(
        'This organization has no registered legal country, so the applicable Country Addendum '
        + 'cannot be determined. Select the legal country first.',
      );
    }

    /* ── Publication: is there anything anybody may accept? ──────────────── */

    const bundle = publishedBundleFor(country);
    if (!bundle) {
      throw errors.validation(
        'The Ledgora legal documents are not published yet, so no acceptance can be recorded. '
        + 'This is expected while they are in draft.',
      );
    }

    /* ── The bundle must be complete and exactly right ───────────────────── */

    const expected = new Set<LegalDocumentId>(['master-terms', ADDENDUM_FOR_COUNTRY[country]]);
    const supplied = new Set(input.documents.map((d) => d.documentId));
    if (supplied.size !== expected.size || [...expected].some((id) => !supplied.has(id))) {
      throw errors.validation(
        `This organization must accept the Master Terms and the ${ADDENDUM_FOR_COUNTRY[country]} together.`,
      );
    }

    for (const document of input.documents) {
      if (!DOCUMENT_IDS.includes(document.documentId)) throw errors.validation('Unknown document.');
      if (!SHA256.test(document.contentHash)) {
        throw errors.validation('A valid content hash is required for every document accepted.');
      }
      /*
       * The version and hash must match a document the SERVER publishes. The
       * client says what it showed; this says what may be shown. Without it an
       * acceptance could name a version that never existed and still be stored
       * as evidence.
       */
      if (!findPublishedDocument(document.documentId, document.version, document.contentHash)) {
        throw errors.validation(
          `${document.documentId} version ${document.version} is not a published Ledgora document, `
          + 'or its content hash does not match the published text.',
        );
      }
    }

    /* ── Everything validated. Now write. ────────────────────────────────── */

    const recorded: AcceptanceRow[] = [];
    let inserted = 0;

    for (const document of input.documents) {
      /*
       * `onConflict … doNothing` against the unique key is what makes this
       * idempotent under concurrency. Checking first and inserting second would
       * lose the race between two tabs; letting the database arbitrate does not.
       */
      const result = await trx
        .insertInto('legal_acceptances')
        .values({
          user_id: input.userId,
          organization_id: input.organizationId,
          legal_country: country,
          scope: input.scope,
          document_id: document.documentId,
          version: document.version,
          content_hash: document.contentHash,
          binding_authority_confirmed: input.scope === 'organization' && input.bindingAuthorityConfirmed,
          accepted_as_role: input.actingAsRole,
          user_agent: input.userAgent ?? null,
        })
        .onConflict((oc) => oc
          .columns(['organization_id', 'user_id', 'scope', 'document_id', 'version', 'content_hash'])
          .doNothing())
        .returning([
          'scope', 'document_id', 'version', 'content_hash',
          'accepted_at', 'user_id', 'binding_authority_confirmed',
        ])
        .executeTakeFirst();

      if (result) {
        inserted += 1;
        recorded.push(toRow(result));
        continue;
      }

      /* Already present — return the existing row so the caller sees the truth. */
      const existing = await trx
        .selectFrom('legal_acceptances')
        .select([
          'scope', 'document_id', 'version', 'content_hash',
          'accepted_at', 'user_id', 'binding_authority_confirmed',
        ])
        .where('organization_id', '=', input.organizationId)
        .where('user_id', '=', input.userId)
        .where('scope', '=', input.scope)
        .where('document_id', '=', document.documentId)
        .where('version', '=', document.version)
        .where('content_hash', '=', document.contentHash)
        .executeTakeFirst();
      if (existing) recorded.push(toRow(existing));
    }

    if (inserted > 0) {
      await writeAuditLog(trx, {
        action: input.scope === 'organization'
          ? 'legal.organization_accepted'
          : 'legal.individual_acknowledged',
        actorUserId: input.userId,
        organizationId: input.organizationId,
        metadata: {
          scope: input.scope,
          legalCountry: country,
          documents: input.documents.map((d) => ({
            id: d.documentId, version: d.version, hash: d.contentHash,
          })),
          bindingAuthorityConfirmed: input.bindingAuthorityConfirmed,
          role: input.actingAsRole,
        },
      });
    }

    return { recorded, idempotentReplay: inserted === 0 };
  });
}

/* ── The registered legal country ─────────────────────────────────────────── */

export interface SetLegalCountryInput {
  organizationId: string;
  country: unknown;
  actorUserId: string;
  actorRole: string | null;
  /** Resolved by the route from `legal_terms:manage_organization_settings`. */
  mayAdministerLegalCountry: boolean;
  /** How the authority was held, for the change record. */
  authority: string;
  reason?: string | null;
}

export interface SetLegalCountryResult {
  previousCountry: LegalCountry | null;
  newCountry: LegalCountry;
  /** True when the change invalidated an existing country-addendum acceptance. */
  addendumAcceptanceInvalidated: boolean;
}

/**
 * Set or change the organization's registered legal country.
 *
 * Changing it changes which law governs the contract, so it is an act of the
 * same class as accepting the Terms and carries the same restriction. The
 * previous country's addendum acceptance is NOT deleted — it remains the true
 * record of what was agreed under the old country — but it stops satisfying the
 * requirement, because the applicable addendum is now a different document.
 * That invalidation is derived from the country change, not stored as a flag
 * somebody could clear.
 */
export async function setLegalCountry(
  db: Kysely<Database>,
  input: SetLegalCountryInput,
): Promise<SetLegalCountryResult> {
  if (!isLegalCountry(input.country)) {
    throw errors.validation(
      'The legal country must be one of AE, JO or SA. It is the country the organization is '
      + 'legally registered in, and it is never inferred from an address, a locale or a network address.',
    );
  }
  if (!input.mayAdministerLegalCountry) {
    throw errors.forbidden(
      'You are not authorised to set this organization’s registered legal country. '
      + 'It determines which Country Addendum governs the agreement.',
    );
  }

  const country = input.country;

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .select(['id', 'legal_country'])
      .where('id', '=', input.organizationId)
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Organization');

    const previous = (organization.legal_country as LegalCountry | null) ?? null;
    if (previous === country) {
      return { previousCountry: previous, newCountry: country, addendumAcceptanceInvalidated: false };
    }

    await trx
      .updateTable('organizations')
      .set({ legal_country: country, updated_at: new Date() })
      .where('id', '=', input.organizationId)
      .execute();

    await trx
      .insertInto('organization_legal_country_changes')
      .values({
        organization_id: input.organizationId,
        previous_country: previous,
        new_country: country,
        changed_by_user_id: input.actorUserId,
        changed_by_role: input.actorRole,
        authority: input.authority,
        reason: input.reason ?? null,
      })
      .execute();

    await writeAuditLog(trx, {
      action: 'legal.country_changed',
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      metadata: {
        previousCountry: previous,
        newCountry: country,
        authority: input.authority,
        role: input.actorRole,
        /*
         * Stated in the trail rather than left to be worked out: the previous
         * addendum acceptance is preserved but no longer satisfies the
         * requirement, and a new acceptance is needed.
         */
        priorAddendumAcceptancePreservedButSuperseded: previous !== null,
      },
    });

    return {
      previousCountry: previous,
      newCountry: country,
      addendumAcceptanceInvalidated: previous !== null,
    };
  });
}
