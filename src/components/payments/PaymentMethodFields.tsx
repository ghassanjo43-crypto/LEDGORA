import type { PaymentMethod } from '@/types/payment';
import { Field, Input } from '@/components/ui/Input';

interface Props {
  method: PaymentMethod;
  readOnly?: boolean;
  chequeNumber: string; setChequeNumber: (v: string) => void;
  chequeDate: string; setChequeDate: (v: string) => void;
  chequeBankName: string; setChequeBankName: (v: string) => void;
  cardReference: string; setCardReference: (v: string) => void;
  directDebitReference: string; setDirectDebitReference: (v: string) => void;
}

/** Method-conditional fields (cheque / card / direct debit) for the payment editor. */
export function PaymentMethodFields(p: Props) {
  if (p.method === 'cheque') {
    return (
      <section className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-3">
        <Field label="Cheque number" required><Input value={p.chequeNumber} onChange={(e) => p.setChequeNumber(e.target.value)} disabled={p.readOnly} /></Field>
        <Field label="Cheque date" required><Input type="date" value={p.chequeDate} onChange={(e) => p.setChequeDate(e.target.value)} disabled={p.readOnly} /></Field>
        <Field label="Cheque bank"><Input value={p.chequeBankName} onChange={(e) => p.setChequeBankName(e.target.value)} disabled={p.readOnly} /></Field>
      </section>
    );
  }
  if (p.method === 'card') {
    return (
      <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <Field label="Card reference"><Input value={p.cardReference} onChange={(e) => p.setCardReference(e.target.value)} disabled={p.readOnly} placeholder="Card / authorisation reference" /></Field>
      </section>
    );
  }
  if (p.method === 'direct-debit') {
    return (
      <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <Field label="Mandate / reference" required><Input value={p.directDebitReference} onChange={(e) => p.setDirectDebitReference(e.target.value)} disabled={p.readOnly} placeholder="Direct-debit mandate reference" /></Field>
      </section>
    );
  }
  return null;
}
