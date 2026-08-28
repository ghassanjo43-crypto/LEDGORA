/**
 * The legal documents the SERVER considers published.
 *
 * ══ Why the server needs its own list ════════════════════════════════════════
 *
 * Without one, an acceptance request could name any version string and any
 * well-formed hash, and the server would store it as evidence. "The customer
 * accepted version 9.9.9 with hash abc…" would be indistinguishable from a real
 * acceptance while corresponding to no document that ever existed. A record of
 * consent that the recording party cannot itself verify is not evidence.
 *
 * So the version and hash of every acceptable document are declared HERE, and
 * `legalService` refuses anything not on this list. The client sends what it
 * showed; the server checks it against what may be shown.
 *
 * ══ Why it holds no text ═════════════════════════════════════════════════════
 *
 * Only identity: id, version, effective date and the SHA-256 of the canonical
 * text. The words live in `src/content/legal` on the frontend, which renders
 * them and computes the hash the same way for both purposes. Duplicating the
 * prose here would create a second copy to drift; duplicating the DIGEST cannot
 * drift silently, because a mismatch is exactly what it detects.
 *
 * ══ Why it is empty ══════════════════════════════════════════════════════════
 *
 * Nothing is published. All four documents are unapproved drafts carrying
 * unresolved placeholders, so there is no version anybody may be recorded as
 * accepting, and this list is the server's statement of that fact. An empty
 * registry means every acceptance request is refused — which is the correct
 * behaviour while the gate is dormant, and it is enforced here rather than
 * merely arranged in the UI.
 *
 * ══ Publishing ═══════════════════════════════════════════════════════════════
 *
 * A document is added to this list ONLY when counsel has approved it, the
 * business has approved publication, it has an effective date and a real
 * version, and its pinned hash matches its text. Adding an entry here is the
 * server-side half of that decision, and it is a code change that goes through
 * review — not a flag anybody can flip at runtime.
 */

export type PublishedDocumentId = 'master-terms' | 'addendum-ae' | 'addendum-jo' | 'addendum-sa';
export type LegalCountryCode = 'AE' | 'JO' | 'SA';

export interface PublishedLegalDocument {
  id: PublishedDocumentId;
  /** Absent on the Master Terms, which apply to every country. */
  country?: LegalCountryCode;
  version: string;
  effectiveDate: string;
  /** SHA-256 of the canonical text, as the frontend computes it. */
  contentHash: string;
}

/**
 * Deliberately empty. See the module note — nothing is approved for
 * publication, so nothing may be accepted.
 */
export const PUBLISHED_LEGAL_DOCUMENTS: readonly PublishedLegalDocument[] = [];

/** The addendum that belongs to each country. */
export const ADDENDUM_FOR_COUNTRY: Record<LegalCountryCode, PublishedDocumentId> = {
  AE: 'addendum-ae',
  JO: 'addendum-jo',
  SA: 'addendum-sa',
};

export function findPublishedDocument(
  id: string,
  version: string,
  contentHash: string,
): PublishedLegalDocument | undefined {
  return PUBLISHED_LEGAL_DOCUMENTS.find(
    (d) => d.id === id && d.version === version && d.contentHash === contentHash,
  );
}

/** Is anything published at all? False today, and the acceptance gate reads it. */
export function anyDocumentIsPublished(): boolean {
  return PUBLISHED_LEGAL_DOCUMENTS.length > 0;
}

/**
 * The exact bundle an organization in `country` must accept: the Master Terms
 * plus that country's addendum, or `null` while either is unpublished.
 *
 * Returning null rather than a partial bundle is the point. A half-published
 * pair must not produce a half-acceptance.
 */
export function publishedBundleFor(country: LegalCountryCode): PublishedLegalDocument[] | null {
  const master = PUBLISHED_LEGAL_DOCUMENTS.find((d) => d.id === 'master-terms');
  const addendum = PUBLISHED_LEGAL_DOCUMENTS.find((d) => d.id === ADDENDUM_FOR_COUNTRY[country]);
  if (!master || !addendum) return null;
  return [master, addendum];
}
