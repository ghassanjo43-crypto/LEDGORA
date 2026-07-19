import { useRef, useState } from 'react';
import {
  Landmark,
  UploadCloud,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  Ban,
} from 'lucide-react';
import type { SubscriptionInvoice } from '@/types/billing';
import { useBillingStore } from '@/store/billingStore';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { MAX_PROOF_BYTES, ALLOWED_PROOF_TYPES, type ProofInput } from '@/lib/billingCalculations';
import { DevelopmentBankWarning } from './DevelopmentBankWarning';
import { paymentReferenceMatches } from '@/services/paymentReferenceService';
import { cn } from '@/lib/utils';

const STEPS = ['Invoice', 'Bank instructions', 'Proof upload', 'Pending verification', 'Approved'] as const;

function stepIndex(status: SubscriptionInvoice['status']): number {
  switch (status) {
    case 'issued':
      return 1;
    case 'rejected':
      return 2;
    case 'proof-submitted':
      return 3;
    case 'approved':
      return 4;
    default:
      return 0;
  }
}

export function SubscriptionInvoicePanel({ invoice }: { invoice: SubscriptionInvoice }) {
  const uploadProof = useBillingStore((s) => s.uploadPaymentProof);
  const cancelInvoice = useBillingStore((s) => s.cancelInvoice);
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<{ name: string; type: string; size: number; dataUrl: string } | null>(null);
  // Pre-filled with the reference LEDGORA issued for this invoice.
  const [reference, setReference] = useState(invoice.paymentReference ?? '');
  const [bankTransactionReference, setBankTransactionReference] = useState('');
  const [amount, setAmount] = useState<string>(String(invoice.amount));
  const [paidAt, setPaidAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const activeStep = stepIndex(invoice.status);
  const bank = invoice.bankSnapshot;
  // Warn (never block) when the entered reference is not the invoice's.
  const referenceMismatch =
    reference.trim().length > 0 && !paymentReferenceMatches(reference, invoice.paymentReference);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    if (f.size > MAX_PROOF_BYTES) {
      setFieldErrors((p) => ({ ...p, file: 'File is larger than 4 MB.' }));
      return;
    }
    if (!ALLOWED_PROOF_TYPES.includes(f.type)) {
      setFieldErrors((p) => ({ ...p, file: 'Only PNG, JPEG, WEBP or PDF receipts are accepted.' }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, type: f.type, size: f.size, dataUrl: String(reader.result) });
      setFieldErrors((p) => ({ ...p, file: '' }));
    };
    reader.onerror = () => setError('Could not read the file. Try another one.');
    reader.readAsDataURL(f);
  };

  const submit = (): void => {
    setError(null);
    setBusy(true);
    const input: ProofInput = {
      fileName: file?.name ?? '',
      fileType: file?.type ?? '',
      fileSize: file?.size ?? 0,
      dataUrl: file?.dataUrl ?? '',
      reference,
      bankTransactionReference,
      amount: Number(amount),
      paidAt,
      note,
    };
    const res = uploadProof(invoice.id, input);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not submit the payment proof.');
      setFieldErrors(res.fieldErrors ?? {});
      return;
    }
    setFieldErrors({});
  };

  const showUploadForm = invoice.status === 'issued' || invoice.status === 'rejected';

  return (
    <div className="space-y-4">
      {/* Stepper */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold',
                i < activeStep
                  ? 'bg-emerald-500 text-white'
                  : i === activeStep
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300',
              )}
            >
              {i < activeStep ? '✓' : i + 1}
            </span>
            <span className={cn(i === activeStep ? 'font-medium text-slate-700 dark:text-slate-200' : 'text-slate-400')}>{label}</span>
            {i < STEPS.length - 1 && <span className="text-slate-300">→</span>}
          </li>
        ))}
      </ol>

      {/* Invoice summary */}
      <Card>
        <CardHeader
          title={`Invoice ${invoice.number}`}
          description={`${invoice.planName} · ${invoice.changeType}`}
          actions={<InvoiceStatusBadge status={invoice.status} />}
        />
        <CardBody className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Amount" value={formatCurrency(invoice.amount, invoice.currency)} strong />
            <Field label="Period" value={`${formatDate(invoice.periodStart)} → ${formatDate(invoice.periodEnd)}`} />
            <Field label="Issued" value={formatDate(invoice.issuedAt)} />
            <Field label="Due by" value={formatDate(invoice.dueAt)} />
          </dl>
        </CardBody>
      </Card>

      {/* Bank instructions */}
      <Card>
        <CardHeader
          title="Bank instructions"
          description="Transfer the invoice total and quote the LEDGORA payment reference exactly as shown."
        />
        <CardBody>
          <DevelopmentBankWarning bank={bank} className="mb-3" />
          <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
            <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <Field label="Bank" value={bank.bankName} />
              <Field label="Account name" value={bank.accountName} />
              <Field label="Account number" value={bank.accountNumber} mono />
              <Field label="IBAN" value={bank.iban} mono />
              <Field label="SWIFT / BIC" value={bank.swift} mono />
              <Field label="Branch" value={bank.branch} />
              <Field label="Invoice number" value={invoice.number} mono />
              <Field label="LEDGORA payment reference (quote this)" value={invoice.paymentReference} mono />
            </dl>
          </div>
          {bank.instructions && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{bank.instructions}</p>}
        </CardBody>
      </Card>

      {/* Status-specific body */}
      {invoice.status === 'approved' ? (
        <StatusNote icon={CheckCircle2} tone="green" title="Payment approved — subscription active">
          Your {invoice.planName} subscription is active until {formatDate(invoice.periodEnd)}.
        </StatusNote>
      ) : invoice.status === 'proof-submitted' ? (
        <StatusNote icon={Clock} tone="amber" title="Pending verification">
          Your payment proof has been submitted and is awaiting administrator approval. You will gain access as soon as it is approved.
        </StatusNote>
      ) : invoice.status === 'cancelled' ? (
        <StatusNote icon={Ban} tone="slate" title="Invoice cancelled">
          This invoice was cancelled or superseded by a newer request.
        </StatusNote>
      ) : (
        <Card>
          <CardHeader title="Upload payment proof" description="Attach the bank transfer receipt for administrator verification." />
          <CardBody className="space-y-3">
            {invoice.status === 'rejected' && invoice.rejectionReason && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Previous proof was rejected: {invoice.rejectionReason}. Please upload a corrected receipt.</span>
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>
            )}
            {showUploadForm && (
              <>
                <div>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="focus-ring flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3 py-4 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-800/40"
                  >
                    <UploadCloud className="h-5 w-5" />
                    {file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)` : 'Choose receipt (PNG, JPEG, WEBP or PDF, max 4 MB)'}
                  </button>
                  <input ref={fileRef} type="file" accept={ALLOWED_PROOF_TYPES.join(',')} className="hidden" onChange={onFile} />
                  {fieldErrors.file && <p className="mt-1 text-xs text-red-600">{fieldErrors.file}</p>}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <LabeledInput label="LEDGORA payment reference" value={reference} onChange={setReference} error={fieldErrors.reference} placeholder={invoice.paymentReference} />
                  <LabeledInput label="Bank transaction reference (optional)" value={bankTransactionReference} onChange={setBankTransactionReference} placeholder="e.g. TT-2026-00184" />
                </div>
                {referenceMismatch && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    This is not the reference on your invoice ({invoice.paymentReference}). Leave it as entered if that is what
                    your transfer quoted — the reviewer will match it manually, which may take longer.
                  </p>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <LabeledInput label="Amount paid" value={amount} onChange={setAmount} error={fieldErrors.amount} type="number" />
                  <LabeledInput label="Payment date" value={paidAt} onChange={setPaidAt} error={fieldErrors.paidAt} type="date" />
                </div>
                <Textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                    Submit for verification
                  </Button>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      )}

      {invoice.status !== 'approved' && invoice.status !== 'cancelled' && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => cancelInvoice(invoice.id)}>
            <Ban className="h-4 w-4" /> Cancel this request
          </Button>
        </div>
      )}
    </div>
  );
}

export function InvoiceStatusBadge({ status }: { status: SubscriptionInvoice['status'] }) {
  const meta: Record<SubscriptionInvoice['status'], { label: string; tone: 'slate' | 'amber' | 'green' | 'red' }> = {
    issued: { label: 'Awaiting payment', tone: 'amber' },
    'proof-submitted': { label: 'Pending verification', tone: 'amber' },
    approved: { label: 'Approved', tone: 'green' },
    rejected: { label: 'Rejected', tone: 'red' },
    cancelled: { label: 'Cancelled', tone: 'slate' },
  };
  const m = meta[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

function Field({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={cn('text-sm text-slate-700 dark:text-slate-200', strong && 'font-semibold text-slate-900 dark:text-slate-50', mono && 'font-mono text-xs')}>{value || '—'}</dd>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  error,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <Input type={type} value={value} placeholder={placeholder} hasError={!!error} onChange={(e) => onChange(e.target.value)} />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function StatusNote({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: typeof CheckCircle2;
  tone: 'green' | 'amber' | 'slate';
  title: string;
  children: React.ReactNode;
}) {
  const tones = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    slate: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300',
  };
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border p-4', tones[tone])}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-sm opacity-90">{children}</p>
      </div>
    </div>
  );
}
