/**
 * Organization member management.
 *
 * ── The organization this page operates on ───────────────────────────────────
 * It comes from ONE resolver, `useEffectiveOrganizationSync` (see
 * `lib/effectiveOrganization`), which answers "which organization is being
 * operated on?" — not "which organization does the signed-in user belong to?".
 *
 * The difference is the defect this page used to have. It read
 * `organizationStore.organization`, which for a platform administrator is
 * correctly `null` (an operator is deliberately tenantless), and told them:
 *
 *   "Create your organization first to manage members."
 *
 * …while the banner above it read the VIEWED subscriber from `operatorViewStore`
 * and correctly said "Acme Holdings Ltd.". Two stores, two questions, one
 * contradiction. Now there is one question, and "create your organization first"
 * is reachable only from `isGenuinelyWithoutOrganization` — a settled subscriber
 * lookup that came back empty.
 *
 * In operator mode the roster is loaded from the capability-guarded admin
 * endpoint for the viewed organization; in subscriber mode from the caller's own.
 * Either way the backend re-authorizes: the id below is a routing detail, never
 * a permission.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAuthStore, membersOf, canManageMembers } from '@/store/authStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useRouterStore } from '@/store/routerStore';
import { useEffectiveOrganizationSync } from '@/store/effectiveOrganization';
import { useMemberDirectoryStore } from '@/store/memberDirectoryStore';
import { MemberManagementPanel } from '@/components/members/MemberManagementPanel';
import { isGenuinelyWithoutOrganization } from '@/lib/effectiveOrganization';
import { memberApi, type MemberRecord } from '@/services/api/memberApi';
import { ApiError, isApiConfigured } from '@/services/api/client';
import { ROUTES } from '@/lib/accessControl';
import type { OrgUserRole } from '@/types/onboarding';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { MetricCard } from '@/components/ui/MetricCard';
import { Users, UserPlus, ShieldCheck } from 'lucide-react';
import { useDemoActionGuard } from '@/components/onboarding/FreeDemoNotices';
import { AmendmentPolicyPanel } from '@/components/amendments/AmendmentPolicyPanel';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

/** Roles the backend accepts for a new member (ownership transfer is separate). */
const INVITE_ROLE_OPTIONS = [
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

function statusTone(status?: string): 'green' | 'amber' | 'red' | 'slate' {
  return status === 'active' ? 'green' : status === 'invited' ? 'amber' : status === 'suspended' ? 'red' : 'slate';
}

/** One row shape, whichever context supplied it. */
interface MemberRow {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
}

export function MembersPage() {
  const context = useEffectiveOrganizationSync();
  const navigate = useRouterStore((s) => s.navigate);

  // ── Operator: an administrator has no organization of their own, and must
  // never be asked to make one. Send them to the console or the selector.
  if (context.mode === 'none') {
    return (
      <Alert variant="info" title="No subscriber selected">
        <div className="space-y-2">
          <p data-testid="members-no-selection">
            You are signed in as a Ledgora platform administrator, so you have no subscriber workspace of your own. Choose a
            subscriber in the admin console to manage their members.
          </p>
          <Button size="sm" variant="outline" onClick={() => navigate(ROUTES.adminConsole)}>
            Back to admin console
          </Button>
        </div>
      </Alert>
    );
  }

  if (context.status === 'loading') {
    return (
      <Alert variant="info">
        <span data-testid="members-loading">Loading the workspace…</span>
      </Alert>
    );
  }

  // A failed lookup is not proof of absence. It never renders the creation prompt.
  if (context.status === 'error') {
    return (
      <Alert variant="warning" title="We could not load this workspace">
        <p data-testid="members-error">{context.error ?? 'Please try again.'}</p>
      </Alert>
    );
  }

  // The ONE honest use of this message: a settled subscriber lookup with no
  // organization behind it.
  if (isGenuinelyWithoutOrganization(context)) {
    return <Alert variant="info">Create your company workspace first to manage members.</Alert>;
  }

  if (!context.organizationId) {
    return (
      <Alert variant="warning">
        <span data-testid="members-error">We could not determine which workspace to show.</span>
      </Alert>
    );
  }

  return (
    <MemberRoster
      organizationId={context.organizationId}
      organizationName={context.organizationName}
      mode={context.mode}
      canMutate={context.canMutate}
    />
  );
}

function MemberRoster({
  organizationId,
  organizationName,
  mode,
  canMutate,
}: {
  organizationId: string;
  organizationName: string | null;
  mode: 'subscriber' | 'operator';
  canMutate: boolean;
}) {
  const users = useAuthStore((s) => s.users);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const inviteMember = useAuthStore((s) => s.inviteMember);
  const updateMemberRole = useAuthStore((s) => s.updateMemberRole);
  const setMemberStatus = useAuthStore((s) => s.setMemberStatus);
  const removeMember = useAuthStore((s) => s.removeMember);
  const planUserLimit = useEntitlementStore((s) => s.subscription.userLimit);

  const load = useMemberDirectoryStore((s) => s.load);
  const directoryStatus = useMemberDirectoryStore((s) => s.status);
  const directoryOrganizationId = useMemberDirectoryStore((s) => s.loadedOrganizationId);
  const directoryMembers = useMemberDirectoryStore((s) => s.members);
  const directorySeatsUsed = useMemberDirectoryStore((s) => s.seatsUsed);
  const directorySeatLimit = useMemberDirectoryStore((s) => s.seatLimit);
  const directoryError = useMemberDirectoryStore((s) => s.error);

  const [form, setForm] = useState<{ fullName: string; email: string; role: OrgUserRole }>({
    fullName: '',
    email: '',
    role: 'member',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const demoGuard = useDemoActionGuard();

  // The roster comes from the backend whenever there is one. Re-runs on an
  // organization switch, and the store discards any response that arrives after
  // the operator has moved on.
  const backed = isApiConfigured();
  useEffect(() => {
    if (!backed) return;
    void load({ organizationId, mode });
    // Clearing the banner on switch stops a message about Acme sitting above
    // Globex's roster.
    setBanner(null);
  }, [backed, load, organizationId, mode]);

  const reload = (): void => {
    if (backed) void load({ organizationId, mode });
  };

  /**
   * Rows for the organization being operated on.
   *
   * The backend roster is used ONLY when it is the roster for THIS organization —
   * `loadedOrganizationId` is checked explicitly, so a stale payload can never be
   * rendered under the wrong subscriber's name even for one frame.
   */
  const rows: MemberRow[] = useMemo(() => {
    if (backed) {
      if (directoryOrganizationId !== organizationId) return [];
      return directoryMembers.map((m: MemberRecord) => ({
        id: m.userId,
        fullName: m.fullName,
        email: m.email,
        role: m.role,
        status: m.status,
      }));
    }
    // No backend (static demo): the local model is the only roster there is.
    return membersOf(users, organizationId).map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      role: u.role,
      status: u.status ?? 'active',
    }));
  }, [backed, directoryMembers, directoryOrganizationId, organizationId, users]);

  const seatLimit = backed && directorySeatLimit !== null ? directorySeatLimit : planUserLimit;
  const seatsUsed = backed
    ? directoryOrganizationId === organizationId
      ? directorySeatsUsed
      : 0
    : rows.filter((m) => m.status !== 'suspended').length;

  const canManage = canMutate && (mode === 'operator' || canManageMembers());

  const act = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setBanner(null);
    try {
      await run();
      reload();
    } catch (cause) {
      setBanner({
        tone: 'error',
        text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Action failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const invite = async (): Promise<void> => {
    setBanner(null);
    if (demoGuard('invite')) return;

    if (!backed) {
      const res = inviteMember(form);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setBanner({ tone: 'error', text: res.error ?? 'Could not send the invitation.' });
        return;
      }
      setErrors({});
      setForm({ fullName: '', email: '', role: 'member' });
      setBanner({ tone: 'success', text: `Invitation created. Demo verification token: ${res.verificationToken}` });
      return;
    }

    await act(async () => {
      await memberApi.inviteToOrganization(organizationId, {
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        // `owner` and `admin` are not invitable — the backend refuses both, so
        // the form falls back to the safest role rather than sending a value
        // that would come back 400.
        role: form.role === 'admin' || form.role === 'owner' ? 'member' : form.role,
      });
      setErrors({});
      setForm({ fullName: '', email: '', role: 'member' });
      setBanner({ tone: 'success', text: `Invitation created for ${form.email.trim()}.` });
    });
  };

  const changeRole = async (userId: string, role: string): Promise<void> => {
    if (!backed) {
      const res = updateMemberRole(userId, role as OrgUserRole);
      if (!res.ok) setBanner({ tone: 'error', text: res.error ?? 'Action failed.' });
      return;
    }
    await act(() => memberApi.updateInOrganization(organizationId, userId, { role: role as never }).then(() => undefined));
  };

  const changeStatus = async (userId: string, status: 'active' | 'suspended'): Promise<void> => {
    if (!backed) {
      const res = setMemberStatus(userId, status);
      if (!res.ok) setBanner({ tone: 'error', text: res.error ?? 'Action failed.' });
      return;
    }
    await act(() => memberApi.updateInOrganization(organizationId, userId, { status }).then(() => undefined));
  };

  const drop = async (userId: string): Promise<void> => {
    if (!backed) {
      const res = removeMember(userId);
      if (!res.ok) setBanner({ tone: 'error', text: res.error ?? 'Action failed.' });
      return;
    }
    await act(() => memberApi.removeFromOrganization(organizationId, userId).then(() => undefined));
  };

  const loading = backed && directoryStatus === 'loading' && directoryOrganizationId !== organizationId;

  return (
    <div className="space-y-6">
      {mode === 'operator' && (
        <Alert variant="warning">
          <span data-testid="members-operator-context">
            Managing members of <b>{organizationName ?? 'the selected subscriber'}</b> as a Ledgora platform
            administrator. Every change is recorded in the audit trail against your account.
          </span>
        </Alert>
      )}

      {/*
        Exact-subscriber view is read-only for member management: the operator
        asked to see the customer's experience, not to edit on their behalf.
      */}
      {mode === 'operator' && !canMutate && (
        <Alert variant="info">
          <span data-testid="members-exact-view-readonly">
            Return to administrator view to manage members. You are currently viewing exactly as the subscriber sees it.
          </span>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Members" value={loading ? '—' : String(rows.length)} icon={Users} />
        <MetricCard
          label="Seats used"
          value={loading ? '—' : `${seatsUsed} / ${seatLimit}`}
          icon={ShieldCheck}
          tone={!loading && seatsUsed >= seatLimit ? 'amber' : 'brand'}
        />
        <MetricCard
          label="Owners"
          value={loading ? '—' : String(rows.filter((m) => m.role === 'owner').length)}
          icon={ShieldCheck}
          tone="slate"
        />
      </div>

      {banner && <Alert variant={banner.tone} onClose={() => setBanner(null)}>{banner.text}</Alert>}
      {backed && directoryError && (
        <Alert variant="warning">
          <span data-testid="members-error">{directoryError}</span>
        </Alert>
      )}

      {/*
        The BACKED path: full member and invitation management against the real
        account service, shared with the Super Admin per-subscriber section so
        the two surfaces cannot drift. The legacy browser-only form and table
        below remain for the static demo build, which has no account service.
      */}
      {backed && organizationId && (
        <MemberManagementPanel
          mode={mode === 'operator' ? 'operator' : 'subscriber'}
          organizationId={organizationId}
          organizationName={organizationName}
          canManage={canManage}
          currentUserId={currentUserId}
        />
      )}

      {!backed && canManage ? (
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <UserPlus className="h-4 w-4" /> Invite a member
          </h3>
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_140px_auto]">
            <Field label="Full name" error={errors.fullName}>
              <Input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder="Jane Smith"
                hasError={!!errors.fullName}
              />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="jane@company.com"
                hasError={!!errors.email}
              />
            </Field>
            <Field label="Role" error={errors.role}>
              <Select
                options={backed ? INVITE_ROLE_OPTIONS : ROLE_OPTIONS}
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as OrgUserRole })}
              />
            </Field>
            <Button onClick={() => void invite()} disabled={busy || seatsUsed >= seatLimit}>
              Send invite
            </Button>
          </div>
          {seatsUsed >= seatLimit && (
            <p className="mt-2 text-xs text-amber-600">
              {mode === 'operator'
                ? `This workspace has used all ${seatLimit} seats. Free a seat or change its plan to add another.`
                : `You've used all ${seatLimit} seats. Suspend or remove a member, or upgrade your plan, to invite more.`}
            </p>
          )}
        </Card>
      ) : (
        !backed && mode === 'subscriber' && (
          <Alert variant="info">You have read-only access to the member list. Ask an owner or admin to make changes.</Alert>
        )
      )}

      {!backed && (
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Email</th>
              <th className="px-4 py-2 text-left">Role</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  <span data-testid="members-roster-loading">Loading members…</span>
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((m) => {
                // In operator mode the administrator is never a member of this
                // organization, so no row is ever "you".
                const isSelf = mode === 'subscriber' && m.id === currentUserId;
                return (
                  <tr key={m.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 font-medium">
                      {m.fullName}
                      {isSelf && <span className="ml-1 text-xs text-slate-400">(you)</span>}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{m.email}</td>
                    <td className="px-4 py-2">
                      {canManage && m.role !== 'owner' && !isSelf ? (
                        <Select
                          className="h-8 w-28"
                          options={ROLE_OPTIONS}
                          value={m.role}
                          onChange={(e) => void changeRole(m.id, e.target.value)}
                        />
                      ) : (
                        <Badge tone={m.role === 'owner' ? 'indigo' : 'slate'}>{m.role}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {canManage && !isSelf && (
                        <div className="flex justify-end gap-1">
                          {m.status === 'suspended' ? (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeStatus(m.id, 'active')}>
                              Reactivate
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeStatus(m.id, 'suspended')}>
                              Suspend
                            </Button>
                          )}
                          {m.role !== 'owner' && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void drop(m.id)}>
                              Remove
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Card>
      )}

      {/*
        Who may amend a POSTED document. Beside the member list rather than
        buried in Settings, because it is a decision about people: the question
        "who can restate an invoice we have already sent?" belongs next to the
        list of who those people are.
      */}
      {mode === 'subscriber' && <AmendmentPolicyPanel />}

      <p className="text-xs text-slate-400">
        Roles: <b>Owner</b> has full control and billing. <b>Admin</b> manages members and settings. <b>Member</b> uses
        the app. Suspended members keep their history but cannot sign in.
      </p>
    </div>
  );
}
