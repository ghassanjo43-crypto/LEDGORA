import { ChevronDown, Send, Download, Copy, Trash2, UserCheck, Tag } from 'lucide-react';
import { Dropdown, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Dropdown';
import { cn } from '@/lib/utils';

export function JournalBulkActions({
  count,
  canPost,
  canDelete,
  onPost,
  onExport,
  onDuplicate,
  onDelete,
}: {
  count: number;
  canPost: boolean;
  canDelete: boolean;
  onPost: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const none = count === 0;
  return (
    <Dropdown
      align="right"
      label="Bulk actions"
      panelClassName="w-56"
      trigger={(o) => (
        <span
          className={cn(
            'flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
            o && 'bg-slate-50 dark:bg-slate-800',
          )}
        >
          Bulk Actions {count > 0 && <span className="rounded-full bg-brand-100 px-1.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">{count}</span>}
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </span>
      )}
    >
      <MenuLabel>{none ? 'No entries selected' : `${count} selected`}</MenuLabel>
      <MenuItem icon={Send} disabled={none || !canPost} onClick={onPost}>Post selected</MenuItem>
      <MenuItem icon={Download} disabled={none} onClick={onExport}>Export selected</MenuItem>
      <MenuItem icon={Copy} disabled={none} onClick={onDuplicate}>Duplicate selected</MenuItem>
      <MenuItem icon={Trash2} danger disabled={none || !canDelete} onClick={onDelete}>Delete draft entries</MenuItem>
      <MenuSeparator />
      <MenuItem icon={UserCheck} disabled>
        <span className="flex items-center justify-between gap-2">Assign approval<span className="rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase text-slate-400 dark:bg-slate-800">Soon</span></span>
      </MenuItem>
      <MenuItem icon={Tag} disabled>
        <span className="flex items-center justify-between gap-2">Add tags<span className="rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase text-slate-400 dark:bg-slate-800">Soon</span></span>
      </MenuItem>
    </Dropdown>
  );
}
