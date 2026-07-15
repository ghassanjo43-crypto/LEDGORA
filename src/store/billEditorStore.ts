import { create } from 'zustand';

/** Transient cross-view bridge to open a specific bill draft after navigating to the Bills view. */
interface BillEditorState {
  requestedEditorId: string | null;
  requestOpen: (billId: string) => void;
  consume: () => string | null;
}

export const useBillEditor = create<BillEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestOpen: (billId) => set({ requestedEditorId: billId }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
}));
