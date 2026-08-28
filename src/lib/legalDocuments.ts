/**
 * The legal document registry: which documents exist, which one applies to a
 * given organization, and what exactly was shown when someone accepted.
 *
 * ══ The rule this module enforces ════════════════════════════════════════════
 *
 * The applicable Country Addendum is decided by the organization's REGISTERED
 * LEGAL COUNTRY and by nothing else. Not the browser's locale, not its
 * timezone, not the IP address the request came from, not the display language,
 * not the billing currency. Those are all things an attacker can set and a
 * traveller changes by accident, and none of them is evidence of where a
 * company is registered.
 *
 * `resolveApplicableDocuments` therefore takes a `LegalCountryCode` and nothing
 * else. There is no signal to ignore because there is no parameter to pass one
 * in — which is a stronger guarantee than a rule that has to be remembered.
 *
 * ══ Canonical text and hashing ═══════════════════════════════════════════════
 *
 * `canonicalText` renders a document to one deterministic string, and
 * `documentHash` is its SHA-256. That digest is stored with every acceptance so
 * a third party can hash the published text themselves and confirm it is what
 * was agreed. Because the canonical form is derived from the document DATA and
 * not from the page's markup, restyling the Terms page cannot change the hash,
 * and editing a word cannot leave it unchanged.
 */
import type {
  LegalBlock,
  LegalCountryCode,
  LegalDocument,
  LegalDocumentId,
} from '@/content/legal/types';
import { MASTER_TERMS } from '@/content/legal/masterTerms';
import { UAE_ADDENDUM } from '@/content/legal/uaeAddendum';
import { JORDAN_ADDENDUM } from '@/content/legal/jordanAddendum';
import { SAUDI_ADDENDUM } from '@/content/legal/saudiAddendum';
import { sha256Hex } from '@/lib/sha256';

/* ── The countries Ledgora is offered in ──────────────────────────────────── */

export const LEGAL_COUNTRIES: LegalCountryCode[] = ['AE', 'JO', 'SA'];

export const LEGAL_COUNTRY_NAMES: Record<LegalCountryCode, string> = {
  AE: 'United Arab Emirates',
  JO: 'Hashemite Kingdom of Jordan',
  SA: 'Kingdom of Saudi Arabia',
};

/**
 * Is this a country Ledgora is offered in?
 *
 * Fail-closed and total: anything that is not one of the three supported codes
 * is not a legal country, including `undefined`, a lower-cased code, a country
 * name, and a three-letter code. An organization whose stored country does not
 * pass this has no applicable addendum and cannot accept — which is the correct
 * outcome, not an edge case to paper over.
 */
export function isLegalCountry(value: unknown): value is LegalCountryCode {
  return typeof value === 'string' && (LEGAL_COUNTRIES as string[]).includes(value);
}

const ADDENDUM_BY_COUNTRY: Record<LegalCountryCode, LegalDocument> = {
  AE: UAE_ADDENDUM,
  JO: JORDAN_ADDENDUM,
  SA: SAUDI_ADDENDUM,
};

export const ALL_LEGAL_DOCUMENTS: LegalDocument[] = [
  MASTER_TERMS,
  UAE_ADDENDUM,
  JORDAN_ADDENDUM,
  SAUDI_ADDENDUM,
];

export function masterTerms(): LegalDocument {
  return MASTER_TERMS;
}

export function addendumFor(country: LegalCountryCode): LegalDocument {
  return ADDENDUM_BY_COUNTRY[country];
}

export function documentById(id: LegalDocumentId): LegalDocument | undefined {
  return ALL_LEGAL_DOCUMENTS.find((d) => d.id === id);
}

/* ── What applies to one organization ─────────────────────────────────────── */

export interface ApplicableDocuments {
  country: LegalCountryCode;
  countryName: string;
  master: LegalDocument;
  addendum: LegalDocument;
}

/**
 * The documents that apply to an organization registered in `country`.
 *
 * Takes ONLY the registered legal country. See the module note: there is
 * deliberately no way to pass a locale, an IP address or a currency into this
 * decision.
 */
export function resolveApplicableDocuments(country: LegalCountryCode): ApplicableDocuments {
  return {
    country,
    countryName: LEGAL_COUNTRY_NAMES[country],
    master: MASTER_TERMS,
    addendum: ADDENDUM_BY_COUNTRY[country],
  };
}

/* ── Canonical text and hashing ───────────────────────────────────────────── */

function blockText(block: LegalBlock): string {
  if (block.kind === 'paragraph') return `P:${block.text}`;
  if (block.kind === 'list') return `L:${block.items.join('')}`;
  return `U:${block.text}`;
}

/**
 * One deterministic string per document — the thing that is hashed.
 *
 * Includes the identity fields a reader needs to know WHICH text this is
 * (id, version, effective date, language, title), then every section in order.
 * Separators are control characters so no document content can forge a
 * boundary and make two different documents hash alike.
 */
export function canonicalText(document: LegalDocument): string {
  const header = [
    document.id,
    document.country ?? 'ALL',
    document.version,
    document.effectiveDate,
    document.language,
    document.title,
  ].join('');
  const body = document.sections
    .map((s) => [s.number, s.heading, ...s.blocks.map(blockText)].join(''))
    .join('');
  return `${header}${body}`;
}

/** SHA-256 of the canonical text. Stored with every acceptance. */
export function documentHash(document: LegalDocument): string {
  return sha256Hex(canonicalText(document));
}

/* ── Publication readiness ────────────────────────────────────────────────── */

/** Every `unresolved` block in a document, in order. */
export function unresolvedItems(document: LegalDocument): string[] {
  return document.sections.flatMap((s) =>
    s.blocks.filter((b): b is Extract<LegalBlock, { kind: 'unresolved' }> => b.kind === 'unresolved')
      .map((b) => `${s.number} — ${b.text}`),
  );
}

export interface PublicationReadiness {
  ready: boolean;
  counselApproved: boolean;
  unresolvedCount: number;
  reasons: string[];
}

/**
 * May this document be PRESENTED FOR ACCEPTANCE yet?
 *
 * A draft may be published for review — that is what the public Terms page is
 * for — but nobody may be recorded as having accepted a document that counsel
 * has not approved or that still contains unresolved placeholders. An
 * acceptance of "[UNRESOLVED — governing Emirate]" is not an acceptance of
 * anything, and recording it as one would be worse than having no record.
 */
export function publicationReadiness(document: LegalDocument): PublicationReadiness {
  const unresolved = unresolvedItems(document);
  const reasons: string[] = [];

  /* 1. No unresolved placeholders. */
  if (unresolved.length > 0) {
    reasons.push(`${document.title} still has ${unresolved.length} unresolved item(s) that counsel must settle.`);
  }
  /* 2. An effective date. */
  if (!document.effectiveDate || document.effectiveDate === 'not-yet-effective') {
    reasons.push(`${document.title} has no effective date.`);
  }
  /* 3. A real version — a `-draft` suffix is not one. */
  if (!document.version || document.version.endsWith('-draft')) {
    reasons.push(`${document.title} is still at draft version ${document.version}.`);
  }
  /* 4. An immutable content hash, pinned and matching. */
  if (!document.expectedContentHash) {
    reasons.push(`${document.title} has no pinned content hash.`);
  } else if (document.expectedContentHash !== documentHash(document)) {
    /*
     * The text moved after it was pinned. This is the loud failure the pin
     * exists to produce: an approved document whose words have changed is not
     * the document anyone accepted, and publishing it would silently redefine
     * an existing agreement.
     */
    reasons.push(
      `${document.title} does not match its pinned content hash — the text has changed since it was approved. `
      + 'Raise the version and re-pin the hash.',
    );
  }
  /* 5. Explicit approval — counsel on the words, the business on publishing. */
  if (!document.counselApproved) {
    reasons.push(`${document.title} has not been approved by counsel (${document.reviewRequired}).`);
  }
  if (!document.publicationApproved) {
    reasons.push(`${document.title} has not been approved for publication.`);
  }

  return {
    ready: reasons.length === 0,
    counselApproved: document.counselApproved,
    unresolvedCount: unresolved.length,
    reasons,
  };
}

/**
 * Is this document safe to show on a PUBLIC production route?
 *
 * The same answer as publication readiness, and deliberately the same function:
 * a document that may not be accepted may not be published either. A public
 * `/terms` page carrying "[UNRESOLVED — governing Emirate]" is a worse problem
 * than a missing page, because a reader has no way to know it is not the deal.
 */
export function isPubliclyPublishable(document: LegalDocument): boolean {
  return publicationReadiness(document).ready;
}

/** The published documents, which may be empty while everything is in draft. */
export function publishedDocuments(): LegalDocument[] {
  return ALL_LEGAL_DOCUMENTS.filter(isPubliclyPublishable);
}

/**
 * Is the whole legal surface live?
 *
 * The Terms link appears on sign-in, registration, pricing and the footer only
 * when the Master Terms AND all three Addenda are publishable — because a link
 * that leads to "one of these is missing" is worse than no link, and because
 * acceptance arms at the same moment.
 */
export function legalSurfaceIsLive(): boolean {
  return ALL_LEGAL_DOCUMENTS.every(isPubliclyPublishable);
}

/** Readiness of the pair an organization in `country` would be asked to accept. */
export function acceptanceReadiness(country: LegalCountryCode): PublicationReadiness {
  const { master, addendum } = resolveApplicableDocuments(country);
  const parts = [publicationReadiness(master), publicationReadiness(addendum)];
  const reasons = parts.flatMap((p) => p.reasons);
  return {
    ready: reasons.length === 0,
    counselApproved: parts.every((p) => p.counselApproved),
    unresolvedCount: parts.reduce((sum, p) => sum + p.unresolvedCount, 0),
    reasons,
  };
}
