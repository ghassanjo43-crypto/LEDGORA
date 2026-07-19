/**
 * Bank-remittance payment references.
 *
 * A payment reference (`LG-XXXX-XXXX`) is the only thing that ties an incoming
 * bank transfer back to an invoice — a transfer arrives with nothing else that
 * identifies the customer. It must therefore be unique, and a human must be able
 * to copy it into a bank form without ambiguity.
 *
 * ⚠ PRODUCTION REQUIREMENT — references MUST be generated server-side.
 *
 *   The development adapter below runs in the customer's browser. That means:
 *     • it can only check uniqueness against invoices this browser knows about,
 *       so two customers could be issued the same reference;
 *     • a customer can trivially alter their own reference before "paying";
 *     • `Math.random()` (used as the fallback source of entropy) is not
 *       cryptographically strong.
 *
 *   A real deployment issues the reference inside the same database transaction
 *   that creates the invoice, and the column MUST carry a UNIQUE constraint —
 *   uniqueness is enforced by the database, never by an application-level scan:
 *
 *     ALTER TABLE subscription_invoices
 *       ADD COLUMN payment_reference text NOT NULL;
 *     CREATE UNIQUE INDEX subscription_invoices_payment_reference_key
 *       ON subscription_invoices (payment_reference);
 *
 *   On a collision the insert fails and the server retries with a new value.
 *   Nothing here is or should be presented as production-secure, and no secret
 *   or API key belongs in this (public) frontend bundle.
 */

/** Shape a backend adapter must satisfy. */
export interface PaymentReferenceService {
  /**
   * Issue the authoritative payment reference for an invoice.
   * BACKEND SEAM: `POST /api/organizations/{organizationId}/invoices/{invoiceId}/payment-reference`
   * (or, more usually, the invoice-creation endpoint returns it directly).
   */
  createReference(invoiceId: string, organizationId: string): Promise<string>;
}

/**
 * Crockford-style alphabet: no `I`, `L`, `O` or `U`, so a reference can never be
 * misread as 1/0 or transcribed into a bank form incorrectly.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BLOCK_LENGTH = 4;
const BLOCKS = 2;

/** `LG-` + two 4-character blocks. Used to validate customer-entered values. */
export const PAYMENT_REFERENCE_PATTERN = /^LG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(out);
    return out;
  }
  // Fallback for environments without WebCrypto. Development-only path.
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function randomReference(): string {
  const bytes = randomBytes(BLOCK_LENGTH * BLOCKS);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  const blocks: string[] = [];
  for (let i = 0; i < BLOCKS; i += 1) {
    blocks.push(chars.slice(i * BLOCK_LENGTH, (i + 1) * BLOCK_LENGTH).join(''));
  }
  return `LG-${blocks.join('-')}`;
}

/**
 * Synchronous development generator.
 *
 * The invoice stores create their invoice in a single synchronous action, so the
 * frontend-only build needs a synchronous reference. `isTaken` lets each caller
 * supply the references it already knows about — a best-effort local check that
 * a database UNIQUE constraint replaces in production.
 */
export function generateDevelopmentReference(isTaken?: (reference: string) => boolean): string {
  let reference = randomReference();
  // Bounded: with 32^8 ≈ 1.1e12 possibilities a local collision is negligible.
  for (let attempt = 0; attempt < 20 && isTaken?.(reference); attempt += 1) {
    reference = randomReference();
  }
  return reference;
}

/** Is this a well-formed LEDGORA payment reference? */
export function isValidPaymentReference(value: string): boolean {
  return PAYMENT_REFERENCE_PATTERN.test(normalizePaymentReference(value));
}

/** Normalise customer input (spacing/case) before comparing to the invoice. */
export function normalizePaymentReference(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

/** Do the customer's typed reference and the invoice's reference agree? */
export function paymentReferenceMatches(entered: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return normalizePaymentReference(entered) === normalizePaymentReference(expected);
}

/**
 * DEVELOPMENT adapter. Satisfies the async contract so a backend implementation
 * is a drop-in replacement (see `services/index.ts`).
 */
export const devPaymentReferenceService: PaymentReferenceService = {
  async createReference(invoiceId, organizationId) {
    void invoiceId;
    void organizationId;
    // BACKEND SEAM: replace with the API call described at the top of this file.
    // The server generates the reference under a UNIQUE database constraint.
    return generateDevelopmentReference();
  },
};
