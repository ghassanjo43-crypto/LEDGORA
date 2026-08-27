/**
 * The amendment audit trail: append-only, checksum-chained, and the only place
 * an amendment attempt is recorded whatever its outcome.
 *
 * ── Append-only by construction ──────────────────────────────────────────────
 * `append` is the ONLY way in. There is no update, no delete and no bulk
 * replace — not even the `replaceAll` every other store carries for the
 * company-switch path, because nothing in that path touches this store and an
 * unused way to overwrite the whole trail is exactly what an append-only trail
 * must not have. `resetToDefault` clears it, and is reachable only from the
 * same workspace teardown that clears every other store.
 *
 * Read `lib/amendmentAudit` for exactly what the checksum chain does and does
 * not guarantee while these records live in the browser. It is stated there
 * once, honestly, rather than implied here.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * `findByCorrelation` is what stops a double-clicked confirmation posting two
 * reversals: the service asks for the correlation id before it does anything,
 * and replays the first attempt's result if it finds one.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { AmendmentAuditEvent } from '@/types/documentAmendment';
import { sealEvent, verifyAmendmentChain, type ChainVerification } from '@/lib/amendmentAudit';

interface AmendmentAuditState {
  events: AmendmentAuditEvent[];

  /** Seal and append. Returns the sealed event, including its checksum. */
  append: (event: Omit<AmendmentAuditEvent, 'id' | 'sequence' | 'previousChecksum' | 'checksum'> & { id: string }) => AmendmentAuditEvent;
  /** Every event for one document chain, oldest first. */
  forDocument: (documentId: string) => AmendmentAuditEvent[];
  findByCorrelation: (correlationId: string) => AmendmentAuditEvent | undefined;
  /**
   * The SUCCEEDED attempt under this correlation id, if there is one.
   *
   * What idempotency actually needs. `findByCorrelation` returns the first
   * event, which after a refused-then-corrected retry is the refusal — and a
   * replay of that would undo the amendment the operator did complete.
   */
  findCompleted: (correlationId: string) => AmendmentAuditEvent | undefined;
  verify: () => ChainVerification;

  resetToDefault: () => void;
}

export const useAmendmentAuditStore = create<AmendmentAuditState>()(
  persist(
    (set, get) => ({
      events: [],

      append: (input) => {
        const events = get().events;
        const previous = events[events.length - 1];
        const sealed = sealEvent({
          ...input,
          sequence: events.length + 1,
          previousChecksum: previous?.checksum ?? '',
        });
        set({ events: [...events, sealed] });
        return sealed;
      },

      forDocument: (documentId) =>
        get().events.filter(
          (e) => e.documentId === documentId || e.replacementDocumentId === documentId,
        ),

      findByCorrelation: (correlationId) =>
        get().events.find((e) => e.correlationId === correlationId),

      findCompleted: (correlationId) =>
        get().events.find((e) => e.correlationId === correlationId && e.outcome === 'succeeded'),

      verify: () => verifyAmendmentChain(get().events),

      resetToDefault: () => set({ events: [] }),
    }),
    {
      name: 'ledgora-amendment-audit',
      storage: businessJSONStorage,
      version: 1,
      partialize: (s) => ({ events: s.events }),
    },
  ),
);
