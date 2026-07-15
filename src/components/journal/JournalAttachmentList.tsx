import { Paperclip, Plus } from 'lucide-react';

/**
 * Attachments list. The data model has no attachment storage yet, so this
 * renders a ready empty state rather than fabricating files. When an
 * attachments store is added, map records to rows here (icon/name/size/download).
 */
export function JournalAttachmentList() {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center dark:border-slate-700">
      <Paperclip className="mx-auto h-5 w-5 text-slate-300 dark:text-slate-600" />
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">No attachments on this entry.</p>
      <button
        type="button"
        disabled
        className="mt-2 inline-flex cursor-not-allowed items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-400 dark:bg-slate-800"
      >
        <Plus className="h-3 w-3" /> Attach files
        <span className="rounded bg-slate-200 px-1 text-[9px] font-semibold uppercase text-slate-400 dark:bg-slate-700">Soon</span>
      </button>
    </div>
  );
}
