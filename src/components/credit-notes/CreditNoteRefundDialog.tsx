import { useState } from 'react';
import { Banknote } from 'lucide-react';
import type { CreditNote } from '@/types/creditNote';
import { useStore } from '@/store/useStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { formatCurrency } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

/** Refund remaining customer credit as cash — a separate journal entry. */
export function CreditNoteRefundDialog({ creditNote, onClose }: { creditNote: CreditNote; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const refundCreditNote = useCreditNoteStore((s) => s.refundCreditNote);
  const { notify } = useToast();
  const banks = accounts.filter((a) => a.type === 'ASSET' && /cash and cash equivalents/i.test(a.ifrsSubcategory));

  const [amount, setAmount] = useState(Math.round(creditNote.remainingCredit * 100) / 100);
  const [refundDate, setRefundDate] = useState(new Date().toISOString().slice(0, 10));
  const [bankAccountId, setBankAccountId] = useState(banks[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');

  const money = (n: number): string => formatCurrency(n, creditNote.currency);

  const submit = (): void => {
    const res = refundCreditNote(creditNote.id, { amount: Number(amount), refundDate, bankAccountId, reference, memo });
    if (res.ok) { notify('Refund recorded & posted.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not record the refund.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Refund credit — {creditNote.creditNoteNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Remaining credit {money(creditNote.remainingCredit)}. A refund posts Dr receivables / Cr bank.</p>
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-slate-500">Amount<Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="mt-1" /></label>
          <label className="block text-xs text-slate-500">Refund date<Input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)} className="mt-1" /></label>
          <label className="block text-xs text-slate-500">Pay from<Select className="mt-1" options={banks.map((b) => ({ value: b.id, label: `${b.code} · ${b.name}` }))} value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} /></label>
          <label className="block text-xs text-slate-500">Reference<Input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1" placeholder="Payment reference" /></label>
          <label className="block text-xs text-slate-500">Memo<Input value={memo} onChange={(e) => setMemo(e.target.value)} className="mt-1" placeholder="Optional" /></label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!bankAccountId || Number(amount) <= 0} onClick={submit}><Banknote className="h-4 w-4" /> Record refund</Button>
        </div>
      </div>
    </div>
  );
}
