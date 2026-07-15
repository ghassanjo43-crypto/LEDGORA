/** Column definitions for the General Journal dense table. */
export type JournalColumnId =
  | 'date'
  | 'journalNo'
  | 'reference'
  | 'entity'
  | 'accountCode'
  | 'accountName'
  | 'description'
  | 'debit'
  | 'credit';

export interface JournalColumnDef {
  id: JournalColumnId;
  label: string;
  /** Always visible & cannot be toggled off. */
  required?: boolean;
  /** Hidden by default on smaller screens (lower priority). */
  optional?: boolean;
  align?: 'left' | 'right' | 'center';
}

export const JOURNAL_COLUMNS: JournalColumnDef[] = [
  { id: 'date', label: 'Date', required: true },
  { id: 'journalNo', label: 'Journal No.', required: true },
  { id: 'reference', label: 'Reference' },
  { id: 'entity', label: 'Entity' },
  { id: 'accountCode', label: 'Account Code', align: 'left' },
  { id: 'accountName', label: 'Account Name', required: true },
  { id: 'description', label: 'Description' },
  { id: 'debit', label: 'Debit', required: true, align: 'right' },
  { id: 'credit', label: 'Credit', required: true, align: 'right' },
];

export function defaultColumnVisibility(): Record<JournalColumnId, boolean> {
  const out = {} as Record<JournalColumnId, boolean>;
  for (const c of JOURNAL_COLUMNS) out[c.id] = true;
  return out;
}
