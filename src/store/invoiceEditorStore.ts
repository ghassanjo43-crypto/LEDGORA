import { create } from 'zustand';

/**
 * Transient cross-view bridge: lets the Dashboard (or any other page) request
 * that a specific invoice draft be opened in the editor after switching to the
 * Invoices view. Never persisted — it is consumed once on arrival.
 *
 * Identical in shape to `billEditorStore`, `paymentEditorStore`,
 * `creditNoteEditorStore` and `receiptEditorStore`. Invoices were the one
 * document module without one, which is why the Dashboard could not open an
 * invoice it had just created; this closes that gap rather than introducing a
 * new mechanism.
 *
 * ── Why a store and not a URL parameter or an event ──────────────────────────
 * The request has to survive exactly one view switch and then disappear. A
 * store makes that explicit: `requestOpen` sets it, the destination page's
 * effect `consume`s it, and consuming clears it. A global DOM event would race
 * with mounting, and a URL parameter would persist into the browser history so
 * a refresh or a back-navigation would reopen a drawer the user had closed.
 */
interface InvoiceEditorState {
  requestedEditorId: string | null;
  requestOpen: (invoiceId: string) => void;
  consume: () => string | null;
}

export const useInvoiceEditor = create<InvoiceEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestOpen: (invoiceId) => set({ requestedEditorId: invoiceId }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
}));
