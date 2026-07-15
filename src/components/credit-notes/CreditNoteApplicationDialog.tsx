import { useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';
import type { CreditNote } from '@/types/creditNote';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { formatCurrency } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

/** Allocate remaining credit to one of the customer's open invoices (subledger — no new journal). */
export function CreditNoteApplicationDialog({ creditNote, onClose }: { creditNote: CreditNote; onClose: () => void }) {
  const invoices = useInvoiceStore((s) => s.invoices);
  const applyCreditNote = useCreditNoteStore((s) => s.applyCreditNote);
  const { notify } = useToast();

  const openInvoices = useMemo(
    () => invoices.filter((i) => i.customerId === creditNote.customerId && i.entityId === creditNote.entityId && i.status !== 'void' && i.status !== 'draft' && i.balanceDue > 0.005),
    [invoices, creditNote.customerId, creditNote.entityId],
  );
  // Default to the original invoice when it is still open.
  const [invoiceId, setInvoiceId] = useState(openInvoices.find((i) => i.id === creditNote.originalInvoiceId)?.id ?? openInvoices[0]?.id ?? '');
  const target = openInvoices.find((i) => i.id === invoiceId);
  const suggested = target ? Math.min(creditNote.remainingCredit, target.balanceDue) : creditNote.remainingCredit;
  const [amount, setAmount] = useState(Math.round(suggested * 100) / 100);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const money = (n: number): string => formatCurrency(n, creditNote.currency);

  const submit = (): void => {
    const res = applyCreditNote(creditNote.id, invoiceId, Number(amount), date);
    if (res.ok) { notify('Credit applied to the invoice.', 'success'); onClose(); }
    else notify(res.error ?? 'Could not apply the credit.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Apply credit — {creditNote.creditNoteNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Remaining credit {money(creditNote.remainingCredit)}</p>
        {openInvoices.length === 0 ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            This customer has no open invoices to apply the credit to. Leave it as customer credit or refund it.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <label className="block text-xs text-slate-500">Apply to invoice
              <Select className="mt-1" options={openInvoices.map((i) => ({ value: i.id, label: `${i.invoiceNumber} · balance ${money(i.balanceDue)}` }))} value={invoiceId} onChange={(e) => { setInvoiceId(e.target.value); const inv = openInvoices.find((x) => x.id === e.target.value); if (inv) setAmount(Math.round(Math.min(creditNote.remainingCredit, inv.balanceDue) * 100) / 100); }} />
            </label>
            <label className="block text-xs text-slate-500">Amount<Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="mt-1" /></label>
            <label className="block text-xs text-slate-500">Application date<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" /></label>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!invoiceId || Number(amount) <= 0} onClick={submit}><Link2 className="h-4 w-4" /> Apply credit</Button>
        </div>
      </div>
    </div>
  );
}
