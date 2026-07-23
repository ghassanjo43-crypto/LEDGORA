/**
 * Subscriber detail drawer for the platform operator console.
 *
 * Opens the SELECTED subscriber only — every field is drawn from the row that
 * was clicked, never from ambient "active organization" state, so one
 * subscriber's card can never show another's organization or subscription.
 *
 * Three honestly-distinguished states (see `SubscriberState`):
 *  · active-tenant       — the one organization retained in this single-tenant
 *                          build; full plan / invoice / member detail is shown
 *                          and the workspace can be opened.
 *  · onboarded-elsewhere — the owner completed onboarding, but their tenant is
 *                          not the one retained locally, so its detail is not
 *                          available (a backend limitation, not fabricated).
 *  · not-onboarded       — a registered account that never created an
 *                          organization; only its sign-up data exists.
 *
 * Accessibility: built on the shared `Drawer` (role="dialog", Escape to close,
 * focusable close control). The workspace-entry control is a real disabled/
 * enabled button with a visible reason when it cannot be used.
 */
import type { RegisteredUser } from '@/types/onboarding';
import { Drawer } from '@/components/ui/Drawer';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { formatCurrency } from '@/lib/money';

export type SubscriberState = 'active-tenant' | 'onboarded-elsewhere' | 'not-onboarded';

export interface SubscriberRow {
  owner: RegisteredUser;
  orgName: string;
  state: SubscriberState;
}

export interface SubscriberInvoice {
  id: string;
  number: string;
  paymentReference: string;
  total: number;
  currency: string;
  status: string;
}

/** Full detail, present ONLY for the retained active-tenant row. */
export interface ActiveTenantDetail {
  planName: string;
  status: string;
  edition: string;
  addOns: string;
  monthlyTotal: number;
  currency: string;
  activeSeats: number;
  userLimit: number;
  paymentReference: string;
  members: RegisteredUser[];
  invoices: SubscriberInvoice[];
}

export interface SubscriberDetailDrawerProps {
  open: boolean;
  row: SubscriberRow | null;
  detail: ActiveTenantDetail | null;
  onClose: () => void;
  onOpenWorkspace: () => void;
}

function invoiceTone(status: string): 'green' | 'red' | 'amber' {
  if (status === 'paid') return 'green';
  if (status === 'rejected' || status === 'cancelled') return 'red';
  return 'amber';
}

function memberTone(status?: string): 'green' | 'amber' | 'red' | 'slate' {
  if (status === 'active') return 'green';
  if (status === 'invited') return 'amber';
  if (status === 'suspended') return 'red';
  return 'slate';
}

/** The reason workspace entry is unavailable, or null when it is available. */
function workspaceBlockReason(state: SubscriberState): string | null {
  if (state === 'active-tenant') return null;
  if (state === 'not-onboarded') return 'This subscriber has not completed organization onboarding.';
  return "This subscriber's organization is not retained in this single-tenant build, so its workspace cannot be opened here. Multi-subscriber workspace access needs the backend.";
}

export function SubscriberDetailDrawer({ open, row, detail, onClose, onOpenWorkspace }: SubscriberDetailDrawerProps) {
  if (!row) return null;

  const { owner, orgName, state } = row;
  const blockReason = workspaceBlockReason(state);
  const canOpenWorkspace = blockReason === null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={owner.fullName}
      description={owner.email}
      footer={
        <div className="flex w-full flex-col items-stretch gap-2">
          {blockReason && <p className="text-xs text-slate-500 dark:text-slate-400">{blockReason}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={onOpenWorkspace}
              disabled={!canOpenWorkspace}
              title={blockReason ?? undefined}
            >
              Open subscriber workspace
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5" data-testid="subscriber-detail" data-subscriber-id={owner.id}>
        {/* Account — always available from sign-up data. */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Account</h3>
          <dl className="space-y-1 text-sm">
            <Row label="Owner name" value={owner.fullName} />
            <Row label="Email" value={owner.email} />
            <Row label="Verification" value={owner.emailVerified ? 'Verified' : 'Unverified'} />
            <Row label="Mobile" value={owner.mobile || '—'} />
            <Row label="Country" value={owner.country || '—'} />
            <Row label="Registered" value={owner.createdAt.slice(0, 10)} />
          </dl>
        </section>

        {/* Organization + subscription. */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Organization &amp; subscription</h3>

          {state === 'not-onboarded' && (
            <Alert variant="info">
              <span className="font-medium">Not onboarded yet.</span> This account has registered but has not created an
              organization or chosen a plan. Only the sign-up data above is available.
            </Alert>
          )}

          {state === 'onboarded-elsewhere' && (
            <Alert variant="warning">
              This subscriber&apos;s organization ({orgName}) is not the tenant retained in this single-tenant build, so
              its subscription and invoice detail is not available here. It would be served by the backend.
            </Alert>
          )}

          {state === 'active-tenant' && detail && (
            <dl className="space-y-1 text-sm">
              <Row label="Organization" value={orgName} />
              <Row label="Plan" value={detail.planName} />
              <Row label="Subscription status" value={detail.status} />
              <Row label="Edition" value={detail.edition} />
              <Row label="Add-ons" value={detail.addOns} />
              <Row label="MRR" value={formatCurrency(detail.monthlyTotal, detail.currency)} />
              <Row label="Seats" value={`${detail.activeSeats} / ${detail.userLimit}`} />
              <Row label="Payment reference" value={detail.paymentReference} />
            </dl>
          )}
        </section>

        {state === 'active-tenant' && detail && (
          <>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Members ({detail.members.length})
              </h3>
              {detail.members.length === 0 ? (
                <p className="text-sm text-slate-400">No members.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {detail.members.map((m) => (
                      <tr key={m.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                        <td className="py-1">
                          {m.fullName}
                          <span className="block text-xs text-slate-400">{m.email}</span>
                        </td>
                        <td className="py-1 text-right capitalize text-slate-500">{m.role}</td>
                        <td className="py-1 text-right">
                          <Badge tone={memberTone(m.status)}>{m.status ?? 'active'}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Invoices ({detail.invoices.length})
              </h3>
              {detail.invoices.length === 0 ? (
                <p className="text-sm text-slate-400">No invoices.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400">
                    <tr>
                      <th className="text-left font-medium">Number</th>
                      <th className="text-left font-medium">Reference</th>
                      <th className="text-right font-medium">Total</th>
                      <th className="text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.invoices.map((i) => (
                      <tr key={i.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-1 font-medium">{i.number}</td>
                        <td className="py-1 text-slate-500">{i.paymentReference}</td>
                        <td className="py-1 text-right">{formatCurrency(i.total, i.currency)}</td>
                        <td className="py-1 text-right">
                          <Badge tone={invoiceTone(i.status)}>{i.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-medium capitalize text-slate-700 dark:text-slate-200">{value}</dd>
    </div>
  );
}
