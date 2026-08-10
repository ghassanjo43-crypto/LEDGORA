/**
 * "Users & members" for one selected subscriber.
 *
 * ── Why this is its own drawer ───────────────────────────────────────────────
 * Member management previously lived inside the closure drawer, reachable only
 * through a control labelled "Manage closure". Routine work — inviting a
 * colleague, resending an invitation — was therefore hidden behind the most
 * destructive surface in the console. The two are now separate: closure keeps
 * its drawer, and this one does nothing destructive to the tenant.
 *
 * ── The subscriber is always named ───────────────────────────────────────────
 * The organization's legal name and id are shown at the top, because an
 * operator acting across tenants must never have to infer whose members these
 * are. Every request the panel makes carries that id explicitly; nothing here
 * sets a "current organization" or impersonates the customer.
 */
import { Drawer } from '@/components/ui/Drawer';
import { Badge } from '@/components/ui/Badge';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';
import { MemberManagementPanel } from '@/components/members/MemberManagementPanel';

export interface SubscriberMembersDrawerProps {
  open: boolean;
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  capabilities: PlatformCapabilityName[];
  onClose: () => void;
}

export function SubscriberMembersDrawer({
  open,
  organizationId,
  legalName,
  organizationStatus,
  capabilities,
  onClose,
}: SubscriberMembersDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-5xl"
      title={`Users & members — ${legalName}`}
      description="Invite, manage and remove people inside this subscriber. Nothing here closes or deletes the account."
    >
      <div className="space-y-4">
        {/* Whose members these are, stated plainly and unmissably. */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700"
          data-testid="members-subscriber-identity"
        >
          <Badge tone="indigo">{legalName}</Badge>
          <code className="text-[11px] text-slate-500 dark:text-slate-400">{organizationId}</code>
          <Badge tone={organizationStatus === 'active' ? 'green' : 'amber'}>{organizationStatus}</Badge>
        </div>

        <MemberManagementPanel
          mode="operator"
          organizationId={organizationId}
          organizationName={legalName}
          organizationStatus={organizationStatus}
          // Presentation only — every route re-checks the capability itself.
          canManage={capabilities.includes('manage-users')}
        />
      </div>
    </Drawer>
  );
}
