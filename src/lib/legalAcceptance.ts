/**
 * Whether this person still has to accept something before they may work.
 *
 * ══ Signing in is authentication, not consent ════════════════════════════════
 *
 * Nothing in this module treats a successful login as acceptance. Acceptance is
 * a separate, deliberate act with its own record; `evaluateAcceptance` only
 * reports whether that act is outstanding. A user who signs in and never ticks
 * the box has authenticated and accepted nothing, and that is the correct state
 * for them to be in.
 *
 * ══ Why a draft cannot be required ═══════════════════════════════════════════
 *
 * The Master Terms and all three Addenda are currently unapproved drafts
 * carrying `[UNRESOLVED]` placeholders. Two obvious wirings are both wrong:
 *
 *   · require acceptance anyway — and every user is shown a contract with a
 *     blank where the governing court should be, and a record is written
 *     claiming they agreed to it. That record would be worthless, and worse
 *     than worthless because it would look like evidence;
 *   · require acceptance and let nobody past — and the legal gate becomes an
 *     outage.
 *
 * So the gate is DORMANT while the documents are not publication-ready, and it
 * arms itself the moment counsel approves them, an effective date is set and
 * the unresolved items are gone. No code change is needed to switch it on,
 * which means nobody has to remember to.
 */
import type { LegalCountryCode, LegalDocumentId } from '@/content/legal/types';
import {
  acceptanceReadiness,
  documentHash,
  isLegalCountry,
  resolveApplicableDocuments,
} from '@/lib/legalDocuments';

/**
 * The two different legal acts, kept apart.
 *
 *   organization — binds the ORGANIZATION. Only the Primary Owner, or someone
 *                  explicitly granted the authority, may perform it.
 *   individual   — this person acknowledging the document for themselves. Every
 *                  user must; it binds nobody but them.
 *
 * An invited bookkeeper acknowledging the Terms is not the company agreeing to
 * them, and this type is what stops the two ever being read as the same fact.
 */
export type AcceptanceScope = 'organization' | 'individual';

/** One acceptance as the server records it. */
export interface AcceptanceRecord {
  scope: AcceptanceScope;
  documentId: LegalDocumentId;
  version: string;
  contentHash: string;
  /** Server timestamp. Never client-supplied. */
  acceptedAt: string;
}

/* ── Who may bind the organization ────────────────────────────────────────── */

export interface BindingAuthorityInput {
  /** True only for the subscriber who owns the workspace. */
  isPrimaryOwner: boolean;
  /** The resolved `legal_terms:accept` permission from the server. */
  hasExplicitAcceptPermission: boolean;
  /**
   * True when a LEDGORA platform operator is acting. Never authority: a
   * platform role is not a mandate from the customer, and a Super Admin
   * accepting a subscriber's contract on their behalf is precisely the act
   * this flag exists to refuse.
   */
  actingAsPlatformOperator?: boolean;
}

export interface BindingAuthority {
  mayBind: boolean;
  source: 'primary-owner' | 'explicit-permission' | 'none';
  /** What to tell a user who cannot bind. Never blames them. */
  explanation: string;
}

/**
 * May this person accept on the ORGANIZATION's behalf?
 *
 * Deliberately narrow. Accountant, Member and Viewer never hold it by role, an
 * Organization Admin does not acquire it by managing colleagues, and a platform
 * Super Admin cannot take it — the authority to bind a company comes from the
 * company, not from a job title and not from operating the platform.
 */
export function resolveBindingAuthority(input: BindingAuthorityInput): BindingAuthority {
  if (input.actingAsPlatformOperator) {
    return {
      mayBind: false,
      source: 'none',
      explanation:
        'A Ledgora platform operator cannot accept these Terms on a subscriber’s behalf. '
        + 'The organization’s Primary Owner, or someone they have authorised, must accept them.',
    };
  }
  if (input.isPrimaryOwner) {
    return { mayBind: true, source: 'primary-owner', explanation: 'You are the organization’s Primary Owner.' };
  }
  if (input.hasExplicitAcceptPermission) {
    return {
      mayBind: true,
      source: 'explicit-permission',
      explanation: 'You have been explicitly authorised to accept these Terms for this organization.',
    };
  }
  return {
    mayBind: false,
    source: 'none',
    explanation:
      'Your organization has not yet accepted the Ledgora Terms. The organization’s Primary Owner — '
      + 'or someone they have explicitly authorised — must accept them before the accounting features '
      + 'can be used. You can still review the Terms, manage your account and subscription, get support, '
      + 'and export your data.',
  };
}

/** What the person must be shown and asked to accept. */
export interface RequiredDocument {
  documentId: LegalDocumentId;
  title: string;
  version: string;
  contentHash: string;
  /** Why this one is outstanding, for the review screen and for support. */
  reason: 'never-accepted' | 'version-superseded' | 'text-changed';
}

export type AcceptanceStatus =
  /** The documents are not ready to be accepted by anyone. Gate dormant. */
  | 'not-required-documents-not-ready'
  /** No registered legal country, so no addendum can be determined. */
  | 'country-required'
  /** Everything current is accepted, at both levels. */
  | 'satisfied'
  /** The ORGANIZATION has not accepted. Only an authorised person can fix it. */
  | 'organization-acceptance-required'
  /** The organization has accepted; THIS user has not acknowledged. */
  | 'individual-acknowledgment-required'
  /** Both are outstanding. */
  | 'both-required';

export interface AcceptanceEvaluation {
  status: AcceptanceStatus;
  /** True only when the user must be stopped before operational access. */
  blocksOperationalAccess: boolean;
  country: LegalCountryCode | null;
  /** Documents the ORGANIZATION still owes. */
  organizationOutstanding: RequiredDocument[];
  /** Documents THIS USER still owes personally. */
  individualOutstanding: RequiredDocument[];
  /** Human-readable explanation, for the screen and for diagnostics. */
  explanation: string;
}

export interface AcceptanceInput {
  /**
   * The organization's REGISTERED legal country, from the server.
   *
   * Deliberately the only geographic input this function takes. There is no
   * parameter for a locale, a timezone, an IP address or a currency, so a
   * caller cannot pass one in even by mistake.
   */
  legalCountry: unknown;
  /**
   * Organization-scope acceptances for this organization, whoever gave them.
   * The company accepts once; it does not re-accept per employee.
   */
  organizationAcceptances: readonly AcceptanceRecord[];
  /** Individual-scope acknowledgements recorded for THIS user. */
  individualAcknowledgments: readonly AcceptanceRecord[];
}

/**
 * Evaluate what, if anything, this user still owes.
 *
 * Pure: it reads the document registry and the supplied records, and touches no
 * store, no clock and no network. That is what lets the twelve required
 * scenarios be asserted without standing up a session.
 */
export function evaluateAcceptance(input: AcceptanceInput): AcceptanceEvaluation {
  const empty = {
    organizationOutstanding: [] as RequiredDocument[],
    individualOutstanding: [] as RequiredDocument[],
  };

  if (!isLegalCountry(input.legalCountry)) {
    return {
      ...empty,
      status: 'country-required',
      /*
       * NOT a block. A user whose organization has never been asked for its
       * legal country has done nothing wrong, and locking them out of their own
       * books over a question nobody put to them would be the product fault
       * presented as theirs.
       */
      blocksOperationalAccess: false,
      country: null,
      explanation:
        'This organization has no registered legal country yet, so the applicable Country Addendum '
        + 'cannot be determined. An authorised representative must select it before the Terms can be '
        + 'presented for acceptance.',
    };
  }

  const country = input.legalCountry;
  const readiness = acceptanceReadiness(country);
  if (!readiness.ready) {
    return {
      ...empty,
      status: 'not-required-documents-not-ready',
      blocksOperationalAccess: false,
      country,
      explanation:
        'The Ledgora legal documents are not yet approved for acceptance, so no acceptance is required. '
        + readiness.reasons.join(' '),
    };
  }

  const organizationOutstanding = outstandingFor(country, input.organizationAcceptances);
  const individualOutstanding = outstandingFor(country, input.individualAcknowledgments);

  if (organizationOutstanding.length === 0 && individualOutstanding.length === 0) {
    return {
      ...empty,
      status: 'satisfied',
      blocksOperationalAccess: false,
      country,
      explanation: 'The organization has accepted the current documents, and you have acknowledged them.',
    };
  }

  const status: AcceptanceStatus =
    organizationOutstanding.length > 0 && individualOutstanding.length > 0
      ? 'both-required'
      : organizationOutstanding.length > 0
        ? 'organization-acceptance-required'
        : 'individual-acknowledgment-required';

  return {
    status,
    /*
     * Either level outstanding blocks operational access — but they are fixed
     * by different people. An employee cannot resolve an organization
     * acceptance, so the screen must tell them who can rather than implying
     * they are at fault.
     */
    blocksOperationalAccess: true,
    country,
    organizationOutstanding,
    individualOutstanding,
    explanation:
      status === 'individual-acknowledgment-required'
        ? 'You must acknowledge the current Ledgora Terms before using the accounting features.'
        : status === 'organization-acceptance-required'
          ? 'This organization has not yet accepted the current Ledgora Terms.'
          : 'This organization has not accepted the current Ledgora Terms, and you have not acknowledged them.',
  };
}

/** Which of the two applicable documents are missing from `records`. */
function outstandingFor(
  country: LegalCountryCode,
  records: readonly AcceptanceRecord[],
): RequiredDocument[] {
  const { master, addendum } = resolveApplicableDocuments(country);
  const outstanding: RequiredDocument[] = [];

  for (const document of [master, addendum]) {
    const hash = documentHash(document);
    const forThisDocument = records.filter((a) => a.documentId === document.id);
    const matching = forThisDocument.find((a) => a.version === document.version);

    if (!matching) {
      outstanding.push({
        documentId: document.id,
        title: document.title,
        version: document.version,
        contentHash: hash,
        reason: forThisDocument.length === 0 ? 'never-accepted' : 'version-superseded',
      });
      continue;
    }

    /*
     * Same version, different text. The versioning rule says the version is
     * raised whenever the words change, but "should not happen" is not a
     * guarantee, and the consequence of ignoring it is somebody treated as
     * having accepted text they were never shown.
     */
    if (matching.contentHash !== hash) {
      outstanding.push({
        documentId: document.id,
        title: document.title,
        version: document.version,
        contentHash: hash,
        reason: 'text-changed',
      });
    }
  }

  return outstanding;
}

/**
 * The documents a person would be asked to accept for `country`, with the
 * hashes that must be recorded. Used by the review screen, so what is SHOWN and
 * what is RECORDED are computed from one place and cannot disagree.
 *
 * A user must never be recorded as accepting a document they were not shown;
 * building both from this function is what makes that structural.
 */
export function documentsToPresent(country: LegalCountryCode): RequiredDocument[] {
  const { master, addendum } = resolveApplicableDocuments(country);
  return [master, addendum].map((document) => ({
    documentId: document.id,
    title: document.title,
    version: document.version,
    contentHash: documentHash(document),
    reason: 'never-accepted' as const,
  }));
}
