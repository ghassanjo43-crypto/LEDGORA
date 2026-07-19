import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, FileText, ShieldCheck, ExternalLink } from 'lucide-react';
import type { SubscriptionInvoice } from '@/types/billing';
import { useBillingStore } from '@/store/billingStore';
import { useInvoices, useIsAdmin } from '@/store/billingHooks';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

/**
 * Administrator verification queue — step 5/6 of the payment process. Lists
 * invoices with a submitted proof and lets an administrator approve (which
 * activates the subscription) or reject with a reason. Admin-permission gated.
 */
export function PaymentVerificationPanel() {
  const invoices = useInvoices();
  const isAdmin = useIsAdmin();
  const approve = useBillingStore((s) => s.approvePayment);
  const reject = useBillingStore((s) => s.rejectPayment);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const pending = useMemo(
    () => invoices.filter((i) => i.status === 'proof-submitted'),
    [invoices],
  );

  if (!isAdmin) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Administrator access required"
        description="Only administrators can verify bank-remittance payments."
      />
    );
  }

  if (pending.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Nothing to verify"
        description="There are no payment proofs awaiting verification."
      />
    );
  }

  const onApprove = (inv: SubscriptionInvoice): void => {
    setError(null);
    const res = approve(inv.id);
    if (!res.ok) setError(res.error ?? 'Could not approve the payment.');
  };

  const onReject = (inv: SubscriptionInvoice): void => {
    setError(null);
    const res = reject(inv.id, reason);
    if (!res.ok) {
      setError(res.error ?? 'Could not reject the payment.');
      return;
    }
    setRejecting(null);
    setReason('');
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>
      )}
      {pending.map((inv) => {
        const proof = inv.proofs.find((p) => p.id === inv.currentProofId);
        return (
          <Card key={inv.id}>
            <CardHeader title={`${inv.number} · ${inv.planName}`} description={`${inv.changeType} · ${formatCurrency(inv.amount, inv.currency)} · period ${formatDate(inv.periodStart)} → ${formatDate(inv.periodEnd)}`} />
            <CardBody className="space-y-3">
              {proof ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                      <Meta
                        label={proof.matchesInvoiceReference === false ? 'Quoted reference (mismatch)' : 'LEDGORA reference'}
                        value={
                          proof.matchesInvoiceReference === false
                            ? `${proof.reference} — invoice expects ${inv.paymentReference}`
                            : proof.reference
                        }
                        mono
                      />
                      {proof.bankTransactionReference && (
                        <Meta label="Bank transaction ref" value={proof.bankTransactionReference} mono />
                      )}
                      <Meta label="Amount paid" value={formatCurrency(proof.amount, inv.currency)} />
                      <Meta label="Paid on" value={formatDate(proof.paidAt)} />
                      <Meta label="Uploaded" value={`${formatDate(proof.uploadedAt)} by ${proof.uploadedBy}`} />
                      {proof.note && <Meta label="Note" value={proof.note} span />}
                    </dl>
                  </div>
                  <ProofPreview dataUrl={proof.dataUrl} fileType={proof.fileType} fileName={proof.fileName} />
                </div>
              ) : (
                <p className="text-sm text-slate-400">Proof not found.</p>
              )}

              {rejecting === inv.id ? (
                <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <label className="block text-xs font-medium text-slate-500">Rejection reason</label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain what needs correcting" />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setRejecting(null); setReason(''); }}>Cancel</Button>
                    <Button variant="danger" size="sm" onClick={() => onReject(inv)}><XCircle className="h-4 w-4" /> Confirm rejection</Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setRejecting(inv.id)}><XCircle className="h-4 w-4" /> Reject</Button>
                  <Button variant="primary" size="sm" onClick={() => onApprove(inv)}><CheckCircle2 className="h-4 w-4" /> Approve & activate</Button>
                </div>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function Meta({ label, value, mono, span }: { label: string; value: string; mono?: boolean; span?: boolean }) {
  return (
    <div className={span ? 'col-span-2' : undefined}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-slate-700 dark:text-slate-200' : 'text-slate-700 dark:text-slate-200'}>{value}</dd>
    </div>
  );
}

function ProofPreview({ dataUrl, fileType, fileName }: { dataUrl: string; fileType: string; fileName: string }) {
  if (fileType.startsWith('image/')) {
    return (
      <a href={dataUrl} target="_blank" rel="noopener noreferrer" className="focus-ring block overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
        <img src={dataUrl} alt={fileName} className="h-28 w-full object-cover" />
      </a>
    );
  }
  return (
    <a
      href={dataUrl}
      target="_blank"
      rel="noopener noreferrer"
      download={fileName}
      className="focus-ring flex h-28 flex-col items-center justify-center gap-1 rounded-lg border border-slate-200 text-sm text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/50"
    >
      <FileText className="h-6 w-6" />
      <span className="flex items-center gap-1">Open receipt <ExternalLink className="h-3 w-3" /></span>
    </a>
  );
}
