/**
 * The member profile an administrator opens from the directory.
 *
 * ── One subject, never a mixture ─────────────────────────────────────────────
 * The drawer renders ONLY when the loaded detail's `userId` matches the row that
 * was clicked (`detailUserId === selectedUserId`, enforced by the store). While a
 * new subject is loading it shows a skeleton rather than the previous person's
 * data — a profile that briefly shows Alice's audit trail under Bob's name is a
 * disclosure, not a flicker.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 * There is no field here for a password, a hash, a session token, a CSRF token or
 * a reset token, because the API returns none. "Active sessions" is a COUNT.
 * "Must change password" is a flag. That is the whole security picture the console
 * needs, and it is all the backend will give it.
 *
 * ── Subscription section ─────────────────────────────────────────────────────
 * Labelled as the ORGANIZATION's package throughout, with the organization named,
 * because that is what it is. The package control opens the assignment dialog for
 * the tenant — the drawer never implies a per-member plan.
 */
import { useMemo, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import type { BadgeTone } from '@/data/ifrsOptions';
import type { AdminMemberDetail, PlatformCapabilityName } from '@/services/api/adminConsoleApi';
import { KeyRound, Link2, LockOpen, LogOut, MailCheck, Package, ShieldOff, ShieldCheck } from 'lucide-react';

export type MemberAction =
  | 'reset-temporary'
  | 'reset-link'
  | 'unlock'
  | 'revoke-sessions'
  | 'disable'
  | 'enable'
  | 'verify-email'
  | 'assign-package';

export interface MemberDetailDrawerProps {
  open: boolean;
  /** Loaded detail, or null while it is in flight / failed. */
  detail: AdminMemberDetail | null;
  /** The subject the detail describes. Compared against `selectedUserId`. */
  detailUserId: string | null;
  selectedUserId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  busy?: boolean;
  capabilities: PlatformCapabilityName[];
  onClose: () => void;
  onAction: (action: MemberAction) => void;
  onChangeRole: (organizationId: string, role: string) => void;
  onRetry: () => void;
}

const ACCOUNT_TONES: Record<string, BadgeTone> = {
  active: 'green',
  disabled: 'red',
  locked: 'amber',
  pending_verification: 'violet',
};

const SUBSCRIPTION_TONES: Record<string, BadgeTone> = {
  active: 'green',
  past_due: 'amber',
  pending_payment: 'amber',
  pending_verification: 'violet',
  suspended: 'red',
  cancelled: 'slate',
  expired: 'slate',
  rejected: 'red',
  draft: 'slate',
  none: 'slate',
};

const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const dateTime = (value: string | null): string =>
  value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) : '—';

const dateOnly = (value: string | null): string => (value ? new Date(value).toISOString().slice(0, 10) : '—');

/** Turn `member.password_reset_temporary` into "Password reset temporary". */
function actionLabel(action: string): string {
  const tail = action.includes('.') ? action.split('.').slice(1).join('.') : action;
  const words = tail.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

export function MemberDetailDrawer({
  open,
  detail,
  detailUserId,
  selectedUserId,
  status,
  error,
  busy,
  capabilities,
  onClose,
  onAction,
  onChangeRole,
  onRetry,
}: MemberDetailDrawerProps) {
  const [confirmingRole, setConfirmingRole] = useState<string | null>(null);

  const can = useMemo(
    () => ({
      reset: capabilities.includes('members.reset_password'),
      manage: capabilities.includes('members.manage'),
      assign: capabilities.includes('subscriptions.assign'),
    }),
    [capabilities],
  );

  if (!open) return null;

  /*
   * The subject guard. `detail` is only trusted when it describes the row that is
   * open — otherwise we are still loading, and showing anything would show the
   * wrong person.
   */
  const showing = detail !== null && detailUserId !== null && detailUserId === selectedUserId ? detail : null;

  return (
    <Drawer
      open
      onClose={onClose}
      widthClassName="max-w-2xl"
      title={showing ? showing.identity.fullName : 'Member'}
      description={showing ? showing.identity.email : 'Loading the member profile…'}
    >
      {status === 'loading' && !showing && (
        <div className="space-y-3" data-testid="member-detail-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {status === 'error' && (
        <Alert variant="warning" title="We could not load this member">
          <div className="space-y-2">
            <p data-testid="member-detail-error">{error ?? 'Please try again.'}</p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </Alert>
      )}

      {showing && (
        <div className="space-y-4" data-testid="member-detail" data-user-id={showing.identity.userId}>
          {/* ── Identity ───────────────────────────────────────────────── */}
          <Section title="Identity" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}>
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Full name">{showing.identity.fullName}</Row>
              <Row label="Email">{showing.identity.email}</Row>
              <Row label="User ID">
                <code className="select-all font-mono text-xs">{showing.identity.userId}</code>
              </Row>
              <Row label="Email verified">
                {showing.identity.emailVerified ? (
                  <Badge tone="green">Verified {dateOnly(showing.identity.emailVerifiedAt)}</Badge>
                ) : (
                  <Badge tone="amber">Not verified</Badge>
                )}
              </Row>
              <Row label="Account status">
                <Badge tone={ACCOUNT_TONES[showing.identity.accountStatus] ?? 'slate'}>
                  {showing.identity.accountStatus}
                </Badge>
              </Row>
              <Row label="Registered">{dateTime(showing.identity.registeredAt)}</Row>
              <Row label="Last login">{dateTime(showing.identity.lastLoginAt)}</Row>
              <Row label="Failed logins">
                <span data-testid="member-failed-logins">{showing.identity.failedLoginCount}</span>
                {showing.identity.locked && (
                  <Badge tone="red" className="ml-2">
                    Locked until {dateTime(showing.identity.lockedUntil)}
                  </Badge>
                )}
              </Row>
              {showing.identity.platformRoles.length > 0 && (
                <Row label="Platform role">
                  {showing.identity.platformRoles.map((role) => (
                    <Badge key={role} tone="indigo" className="ml-1">
                      {role}
                    </Badge>
                  ))}
                </Row>
              )}
            </dl>
          </Section>

          {/* ── Organization memberships ───────────────────────────────── */}
          <Section title="Organization" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}>
            {showing.organizations.length === 0 ? (
              <p className="text-sm text-slate-500">
                This account belongs to no organization yet — they registered but have not onboarded.
              </p>
            ) : (
              <div className="space-y-3">
                {showing.organizations.map((organization) => (
                  <div
                    key={organization.organizationId}
                    className="rounded-md border border-slate-100 p-2.5 dark:border-slate-800"
                    data-testid="member-organization"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{organization.organizationName}</span>
                      <span className="flex items-center gap-1">
                        {organization.primary && <Badge tone="blue">Primary</Badge>}
                        {organization.isOwner && <Badge tone="indigo">Owner</Badge>}
                        <Badge tone={organization.membershipStatus === 'active' ? 'green' : 'amber'}>
                          {organization.membershipStatus}
                        </Badge>
                      </span>
                    </div>
                    <dl className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                      <Row label="Organization ID">
                        <code className="select-all font-mono text-xs">{organization.organizationId}</code>
                      </Row>
                      <Row label="Joined">{dateOnly(organization.joinedAt)}</Row>
                      <Row label="Role">
                        {can.manage ? (
                          <span className="flex items-center gap-2">
                            <Select
                              className="h-8 w-32"
                              options={ROLE_OPTIONS}
                              value={confirmingRole ?? organization.role}
                              disabled={busy}
                              aria-label={`Role in ${organization.organizationName}`}
                              onChange={(event) => {
                                setConfirmingRole(null);
                                onChangeRole(organization.organizationId, event.target.value);
                              }}
                            />
                            {organization.isOwner && (
                              <span className="text-xs text-amber-600">
                                Ownership transfer is a subscriber action.
                              </span>
                            )}
                          </span>
                        ) : (
                          <Badge tone={organization.isOwner ? 'indigo' : 'slate'}>{organization.role}</Badge>
                        )}
                      </Row>
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* ── Subscription: the ORGANIZATION's, never the member's ───── */}
          <Section title="Subscription (organization-wide)" icon={<Package className="h-3.5 w-3.5" aria-hidden />}>
            {!showing.subscription ? (
              <p className="text-sm text-slate-500">No organization, so no package.</p>
            ) : (
              <>
                <Alert variant="info" className="mb-2">
                  <span data-testid="member-package-scope">
                    This package belongs to the organization, not to this member. Changing it affects every member.
                  </span>
                </Alert>
                <dl className="divide-y divide-slate-100 dark:divide-slate-800">
                  <Row label="Package">{showing.subscription.planName ?? showing.subscription.planCode ?? 'None'}</Row>
                  <Row label="Edition">{showing.subscription.edition ?? '—'}</Row>
                  <Row label="Status">
                    <Badge tone={SUBSCRIPTION_TONES[showing.subscription.status] ?? 'slate'}>
                      {showing.subscription.status}
                    </Badge>
                    {showing.subscription.entitlementActive ? (
                      <Badge tone="green" className="ml-1">
                        Entitled
                      </Badge>
                    ) : (
                      <Badge tone="slate" className="ml-1">
                        Not entitled
                      </Badge>
                    )}
                  </Row>
                  <Row label="Active modules">
                    {showing.subscription.modules.length === 0
                      ? '—'
                      : showing.subscription.modules.map((module) => (
                          <Badge key={module} tone="teal" className="ml-1">
                            {module}
                          </Badge>
                        ))}
                  </Row>
                  <Row label="Billing">{showing.subscription.billingCycle ?? '—'}</Row>
                  <Row label="Activated">{dateOnly(showing.subscription.activatedAt)}</Row>
                  <Row label="Renews / expires">{dateOnly(showing.subscription.expiresAt)}</Row>
                  <Row label="Seats used">
                    {showing.subscription.seatsUsed} / {showing.subscription.seatLimit ?? '∞'}
                  </Row>
                  <Row label="Invoice">
                    {showing.subscription.invoiceNumber
                      ? `${showing.subscription.invoiceNumber} · ${showing.subscription.invoiceStatus}`
                      : 'None issued'}
                  </Row>
                  <Row label="Payment proof">{showing.subscription.paymentProofStatus ?? '—'}</Row>
                </dl>
                {can.assign && (
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onAction('assign-package')}
                    data-testid="member-assign-package"
                  >
                    <Package className="h-3.5 w-3.5" aria-hidden /> Change the organization’s package
                  </Button>
                )}
              </>
            )}
          </Section>

          {/* ── Security ───────────────────────────────────────────────── */}
          <Section title="Security" icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />}>
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Active sessions">
                <span data-testid="member-session-count">{showing.security.activeSessionCount}</span>
              </Row>
              <Row label="Last session activity">{dateTime(showing.security.lastSessionAt)}</Row>
              <Row label="Must change password">
                {showing.security.mustChangePassword ? <Badge tone="amber">Yes</Badge> : <Badge tone="slate">No</Badge>}
              </Row>
              <Row label="Temporary password expires">{dateTime(showing.security.passwordExpiresAt)}</Row>
              <Row label="Pending reset link">
                {showing.security.hasPendingResetToken ? <Badge tone="blue">Outstanding</Badge> : '—'}
              </Row>
            </dl>

            {/* The current password is never retrievable — say so, so nobody asks. */}
            <p className="mt-2 text-xs text-slate-400">
              Ledgora stores only an Argon2id hash of a password. The existing password cannot be read by anyone,
              including you — it can only be replaced.
            </p>

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {can.reset && (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('reset-temporary')} data-testid="member-reset-temporary">
                    <KeyRound className="h-3.5 w-3.5" aria-hidden /> Generate temporary password
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('reset-link')} data-testid="member-reset-link">
                    <Link2 className="h-3.5 w-3.5" aria-hidden /> Send reset link
                  </Button>
                </>
              )}
              {can.manage && (
                <>
                  {showing.identity.locked && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('unlock')} data-testid="member-unlock">
                      <LockOpen className="h-3.5 w-3.5" aria-hidden /> Unlock account
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('revoke-sessions')} data-testid="member-revoke-sessions">
                    <LogOut className="h-3.5 w-3.5" aria-hidden /> Revoke sessions
                  </Button>
                  {!showing.identity.emailVerified && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('verify-email')} data-testid="member-verify-email">
                      <MailCheck className="h-3.5 w-3.5" aria-hidden /> Verify email
                    </Button>
                  )}
                  {showing.identity.accountStatus === 'active' ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('disable')} data-testid="member-disable">
                      <ShieldOff className="h-3.5 w-3.5" aria-hidden /> Disable account
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('enable')} data-testid="member-enable">
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Enable account
                    </Button>
                  )}
                </>
              )}
            </div>

            {showing.security.recentSecurityActions.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-slate-500">
                {showing.security.recentSecurityActions.map((entry) => (
                  <li key={entry.id} className="flex justify-between gap-2">
                    <span>{actionLabel(entry.action)}</span>
                    <span className="shrink-0 text-slate-400">{dateTime(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ── Administration ─────────────────────────────────────────── */}
          <Section title="Administration">
            {showing.administration.internalNotes && (
              <p className="mb-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
                {showing.administration.internalNotes}
              </p>
            )}
            {showing.administration.auditHistory.length === 0 ? (
              <p className="text-sm text-slate-500">No audit entries yet.</p>
            ) : (
              <ul className="space-y-1.5 text-xs" data-testid="member-audit-history">
                {showing.administration.auditHistory.map((entry) => (
                  <li key={entry.id} className="flex items-start justify-between gap-2 border-b border-slate-100 pb-1 last:border-0 dark:border-slate-800">
                    <span className="min-w-0">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{actionLabel(entry.action)}</span>
                      {typeof entry.metadata.reason === 'string' && (
                        <span className="block text-slate-500">{entry.metadata.reason}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-slate-400">{dateTime(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
}
