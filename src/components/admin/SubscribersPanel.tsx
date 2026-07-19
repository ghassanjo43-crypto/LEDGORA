/**
 * Platform super-administrator view of subscribers.
 *
 * Every registered account (`authStore.users`) that owns/started an organization
 * is a subscriber, so the roster is derived from the user registry — that's the
 * only array that holds ALL sign-ups (e.g. a newly-registered subscriber).
 *
 * Ledgora is frontend-only and SINGLE-TENANT today: only one organization +
 * subscription + invoice set is retained at a time. So full plan/invoice detail
 * is available for the active organization; other accounts show the sign-up
 * data that is retained. A real multi-tenant backend keeps every org's detail.
 */
import { useMemo, useState } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAuthStore, membersOf } from '@/store/authStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import type { RegisteredUser } from '@/types/onboarding';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { formatCurrency } from '@/lib/money';
import { Building2 } from 'lucide-react';

function statusTone(status?: string): 'green' | 'amber' | 'red' | 'slate' {
  return status === 'active' ? 'green' : status === 'pending_verification' || status === 'pending_payment' ? 'amber' : status === 'suspended' || status === 'rejected' || status === 'expired' ? 'red' : 'slate';
}

interface SubscriberRow {
  owner: RegisteredUser;
  orgName: string;
  isActiveOrg: boolean;
}

export function SubscribersPanel() {
  const organization = useOrganizationStore((s) => s.organization);
  const subscription = useOrganizationStore((s) => s.subscription);
  const invoices = useOrganizationStore((s) => s.invoices);
  const users = useAuthStore((s) => s.users);
  const config = useMeteringConfigStore((s) => s.config);
  const userLimit = useEntitlementStore((s) => s.subscription.userLimit);
  const edition = useEntitlementStore((s) => s.subscription.edition);
  const [selected, setSelected] = useState<string | null>(null);

  // Every account holder (role owner) is a subscriber. Attach the one active
  // organization's detail to its owner; others show sign-up data only.
  const rows: SubscriberRow[] = useMemo(() => {
    return users
      .filter((u) => u.role === 'owner')
      .map((owner) => {
        const isActiveOrg = !!organization && organization.ownerUserId === owner.id;
        const orgName = isActiveOrg ? organization!.legalName : owner.organizationId ? '(organization not retained — single-tenant demo)' : 'Not onboarded yet';
        return { owner, orgName, isActiveOrg };
      })
      .sort((a, b) => Number(b.isActiveOrg) - Number(a.isActiveOrg));
  }, [users, organization]);

  if (rows.length === 0) return <Alert variant="info">No subscriber accounts yet. Registrations appear here.</Alert>;

  const activePlan = config.basePlans.find((p) => p.code === subscription?.basePlanCode);
  const detailRow = selected ? rows.find((r) => r.owner.id === selected) : null;
  const detailMembers = detailRow ? membersOf(users, detailRow.owner.organizationId) : [];

  return (
    <div className="space-y-4">
      <Alert variant="info">
        Single-tenant demo: full subscription &amp; invoice detail is retained for the active organization; other accounts show sign-up data. Multi-subscriber persistence needs the backend.
      </Alert>

      <Card className="overflow-x-auto">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">Subscribers ({rows.length})</div>
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Owner</th><th className="px-4 py-2 text-left">Organization</th><th className="px-4 py-2 text-left">Plan</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">MRR</th><th className="px-4 py-2 text-left">Registered</th><th className="px-4 py-2"></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.owner.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2"><span className="font-medium">{r.owner.fullName}</span><span className="block text-xs text-slate-400">{r.owner.email}{r.owner.emailVerified ? '' : ' · unverified'}</span></td>
                <td className="px-4 py-2">{r.orgName}</td>
                <td className="px-4 py-2 capitalize">{r.isActiveOrg ? activePlan?.name ?? subscription?.basePlanCode ?? '—' : '—'}</td>
                <td className="px-4 py-2">{r.isActiveOrg ? <Badge tone={statusTone(subscription?.status)}>{subscription?.status ?? 'none'}</Badge> : <Badge tone="slate">registered</Badge>}</td>
                <td className="px-4 py-2 text-right">{r.isActiveOrg ? formatCurrency(subscription?.monthlyTotal ?? 0, subscription?.currency ?? 'USD') : '—'}</td>
                <td className="px-4 py-2 text-slate-500">{r.owner.createdAt.slice(0, 10)}</td>
                <td className="px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => setSelected(r.owner.id)}>View</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {detailRow && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100"><Building2 className="h-4 w-4" /> {detailRow.orgName} — {detailRow.owner.fullName}</h3>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Account</h4>
              <dl className="space-y-1 text-sm">
                <Row label="Owner" value={detailRow.owner.fullName} />
                <Row label="Email" value={detailRow.owner.email} />
                <Row label="Mobile" value={detailRow.owner.mobile || '—'} />
                <Row label="Country" value={detailRow.owner.country} />
                <Row label="Email verified" value={detailRow.owner.emailVerified ? 'yes' : 'no'} />
                <Row label="Registered" value={detailRow.owner.createdAt.slice(0, 10)} />
              </dl>
            </div>
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Subscription</h4>
              {detailRow.isActiveOrg ? (
                <dl className="space-y-1 text-sm">
                  <Row label="Plan" value={activePlan?.name ?? subscription?.basePlanCode ?? '—'} />
                  <Row label="Status" value={subscription?.status ?? 'none'} />
                  <Row label="Edition" value={edition} />
                  <Row label="Add-ons" value={subscription?.addOnModuleCodes.join(', ') || 'none'} />
                  <Row label="Monthly total" value={formatCurrency(subscription?.monthlyTotal ?? 0, subscription?.currency ?? 'USD')} />
                  <Row label="Seats" value={`${membersOf(users, detailRow.owner.organizationId).filter((m) => m.status !== 'suspended').length} / ${userLimit}`} />
                  <Row label="Payment ref" value={subscription?.paymentReference ?? '—'} />
                </dl>
              ) : (
                <p className="text-sm text-slate-400">This account's organization is not the active tenant in this browser, so its plan/invoice detail isn't retained (single-tenant demo).</p>
              )}
            </div>
          </div>

          {detailRow.isActiveOrg && (
            <>
              <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Members ({detailMembers.length})</h4>
              <table className="w-full text-sm">
                <tbody>
                  {detailMembers.map((m) => (
                    <tr key={m.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-1">{m.fullName}<span className="block text-xs text-slate-400">{m.email}</span></td>
                      <td className="py-1 text-right capitalize text-slate-500">{m.role}</td>
                      <td className="py-1 text-right"><Badge tone={m.status === 'active' ? 'green' : m.status === 'invited' ? 'amber' : m.status === 'suspended' ? 'red' : 'slate'}>{m.status ?? 'active'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4 className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Invoices ({invoices.length})</h4>
              {invoices.length === 0 ? <p className="text-sm text-slate-400">No invoices.</p> : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400"><tr><th className="text-left">Number</th><th className="text-left">Reference</th><th className="text-right">Total</th><th className="text-right">Status</th></tr></thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1 font-medium">{i.number}</td><td className="py-1 text-slate-500">{i.paymentReference}</td><td className="py-1 text-right">{formatCurrency(i.total, i.currency)}</td><td className="py-1 text-right"><Badge tone={i.status === 'paid' ? 'green' : i.status === 'rejected' || i.status === 'cancelled' ? 'red' : 'amber'}>{i.status}</Badge></td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800"><dt className="text-slate-400">{label}</dt><dd className="font-medium text-slate-700 dark:text-slate-200 capitalize">{value}</dd></div>;
}
