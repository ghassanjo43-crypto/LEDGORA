import { useState } from 'react';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

/** Confirm reversing a posted receipt (posts an exact reversal + reverses allocations). */
export function ReceiptReverseDialog({ onConfirm, onCancel }: { onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">Reverse this receipt?</h2>
        <p className="mt-1 text-xs text-slate-500">Reversing posts an exact reversing journal entry, removes the invoice allocations (restoring balances and statuses), and preserves the original receipt and its number.</p>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for reversal (required)" className="mt-3" autoFocus />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}><Ban className="h-4 w-4" /> Reverse receipt</Button>
        </div>
      </div>
    </div>
  );
}
