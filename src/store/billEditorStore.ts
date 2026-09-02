import { create } from 'zustand';

/** Transient cross-view bridge to open a specific bill draft after navigating to the Bills view. */
interface BillEditorState {
  requestedEditorId: string | null;
  /**
   * A NEW, unsaved bill.
   *
   * On server books there is no draft to point at until the first save — the
   * server needs a supplier, dates and a line with a real account before a bill
   * can exist — so a quick-create asks for a blank editor rather than for a
   * record that is not there yet.
   */
  requestedNew: boolean;
  requestOpen: (billId: string) => void;
  requestNew: () => void;
  consume: () => string | null;
  consumeNew: () => boolean;
}

export const useBillEditor = create<BillEditorState>()((set, get) => ({
  requestedEditorId: null,
  requestedNew: false,
  requestOpen: (billId) => set({ requestedEditorId: billId, requestedNew: false }),
  requestNew: () => set({ requestedNew: true, requestedEditorId: null }),
  consume: () => {
    const id = get().requestedEditorId;
    if (id) set({ requestedEditorId: null });
    return id;
  },
  consumeNew: () => {
    const wanted = get().requestedNew;
    if (wanted) set({ requestedNew: false });
    return wanted;
  },
}));
