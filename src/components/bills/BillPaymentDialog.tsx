import { useState } from 'react';
import { Banknote } from 'lucide-react';
import type { Bill, BillPaymentMethod } from '@/types/bill';
import { useStore } from '@/store/useStore';
import { useBillStore } from '@/store/billStore';
import { formatCurrency } from '@/lib/money';
import { BILL_PAYMENT_METHOD_LABELS } from '@/lib/billLabels';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { useToast } from '@/components/ui/Toast';

/** Record a payment against a posted bill (Dr trade payables / Cr bank). */
export function BillPaymentDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const recordPayment = useBillStore((s) => s.recordPayment);
  const { notify } = useToast();
  const cashAccounts = accounts.filter((a) => a.isPostingAccount && a.type === 'ASSET' && /cash and cash equivalents/i.test(a.ifrsSubcategory));

  const [amount, setAmount] = useState(Math.round(bill.balanceDue * 100) / 100);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [bankAccountId, setBankAccountId] = useState(cashAccounts[0]?.id ?? '');
  const [method, setMethod] = useState<BillPaymentMethod>('bank-transfer');
  const [reference, setReference] = useState('');
  const [bankFeeAmount, setBankFeeAmount] = useState(0);
  const [bankFeeAccountId, setBankFeeAccountId] = useState('');

  const money = (n: number): string => formatCurrency(n, bill.currency);

  const submit = (): void => {
    const res = recordPayment(bill.id, { amount: Number(amount), date, bankAccountId, method, reference, bankFeeAmount: bankFeeAmount || undefined, bankFeeAccountId: bankFeeAmount ? bankFeeAccountId : undefined });
    if (res.ok) { notify('Payment recorded & posted.', 'success'); onClose(); } else notify(res.error ?? 'Could not record the payment.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Pay bill — {bill.billNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Balance due {money(bill.balanceDue)}</p>
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-slate-500">Amount<Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="mt-1" /></label>
          <label className="block text-xs text-slate-500">Date<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" /></label>
          <label className="block text-xs text-slate-500">Pay from<div className="mt-1"><AccountSelect value={bankAccountId} accounts={cashAccounts} onChange={(a) => setBankAccountId(a.id)} /></div></label>
          <label className="block text-xs text-slate-500">Method<Select className="mt-1" options={(Object.keys(BILL_PAYMENT_METHOD_LABELS) as BillPaymentMethod[]).map((m) => ({ value: m, label: BILL_PAYMENT_METHOD_LABELS[m] }))} value={method} onChange={(e) => setMethod(e.target.value as BillPaymentMethod)} /></label>
          <label className="block text-xs text-slate-500">Reference<Input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1" placeholder="Payment reference" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-500">Bank fee<Input type="number" step="0.01" value={bankFeeAmount} onChange={(e) => setBankFeeAmount(Number(e.target.value))} className="mt-1" /></label>
            <label className="block text-xs text-slate-500">Fee account<div className="mt-1"><AccountSelect value={bankFeeAccountId} accounts={accounts} onChange={(a) => setBankFeeAccountId(a.id)} disabled={bankFeeAmount <= 0} /></div></label>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!bankAccountId || Number(amount) <= 0} onClick={submit}><Banknote className="h-4 w-4" /> Record payment</Button></div>
      </div>
    </div>
  );
}
