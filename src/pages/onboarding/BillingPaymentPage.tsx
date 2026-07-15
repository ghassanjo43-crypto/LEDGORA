/**
 * Bank-remittance payment step. Shows the invoice, the frozen bank instructions
 * and the unique payment reference the customer must quote, then accepts a
 * payment-proof upload. Uploading moves the subscription to pending_verification.
 */
import { useMemo, useState } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard, Stepper, money } from '@/components/onboarding/OnboardingChrome';
import { ROUTES } from '@/lib/accessControl';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

const MAX_PROOF_BYTES = 5_000_000;

export function BillingPaymentPage() {
  const subscription = useOrganizationStore((s) => s.subscription);
  const invoices = useOrganizationStore((s) => s.invoices);
  const uploadProof = useOrganizationStore((s) => s.uploadPaymentProof);
  const navigate = useRouterStore((s) => s.navigate);

  const invoice = useMemo(
    () => (subscription?.invoiceId ? invoices.find((i) => i.id === subscription.invoiceId) ?? null : null),
    [invoices, subscription?.invoiceId],
  );

  const [file, setFile] = useState<{ name: string; type: string; size: number; dataUrl: string } | null>(null);
  const [reference, setReference] = useState(invoice?.paymentReference ?? '');
  const [amount, setAmount] = useState(invoice ? String(invoice.total) : '');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  if (!subscription || !invoice) {
    return (
      <CenteredCard title="Payment">
        <Alert variant="warning">No pending invoice was found. Choose a subscription to continue.</Alert>
        <Button className="mt-4 w-full" onClick={() => navigate(ROUTES.onboardingSubscription)}>
          Choose a subscription
        </Button>
      </CenteredCard>
    );
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_PROOF_BYTES) {
      setErrors((x) => ({ ...x, file: 'File must be 5 MB or smaller.' }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, type: f.type, size: f.size, dataUrl: String(reader.result) });
      setErrors((x) => ({ ...x, file: '' }));
    };
    reader.readAsDataURL(f);
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setFormError(null);
    const res = uploadProof({
      fileName: file?.name ?? '',
      fileType: file?.type ?? '',
      fileSize: file?.size ?? 0,
      dataUrl: file?.dataUrl ?? '',
      reference,
      amount: Number(amount),
      paidAt,
      note,
    });
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      setFormError(res.error ?? 'Upload failed.');
      return;
    }
    navigate(ROUTES.subscriptionStatus);
  };

  const bank = invoice.bank;

  return (
    <CenteredCard title="Complete your payment" subtitle="Transfer the amount below, then upload your proof of payment." width="xl">
      <Stepper current="Payment" />

      {subscription.status === 'rejected' && invoice.rejectionReason && (
        <Alert variant="error" className="mb-4" title="Your previous proof was rejected">
          {invoice.rejectionReason} — please transfer again and re-upload your proof.
        </Alert>
      )}
      {invoice.infoRequest && (
        <Alert variant="warning" className="mb-4" title="More information requested">
          {invoice.infoRequest}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Bank instructions */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Invoice {invoice.number}</span>
              <span className="text-lg font-bold text-slate-900 dark:text-slate-50">{money(invoice.total, invoice.currency)}</span>
            </div>
            <ul className="mt-3 space-y-1 text-xs text-slate-600 dark:text-slate-300">
              {invoice.lines.map((l) => (
                <li key={l.key} className="flex justify-between">
                  <span>{l.label}</span>
                  <span>{money(l.amount, invoice.currency)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-500/30 dark:bg-brand-500/10">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Payment reference (quote this on your transfer)</p>
            <p className="mt-1 font-mono text-xl font-bold tracking-wide text-brand-700 dark:text-brand-300">{invoice.paymentReference}</p>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800">
            <p className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Bank details</p>
            <dl className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
              <Row label="Bank" value={bank.bankName} />
              <Row label="Account name" value={bank.accountName} />
              <Row label="Account no." value={bank.accountNumber} />
              <Row label="IBAN" value={bank.iban} />
              <Row label="SWIFT" value={bank.swift} />
              <Row label="Branch" value={bank.branch} />
            </dl>
            {bank.instructions && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{bank.instructions}</p>}
          </div>
        </div>

        {/* Proof upload */}
        <form className="space-y-4" onSubmit={submit} noValidate>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Upload proof of payment</h3>
          {formError && <Alert variant="error">{formError}</Alert>}
          <Field label="Proof file (PDF or image, ≤ 5 MB)" required error={errors.file}>
            <input type="file" accept="image/*,application/pdf" onChange={onFile} className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs dark:text-slate-300 dark:file:bg-slate-800" />
            {file && <p className="mt-1 text-xs text-emerald-600">Attached: {file.name}</p>}
          </Field>
          <Field label="Bank transfer reference" required error={errors.reference}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} hasError={!!errors.reference} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount paid" required error={errors.amount}>
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} hasError={!!errors.amount} />
            </Field>
            <Field label="Payment date" required error={errors.paidAt}>
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} hasError={!!errors.paidAt} />
            </Field>
          </div>
          <Field label="Note (optional)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the reviewer should know" />
          </Field>
          <Button type="submit" className="w-full">Submit proof for verification</Button>
        </form>
      </div>
    </CenteredCard>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-700 dark:text-slate-200">{value || '—'}</dd>
    </div>
  );
}
