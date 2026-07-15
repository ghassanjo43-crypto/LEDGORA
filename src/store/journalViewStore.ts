import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { defaultColumnVisibility, JOURNAL_COLUMNS, type JournalColumnId } from '@/lib/journalColumns';

interface JournalViewState {
  columns: Record<JournalColumnId, boolean>;
  rowsPerPage: number;
  /** Transient: an entry the General Ledger asked the Journal to focus/open. */
  focusEntryId: string | null;

  toggleColumn: (id: JournalColumnId) => void;
  resetColumns: () => void;
  setRowsPerPage: (n: number) => void;
  requestFocusEntry: (id: string | null) => void;
}

/** Persisted table view preferences (column visibility + page size). */
export const useJournalView = create<JournalViewState>()(
  persist(
    (set) => ({
      columns: defaultColumnVisibility(),
      rowsPerPage: 20,
      focusEntryId: null,

      toggleColumn: (id) =>
        set((s) => ({ columns: { ...s.columns, [id]: !s.columns[id] } })),
      resetColumns: () => set({ columns: defaultColumnVisibility() }),
      setRowsPerPage: (rowsPerPage) => set({ rowsPerPage }),
      requestFocusEntry: (focusEntryId) => set({ focusEntryId }),
    }),
    {
      name: 'ledgerly-journal-view',
      version: 1,
      partialize: (s) => ({ columns: s.columns, rowsPerPage: s.rowsPerPage }),
      merge: (persisted, current) => {
        const p = persisted as Partial<JournalViewState> | undefined;
        // Reconcile with the known column set so new columns appear.
        const columns = { ...defaultColumnVisibility() };
        if (p?.columns) {
          for (const c of JOURNAL_COLUMNS) {
            if (typeof p.columns[c.id] === 'boolean') columns[c.id] = p.columns[c.id];
          }
        }
        return { ...current, ...p, columns };
      },
    },
  ),
);
