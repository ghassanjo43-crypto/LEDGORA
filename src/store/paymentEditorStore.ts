import { create } from 'zustand';

/**
 * Transient cross-view bridge: lets the Bills / Suppliers / Dashboard pages
 * request that a specific payment draft be opened in the editor after switching
 * to the Payments view. Never persisted — it is consumed once on arrival.
 */
interface PaymentEditorState {
  requestedEditorId: string | null;
  requestOpen: (paymentId: string) => void;
  consume: () => string | null;
}

export const usePaymentEditor = create<PaymentEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestOpen: (paymentId) => set({ requestedEditorId: paymentId }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
}));
