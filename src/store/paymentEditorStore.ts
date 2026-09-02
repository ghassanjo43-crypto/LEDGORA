import { create } from 'zustand';

/**
 * Transient cross-view bridge: lets the Bills / Suppliers / Dashboard pages
 * request that a specific payment draft be opened in the editor after switching
 * to the Payments view. Never persisted — it is consumed once on arrival.
 */
interface PaymentEditorState {
  requestedEditorId: string | null;
  /**
   * A NEW durable payment for this supplier.
   *
   * On server books there is no draft to point at until the first save — the
   * server needs a supplier, a date, an amount and a paying account before a
   * payment can exist — so "Record payment" on a bill asks for a blank editor
   * seeded with the supplier rather than for a record that is not there yet.
   */
  requestedNewSupplierId: string | null;
  /** A new durable payment with no supplier chosen yet. */
  requestedNew: boolean;
  requestOpen: (paymentId: string) => void;
  requestNew: () => void;
  requestNewForSupplier: (supplierId: string) => void;
  consume: () => string | null;
  consumeNewSupplier: () => string | null;
  consumeNew: () => boolean;
}

export const usePaymentEditor = create<PaymentEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestedNewSupplierId: null,
  requestedNew: false,
  requestOpen: (paymentId) =>
    set({ requestedEditorId: paymentId, requestedNewSupplierId: null, requestedNew: false }),
  requestNew: () => set({ requestedNew: true, requestedEditorId: null, requestedNewSupplierId: null }),
  requestNewForSupplier: (supplierId) =>
    set({ requestedNewSupplierId: supplierId, requestedEditorId: null, requestedNew: false }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
  consumeNewSupplier: () => {
    const id = get().requestedNewSupplierId;
    if (id) set({ requestedNewSupplierId: null });
    return id;
  },
  consumeNew: () => {
    const wanted = get().requestedNew;
    if (wanted) set({ requestedNew: false });
    return wanted;
  },
}));
