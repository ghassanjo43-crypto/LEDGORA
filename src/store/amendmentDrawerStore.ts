/**
 * Which document, if any, has its amendment drawer open.
 *
 * ══ Why the drawer cannot own this state ═════════════════════════════════════
 *
 * The `Amend posted document` action lives inside an Actions dropdown. That
 * dropdown closes on ANY click inside its panel (`Dropdown`'s `closeOnClick`
 * defaults to true) and is rendered as `{open && createPortal(panel)}` — so
 * closing UNMOUNTS the whole panel and everything in it.
 *
 * While the drawer was a child of the menu item, that made the workflow
 * unreachable from every list page: clicking the action set the item's local
 * `open` state, the same click closed the menu, the menu unmounted the item,
 * and the state went with it. Nothing appeared. An enabled action that does
 * nothing when clicked is indistinguishable from a disabled one, which is
 * exactly how it was reported.
 *
 * So the request outlives the menu. The page mounts one `AmendmentDrawerHost`
 * outside its table, this store carries the target across the unmount, and the
 * drawer opens from there. It is the pattern the codebase already uses to hand
 * a document from one surface to another — `invoiceEditorStore`,
 * `creditNoteEditorStore` and `receiptEditorStore` all do the same thing for
 * the same reason.
 *
 * ══ Not persisted ════════════════════════════════════════════════════════════
 *
 * Deliberately in-memory. "A drawer was open" is not a fact worth surviving a
 * reload, and persisting it would reopen an amendment the user had abandoned —
 * against a document that may have moved on in the meantime.
 */
import { create } from 'zustand';
import type { AmendableDocumentType } from '@/types/documentAmendment';

export interface AmendmentTarget {
  documentType: AmendableDocumentType;
  documentId: string;
}

interface AmendmentDrawerState {
  target: AmendmentTarget | null;
  /** Ask for the drawer. Survives the menu that asked for it unmounting. */
  requestOpen: (documentType: AmendableDocumentType, documentId: string) => void;
  close: () => void;
}

export const useAmendmentDrawerStore = create<AmendmentDrawerState>()((set) => ({
  target: null,
  requestOpen: (documentType, documentId) => set({ target: { documentType, documentId } }),
  close: () => set({ target: null }),
}));
