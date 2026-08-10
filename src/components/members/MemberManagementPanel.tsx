/**
 * Member and invitation management, for BOTH surfaces that need it.
 *
 * ── Why one component ────────────────────────────────────────────────────────
 * The subscriber's own Users & Roles page and the Super Admin's per-subscriber
 * section show the same information and offer the same acts. Building them
 * separately is how two screens come to disagree about what a suspended member
 * may do. The only difference is WHICH endpoints they call, so that — and only
 * that — is what `mode` selects.
 *
 *   subscriber → `/api/organizations/current/...`  (organization derived from
 *                the caller's own membership; no id is ever sent)
 *   operator   → `/api/admin/organizations/:id/...` (id in the URL, behind a
 *                platform capability no customer role satisfies)
 *
 * The operator path never sets a "current organization" and never impersonates
 * anybody: every request names the subscriber explicitly.
 *
 * ── Nothing here is authorization ────────────────────────────────────────────
 * `canManage` decides which controls are OFFERED. Every route re-checks its own
 * authority against the database-backed session, so a client that ignored this
 * would collect 403s. Failures render the server's own message — never a
 * generic success.
 *
 * ── The development-only link ────────────────────────────────────────────────
 * `invitationToken` arrives only when the server has explicitly been configured
 * to expose it, which production refuses. It lives in ONE `useState` here, is
 * shown once with a "Development only" label, and is cleared when the dialog
 * closes or unmounts. It never reaches the directory store, browser storage, a
 * URL or a log.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Input, Field } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ApiError } from '@/services/api/client';
import {
  memberApi,
  type InvitationResult,
  type MemberRecord,
  type MemberRole,
  type MemberStatus,
  type SeatUsage,
} from '@/services/api/memberApi';
import { InviteMemberDialog } from './InviteMemberDialog';
import { SeatUsageSummary } from './SeatUsageSummary';

export type MemberPanelMode = 'subscriber' | 'operator';

/**
 * Organization states in which the backend accepts new or reactivated members.
 *
 * ── A suspended MEMBER is not a suspended ORGANIZATION ──────────────────────
 * Two different states that this mapping deliberately keeps apart:
 *
 *   · a suspended MEMBER inside an ACTIVE organization is reactivatable — that
 *     is the normal way somebody comes back after leave or an investigation;
 *   · a suspended ORGANIZATION is a live customer with a billing problem. The
 *     canonical backend policy (`memberService.INVITABLE_ORGANIZATION_STATUSES`)
 *     permits it to keep managing its team, so this mirrors that exactly.
 *
 * `archived`, `pending_deletion` and `closed` are absent: those tenants are out
 * of circulation, every member has been signed out, and the backend refuses.
 * This list mirrors the server's — it never widens it.
 */
const MEMBER_CHANGES_ALLOWED_STATUSES = new Set(['active', 'suspended']);

export interface MemberManagementPanelProps {
  mode: MemberPanelMode;
  organizationId: string;
  /** Shown prominently so the operator always knows whose members these are. */
  organizationName?: string | null;
  /** From the backend. Drives the read-only lifecycle rules. */
  organizationStatus?: string | null;
  /** Presentation only — the routes remain authoritative. */
  canManage: boolean;
  /** The signed-in user, so the UI never offers self-management. */
  currentUserId?: string | null;
}

const ROLE_FILTERS = [
  { value: 'all', label: 'Any role' },
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Organization Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Standard User' },
  { value: 'viewer', label: 'Read-only / Auditor' },
];

const STATUS_FILTERS = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'invited', label: 'Invitation pending' },
  { value: 'suspended', label: 'Suspended' },
];

/**
 * Roles a MEMBER may be changed to.
 *
 * `owner` is absent because ownership is transferred, not assigned; `admin` is
 * absent because the backend refuses to mint one this way. Offering either
 * would be offering a button that returns 400.
 */
const ASSIGNABLE_ROLES: MemberRole[] = ['manager', 'accountant', 'member', 'viewer'];

const shortDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString() : '—';

type PendingAction = {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: boolean;
  run: () => Promise<string>;
};

export function MemberManagementPanel({
  mode,
  organizationId,
  organizationName,
  organizationStatus,
  canManage,
  currentUserId,
}: MemberManagementPanelProps) {
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [seats, setSeats] = useState<SeatUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  /**
   * The lifecycle gate.
   *
   * An archived or pending-deletion subscriber is out of circulation and every
   * member has been signed out; the backend refuses invitations into it, so the
   * UI must not offer them — and must say why rather than showing a dead button.
   */
  const lifecycleAllowsChanges =
    !organizationStatus || MEMBER_CHANGES_ALLOWED_STATUSES.has(organizationStatus);
  const managementEnabled = canManage && lifecycleAllowsChanges;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const roster =
          mode === 'operator'
            ? await memberApi.listForOrganization(organizationId, signal)
            : await memberApi.listForCurrentOrganization(signal);
        setMembers(roster.members);

        /*
         * Seat usage, always from a dedicated backend endpoint — never
         * reconstructed here. Both modes now have one, so the figures on screen
         * are the same figures the invitation path enforces under its row lock.
         */
        const usage =
          mode === 'operator'
            ? await memberApi.seatsForOrganization(organizationId, signal)
            : await memberApi.seatsForCurrentOrganization(signal);
        setSeats(usage.seats);
      } catch (caught) {
        if ((caught as { name?: string }).name === 'AbortError') return;
        setError(caught instanceof ApiError ? caught.message : 'The member list could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [mode, organizationId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return members.filter((m) => {
      if (roleFilter !== 'all' && m.role !== roleFilter) return false;
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (!needle) return true;
      return m.fullName.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle);
    });
  }, [members, search, roleFilter, statusFilter]);

  /** Run a confirmed action, then re-read authoritative state from the server. */
  const runPending = async (): Promise<void> => {
    if (!pending || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const message = await pending.run();
      setPending(null);
      setNotice(message);
      await load();
    } catch (caught) {
      // The server's own wording. Never a false success.
      setActionError(caught instanceof ApiError ? caught.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: MemberRecord, role: MemberRole): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      if (mode === 'operator') {
        await memberApi.updateInOrganization(organizationId, member.userId, { role });
      } else {
        await memberApi.updateInCurrentOrganization(member.userId, {
          role,
          reason: `Role changed to ${role}.`,
        });
      }
      setNotice(`${member.fullName} is now ${role}.`);
      await load();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'The role could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (member: MemberRecord, status: MemberStatus): PendingAction => ({
    title: status === 'suspended' ? `Suspend ${member.fullName}` : `Reactivate ${member.fullName}`,
    message:
      status === 'suspended'
        ? 'They lose access immediately and every active session is ended. Their seat is released, and nothing they created is deleted — records they authored keep their attribution.'
        : 'They regain access with their existing role. A seat is consumed again, so this fails if the plan is full.',
    confirmLabel: status === 'suspended' ? 'Suspend member' : 'Reactivate member',
    destructive: status === 'suspended',
    run: async () => {
      if (mode === 'operator') {
        await memberApi.updateInOrganization(organizationId, member.userId, { status });
      } else {
        await memberApi.updateInCurrentOrganization(member.userId, {
          status,
          reason: status === 'suspended' ? 'Suspended by an administrator.' : 'Reactivated.',
        });
      }
      return status === 'suspended'
        ? `${member.fullName} was suspended. Their seat has been released.`
        : `${member.fullName} was reactivated.`;
    },
  });

  const removeMember = (member: MemberRecord): PendingAction => ({
    title: `Remove ${member.fullName}`,
    message:
      'They lose access to THIS organization only. Their Ledgora account, any membership of another organization, and every record they created, approved or posted are all left intact — removal is not deletion.',
    confirmLabel: 'Remove from organization',
    destructive: true,
    run: async () => {
      await memberApi.removeFromOrganization(organizationId, member.userId);
      return `${member.fullName} was removed. Their seat has been released and their history is unchanged.`;
    },
  });

  const cancelInvitation = (member: MemberRecord): PendingAction => ({
    title: `Cancel the invitation for ${member.email}`,
    message:
      'The invitation link stops working and the reserved seat is released. Their Ledgora identity is not deleted — they can be invited again later.',
    confirmLabel: 'Cancel invitation',
    destructive: true,
    run: async () => {
      // Both paths name their target: the operator route carries the
      // organization in its URL, the subscriber route derives it from the
      // caller's own membership. Neither reads a global "current organization".
      if (mode === 'operator') {
        await memberApi.cancelInvitationForOrganization(organizationId, member.userId);
      } else {
        await memberApi.cancelInvitation(member.userId);
      }
      return `The invitation for ${member.email} was cancelled and its seat released.`;
    },
  });

  const resend = async (member: MemberRecord): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const result =
        mode === 'operator'
          ? await memberApi.resendInvitationForOrganization(organizationId, member.userId)
          : await memberApi.resendInvitation(member.userId);
      setNotice(`${deliveryMessage(result.delivery, member.email)} Any earlier link has stopped working.`);
      await load();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'The invitation could not be resent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="member-management">
      {organizationName && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Managing members of{' '}
          <span className="font-semibold text-slate-800 dark:text-slate-100" data-testid="managed-organization">
            {organizationName}
          </span>
        </p>
      )}

      {error && <Alert variant="error">{error}</Alert>}
      {actionError && (
        <Alert variant="error" title="Could not complete" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          <span data-testid="member-notice">{notice}</span>
        </Alert>
      )}

      {canManage && !lifecycleAllowsChanges && (
        <Alert variant="warning" title="Member management is unavailable">
          <span data-testid="lifecycle-reason">
            This subscriber is {organizationStatus}. Members are shown read-only: invitations and
            reactivation are refused until the account is restored.
          </span>
        </Alert>
      )}

      {seats && <SeatUsageSummary seats={seats} />}

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Search" className="min-w-[200px] flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or email"
            aria-label="Search members"
            data-testid="member-search"
          />
        </Field>
        <Field label="Role">
          <Select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            options={ROLE_FILTERS}
            aria-label="Filter by role"
            data-testid="member-role-filter"
          />
        </Field>
        <Field label="Status">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={STATUS_FILTERS}
            aria-label="Filter by status"
            data-testid="member-status-filter"
          />
        </Field>
        {managementEnabled && (
          <Button
            onClick={() => setInviting(true)}
            disabled={busy}
            data-testid="invite-user"
          >
            Add user
          </Button>
        )}
      </div>

      {/* ── Roster ──────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-slate-500" data-testid="members-loading">
            Loading members…
          </p>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm text-slate-500" data-testid="members-empty">
            {members.length === 0
              ? 'No members yet. Invite someone to get started.'
              : 'No members match these filters.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Organization members and pending invitations</caption>
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left">Member</th>
                  <th scope="col" className="px-4 py-2 text-left">Role</th>
                  <th scope="col" className="px-4 py-2 text-left">Status</th>
                  <th scope="col" className="px-4 py-2 text-left">Added</th>
                  <th scope="col" className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((member) => {
                  const isSelf = member.userId === currentUserId;
                  const isOwner = member.role === 'owner';
                  const isPending = member.status === 'invited';
                  /*
                   * The owner and the signed-in user are never offered
                   * management controls: the backend protects the last owner and
                   * refuses self-promotion, so offering either would be offering
                   * a button that fails.
                   */
                  const actionable = managementEnabled && !isSelf && !isOwner;

                  return (
                    <tr
                      key={member.membershipId}
                      className="border-t border-slate-100 dark:border-slate-800"
                      data-testid={`member-row-${member.userId}`}
                    >
                      <td className="px-4 py-2">
                        <span className="font-medium">{member.fullName}</span>
                        <span className="block text-xs text-slate-400">{member.email}</span>
                      </td>
                      <td className="px-4 py-2">
                        {actionable ? (
                          <Select
                            value={member.role}
                            disabled={busy}
                            aria-label={`Role for ${member.fullName}`}
                            data-testid={`role-select-${member.userId}`}
                            onChange={(e) => void changeRole(member, e.target.value as MemberRole)}
                            options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r }))}
                          />
                        ) : (
                          <Badge tone={isOwner ? 'indigo' : 'slate'}>{member.role}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <MembershipStatusBadge member={member} />
                      </td>
                      <td className="px-4 py-2 text-slate-500">{shortDate(member.joinedAt)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right">
                        {isSelf && <span className="text-xs text-slate-400">You</span>}
                        {isOwner && !isSelf && (
                          <span className="text-xs text-slate-400" data-testid={`owner-protected-${member.userId}`}>
                            Owner — transfer ownership first
                          </span>
                        )}

                        {actionable && isPending && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void resend(member)}
                              data-testid={`resend-${member.userId}`}
                            >
                              Resend
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setPending(cancelInvitation(member))}
                              data-testid={`cancel-invite-${member.userId}`}
                            >
                              Cancel invite
                            </Button>
                          </>
                        )}

                        {actionable && !isPending && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              setPending(
                                setStatus(member, member.status === 'suspended' ? 'active' : 'suspended'),
                              )
                            }
                            data-testid={`toggle-status-${member.userId}`}
                          >
                            {member.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                          </Button>
                        )}

                        {actionable && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setPending(removeMember(member))}
                            data-testid={`remove-${member.userId}`}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <InviteMemberDialog
        open={inviting}
        mode={mode}
        organizationId={organizationId}
        organizationName={organizationName ?? null}
        seats={seats}
        onClose={() => setInviting(false)}
        onInvited={(result) => {
          /*
           * The temporary-password path has its own message and deliberately
           * does NOT repeat the password: the administrator already has it, and
           * echoing it here would put a live credential on a second surface.
           */
          setNotice(
            result.onboarding === 'temporary_password'
              ? 'User created. Give the temporary password to the user through a separate secure channel. The user must change it at first login.'
              : deliveryMessage(result.delivery, result.member.email),
          );
          void load();
        }}
      />

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        message={
          <div className="space-y-2 text-sm">
            <p>{pending?.message}</p>
            {actionError && <p className="text-red-600 dark:text-red-400">{actionError}</p>}
          </div>
        }
        confirmLabel={busy ? 'Working…' : (pending?.confirmLabel ?? 'Confirm')}
        destructive={pending?.destructive}
        onConfirm={() => void runPending()}
        onCancel={() => {
          setPending(null);
          setActionError(null);
        }}
      />
    </div>
  );
}

/**
 * The honest delivery sentence.
 *
 * "Invitation email sent" appears for `sent` and for nothing else. The other two
 * outcomes say the invitation EXISTS and can be resent, which is true and
 * actionable — claiming an email was sent when no transport is configured is the
 * specific lie this function exists to prevent.
 */
export function deliveryMessage(delivery: InvitationResult['delivery'], email: string): string {
  switch (delivery) {
    case 'sent':
      return `Invitation email sent to ${email}.`;
    case 'failed':
      return `Invitation created for ${email}, but the email could not be delivered. You can resend it.`;
    case 'unavailable':
    default:
      return `Invitation created for ${email}. Email delivery is not configured in this deployment, so it was not sent — you can resend it once mail is available.`;
  }
}

/** Membership state, including the pending-invitation case. */
function MembershipStatusBadge({ member }: { member: MemberRecord }) {
  if (member.status === 'invited') {
    return (
      <span data-testid={`status-${member.userId}`}>
        <Badge tone="amber">Invitation pending</Badge>
      </span>
    );
  }
  if (member.status === 'suspended') {
    return (
      <span data-testid={`status-${member.userId}`}>
        <Badge tone="red">Suspended</Badge>
      </span>
    );
  }
  return (
    <span data-testid={`status-${member.userId}`}>
      <Badge tone="green">Active</Badge>
    </span>
  );
}
