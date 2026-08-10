/**
 * Applicant detail for the platform operator console.
 *
 * Shows exactly the applicant that was opened, from the record the backend
 * returned for that user — never from ambient "current organization" state.
 * Stages the applicant has not reached are shown as "not reached", not hidden,
 * so the operator can see at a glance where the prospect stalled.
 */
import { Drawer } from '@/components/ui/Drawer';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { formatCurrency } from '@/lib/money';
import type { Applicant } from '@/services/api/authApi';
import { organizationLabel, packageLabel, stageLabel, stageTone } from '@/lib/applicantStages';

export interface ApplicantDetailDrawerProps {
  open: boolean;
  applicant: Applicant | null;
  busy?: boolean;
  onClose: () => void;
  onRemind: () => void;
  onSuspend: () => void;
  onArchive: () => void;
  onRestore: () => void;
}

const dateTime = (value: string | null): string => (value ? new Date(value).toLocaleString() : 'Not reached');

export function ApplicantDetailDrawer({
  open,
  applicant,
  busy = false,
  onClose,
  onRemind,
  onSuspend,
  onArchive,
  onRestore,
}: ApplicantDetailDrawerProps) {
  if (!applicant) return null;

  const closed = applicant.stage === 'suspended' || applicant.stage === 'archived';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={applicant.fullName}
      description={applicant.email}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {applicant.funnelStage === 'registered_no_package' && (
            <Button variant="secondary" onClick={onRemind} disabled={busy}>
              Send package reminder
            </Button>
          )}
          {closed ? (
            <Button variant="primary" onClick={onRestore} disabled={busy}>
              Restore applicant
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onArchive} disabled={busy}>
                Archive
              </Button>
              <Button variant="danger" onClick={onSuspend} disabled={busy}>
                Suspend
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-5" data-testid="applicant-detail" data-applicant-id={applicant.userId}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stageTone(applicant.stage)}>{stageLabel(applicant.stage)}</Badge>
          {applicant.dormant && applicant.funnelStage !== 'registered_no_package' && (
            <Badge tone="slate">Reached: {stageLabel(applicant.funnelStage)}</Badge>
          )}
          {!applicant.emailVerified && <Badge tone="amber">Email unverified</Badge>}
          {applicant.accountStatus !== 'active' && <Badge tone="red">Account {applicant.accountStatus}</Badge>}
        </div>

        {applicant.funnelStage === 'registered_no_package' && (
          <Alert variant="info">
            This account is registered but has not chosen a package yet. They are a prospect, not a subscriber — and they
            appear here from the moment they signed up.
          </Alert>
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Account</h3>
          <dl className="space-y-1 text-sm">
            <Row label="Full name" value={applicant.fullName} />
            <Row label="Email" value={applicant.email} />
            <Row label="Registered" value={dateTime(applicant.registeredAt)} />
            <Row label="Last sign-in" value={applicant.lastLoginAt ? dateTime(applicant.lastLoginAt) : 'Never'} />
            <Row label="Last activity" value={dateTime(applicant.lastActivityAt)} />
            <Row label="Source" value={applicant.source ?? 'unknown'} />
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Organization &amp; package</h3>
          <dl className="space-y-1 text-sm">
            <Row label="Organization" value={organizationLabel(applicant)} />
            <Row label="Country" value={applicant.organizationCountry ?? '—'} />
            <Row label="Package" value={packageLabel(applicant)} />
            <Row
              label="Monthly price"
              value={
                applicant.planMonthlyPrice === null
                  ? '—'
                  : formatCurrency(applicant.planMonthlyPrice, applicant.planCurrency ?? 'USD')
              }
            />
            <Row label="Billing cycle" value={applicant.billingCycle ?? '—'} />
            <Row label="Subscription status" value={applicant.subscriptionStatus ?? 'No subscription'} />
            <Row
              label="Expires"
              value={applicant.subscriptionExpiresAt ? dateTime(applicant.subscriptionExpiresAt) : '—'}
            />
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Payment</h3>
          <dl className="space-y-1 text-sm">
            <Row label="Invoice" value={applicant.invoiceNumber ?? 'Not issued'} />
            <Row label="Invoice status" value={applicant.invoiceStatus ?? '—'} />
            <Row
              label="Invoice total"
              value={
                applicant.invoiceTotal === null
                  ? '—'
                  : formatCurrency(applicant.invoiceTotal, applicant.planCurrency ?? 'USD')
              }
            />
            <Row label="Payment reference" value={applicant.paymentReference ?? '—'} />
            <Row label="Payment proof" value={applicant.proofStatus ?? 'Not uploaded'} />
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Funnel timeline</h3>
          <dl className="space-y-1 text-sm">
            <Row label="Registered" value={dateTime(applicant.registeredAt)} />
            <Row label="Package selected" value={dateTime(applicant.packageSelectedAt)} />
            <Row label="Payment started" value={dateTime(applicant.paymentStartedAt)} />
            <Row label="Proof uploaded" value={dateTime(applicant.proofUploadedAt)} />
            <Row label="Activated" value={dateTime(applicant.activatedAt)} />
          </dl>
        </section>
      </div>
    </Drawer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-medium text-slate-700 dark:text-slate-200">{value}</dd>
    </div>
  );
}
