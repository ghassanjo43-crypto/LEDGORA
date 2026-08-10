/**
 * Members — every user across every organization.
 *
 * ── What makes this safe to show ─────────────────────────────────────────────
 * Every row comes from `/api/admin/members`, authorised server-side against a
 * database-backed platform capability. The `capabilities` list this component
 * receives decides which BUTTONS exist, and nothing more: the server re-checks
 * each action, so a client that renders a control it should not have simply gets
 * a 403. Hiding a control is a courtesy to the operator, never a permission.
 *
 * ── No stale data when the scope changes ─────────────────────────────────────
 * `organizationId` may change while a request is in flight — that is what happens
 * when an operator moves from one subscriber to another. The store stamps its
 * contents with the query that produced them, and this component renders rows
 * ONLY when the loaded key matches the query it is currently asking for. So the
 * table is empty for a frame rather than showing the previous tenant's people.
 *
 * ── Reasons and confirmations ────────────────────────────────────────────────
 * Every destructive or security-sensitive action goes through `ReasonPromptDialog`,
 * which will not submit without a written reason — the same rule the backend
 * enforces. Generated credentials go to `CredentialResultDialog`, which shows them
 * once and never stores them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, RefreshCw, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import type { BadgeTone } from '@/data/ifrsOptions';
import {
  adminMemberApi,
  type AdminMemberQuery,
  type PlatformCapabilityName,
} from '@/services/api/adminConsoleApi';
import { ApiError, isApiConfigured } from '@/services/api/client';
import { requestKeyOf, useAdminMemberStore } from '@/store/adminConsoleStores';
import { MemberDetailDrawer, type MemberAction } from './MemberDetailDrawer';
import { CredentialResultDialog, type CredentialResult } from './CredentialResultDialog';
import { ReasonPromptDialog } from './ReasonPromptDialog';
import { PermissionManagerDrawer } from './PermissionManagerDrawer';

const PAGE_SIZE = 25;

const SORT_OPTIONS = [
  { value: 'created_at', label: 'Created date' },
  { value: 'full_name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'organization_name', label: 'Organization' },
  { value: 'organization_role', label: 'Role' },
  { value: 'account_status', label: 'Account status' },
  { value: 'last_login_at', label: 'Last login' },
];

const ROLE_FILTERS = [
  { value: 'all', label: 'Any role' },
  { value: 'owner', label: 'Owner' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const STATUS_FILTERS = [
  { value: 'all', label: 'Any account status' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'locked', label: 'Locked' },
  { value: 'pending_verification', label: 'Pending verification' },
];

const VERIFICATION_FILTERS = [
  { value: 'all', label: 'Any verification' },
  { value: 'verified', label: 'Email verified' },
  { value: 'unverified', label: 'Email unverified' },
];

const AUDIENCE_FILTERS = [
  { value: 'all', label: 'Everyone' },
  { value: 'customer', label: 'Subscribers only' },
  { value: 'platform', label: 'Platform staff only' },
];

const ACCOUNT_TONES: Record<string, BadgeTone> = {
  active: 'green',
  disabled: 'red',
  locked: 'amber',
  pending_verification: 'violet',
};

const shortDate = (value: string | null): string => (value ? new Date(value).toISOString().slice(0, 10) : '—');

/** A pending action that needs a reason before it can be sent. */
interface PendingAction {
  kind: MemberAction | 'change-role';
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  run: (reason: string) => Promise<string>;
}

export interface MembersPanelProps {
  /** Scope the directory to one subscriber. Omit for the whole platform. */
  organizationId?: string | null;
  /** Shown when the directory is scoped, so the operator knows where they are. */
  organizationName?: string | null;
  capabilities: PlatformCapabilityName[];
  /** Opens the package dialog for a member's organization. */
  onAssignPackage?: (organizationId: string, organizationName: string | null) => void;
}

export function MembersPanel({
  organizationId = null,
  organizationName = null,
  capabilities,
  onAssignPackage,
}: MembersPanelProps) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [accountStatus, setAccountStatus] = useState('all');
  const [verification, setVerification] = useState('all');
  const [audience, setAudience] = useState('all');
  const [sort, setSort] = useState<NonNullable<AdminMemberQuery['sort']>>('created_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The member whose permission matrix is open, if any. */
  const [permissionTarget, setPermissionTarget] = useState<{
    userId: string;
    userName: string;
    organizationId: string;
    organizationName: string | null;
  } | null>(null);

  /*
   * Which permission controls to offer. A courtesy so the console does not
   * present an action that would come back 403 — every route re-checks its own
   * capability, so a client ignoring these gains nothing.
   */
  const canReadPermissions = capabilities.includes('permissions.read');
  const canManagePermissions = capabilities.includes('permissions.manage');
  /**
   * The one-time credential, in PLAIN component state — never a store, never
   * persisted. Cleared the instant the dialog is dismissed.
   */
  const [credential, setCredential] = useState<CredentialResult | null>(null);
  /** Set when an action succeeded but returned no credential. */
  const [missingCredential, setMissingCredential] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useAdminMemberStore((s) => s.load);
  const select = useAdminMemberStore((s) => s.select);
  const reloadDetail = useAdminMemberStore((s) => s.reloadDetail);
  const status = useAdminMemberStore((s) => s.status);
  const loadedKey = useAdminMemberStore((s) => s.loadedKey);
  const members = useAdminMemberStore((s) => s.members);
  const pagination = useAdminMemberStore((s) => s.pagination);
  const listError = useAdminMemberStore((s) => s.error);
  const selectedUserId = useAdminMemberStore((s) => s.selectedUserId);
  const detail = useAdminMemberStore((s) => s.detail);
  const detailUserId = useAdminMemberStore((s) => s.detailUserId);
  const detailStatus = useAdminMemberStore((s) => s.detailStatus);
  const detailError = useAdminMemberStore((s) => s.detailError);

  const configured = isApiConfigured();

  /** Debounce the search box so typing does not fire a request per keystroke. */
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Changing the scope resets paging and clears any message about the previous
  // subscriber, so a success banner about Acme never sits above Globex's table.
  useEffect(() => {
    setOffset(0);
    setNotice(null);
    setActionError(null);
    void select(null);
  }, [organizationId, select]);

  const query = useMemo<AdminMemberQuery>(
    () => ({
      ...(organizationId ? { organizationId } : {}),
      ...(search ? { search } : {}),
      ...(role !== 'all' ? { role } : {}),
      ...(accountStatus !== 'all' ? { accountStatus } : {}),
      ...(verification !== 'all' ? { verification: verification as 'verified' | 'unverified' } : {}),
      ...(audience !== 'all' ? { audience: audience as 'platform' | 'customer' } : {}),
      sort,
      direction,
      limit: PAGE_SIZE,
      offset,
    }),
    [organizationId, search, role, accountStatus, verification, audience, sort, direction, offset],
  );

  const queryKey = useMemo(() => requestKeyOf(query as Record<string, unknown>), [query]);

  useEffect(() => {
    if (!configured) return;
    void load(query);
  }, [configured, load, query]);

  /**
   * The staleness gate. Rows are rendered only when the store's contents belong
   * to the query being asked for right now.
   */
  const fresh = loadedKey === queryKey;
  const rows = fresh ? members : [];
  const total = fresh ? pagination.total : 0;
  /**
   * Two different questions, deliberately not conflated:
   *  `loading`  — a request is in flight, so paging controls should be inert;
   *  `awaiting` — there is nothing trustworthy to render yet (either loading, or
   *               the store holds another query's contents).
   * Disabling Refresh on `awaiting` would strand a failed load forever: the
   * contents never become fresh, so the retry control would never re-enable.
   */
  const loading = status === 'loading';
  const awaiting = loading || !fresh;

  const refresh = useCallback(async (): Promise<void> => {
    await load(query);
    await reloadDetail();
  }, [load, query, reloadDetail]);

  /** Run an action, surface its outcome honestly, then re-read. */
  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  };

  /** Same, but for an action driven by the reason dialog. */
  const runPending = async (reason: string): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const message = await pending.run(reason);
      setPending(null);
      setNotice(message);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };

  const subject = detailUserId === selectedUserId ? detail : null;

  const handleAction = (action: MemberAction): void => {
    if (!subject) return;
    const userId = subject.identity.userId;
    const name = subject.identity.fullName;
    const email = subject.identity.email;

    switch (action) {
      case 'reset-temporary':
        setPending({
          kind: action,
          title: 'Generate a temporary password',
          description: `A new password will be generated for ${name} and shown to you once. It cannot be retrieved afterwards. Every current session is ended, any lock is cleared, and ${name} must choose a new password at their next sign-in.`,
          confirmLabel: 'Generate password',
          destructive: true,
          run: async (reason) => {
            const result = await adminMemberApi.resetPassword(userId, { mode: 'temporary', reason });
            /*
             * Capture the credential FIRST, into plain component state, before the
             * roster/detail refresh that `runPending` performs. The dialog is a
             * sibling of everything that re-renders, so nothing here can unmount
             * it or discard the value.
             */
            if (!result.credential) {
              // The reset happened; the credential did not arrive. Say so.
              setMissingCredential(
                `Password reset for ${name} succeeded, but no temporary credential was returned. Generate a new temporary password from the member details.`,
              );
              return `${name}: reset recorded without a retrievable credential.`;
            }
            setCredential({
              subjectName: result.member?.fullName ?? name,
              subjectEmail: result.member?.email ?? email,
              type: result.credential.type,
              temporaryPassword: result.credential.temporaryPassword,
              invitationToken: result.credential.invitationToken,
              expiresAt: result.credential.expiresAt,
              deliveryStatus: result.credential.deliveryStatus,
              message: result.credential.message,
              revokedSessions: result.credential.revokedSessions,
              mustChangePassword: result.credential.mustChangePassword,
            });
            return `Temporary password issued for ${name}.`;
          },
        });
        return;

      case 'reset-link':
        setPending({
          kind: action,
          title: 'Send a password reset link',
          description: `A single-use, expiring reset link will be created for ${name}. Their current password and sessions are left alone until they use it.`,
          confirmLabel: 'Create reset link',
          destructive: false,
          run: async (reason) => {
            const result = await adminMemberApi.resetPassword(userId, { mode: 'link', reason });
            if (!result.credential) {
              setMissingCredential(
                `A reset link for ${name} could not be produced. Try again, or generate a temporary password instead.`,
              );
              return `${name}: no reset link was returned.`;
            }
            setCredential({
              subjectName: result.member?.fullName ?? name,
              subjectEmail: result.member?.email ?? email,
              type: result.credential.type,
              invitationToken: result.credential.invitationToken,
              expiresAt: result.credential.expiresAt,
              deliveryStatus: result.credential.deliveryStatus,
              message: result.credential.message,
              revokedSessions: result.credential.revokedSessions,
              mustChangePassword: result.credential.mustChangePassword,
            });
            // The server's own words — never "Email sent" unless it was.
            return result.credential.deliveryStatus === 'sent'
              ? `Reset link sent to ${email}.`
              : result.credential.message;
          },
        });
        return;

      case 'disable':
        setPending({
          kind: action,
          title: 'Disable this account',
          description: `${name} will be signed out everywhere and unable to sign in. Their records and history are kept — nothing is deleted.`,
          confirmLabel: 'Disable account',
          destructive: true,
          run: async (reason) => {
            const result = await adminMemberApi.setStatus(userId, 'disabled', reason);
            return `${name} disabled. ${result.revokedSessions} session(s) ended.`;
          },
        });
        return;

      case 'enable':
        setPending({
          kind: action,
          title: 'Enable this account',
          description: `${name} will be able to sign in again. Any failed-attempt lock is cleared.`,
          confirmLabel: 'Enable account',
          destructive: false,
          run: async (reason) => {
            await adminMemberApi.setStatus(userId, 'active', reason);
            return `${name} enabled.`;
          },
        });
        return;

      case 'verify-email':
        setPending({
          kind: action,
          title: 'Verify this email address administratively',
          description: `Record that ${email} has been verified by other means. This is logged as an ADMINISTRATIVE verification, not as the customer confirming it themselves.`,
          confirmLabel: 'Mark verified',
          destructive: false,
          run: async (reason) => {
            await adminMemberApi.verifyEmail(userId, reason);
            return `${email} marked verified.`;
          },
        });
        return;

      case 'unlock':
        void run('unlock', async () => {
          const result = await adminMemberApi.unlock(userId);
          return `${name} unlocked (status ${result.accountStatus}).`;
        });
        return;

      case 'revoke-sessions':
        void run('revoke sessions', async () => {
          const result = await adminMemberApi.revokeSessions(userId);
          return `${result.revokedSessions} session(s) ended for ${name}.`;
        });
        return;

      case 'assign-package': {
        const organization = subject.organizations.find((o) => o.primary) ?? subject.organizations[0];
        if (organization && onAssignPackage) {
          onAssignPackage(organization.organizationId, organization.organizationName);
        }
        return;
      }
    }
  };

  const handleChangeRole = (targetOrganizationId: string, newRole: string): void => {
    if (!subject) return;
    const name = subject.identity.fullName;
    void run('change role', async () => {
      await adminMemberApi.updateMembership(subject.identity.userId, {
        organizationId: targetOrganizationId,
        role: newRole,
      });
      return `${name} is now ${newRole} in this organization.`;
    });
  };

  if (!configured) {
    return (
      <Alert variant="warning" title="Backend not configured for this build">
        The member directory is served by the LEDGORA account service. Set <code>VITE_API_URL</code> and sign in as a
        platform administrator to manage members.
      </Alert>
    );
  }

  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <Alert variant="info">
        Every user across every organization. A member belongs to an organization; the SUBSCRIPTION belongs to that
        organization, never to the individual.
        {organizationName && (
          <>
            {' '}
            Filtered to <b data-testid="members-scope">{organizationName}</b>.
          </>
        )}
      </Alert>

      {listError && <Alert variant="error">{listError}</Alert>}
      {actionError && <Alert variant="error" onClose={() => setActionError(null)}>{actionError}</Alert>}
      {/* Never fold "no credential returned" into a success message. */}
      {missingCredential && (
        <Alert variant="warning" title="No credential was returned" onClose={() => setMissingCredential(null)}>
          <span data-testid="members-missing-credential">{missingCredential}</span>
        </Alert>
      )}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          <span data-testid="members-notice">{notice}</span>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input
            className="pl-8"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name, email or organization"
            aria-label="Search members"
          />
        </div>
        <div className="w-40">
          <Select
            options={ROLE_FILTERS}
            value={role}
            aria-label="Filter by role"
            onChange={(event) => {
              setRole(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-48">
          <Select
            options={STATUS_FILTERS}
            value={accountStatus}
            aria-label="Filter by account status"
            onChange={(event) => {
              setAccountStatus(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-48">
          <Select
            options={VERIFICATION_FILTERS}
            value={verification}
            aria-label="Filter by email verification"
            onChange={(event) => {
              setVerification(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-44">
          <Select
            options={AUDIENCE_FILTERS}
            value={audience}
            aria-label="Filter by audience"
            onChange={(event) => {
              setAudience(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-44">
          <Select
            options={SORT_OPTIONS}
            value={sort}
            aria-label="Sort members by"
            onChange={(event) => {
              setSort(event.target.value as NonNullable<AdminMemberQuery['sort']>);
              setOffset(0);
            }}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
            setOffset(0);
          }}
          aria-label={`Sort ${direction === 'asc' ? 'descending' : 'ascending'}`}
        >
          {direction === 'asc' ? 'Ascending' : 'Descending'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden /> Members ({total})
          </span>
          {total > 0 && (
            <span className="font-normal normal-case text-slate-400">
              Showing {offset + 1}–{pageEnd}
            </span>
          )}
        </div>

        {awaiting && rows.length === 0 ? (
          <div className="space-y-2 p-4" data-testid="members-loading">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500" data-testid="members-empty">
            {search || role !== 'all' || accountStatus !== 'all'
              ? 'No members match these filters.'
              : 'No members yet.'}
          </p>
        ) : (
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Member</th>
                <th className="px-4 py-2 text-left">Organization</th>
                <th className="px-4 py-2 text-left">Role</th>
                <th className="px-4 py-2 text-left">Account status</th>
                <th className="px-4 py-2 text-left">Subscription</th>
                <th className="px-4 py-2 text-left">Platform role</th>
                <th className="px-4 py-2 text-left">Last login</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((member) => (
                <tr
                  key={member.userId}
                  className="border-t border-slate-100 dark:border-slate-800"
                  data-testid="member-row"
                  data-user-id={member.userId}
                >
                  <td className="px-4 py-2">
                    <span className="font-medium">{member.fullName}</span>
                    {/*
                      The account type of the person, not of their organization.
                      Only test/demo is badged: production is the default for
                      every account, so badging it would put a label on every
                      row and make the disposable ones harder to spot rather
                      than easier. The title says what an absent badge means.
                    */}
                    {(member.dataClassification === 'test' || member.dataClassification === 'demo') && (
                      <span data-testid={`member-classification-${member.userId}`}>
                        <Badge
                          tone={member.dataClassification === 'test' ? 'amber' : 'violet'}
                          className="ml-1"
                          title="A disposable account. Accounts without this badge are production."
                        >
                          {member.dataClassification}
                        </Badge>
                      </span>
                    )}
                    <span className="block text-xs text-slate-400">
                      {member.email}
                      {member.emailVerified ? '' : ' · unverified'}
                    </span>
                  </td>
                  <td className={member.organizationName ? 'px-4 py-2' : 'px-4 py-2 text-slate-400'}>
                    {member.organizationName ?? 'No organization yet'}
                    {member.organizationCount > 1 && (
                      <Badge tone="slate" className="ml-1">
                        +{member.organizationCount - 1}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {member.organizationRole ? (
                      <Badge tone={member.isOwner ? 'indigo' : 'slate'}>{member.organizationRole}</Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={ACCOUNT_TONES[member.accountStatus] ?? 'slate'}>{member.accountStatus}</Badge>
                    {member.locked && (
                      <Badge tone="red" className="ml-1">
                        locked
                      </Badge>
                    )}
                    {member.mustChangePassword && (
                      <Badge tone="amber" className="ml-1">
                        must change password
                      </Badge>
                    )}
                  </td>
                  {/*
                    The organization's package, not the person's. Shown greyed
                    when it is not live, because "Enterprise" and "Enterprise,
                    lapsed" mean very different things for what this person can
                    actually reach.
                  */}
                  <td className="px-4 py-2">
                    {member.planCode ? (
                      <Badge tone={member.subscriptionActive ? 'green' : 'amber'}>
                        {member.planCode}
                        {member.subscriptionActive ? '' : ` · ${member.subscriptionStatus ?? 'inactive'}`}
                      </Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {member.platformRoles.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      member.platformRoles.map((platformRole) => (
                        <Badge key={platformRole} tone="indigo" className="mr-1">
                          {platformRole}
                        </Badge>
                      ))
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{shortDate(member.lastLoginAt)}</td>
                  <td className="px-4 py-2 text-slate-500">{shortDate(member.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {/*
                      Offered only where it would work: permissions are scoped to
                      an organization, so an account with no tenant has none to
                      configure. Hiding it is a courtesy — the route re-checks
                      `permissions.read` regardless.
                    */}
                    {member.organizationId && canReadPermissions && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mr-1"
                        onClick={() =>
                          setPermissionTarget({
                            userId: member.userId,
                            userName: member.fullName,
                            organizationId: member.organizationId!,
                            organizationName: member.organizationName,
                          })
                        }
                        aria-label={`Manage permissions for ${member.fullName}`}
                      >
                        Permissions
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void select(member.userId)}
                      aria-label={`View details for ${member.fullName}`}
                    >
                      View details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset((current) => Math.max(current - PAGE_SIZE, 0))}
          >
            Previous
          </Button>
          <span className="text-xs text-slate-500" data-testid="members-page">
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(Math.ceil(total / PAGE_SIZE), 1)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pageEnd >= total || loading}
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      )}

      <MemberDetailDrawer
        open={selectedUserId !== null}
        detail={detail}
        detailUserId={detailUserId}
        selectedUserId={selectedUserId}
        status={detailStatus}
        error={detailError}
        busy={busy}
        capabilities={capabilities}
        onClose={() => void select(null)}
        onAction={handleAction}
        onChangeRole={handleChangeRole}
        onRetry={() => void reloadDetail()}
      />

      <ReasonPromptDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description={pending?.description ?? ''}
        confirmLabel={pending?.confirmLabel}
        destructive={pending?.destructive}
        busy={busy}
        error={actionError}
        onConfirm={(reason) => void runPending(reason)}
        onCancel={() => {
          setPending(null);
          setActionError(null);
        }}
      />

      <CredentialResultDialog result={credential} onClose={() => setCredential(null)} />

      {permissionTarget && (
        <PermissionManagerDrawer
          open
          userId={permissionTarget.userId}
          userName={permissionTarget.userName}
          organizationId={permissionTarget.organizationId}
          organizationName={permissionTarget.organizationName}
          surface="platform"
          editable={canManagePermissions}
          onClose={() => setPermissionTarget(null)}
          // A permission change can alter the account's status badges, so the
          // directory is refreshed rather than left showing a stale row.
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}
