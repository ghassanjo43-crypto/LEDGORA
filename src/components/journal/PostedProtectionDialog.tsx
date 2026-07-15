import { useEffect } from 'react';
import { Lock, RotateCcw, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Shown when a user tries to edit a POSTED entry. Posted entries are immutable;
 * the accountant must instead reverse the entry or duplicate it as a new draft.
 */
export function PostedProtectionDialog({
  open,
  entryNumber,
  onReverse,
  onDuplicate,
  onCancel,
}: {
  open: boolean;
  entryNumber: string;
  onReverse: () => void;
  onDuplicate: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="alertdialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-dropdown dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
            <Lock className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Posted entries can’t be edited
            </h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Posted journal entry <strong>{entryNumber}</strong> is locked to preserve the audit
              trail. Create a reversing entry or duplicate it as a new draft instead.
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={onReverse} className="justify-start">
            <RotateCcw className="h-4 w-4" /> Create reversal
          </Button>
          <Button variant="secondary" onClick={onDuplicate} className="justify-start">
            <Copy className="h-4 w-4" /> Duplicate as draft
          </Button>
          <Button variant="ghost" onClick={onCancel} className="justify-start">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
