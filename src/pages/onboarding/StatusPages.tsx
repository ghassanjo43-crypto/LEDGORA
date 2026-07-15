/**
 * Subscription status + lifecycle surfaces reachable while the app itself is
 * gated: pending-verification status, suspended, renew (expired), plus the
 * lightweight profile and support pages a pending user may always open.
 */
import { useMemo } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAuthStore } from '@/store/authStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard, money } from '@/components/onboarding/OnboardingChrome';
import { ROUTES } from '@/lib/accessControl';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';

/* ── Pending verification ──────────────────────────────────────────────────── */

export function SubscriptionStatusPage() {
  const subscription = useOrganizationStore((s) => s.subscription);
  const invoices = useOrganizationStore((s) => s.invoices);
  const navigate = useRouterStore((s) => s.navigate);
  const logout = useAuthStore((s) => s.logout);

  const invoice = useMemo(
    () => (subscription?.invoiceId ? invoices.find((i) => i.id === subscription.invoiceId) ?? null : null),
    [invoices, subscription?.invoiceId],
  );

  if (!subscription) {
    return (
      <CenteredCard title="Subscription status">
        <Alert variant="info">You don’t have a subscription yet.</Alert>
        <Button className="mt-4 w-full" onClick={() => navigate(ROUTES.onboardingSubscription)}>Choose a plan</Button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard title="Subscription status" subtitle="Here's where your subscription stands.">
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100 capitalize">{subscription.basePlanCode} plan</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{money(subscription.monthlyTotal, subscription.currency)}/month</p>
          </div>
          <StatusBadge status={subscription.status} />
        </div>

        {subscription.status === 'pending_verification' && (
          <Alert variant="info" title="Awaiting verification">
            We’ve received your payment proof {invoice ? `for invoice ${invoice.number}` : ''} and our team is reviewing
            it. You’ll get an activation email once it’s approved. You can sign in any time to check progress.
          </Alert>
        )}
        {invoice?.infoRequest && (
          <Alert variant="warning" title="Action needed">
            {invoice.infoRequest}
            <div className="mt-2">
              <Button size="sm" onClick={() => navigate(ROUTES.billingPayment)}>Update payment details</Button>
            </div>
          </Alert>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={() => { logout(); navigate(ROUTES.login); }}>Sign out</Button>
          <Button variant="outline" size="sm" onClick={() => navigate(ROUTES.support)}>Contact support</Button>
        </div>
      </div>
    </CenteredCard>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active' ? 'green' : status === 'pending_verification' ? 'amber' : status === 'rejected' || status === 'suspended' ? 'red' : 'slate';
  return <Badge tone={tone as never}>{status.replace('_', ' ')}</Badge>;
}

/* ── Suspended ─────────────────────────────────────────────────────────────── */

export function SubscriptionSuspendedPage() {
  const navigate = useRouterStore((s) => s.navigate);
  const logout = useAuthStore((s) => s.logout);
  return (
    <CenteredCard title="Subscription suspended">
      <Alert variant="error" title="Access is temporarily suspended">
        Your organization’s subscription has been suspended. Your accounting data is safe and preserved in read-only
        state. Please contact support to restore access.
      </Alert>
      <div className="mt-4 flex justify-between">
        <Button variant="ghost" size="sm" onClick={() => { logout(); navigate(ROUTES.login); }}>Sign out</Button>
        <Button size="sm" onClick={() => navigate(ROUTES.support)}>Contact support</Button>
      </div>
    </CenteredCard>
  );
}

/* ── Renew (expired) ───────────────────────────────────────────────────────── */

export function BillingRenewPage() {
  const subscription = useOrganizationStore((s) => s.subscription);
  const navigate = useRouterStore((s) => s.navigate);
  return (
    <CenteredCard title="Renew your subscription" subtitle="Your subscription term has ended.">
      <Alert variant="warning" title="Subscription expired">
        Your subscription {subscription?.expiresAt ? `expired on ${subscription.expiresAt.slice(0, 10)}` : 'has expired'}.
        Your historical records remain available in read-only mode. Renew to resume full access.
      </Alert>
      <Button className="mt-4 w-full" onClick={() => navigate(ROUTES.onboardingSubscription)}>Review plan &amp; renew</Button>
    </CenteredCard>
  );
}

/* ── Profile ───────────────────────────────────────────────────────────────── */

export function ProfilePage() {
  const users = useAuthStore((s) => s.users);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const organization = useOrganizationStore((s) => s.organization);
  const navigate = useRouterStore((s) => s.navigate);
  const logout = useAuthStore((s) => s.logout);
  const user = useMemo(() => users.find((u) => u.id === currentUserId) ?? null, [users, currentUserId]);

  return (
    <CenteredCard title="Your profile">
      {user ? (
        <dl className="space-y-2 text-sm">
          <ProfileRow label="Name" value={user.fullName} />
          <ProfileRow label="Email" value={user.email} />
          <ProfileRow label="Mobile" value={user.mobile} />
          <ProfileRow label="Role" value={user.role} />
          <ProfileRow label="Organization" value={organization?.legalName ?? '—'} />
        </dl>
      ) : (
        <Alert variant="info">Sign in to view your profile.</Alert>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => { logout(); navigate(ROUTES.login); }}>Sign out</Button>
      </div>
    </CenteredCard>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-slate-100 py-1.5 dark:border-slate-800">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-700 dark:text-slate-200 capitalize">{value}</dd>
    </div>
  );
}

/* ── Support ───────────────────────────────────────────────────────────────── */

export function SupportPage() {
  const navigate = useRouterStore((s) => s.navigate);
  return (
    <CenteredCard title="Support" subtitle="We're here to help.">
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <p>For help with registration, payment verification or your subscription, reach us at:</p>
        <ul className="space-y-1">
          <li>📧 <span className="font-medium">support@ledgora.app</span></li>
          <li>💬 In-app chat (business hours)</li>
        </ul>
        <p className="text-xs text-slate-400">Typical response time: within one business day.</p>
      </div>
      <Button className="mt-4 w-full" variant="outline" onClick={() => navigate(ROUTES.subscriptionStatus)}>Back to status</Button>
    </CenteredCard>
  );
}
