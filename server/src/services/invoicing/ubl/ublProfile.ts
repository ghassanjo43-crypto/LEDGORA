/**
 * Everything about a UBL invoice that a national e-invoicing profile decides.
 *
 * ── Why this file exists as a separate thing ─────────────────────────────────
 * UBL 2.1 is a public OASIS standard: the element names, their namespaces and
 * — critically — the ORDER they must appear in are fixed, published, and the
 * same everywhere. `invoiceXml.ts` implements exactly that part, and it is
 * worth implementing now because it does not change when a spec arrives.
 *
 * What every country then does is CUSTOMIZE it: which identifier scheme a tax
 * number is quoted under, which code means "this is a taxable sale", what goes
 * in CustomizationID and ProfileID, which tax category letters are legal. Those
 * values are not derivable from the standard, cannot be reasoned out, and are
 * the difference between a document a tax authority clears and one it rejects.
 *
 * So they live here, in one small interface, rather than being sprinkled
 * through the builder as literals. When ISTD's JoFotara specification is in
 * hand, satisfying it should be writing one `UblProfile` constant and fixing
 * whatever the validator complains about — not re-reading a thousand lines of
 * string concatenation looking for guesses.
 *
 * ⚠️  `PLACEHOLDER_PROFILE` below is NOT a JoFotara profile. Every value in it
 * is an obvious stand-in. It exists so the builder can be exercised and tested
 * today. Submitting a document built with it to ISTD will fail, and it is meant
 * to: a plausible-looking wrong value is far more dangerous than a visibly
 * empty one, because it survives review.
 */

export interface UblPartyIdentification {
  /** The scheme a tax/commercial registration number is quoted under. */
  readonly schemeId: string;
}

export interface UblProfile {
  /** Human-readable name of the profile these values came from. */
  readonly name: string;
  /**
   * False until the values have been checked against an authority's published
   * specification. `assertSubmittable` refuses to let an unverified profile
   * reach a live submission path.
   */
  readonly verified: boolean;

  readonly ublVersionId: string;
  /** Identifies the national customization. Authority-assigned. */
  readonly customizationId: string;
  /** Identifies the business process (e.g. clearance vs reporting). */
  readonly profileId: string;

  /** Code meaning "commercial invoice" in this profile, plus its listed name. */
  readonly invoiceTypeCode: string;
  readonly invoiceTypeCodeName?: string;

  readonly supplierIdentification: UblPartyIdentification;
  readonly customerIdentification: UblPartyIdentification;

  /** Tax scheme identifier, e.g. the profile's code for general sales tax. */
  readonly taxSchemeId: string;
  /** Category code applied to a standard-rated line. */
  readonly standardTaxCategoryId: string;
  /** Category code applied to a zero-rated or exempt line. */
  readonly zeroTaxCategoryId: string;
}

/**
 * A stand-in profile for development and tests.
 *
 * Values are deliberately self-describing rather than realistic, so that a
 * document built with it cannot be mistaken for a real one at a glance.
 */
export const PLACEHOLDER_PROFILE: UblProfile = {
  name: 'PLACEHOLDER (not a real tax authority profile)',
  verified: false,

  ublVersionId: '2.1',
  customizationId: 'PLACEHOLDER-CUSTOMIZATION-ID',
  profileId: 'PLACEHOLDER-PROFILE-ID',

  invoiceTypeCode: '380', // UN/ECE 1001 "Commercial invoice" — genuinely standard.
  invoiceTypeCodeName: undefined,

  supplierIdentification: { schemeId: 'PLACEHOLDER-TAX-SCHEME' },
  customerIdentification: { schemeId: 'PLACEHOLDER-TAX-SCHEME' },

  taxSchemeId: 'VAT', // A real UN/ECE 5153 code, but not necessarily the right one.
  standardTaxCategoryId: 'S',
  zeroTaxCategoryId: 'Z',
};

export class UnverifiedProfileError extends Error {
  constructor(profile: UblProfile) {
    super(
      `Refusing to submit an invoice built with the "${profile.name}" UBL profile. `
      + 'This profile has not been checked against a tax authority specification, so the '
      + 'document it produces would be rejected — or, worse, accepted with wrong values.',
    );
    this.name = 'UnverifiedProfileError';
  }
}

/**
 * The gate between "we can generate XML" and "we may send it to an authority".
 *
 * Call this at the submission boundary, never at the build boundary — building
 * and inspecting placeholder XML is exactly what the placeholder profile is
 * for.
 */
export function assertSubmittable(profile: UblProfile): void {
  if (!profile.verified) throw new UnverifiedProfileError(profile);
}
