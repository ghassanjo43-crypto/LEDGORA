/**
 * The amendment audit chain.
 *
 * ══ What this is ═════════════════════════════════════════════════════════════
 *
 * Every amendment ATTEMPT — succeeded, failed, rejected or cancelled — becomes
 * one event, appended to a chain. Each event carries a checksum computed over
 * its own content and the previous event's checksum, so removing an event,
 * reordering two, or editing the amount inside one breaks every checksum from
 * that point on and `verifyAmendmentChain` reports exactly where.
 *
 * ══ What this is NOT ═════════════════════════════════════════════════════════
 *
 * It is NOT a secure audit log, and describing it as one would be a false
 * claim. Ledgora's invoices, bills, credit notes and journals live in the
 * customer's own browser (`lib/workspaceStorage`), which means:
 *
 *  · anyone with devtools can read the chain, recompute it, and write back a
 *    doctored one that verifies — there is no secret and no server witness, so
 *    the chain proves ACCIDENTAL corruption and casual editing, not tampering
 *    by a determined holder of the browser profile;
 *  · clearing site data destroys the whole trail, exactly as it destroys the
 *    books it describes;
 *  · a crash between two store writes can leave the trail describing an
 *    amendment the rollback then undid — the event's `outcome` is what to read,
 *    never its mere presence.
 *
 * The checksum is therefore deliberately a plain, fast, NON-CRYPTOGRAPHIC
 * digest. A SHA-256 here would buy nothing: with no key and no server, an
 * attacker who can edit the data can equally recompute any digest. Choosing the
 * expensive one would communicate a guarantee that does not exist.
 *
 * When these records move server-side, the chain's role is to be REPLACED by
 * the account service's `audit_logs` — append-only rows the tenant cannot
 * reach — not to be carried over.
 */
import type { AmendmentAuditEvent } from '@/types/documentAmendment';

/**
 * FNV-1a over two lanes, rendered as 16 hex characters.
 *
 * Two independently-seeded 32-bit lanes rather than one, because a single
 * 32-bit digest collides by birthday at a few tens of thousands of events —
 * well inside what an active company produces — and a collision here would
 * report a broken chain as intact.
 */
export function checksum(input: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((code << 1) | (i & 0x1f)), 0x85ebca6b) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Every field of the event EXCEPT its own checksum, in a stable order. */
type Chainable = Omit<AmendmentAuditEvent, 'checksum'>;

/**
 * Canonical serialisation.
 *
 * Key order is fixed by `JSON.stringify`'s replacer rather than left to object
 * literal order, so an event rebuilt with its fields written in a different
 * sequence still digests identically. A canonical form that depended on how the
 * object happened to be constructed would report false tampering after any
 * refactor.
 */
export function canonicalise(event: Chainable): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    return value;
  });
}

/** Seal an event onto the chain. */
export function sealEvent(event: Chainable): AmendmentAuditEvent {
  return { ...event, checksum: checksum(`${event.previousChecksum}|${canonicalise(event)}`) };
}

export interface ChainVerification {
  ok: boolean;
  /** The 1-based index of the first event that does not verify. */
  brokenAt?: number;
  message?: string;
}

/**
 * Walk the chain and report the first break.
 *
 * Reports the FIRST break rather than counting them: once one event's checksum
 * is wrong every later one is wrong too, so a count would describe the size of
 * the trail rather than the size of the problem.
 */
export function verifyAmendmentChain(events: readonly AmendmentAuditEvent[]): ChainVerification {
  let previous = '';
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.previousChecksum !== previous) {
      return {
        ok: false,
        brokenAt: i + 1,
        message: `Amendment audit event ${i + 1} (${event.documentNumber}) does not follow the previous event. The trail has been altered or an event is missing.`,
      };
    }
    const { checksum: recorded, ...rest } = event;
    if (checksum(`${previous}|${canonicalise(rest)}`) !== recorded) {
      return {
        ok: false,
        brokenAt: i + 1,
        message: `Amendment audit event ${i + 1} (${event.documentNumber}) does not match its own checksum. Its contents have been altered.`,
      };
    }
    previous = recorded;
  }
  return { ok: true };
}

/**
 * The honest one-paragraph description of what the trail guarantees, shown in
 * the UI next to it rather than left for a reader to assume.
 */
export const AMENDMENT_AUDIT_LIMITATION =
  'This amendment trail is held in this browser alongside the books it describes. '
  + 'The checksum chain detects accidental corruption and casual editing, and no screen in Ledgora can change or delete an event — '
  + 'but it is not a server-side audit log and cannot be relied on against someone with access to this browser profile.';
