/**
 * "Assign package" / "Change package".
 *
 * ── The warning is not decoration ────────────────────────────────────────────
 * The dialog states, prominently and permanently, that the change applies to the
 * WHOLE ORGANIZATION. That is the single most misunderstood thing about this
 * operation: an administrator arrives from a member's profile, and without the
 * warning it reads as "give this person a bigger plan".
 *
 * ── Consequences before confirmation ─────────────────────────────────────────
 * Every edit re-requests `package-impact`, a pure read, so the operator sees what
 * a downgrade would cost — which members fall outside the new seat allowance, by
 * name, and which modules would be withdrawn — BEFORE they confirm. The confirm
 * step for a downgrade requires them to acknowledge the assessment, and the codes
 * they acknowledged are sent with the change so the audit trail records what they
 * were told.
 *
 * The server independently re-runs the same assessment, so a client that skips the
 * preview does not skip the analysis; it only skips being informed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { subscriptionApi, type PublicPlan } from '@/services/api/authApi';
import {
  adminSubscriberApi,
  type AssignPackageResponse,
  type PackageAssessment,
} from '@/services/api/adminConsoleApi';
import { ApiError } from '@/services/api/client';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active — entitled' },
  { value: 'past_due', label: 'Past due — still entitled, in grace' },
  { value: 'pending_payment', label: 'Pending payment' },
  { value: 'pending_verification', label: 'Pending verification' },
  { value: 'draft', label: 'Draft' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
];

const BILLING_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
];

const OPTIONAL_MODULES = [
  'inventory_basic',
  'inventory_advanced',
  'cost_centers',
  'multi_currency',
  'projects',
  'multi_entity',
  'manufacturing',
  'construction',
  'fixed_assets',
];

const DIRECTION_TONE = {
  upgrade: 'green',
  downgrade: 'amber',
  lateral: 'slate',
  initial: 'blue',
} as const;

export interface AssignPackageDialogProps {
  open: boolean;
  organizationId: string | null;
  organizationName: string | null;
  onClose: () => void;
  onAssigned: (result: AssignPackageResponse) => void;
}

export function AssignPackageDialog({
  open,
  organizationId,
  organizationName,
  onClose,
  onAssigned,
}: AssignPackageDialogProps) {
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [planId, setPlanId] = useState('');
  const [modules, setModules] = useState<string[]>([]);
  const [status, setStatus] = useState('active');
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [seatOverride, setSeatOverride] = useState('');
  const [reason, setReason] = useState('');

  const [assessment, setAssessment] = useState<PackageAssessment | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // A fresh dialog each time: a reason or an acknowledgement from a previous
  // subscriber must never carry over to a different one.
  useEffect(() => {
    if (!open) return;
    setModules([]);
    setStatus('active');
    setBillingCycle('monthly');
    setEffectiveDate(new Date().toISOString().slice(0, 10));
    setSeatOverride('');
    setReason('');
    setAssessment(null);
    setAcknowledged(false);
    setError(null);
    setTouched(false);

    let cancelled = false;
    void subscriptionApi
      .listPublicPlans()
      .then((result) => {
        if (cancelled) return;
        setPlans(result.plans);
        setPlanId(result.plans[0]?.id ?? '');
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Could not load the package catalogue.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, organizationId]);

  /**
   * Re-assess whenever the proposal changes. Debounced, aborted on change, and
   * keyed so a slow answer for an earlier proposal cannot land on a later one.
   */
  const assess = useCallback(
    (signal: AbortSignal) => {
      if (!organizationId || !planId) return Promise.resolve();
      setAssessing(true);
      return adminSubscriberApi
        .packageImpact(
          organizationId,
          { planId, modules, status, seatOverride: seatOverride ? Number(seatOverride) : null },
          signal,
        )
        .then((result) => {
          setAssessment(result.assessment);
          // Any change to the proposal invalidates a previous acknowledgement.
          setAcknowledged(false);
        })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setAssessment(null);
          setError(cause instanceof ApiError ? cause.message : 'Could not assess this change.');
        })
        .finally(() => setAssessing(false));
    },
    [organizationId, planId, modules, status, seatOverride],
  );

  useEffect(() => {
    if (!open || !planId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void assess(controller.signal), 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, planId, assess]);

  const selectedPlan = useMemo(() => plans.find((p) => p.id === planId), [plans, planId]);

  const toggleModule = (module: string): void => {
    setModules((current) =>
      current.includes(module) ? current.filter((m) => m !== module) : [...current, module],
    );
  };

  const needsAcknowledgement = Boolean(assessment?.isDowngrade) || (assessment?.consequences.length ?? 0) > 0;
  const trimmedReason = reason.trim();
  const canSubmit =
    !busy && !!planId && trimmedReason.length > 0 && (!needsAcknowledgement || acknowledged);

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (!organizationId || !trimmedReason) return;
    if (needsAcknowledgement && !acknowledged) return;

    setBusy(true);
    setError(null);
    try {
      const result = await adminSubscriberApi.assignPackage(organizationId, {
        planId,
        ...(modules.length > 0 ? { modules } : {}),
        billingCycle,
        status,
        effectiveDate,
        ...(seatOverride ? { seatOverride: Number(seatOverride) } : {}),
        reason: trimmedReason,
        // What the operator was shown and accepted — recorded in the audit trail.
        acknowledgedConsequences: assessment?.consequences.map((c) => c.code) ?? [],
      });
      onAssigned(result);
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the package.');
    } finally {
      setBusy(false);
    }
  };

  if (!open || !organizationId) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      widthClassName="max-w-2xl"
      title="Change subscription package"
      description={organizationName ?? 'Selected subscriber'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="assign-package-submit">
            {busy ? 'Applying…' : 'Apply package change'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* The warning the requirements call for, verbatim and unmissable. */}
        <Alert variant="warning" title="This affects the whole organization">
          <span data-testid="assign-package-scope-warning">
            This changes the subscription for the entire organization, not only this member.
          </span>
        </Alert>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Base plan" required>
            <Select
              options={plans.map((plan) => ({
                value: plan.id,
                label: `${plan.name} — ${plan.currency} ${plan.monthlyPrice}/mo · ${plan.userLimit} users`,
              }))}
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
              aria-label="Base plan"
            />
          </Field>
          <Field label="Subscription status">
            <Select
              options={STATUS_OPTIONS}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              aria-label="Subscription status"
            />
          </Field>
          <Field label="Billing interval">
            <Select
              options={BILLING_OPTIONS}
              value={billingCycle}
              onChange={(event) => setBillingCycle(event.target.value as 'monthly' | 'annual')}
              aria-label="Billing interval"
            />
          </Field>
          <Field label="Effective date">
            <Input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
          </Field>
          <Field label="Seat override" hint={`Plan default: ${selectedPlan?.userLimit ?? '—'}`}>
            <Input
              type="number"
              min={1}
              value={seatOverride}
              onChange={(event) => setSeatOverride(event.target.value)}
              placeholder="Inherit from plan"
              aria-label="Seat override"
            />
          </Field>
        </div>

        <Field label="Optional modules" hint="Added on top of the plan's own modules, for this tenant only.">
          <div className="flex flex-wrap gap-1.5">
            {OPTIONAL_MODULES.filter((module) => !selectedPlan?.modules.includes(module)).map((module) => {
              const on = modules.includes(module);
              return (
                <button
                  key={module}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleModule(module)}
                  className={
                    on
                      ? 'focus-ring rounded-md border border-teal-300 bg-teal-50 px-2 py-1 text-xs font-medium text-teal-800 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-200'
                      : 'focus-ring rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300'
                  }
                >
                  {module}
                </button>
              );
            })}
          </div>
        </Field>

        {/* ── The assessment ─────────────────────────────────────────────── */}
        <section className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            What will change
            {assessment && (
              <Badge tone={DIRECTION_TONE[assessment.direction]}>{assessment.direction}</Badge>
            )}
          </h3>

          {assessing && !assessment ? (
            <div className="space-y-2" data-testid="assign-package-assessing">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : !assessment ? (
            <p className="text-sm text-slate-500">Choose a plan to see the effect.</p>
          ) : (
            <div className="space-y-3" data-testid="assign-package-assessment">
              <dl className="grid gap-1.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Package</dt>
                  <dd>
                    {assessment.current.planName ?? 'None'} → <b>{assessment.proposed.planName}</b>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Seats</dt>
                  <dd>
                    {assessment.current.seatsUsed} used of {assessment.current.userLimit ?? '∞'} →{' '}
                    <b>{assessment.proposed.userLimit ?? '∞'}</b>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    {assessment.current.status} → <b>{assessment.proposed.status}</b>
                  </dd>
                </div>
              </dl>

              {assessment.modulesRemoved.length > 0 && (
                <p className="flex flex-wrap items-center gap-1 text-xs">
                  <span className="text-slate-500">Withdrawn:</span>
                  {assessment.modulesRemoved.map((module) => (
                    <Badge key={module} tone="red">
                      {module}
                    </Badge>
                  ))}
                </p>
              )}

              {assessment.consequences.length === 0 ? (
                <Alert variant="success">No members or data fall outside the new package.</Alert>
              ) : (
                <div className="space-y-2" data-testid="assign-package-consequences">
                  {assessment.consequences.map((consequence) => (
                    <Alert key={consequence.code} variant="warning" title={consequence.code.replace(/_/g, ' ')}>
                      {consequence.message}
                    </Alert>
                  ))}
                </div>
              )}

              {assessment.membersOverLimit.length > 0 && (
                <div className="rounded-md border border-amber-200 p-2.5 dark:border-amber-500/30">
                  <p className="mb-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                    Members above the new seat allowance ({assessment.membersOverLimit.length})
                  </p>
                  <ul className="space-y-0.5 text-xs text-slate-600 dark:text-slate-300" data-testid="assign-package-over-limit">
                    {assessment.membersOverLimit.map((member) => (
                      <li key={member.userId} className="flex justify-between gap-2">
                        <span>
                          {member.fullName} <span className="text-slate-400">({member.email})</span>
                        </span>
                        <Badge tone="slate">{member.role}</Badge>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Nobody is removed and no accounting data is deleted. They keep their membership; the organization is
                    simply over its allowance until you free a seat or raise the override.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        <Field
          label="Reason for this manual change"
          required
          error={touched && !trimmedReason ? 'A reason is required and is recorded in the audit trail.' : undefined}
          hint={touched && !trimmedReason ? undefined : 'Recorded with the previous and new package in the audit trail.'}
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            hasError={touched && !trimmedReason}
            placeholder="Agreed at renewal, customer downgraded, correcting a mis-sold plan…"
            aria-label="Reason for this manual change"
            data-testid="assign-package-reason"
          />
        </Field>

        {needsAcknowledgement && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              data-testid="assign-package-acknowledge"
            />
            <span>
              I have read the consequences above and confirm this change for the whole organization. No accounting data
              will be deleted.
            </span>
          </label>
        )}

        <p className="text-xs text-slate-400">
          Entitlements are recalculated immediately and the previous package is kept in the tenant's history. The
          customer sees the change after their session refreshes.
        </p>
      </div>
    </Drawer>
  );
}
