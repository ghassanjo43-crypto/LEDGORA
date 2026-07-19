/**
 * Platform entitlement & subscription-lifecycle administration. Lets the
 * super-administrator change an organization's edition, toggle module add-ons,
 * adjust limits and drive the subscription status. Reuses the existing edition/
 * module building blocks. Never deletes data — status changes only gate new
 * activity.
 */
import { useMemo } from 'react';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useEffectiveModules } from '@/store/entitlementHooks';
import type { SubscriptionStatus } from '@/types/subscription';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { EditionBadge } from '@/components/entitlements/EditionBadge';
import { EditionSelector } from '@/components/settings/EditionSelector';
import { ModuleEntitlementTable } from '@/components/settings/ModuleEntitlementTable';
import { BankRemittanceActivationPanel } from '@/components/settings/BankRemittanceActivationPanel';
import { MODULE_BY_ID } from '@/config/modules';
import { formatDate } from '@/lib/utils';

const STATUS_OPTIONS: { value: SubscriptionStatus; label: string }[] = [
  { value: 'trial', label: 'Trial' },
  { value: 'active', label: 'Active' },
  { value: 'past-due', label: 'Past due' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
];

export function EntitlementAdminPanel() {
  const subscription = useEntitlementStore((s) => s.subscription);
  const auditTrail = useEntitlementStore((s) => s.auditTrail);
  const owned = useEffectiveModules();
  const setEdition = useEntitlementStore((s) => s.setEdition);
  const setStatus = useEntitlementStore((s) => s.setSubscriptionStatus);
  const suspend = useEntitlementStore((s) => s.suspendSubscription);
  const renew = useEntitlementStore((s) => s.renewSubscription);
  const updateLimits = useEntitlementStore((s) => s.updateLimits);

  const addOns = useMemo(() => subscription.enabledModules.map((m) => MODULE_BY_ID[m]?.name ?? m), [subscription.enabledModules]);
  const recentAudit = useMemo(() => [...auditTrail].reverse().slice(0, 10), [auditTrail]);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center gap-2"><EditionBadge /><Badge tone="slate">{subscription.status}</Badge></div>
          <dl className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm dark:border-slate-800 sm:grid-cols-4">
            <div><dt className="text-[11px] uppercase text-slate-400">Started</dt><dd className="font-medium">{subscription.startsAt ? formatDate(subscription.startsAt) : '—'}</dd></div>
            <div><dt className="text-[11px] uppercase text-slate-400">Expires</dt><dd className="font-medium">{subscription.expiresAt ? formatDate(subscription.expiresAt) : 'No expiry'}</dd></div>
            <div><dt className="text-[11px] uppercase text-slate-400">User limit</dt><dd className="font-medium">{subscription.userLimit}</dd></div>
            <div><dt className="text-[11px] uppercase text-slate-400">Entity limit</dt><dd className="font-medium">{subscription.entityLimit}</dd></div>
          </dl>
          {addOns.length > 0 && <div className="flex flex-wrap gap-1">{addOns.map((n) => <Badge key={n} tone="teal">{n}</Badge>)}</div>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Edition" description="Changing edition re-filters navigation, reports and forms immediately." />
        <CardBody><EditionSelector value={subscription.edition} onSelect={setEdition} /></CardBody>
      </Card>

      <Card>
        <CardHeader title="Modules & add-ons" description="Enable a module as an add-on or disable one. Historical records are always preserved." />
        <CardBody><ModuleEntitlementTable /></CardBody>
      </Card>

      <Card>
        <CardHeader title="Subscription status & activation" description="Administrative actions — status changes gate new activity only." />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Status</label>
              <Select value={subscription.status} options={STATUS_OPTIONS} onChange={(e) => setStatus(e.target.value as SubscriptionStatus)} className="w-44" />
            </div>
            <Button variant="outline" size="sm" onClick={() => renew()}>Renew</Button>
            <Button variant="outline" size="sm" onClick={() => suspend('Manual admin suspension')}>Suspend</Button>
          </div>
          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <LimitField label="User limit" value={subscription.userLimit} onCommit={(v) => updateLimits({ userLimit: v })} />
            <LimitField label="Entity limit" value={subscription.entityLimit} onCommit={(v) => updateLimits({ entityLimit: v })} />
          </div>
          <div className="border-t border-slate-100 pt-4 dark:border-slate-800"><BankRemittanceActivationPanel /></div>
        </CardBody>
      </Card>

      {recentAudit.length > 0 && (
        <Card>
          <CardHeader title="Subscription audit trail" />
          <CardBody className="p-0">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentAudit.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-2 text-sm"><Badge tone="slate">{e.event}</Badge><span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">{e.detail}</span><span className="shrink-0 text-[11px] text-slate-400">{formatDate(e.at)}</span></li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
      <p className="px-1 text-[11px] text-slate-400">{owned.length} module{owned.length === 1 ? '' : 's'} currently owned.</p>
    </div>
  );
}

function LimitField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <input type="number" min={1} defaultValue={value} key={value} onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 1 && v !== value) onCommit(Math.floor(v)); }} className="focus-ring h-9 w-32 rounded-lg border border-slate-300 bg-white px-2.5 text-sm dark:border-slate-700 dark:bg-slate-900" />
    </div>
  );
}
