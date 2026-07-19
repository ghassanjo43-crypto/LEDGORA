/**
 * Organization member management. An owner/admin invites teammates, assigns
 * roles and activates/suspends them — within the subscription's seat limit.
 * Non-managers see a read-only roster.
 *
 * Email delivery is a backend seam: invitations surface the verification token
 * here (a real deployment emails an accept-invite link).
 */
import { useMemo, useState } from 'react';
import { useAuthStore, membersOf, canManageMembers } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useEntitlementStore } from '@/store/entitlementStore';
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

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

function statusTone(status?: string): 'green' | 'amber' | 'red' | 'slate' {
  return status === 'active' ? 'green' : status === 'invited' ? 'amber' : status === 'suspended' ? 'red' : 'slate';
}

export function MembersPage() {
  const users = useAuthStore((s) => s.users);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const inviteMember = useAuthStore((s) => s.inviteMember);
  const updateMemberRole = useAuthStore((s) => s.updateMemberRole);
  const setMemberStatus = useAuthStore((s) => s.setMemberStatus);
  const removeMember = useAuthStore((s) => s.removeMember);
  const organization = useOrganizationStore((s) => s.organization);
  const userLimit = useEntitlementStore((s) => s.subscription.userLimit);

  const members = useMemo(() => membersOf(users, organization?.id), [users, organization?.id]);
  const canManage = canManageMembers();
  const seatsUsed = useMemo(() => members.filter((m) => m.status !== 'suspended').length, [members]);

  const [form, setForm] = useState<{ fullName: string; email: string; role: OrgUserRole }>({ fullName: '', email: '', role: 'member' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const demoGuard = useDemoActionGuard();

  const invite = (): void => {
    setBanner(null);
    // Collaboration is not part of the Free Demo.
    if (demoGuard('invite')) return;
    const res = inviteMember(form);
    if (!res.ok) { setErrors(res.fieldErrors ?? {}); setBanner({ tone: 'error', text: res.error ?? 'Could not send the invitation.' }); return; }
    setErrors({});
    setForm({ fullName: '', email: '', role: 'member' });
    setBanner({ tone: 'success', text: `Invitation created. Demo verification token: ${res.verificationToken}` });
  };

  const act = (fn: () => { ok: boolean; error?: string }): void => {
    const res = fn();
    if (!res.ok) setBanner({ tone: 'error', text: res.error ?? 'Action failed.' });
    else setBanner(null);
  };

  if (!organization) {
    return <Alert variant="info">Create your organization first to manage members.</Alert>;
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Members" value={String(members.length)} icon={Users} />
        <MetricCard label="Seats used" value={`${seatsUsed} / ${userLimit}`} icon={ShieldCheck} tone={seatsUsed >= userLimit ? 'amber' : 'brand'} />
        <MetricCard label="Owners" value={String(members.filter((m) => m.role === 'owner').length)} icon={ShieldCheck} tone="slate" />
      </div>

      {banner && <Alert variant={banner.tone} onClose={() => setBanner(null)}>{banner.text}</Alert>}

      {canManage ? (
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100"><UserPlus className="h-4 w-4" /> Invite a member</h3>
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_140px_auto]">
            <Field label="Full name" error={errors.fullName}><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="Jane Smith" hasError={!!errors.fullName} /></Field>
            <Field label="Email" error={errors.email}><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@company.com" hasError={!!errors.email} /></Field>
            <Field label="Role" error={errors.role}><Select options={ROLE_OPTIONS} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as OrgUserRole })} /></Field>
            <Button onClick={invite} disabled={seatsUsed >= userLimit}>Send invite</Button>
          </div>
          {seatsUsed >= userLimit && <p className="mt-2 text-xs text-amber-600">You've used all {userLimit} seats. Suspend or remove a member, or upgrade your plan, to invite more.</p>}
        </Card>
      ) : (
        <Alert variant="info">You have read-only access to the member list. Ask an owner or admin to make changes.</Alert>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Email</th><th className="px-4 py-2 text-left">Role</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2"></th></tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.id === currentUserId;
              const status = m.status ?? 'active';
              return (
                <tr key={m.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{m.fullName}{isSelf && <span className="ml-1 text-xs text-slate-400">(you)</span>}</td>
                  <td className="px-4 py-2 text-slate-500">{m.email}</td>
                  <td className="px-4 py-2">
                    {canManage && m.role !== 'owner' && !isSelf ? (
                      <Select className="h-8 w-28" options={ROLE_OPTIONS} value={m.role} onChange={(e) => act(() => updateMemberRole(m.id, e.target.value as OrgUserRole))} />
                    ) : (
                      <Badge tone={m.role === 'owner' ? 'indigo' : 'slate'}>{m.role}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2"><Badge tone={statusTone(status)}>{status}</Badge></td>
                  <td className="px-4 py-2 text-right">
                    {canManage && !isSelf && (
                      <div className="flex justify-end gap-1">
                        {status === 'suspended' ? (
                          <Button size="sm" variant="ghost" onClick={() => act(() => setMemberStatus(m.id, 'active'))}>Reactivate</Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => act(() => setMemberStatus(m.id, 'suspended'))}>Suspend</Button>
                        )}
                        {m.role !== 'owner' && <Button size="sm" variant="ghost" onClick={() => act(() => removeMember(m.id))}>Remove</Button>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <p className="text-xs text-slate-400">
        Roles: <b>Owner</b> has full control and billing. <b>Admin</b> manages members and settings. <b>Member</b> uses the app.
        Suspended members keep their history but cannot sign in.
      </p>
    </div>
  );
}
