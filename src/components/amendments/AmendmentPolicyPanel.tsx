/**
 * Who in this organization may amend a posted document.
 *
 * The subscriber's own control surface. Two levels, matching the server's:
 * a grant for everybody holding a role, and an explicit decision for one
 * person that overrides it either way.
 *
 * The panel refuses to render controls for someone who cannot administer the
 * policy — but that is only an affordance; `amendmentPolicyStore` re-checks
 * every write, so nothing is gained by reaching this component another way.
 */
import { useState } from 'react';
import {
  AMENDMENT_PERMISSION_KEYS,
  PERMISSION_LABELS,
  amendmentRoleTemplate,
  canAdministerAmendmentPolicy,
  resolveAmendmentPermission,
  type AmendmentPermissionKey,
} from '@/lib/amendmentPermissions';
import { readAmendmentContext, permissionInput } from '@/lib/amendmentContext';
import { useAmendmentPolicyStore } from '@/store/amendmentPolicyStore';
import { useAuthStore, membersOf } from '@/store/authStore';
import { ORGANIZATION_ROLES, type OrganizationRole } from '@/types/roles';
import { Card, CardBody } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { cn } from '@/lib/utils';

export function AmendmentPolicyPanel() {
  const users = useAuthStore((s) => s.users);
  const roleGrants = useAmendmentPolicyStore((s) => s.roleGrants);
  const userOverrides = useAmendmentPolicyStore((s) => s.userOverrides);
  const setRoleGrant = useAmendmentPolicyStore((s) => s.setRoleGrant);
  const setUserOverride = useAmendmentPolicyStore((s) => s.setUserOverride);

  const context = readAmendmentContext();
  const mayAdminister = canAdministerAmendmentPolicy(context.role);
  const template = amendmentRoleTemplate();
  const members = membersOf(users, context.organizationId);
  const [selectedUser, setSelectedUser] = useState('');
  /*
   * Refusals are reported HERE rather than through a toast. The panel is
   * embedded in a page that may not sit under a `ToastProvider`, and a
   * permission control that throws when it refuses something is worse than one
   * that says so quietly in place.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  const granted = (role: OrganizationRole, key: AmendmentPermissionKey): boolean =>
    roleGrants.some((g) => g.role === role && g.key === key);
  const inherited = (role: OrganizationRole, key: AmendmentPermissionKey): boolean =>
    template[role].includes(key);

  const apply = (result: { ok: boolean; error?: string }): void => {
    setRefusal(result.ok ? null : (result.error ?? 'That change was not applied.'));
  };

  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Amending posted documents
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A posted invoice, bill, credit note or supplier debit note is never overwritten. An
            authorized user may amend one through a controlled reversal-and-reposting workflow that
            keeps the original document, its journal entry and its full history. Decide here who
            holds that authority — holding a subscription is not itself authorisation.
          </p>
        </div>

        {refusal && <Alert variant="error" onClose={() => setRefusal(null)}>{refusal}</Alert>}

        {!mayAdminister && (
          <Alert variant="info" title="Read-only">
            Only the organization owner or an Organization Admin can change who may amend posted
            documents.
          </Alert>
        )}

        {/* ── By role ────────────────────────────────────────────────────── */}
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-2 py-1 text-left font-semibold">Role</th>
                {AMENDMENT_PERMISSION_KEYS.map((key) => (
                  <th key={key} className="px-2 py-1 text-left font-semibold">{PERMISSION_LABELS[key]}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {ORGANIZATION_ROLES.map((role) => (
                <tr key={role}>
                  <td className="px-2 py-2 font-medium capitalize">{role}</td>
                  {AMENDMENT_PERMISSION_KEYS.map((key) => (
                    <td key={key} className="px-2 py-2">
                      {inherited(role, key) ? (
                        /* The two roles that hold everything hold this too, and
                           it is not a switch — removing it would leave nobody
                           able to grant it back. */
                        <Badge tone="green">always</Badge>
                      ) : (
                        <Toggle
                          checked={granted(role, key)}
                          disabled={!mayAdminister}
                          onChange={(next) => apply(setRoleGrant(role, key, next))}
                          label={`${role} may ${PERMISSION_LABELS[key].toLowerCase()}`}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── By person ──────────────────────────────────────────────────── */}
        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Exceptions for one person
          </h4>
          <p className="mt-1 text-[11px] text-slate-500">
            An explicit decision here beats the role above. A deny always wins.
          </p>
          <Select
            className="mt-2 max-w-sm"
            placeholder="Choose a member…"
            value={selectedUser}
            onChange={(e) => setSelectedUser(e.target.value)}
            options={members.map((m) => ({ value: m.id, label: `${m.fullName} — ${m.role}` }))}
          />
          {selectedUser && (
            <div className="mt-3 space-y-2">
              {AMENDMENT_PERMISSION_KEYS.map((key) => {
                const override = userOverrides.find((o) => o.userId === selectedUser && o.key === key);
                const member = members.find((m) => m.id === selectedUser);
                const effective = member
                  ? resolveAmendmentPermission(
                    permissionInput(
                      { ...context, role: member.role, userId: member.id, actingAsPlatformOperator: false },
                      { roleGrants, userOverrides },
                    ),
                    key,
                  )
                  : null;
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="min-w-[220px] font-medium">{PERMISSION_LABELS[key]}</span>
                    <Select
                      className="h-8 max-w-[160px]"
                      disabled={!mayAdminister}
                      value={override?.effect ?? 'inherit'}
                      onChange={(e) => apply(setUserOverride(
                        selectedUser,
                        key,
                        e.target.value === 'inherit' ? null : (e.target.value as 'grant' | 'deny'),
                      ))}
                      options={[
                        { value: 'inherit', label: 'Inherit from role' },
                        { value: 'grant', label: 'Grant' },
                        { value: 'deny', label: 'Deny' },
                      ]}
                    />
                    {effective && (
                      <Badge tone={effective.allowed ? 'green' : 'slate'}>
                        {effective.allowed ? 'allowed' : 'not allowed'} · {effective.source.replace(/_/g, ' ')}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className={cn('text-[11px] leading-relaxed text-slate-400 dark:text-slate-500')}>
          These rules are enforced in the document services, not only in the menus that offer the
          action. Ledgora’s books are held in this browser today, so this is a real gate against the
          application’s own code paths and not a security boundary against someone with developer
          tools open — the same limit that applies to every other permission on browser-resident data.
        </p>
      </CardBody>
    </Card>
  );
}
