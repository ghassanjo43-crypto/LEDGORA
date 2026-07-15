/**
 * Administrator (platform super-admin) payment-proof review. Lists invoices with
 * a submitted proof and lets the reviewer approve (→ activate subscription),
 * reject, or request more information. Access is gated by platform role in the
 * shell; the store also re-checks permission on every action.
 */
import { useMemo, useState } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { Brand, money } from '@/components/onboarding/OnboardingChrome';
import { ROUTES } from '@/lib/accessControl';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';

export function AdminPaymentReviewPage() {
  const invoices = useOrganizationStore((s) => s.invoices);
  const organization = useOrganizationStore((s) => s.organization);
  const approve = useOrganizationStore((s) => s.approvePayment);
  const reject = useOrganizationStore((s) => s.rejectPayment);
  const requestInfo = useOrganizationStore((s) => s.requestMoreInfo);
  const navigate = useRouterStore((s) => s.navigate);

  const [note, setNote] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const pending = useMemo(() => invoices.filter((i) => i.status === 'proof-submitted'), [invoices]);
  const recent = useMemo(
    () => invoices.filter((i) => i.status === 'paid' || i.status === 'rejected').slice(-5).reverse(),
    [invoices],
  );

  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => {
    const res = fn();
    setMessage(res.ok ? ok : res.error ?? 'Action failed.');
  };

  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Brand />
            <Badge tone="indigo">Admin · Payments</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.appDashboard)}>Back to app</Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Payment proof review</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Verify bank remittances and activate subscriptions.</p>
        {message && <Alert variant="info" className="mt-4" onClose={() => setMessage(null)}>{message}</Alert>}

        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Awaiting verification ({pending.length})</h2>
          {pending.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 dark:border-slate-700">
              No proofs awaiting verification.
            </p>
          ) : (
            <div className="space-y-4">
              {pending.map((inv) => {
                const proof = inv.proofs.find((p) => p.id === inv.currentProofId) ?? inv.proofs[inv.proofs.length - 1];
                return (
                  <div key={inv.id} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{inv.number} · {money(inv.total, inv.currency)}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{organization?.legalName ?? inv.organizationId} · ref {inv.paymentReference}</p>
                      </div>
                      <Badge tone="amber">proof submitted</Badge>
                    </div>

                    {proof && (
                      <div className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/50 sm:grid-cols-2">
                        <span>Paid: <b>{money(proof.amount, inv.currency)}</b> on {proof.paidAt}</span>
                        <span>Bank ref: <b>{proof.reference}</b></span>
                        <span className="sm:col-span-2">
                          Proof: {proof.dataUrl ? (
                            <a href={proof.dataUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">
                              {proof.fileName}
                            </a>
                          ) : proof.fileName}
                        </span>
                        {proof.note && <span className="sm:col-span-2 text-slate-500">Note: {proof.note}</span>}
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => act(() => approve(inv.id), `Approved ${inv.number} — subscription activated.`)}>
                        Approve &amp; activate
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => act(() => reject(inv.id, note[inv.id] || 'Payment could not be verified.'), `Rejected ${inv.number}.`)}>
                        Reject
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => act(() => requestInfo(inv.id, note[inv.id] || ''), `Requested more info for ${inv.number}.`)}>
                        Request info
                      </Button>
                      <Input
                        className="h-8 max-w-xs flex-1"
                        placeholder="Reason / info note"
                        value={note[inv.id] ?? ''}
                        onChange={(e) => setNote((n) => ({ ...n, [inv.id]: e.target.value }))}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {recent.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Recently reviewed</h2>
            <div className="space-y-2">
              {recent.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
                  <span className="text-slate-600 dark:text-slate-300">{inv.number} · {money(inv.total, inv.currency)}</span>
                  <Badge tone={inv.status === 'paid' ? 'green' : 'red'}>{inv.status}</Badge>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
