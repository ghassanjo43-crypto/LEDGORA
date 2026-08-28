/**
 * Legal documents as DATA, not as JSX.
 *
 * ══ Why the text is structured data ══════════════════════════════════════════
 *
 * An acceptance record has to name a version and pin an immutable hash of what
 * the person was actually shown. That is only meaningful if the text has a
 * single canonical form: markup, spacing and component structure must not be
 * able to change the hash while the words stay the same, and the words must not
 * be able to change while the hash stays the same. Prose held in a component
 * cannot give either guarantee — a refactor of the page would silently
 * invalidate every stored hash.
 *
 * So each document is a versioned tree of headings and paragraphs, hashed over
 * its own content by `lib/legalDocuments`. The page renders it; the hash is
 * computed from it; the two cannot drift.
 *
 * ══ Versioning rule ══════════════════════════════════════════════════════════
 *
 * `version` is a document's identity in an acceptance record and MUST be raised
 * whenever the text changes in a way that alters what a customer agreed to.
 * `contentHash` is checked against the text at build and test time, so a change
 * to the words without a change to the version fails the suite rather than
 * quietly re-defining an already-accepted document.
 *
 * ══ Language ═════════════════════════════════════════════════════════════════
 *
 * `language` is on the document, not on the app. The product interface stays
 * English-only; this structure exists so a counsel-approved Arabic version can
 * be added later as its OWN document with its own version and hash, rather than
 * as a translation layer over the English one. A machine translation must never
 * be added here — see the note in `lib/legalDocuments`.
 */

/** ISO 3166-1 alpha-2, restricted to the countries Ledgora is offered in. */
export type LegalCountryCode = 'AE' | 'JO' | 'SA';

export type LegalDocumentId =
  | 'master-terms'
  | 'addendum-ae'
  | 'addendum-jo'
  | 'addendum-sa';

/** A paragraph, a list, or a call-out that must not read as ordinary prose. */
export type LegalBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  /**
   * An item counsel must resolve before this document may be published. Rendered
   * distinctly so a reader can never mistake a placeholder for a term, and
   * counted by `unresolvedItems` so the count can gate publication.
   */
  | { kind: 'unresolved'; text: string };

export interface LegalSection {
  /** Stable clause number, quoted in review and in support. Never renumbered. */
  number: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDocument {
  id: LegalDocumentId;
  /** Present on an addendum; absent on the Master Terms, which apply to all. */
  country?: LegalCountryCode;
  title: string;
  /** Bumped whenever the words change. See the versioning rule above. */
  version: string;
  /** ISO date the version takes effect. */
  effectiveDate: string;
  language: 'en';
  /**
   * False until counsel has signed the text off. The acceptance surface refuses
   * to present an unapproved document, so a draft cannot be accepted by anyone.
   */
  counselApproved: boolean;
  /**
   * Explicit approval to PUBLISH, separate from counsel's approval of the words.
   *
   * Two different decisions by two different people. Counsel says the text is
   * legally sound; the business says this version goes live on this date. A
   * single flag would let either one imply the other, and the failure mode is
   * publishing text counsel approved for a future release.
   */
  publicationApproved: boolean;
  /**
   * The SHA-256 the text is expected to hash to once it is final.
   *
   * Absent while drafting. Once set, `publicationReadiness` requires the
   * computed hash to MATCH it — so an edit to an approved document fails
   * loudly instead of silently redefining what customers already accepted. It
   * is the difference between a version number, which someone can forget to
   * raise, and a fingerprint, which they cannot.
   */
  expectedContentHash?: string;
  /** Who must review it, named so the gap is visible rather than assumed. */
  reviewRequired: string;
  sections: LegalSection[];
}
