import { create } from 'zustand';

/**
 * Transient cross-view bridge: lets the Invoices page request that a specific
 * credit-note draft be opened in the editor after switching to the Credit Notes
 * view. Never persisted — it is consumed once on arrival.
 */
interface CreditNoteEditorState {
  requestedEditorId: string | null;
  requestOpen: (creditNoteId: string) => void;
  consume: () => string | null;
}

export const useCreditNoteEditor = create<CreditNoteEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestOpen: (creditNoteId) => set({ requestedEditorId: creditNoteId }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
}));
