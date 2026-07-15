import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TemplateEditorTab =
  | 'layout'
  | 'branding'
  | 'content'
  | 'columns'
  | 'payment'
  | 'terms'
  | 'language'
  | 'preview';

interface TemplateEditorState {
  /** The draft version currently open in the full-page editor (persisted so a refresh reopens it). */
  editingVersionId: string | null;
  activeTab: TemplateEditorTab;
  /** Transient cross-view request (e.g. from the invoice editor "Edit template"). */
  requestOpenTemplateId: string | null;

  openEditor: (versionId: string) => void;
  closeEditor: () => void;
  setTab: (tab: TemplateEditorTab) => void;
  requestOpen: (templateId: string | null) => void;
}

export const useInvoiceTemplateEditor = create<TemplateEditorState>()(
  persist(
    (set) => ({
      editingVersionId: null,
      activeTab: 'layout',
      requestOpenTemplateId: null,

      openEditor: (editingVersionId) => set({ editingVersionId }),
      closeEditor: () => set({ editingVersionId: null }),
      setTab: (activeTab) => set({ activeTab }),
      requestOpen: (requestOpenTemplateId) => set({ requestOpenTemplateId }),
    }),
    {
      name: 'ledgerly-invoice-template-editor',
      version: 1,
      // requestOpenTemplateId is transient — never persisted.
      partialize: (s) => ({ editingVersionId: s.editingVersionId, activeTab: s.activeTab }),
    },
  ),
);
