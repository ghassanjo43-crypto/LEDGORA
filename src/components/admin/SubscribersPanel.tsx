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
 *
 * The row "View" opens an accessible detail drawer for THAT subscriber (never
 * ambient state), and — for the retained active tenant — lets the operator open
 * the subscriber workspace in explicit viewing mode (see `operatorViewStore`).
 */
import { useMemo, useState } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAuthStore, membersOf } from '@/store/authStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { formatCurrency } from '@/lib/money';
import {
  SubscriberDetailDrawer,
  type ActiveTenantDetail,
  type SubscriberRow,
  type SubscriberState,
} from './SubscriberDetailDrawer';

function statusTone(status?: string): 'green' | 'amber' | 'red' | 'slate' {
  return status === 'active' ? 'green' : status === 'pending_verification' || status === 'pending_payment' ? 'amber' : status === 'suspended' || status === 'rejected' || status === 'expired' ? 'red' : 'slate';
}

export function SubscribersPanel() {
  const organization = useOrganizationStore((s) => s.organization);
  const subscription = useOrganizationStore((s) => s.subscription);
  const invoices = useOrganizationStore((s) => s.invoices);
  const users = useAuthStore((s) => s.users);
  const config = useMeteringConfigStore((s) => s.config);
  const userLimit = useEntitlementStore((s) => s.subscription.userLimit);
  const edition = useEntitlementStore((s) => s.subscription.edition);
  const enterSubscriberView = useOperatorViewStore((s) => s.enter);
  const navigate = useRouterStore((s) => s.navigate);
  const [selected, setSelected] = useState<string | null>(null);

  // Every account holder (role owner) is a subscriber. Classify each against the
  // one retained active organization; others carry only their sign-up data.
  const rows: SubscriberRow[] = useMemo(() => {
    return users
      .filter((u) => u.role === 'owner')
      .map((owner) => {
        const isActiveOrg = !!organization && organization.ownerUserId === owner.id;
        const state: SubscriberState = isActiveOrg
          ? 'active-tenant'
          : owner.organizationId
            ? 'onboarded-elsewhere'
            : 'not-onboarded';
        const orgName =
          state === 'active-tenant'
            ? organization!.legalName
            : state === 'onboarded-elsewhere'
              ? '(organization not retained — single-tenant demo)'
              : 'Not onboarded yet';
        return { owner, orgName, state };
      })
      .sort((a, b) => Number(b.state === 'active-tenant') - Number(a.state === 'active-tenant'));
  }, [users, organization]);

  const activePlan = config.basePlans.find((p) => p.code === subscription?.basePlanCode);
  const detailRow = selected ? rows.find((r) => r.owner.id === selected) ?? null : null;

  // Full detail is assembled ONLY for the retained active tenant, and only when
  // the selected row IS that tenant — never mixing another subscriber's data in.
  const activeDetail: ActiveTenantDetail | null = useMemo(() => {
    if (!detailRow || detailRow.state !== 'active-tenant' || !organization) return null;
    const members = membersOf(users, organization.id);
    return {
      planName: activePlan?.name ?? subscription?.basePlanCode ?? '—',
      status: subscription?.status ?? 'none',
      edition,
      addOns: subscription?.addOnModuleCodes.join(', ') || 'none',
      monthlyTotal: subscription?.monthlyTotal ?? 0,
      currency: subscription?.currency ?? 'USD',
      activeSeats: members.filter((m) => m.status !== 'suspended').length,
      userLimit,
      paymentReference: subscription?.paymentReference ?? '—',
      members,
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        paymentReference: i.paymentReference,
        total: i.total,
        currency: i.currency,
        status: i.status,
      })),
    };
  }, [detailRow, organization, users, activePlan, subscription, edition, userLimit, invoices]);

  if (rows.length === 0) return <Alert variant="info">No subscriber accounts yet. Registrations appear here.</Alert>;

  /**
   * Place the operator into the selected subscriber's organization context and
   * open the subscriber dashboard. Guarded twice: only the retained active
   * tenant is enterable, and we re-check that the loaded organization actually
   * belongs to the selected owner, so accounting data can never cross tenants.
   */
  const openWorkspace = (row: SubscriberRow): void => {
    const org = useOrganizationStore.getState().organization;
    if (row.state !== 'active-tenant' || !org || org.ownerUserId !== row.owner.id) return;
    enterSubscriberView({
      organizationId: org.id,
      ownerUserId: row.owner.id,
      ownerName: row.owner.fullName,
      orgName: org.legalName,
    });
    setSelected(null);
    navigate(ROUTES.appDashboard);
  };

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
            {rows.map((r) => {
              const isActive = r.state === 'active-tenant';
              return (
                <tr key={r.owner.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2"><span className="font-medium">{r.owner.fullName}</span><span className="block text-xs text-slate-400">{r.owner.email}{r.owner.emailVerified ? '' : ' · unverified'}</span></td>
                  <td className="px-4 py-2">{r.orgName}</td>
                  <td className="px-4 py-2 capitalize">{isActive ? activePlan?.name ?? subscription?.basePlanCode ?? '—' : '—'}</td>
                  <td className="px-4 py-2">{isActive ? <Badge tone={statusTone(subscription?.status)}>{subscription?.status ?? 'none'}</Badge> : <Badge tone="slate">registered</Badge>}</td>
                  <td className="px-4 py-2 text-right">{isActive ? formatCurrency(subscription?.monthlyTotal ?? 0, subscription?.currency ?? 'USD') : '—'}</td>
                  <td className="px-4 py-2 text-slate-500">{r.owner.createdAt.slice(0, 10)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected(r.owner.id)}
                      aria-label={`View ${r.owner.fullName}`}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <SubscriberDetailDrawer
        open={!!detailRow}
        row={detailRow}
        detail={activeDetail}
        onClose={() => setSelected(null)}
        onOpenWorkspace={() => detailRow && openWorkspace(detailRow)}
      />
    </div>
  );
}
