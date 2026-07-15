import { create } from 'zustand';

/**
 * Transient cross-view bridge: lets the Invoices/Customers pages request that a
 * specific receipt draft be opened in the editor after switching to the Receipts
 * view. Never persisted — it is consumed once on arrival.
 */
interface ReceiptEditorState {
  requestedEditorId: string | null;
  requestOpen: (receiptId: string) => void;
  consume: () => string | null;
}

export const useReceiptEditor = create<ReceiptEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestOpen: (receiptId) => set({ requestedEditorId: receiptId }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
}));
