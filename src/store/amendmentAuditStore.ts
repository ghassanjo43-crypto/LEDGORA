/**
 * The amendment audit trail: append-only, checksum-chained, and the only place
 * an amendment attempt is recorded whatever its outcome.
 *
 * ── Append-only by construction ──────────────────────────────────────────────
 * There is no `update` and no `delete` on this store, and `replaceAll` exists
 * only for the company-switch/import path that swaps a whole workspace's books
 * in and out (`companyStore.snapshotWorkingStores`). No screen can reach an
 * event and change it, and no ordinary role has a code path that removes one.
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
  verify: () => ChainVerification;

  replaceAll: (events: AmendmentAuditEvent[]) => void;
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

      verify: () => verifyAmendmentChain(get().events),

      replaceAll: (events) => set({ events }),
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
